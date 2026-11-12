// Run: node src/namingworker.check.ts [all]. Structure to Name in a worker (namingworker.ts, naming.worker.ts,
// namepart.ts). 1. namePart, the code the worker and the window both run, gives byte for byte the names the editor
// gave before it moved (Editor.tsx namedPart, kept below as it was), on a spread of Octet's naming test set (OPSIN's
// names.txt, Octet's reagent and drug names; "all" runs every one). 2. The client: answers through a stand-in worker
// equal namePart's; a request past its time ends the worker and answers late, and the next request starts a new worker
// and is answered; Stop ends a running request (and its worker) or drops a waiting one; a worker that does not load,
// fails to load or fails gives "failed" to every waiting request; Structure to Name's requests go before the screen
// reader's. Node has no Worker: the real worker is tried in the browser (see notes).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import type { Mol } from "./render.ts";

const dir = new URL("./vendor/opsin/", import.meta.url);
if (!existsSync(new URL("opsin.js", dir))) { console.log("namingworker.check: skipped (no OPSIN build)"); process.exit(0); }
// chem.ts reads the drawing tokens and loads Indigo's wasm as a browser does; these stand in for the browser.
const gl = globalThis as Record<string, unknown>;
gl.document = { documentElement: {}, createElement: () => ({ getContext: () => ({}) }) };
gl.getComputedStyle = () => ({ getPropertyValue: () => "10" });
gl.window = globalThis;
gl.self = { location: { origin: "file://" } };
gl.fetch = async (u: URL | string) => new Response(readFileSync(new URL(String(u))), { headers: { "content-type": "application/wasm" } });
const chem = await import("./chem.ts");
await chem.ready;
const pack = readFileSync(new URL("opsin-data.bin", dir)), files = new Map<string, Int8Array>();
for (let p = 0; ; ) {
  const n = pack.readUInt16BE(p); p += 2;
  if (!n) break;
  const name = pack.toString("latin1", p, p + n); p += n;
  const size = pack.readInt32BE(p); p += 4;
  files.set(name, new Int8Array(pack.buffer, pack.byteOffset + p, size)); p += size;
}
gl.opsinResource = (name: string) => files.get(name) ?? null;
const opsin = await import(new URL("opsin.js", dir).href);
opsin.init();
const json = (file: string) => JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8"));
const { DRUGS } = await import("./drugs.ts");
const { COMMON } = await import("./common.ts");
const words = readFileSync(new URL("names.txt", dir), "utf8");
const { abbreviationOf, attachOpsin, knownName, nameToSmiles, setOwnNames } = await import("./names.ts");
attachOpsin(opsin, words, json("./nameindex.json"), DRUGS, json("./abbreviations.json"));
// namepart.ts sets the namer and the complex namer, as Editor.tsx did.
const { namePart, nameMixture, inchiOf } = await import("./namepart.ts");
const { checkedName, withAbbreviation } = await import("./naming.ts");
const { sandwichIons } = await import("./metals.ts");
const { mixtureName } = await import("./mixtures.ts");
const W = await import("./namingworker.ts");

// ——— 1. The same names as before ———
// Editor.tsx namedPart before this change, line for line.
const before = (part: Mol) => {
  let bare: string | undefined;
  const p = sandwichIons(part) ?? part;
  try { bare = checkedName(p, chem.expandLabels(p), nameToSmiles, inchiOf, chem.cipOf, knownName); } catch { bare = undefined; }
  return { bare, name: bare && withAbbreviation(bare, abbreviationOf(inchiOf(p))), mol: p };
};
const inputs = [...new Set([...words.split("\n").map((s) => s.trim()).filter(Boolean), ...Object.values(COMMON).filter((v) => !v.startsWith("smiles:")), ...Object.keys(DRUGS)])];
const all = process.argv[2] === "all", step = all ? 1 : Math.ceil(inputs.length / 150);
let compared = 0, named = 0;
const t0 = performance.now();
for (let k = 0; k < inputs.length; k += step) {
  const smiles = nameToSmiles(inputs[k]);
  if (!smiles) continue;
  let m: Mol;
  try { m = chem.parseStructure(smiles); } catch { continue; }
  const a = before(m), b = namePart(m);
  assert.equal(JSON.stringify(b), JSON.stringify(a), inputs[k]);
  compared++;
  if (b.name) named++;
}
assert.ok(compared >= (all ? 6000 : 120), `compared ${compared}`);
assert.ok(named > compared * 0.8, `named ${named} of ${compared}`);
console.log(`namingworker.check: ${compared} structures named the same as before (${named} named) in ${Math.round(performance.now() - t0)} ms`);
// The abbreviation after the name, and the user's own dictionary, as the editor gives them.
const tren = chem.parseStructure(nameToSmiles("TREN")!);
assert.equal(namePart(tren).name, "N1,N1-bis(2-aminoethyl)ethane-1,2-diamine (TREN)");
setOwnNames([{ name: "My amine", smiles: "NCCN(CCN)CCN", inchi: inchiOf(tren) }]);
assert.equal(namePart(tren).name, "N1,N1-bis(2-aminoethyl)ethane-1,2-diamine (My amine)");
setOwnNames([]);
// A mixture's name, as mixtureName gives it.
const water = chem.parseStructure("O"), ethanol = chem.parseStructure("CCO");
const mix = [{ name: namePart(ethanol).bare!, mol: ethanol, count: 1 }, { name: namePart(water).bare!, mol: water, count: 1 }];
assert.equal(nameMixture(mix), mixtureName(mix, nameToSmiles, inchiOf));
assert.ok(nameMixture(mix)?.includes("ethanol"));

// ——— 2. The client ———
// Without Worker, each request runs at once with namePart.
assert.equal(typeof Worker, "undefined");
const here = await W.askName(tren, []).result;
assert.ok(here.done && JSON.stringify(here.answer) === JSON.stringify(namePart(tren)));

// A stand-in worker. It loads after `load` ms (never when undefined; ready false when bad), then answers each request
// as naming.worker.ts does, through a structured copy, after `takes` ms (never when the name is "stuck").
type Fake = { posted: unknown[]; ended: boolean; fail: () => void };
const made: Fake[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function fakes(o: { load?: number; bad?: boolean; takes?: number } = {}) {
  W.setNamingWorker(() => {
    const f: Fake = { posted: [], ended: false, fail: () => {} };
    let ready = false;
    const queue: unknown[] = [];
    const w: W.WorkerLike = {
      onmessage: null, onerror: null,
      postMessage(m) { f.posted.push(m); queue.push(m); pump(); },
      terminate() { f.ended = true; },
    };
    const send = (data: unknown) => { if (!f.ended) w.onmessage?.({ data: structuredClone(data) } as MessageEvent); };
    let busy = false;
    const pump = () => {
      if (!ready || busy || !queue.length) return;
      const ask = queue.shift()! as { part?: Mol; mixture?: typeof mix };
      busy = true;
      if (ask.part?.atoms.length === 0) return; // stuck: an empty part never answers
      setTimeout(() => { busy = false; send({ answer: ask.part ? namePart(ask.part) : nameMixture(ask.mixture!) }); pump(); }, o.takes ?? 1);
    };
    if (o.load !== undefined) setTimeout(() => { send({ ready: !o.bad }); ready = !o.bad; pump(); }, o.load);
    f.fail = () => w.onerror?.({} as ErrorEvent);
    made.push(f);
    return w;
  });
}
const stuck: Mol = { atoms: [], bonds: [] };
// ReShiki's limits; shorter ones for the check.
assert.deepEqual(W.NAMING, { load: 60_000, deadline: 15_000 });
W.NAMING.load = 200;
W.NAMING.deadline = 100;

// Answers through the worker equal namePart's, after it has loaded; one worker serves them all.
fakes({ load: 20 });
const viaWorker = await Promise.all([tren, water, ethanol].map((m) => W.askName(m, []).result));
viaWorker.forEach((o, k) => assert.ok(o.done && JSON.stringify(o.answer) === JSON.stringify(namePart([tren, water, ethanol][k]))));
assert.equal(made.length, 1);
assert.equal((made[0].posted[0] as { own: unknown[] }).own.length, 0, "the user's dictionary goes with each request");
assert.equal(W.namingBusy(), false);

// A request past its time: the worker ends and the answer is late; the next request starts a new worker and is answered.
made.length = 0;
fakes({ load: 5 });
let t = performance.now();
const slow = await W.askName(stuck, []).result;
assert.deepEqual(slow, { done: false, why: "late" });
assert.ok(performance.now() - t >= 95 && performance.now() - t < 1000, "past the deadline, not before");
assert.ok(made[0].ended, "the worker is ended");
const after = await W.askName(water, []).result;
assert.ok(after.done && after.answer.bare === "water");
assert.equal(made.length, 2, "a new worker");
// A request that waits behind a stuck one gets its own full time once it runs.
const [r1, r2] = [W.askName(stuck, []), W.askName(ethanol, [])];
assert.deepEqual(await r1.result, { done: false, why: "late" });
const o2 = await r2.result;
assert.ok(o2.done && o2.answer.bare === "ethanol");

// Stop: a running request ends with its worker; a waiting one is dropped and its worker is kept.
made.length = 0;
fakes({ load: 5, takes: 50 });
const run = W.askName(stuck, []), wait = W.askName(water, []), then = W.askName(ethanol, []);
await sleep(30);
wait.cancel();
assert.deepEqual(await wait.result, { done: false, why: "stopped" });
assert.equal(made[0].ended, false, "dropping a waiting request keeps the worker");
run.cancel();
assert.deepEqual(await run.result, { done: false, why: "stopped" });
assert.ok(made[0].ended, "stopping the running request ends its worker");
const o3 = await then.result;
assert.ok(o3.done && o3.answer.bare === "ethanol", "the next request still answers, in a new worker");
assert.equal(made.length, 2);
// Stop after the answer changes nothing.
run.cancel();

// Structure to Name's requests go before the screen reader's waiting ones.
made.length = 0;
fakes({ load: 5 });
const order: string[] = [];
const bg = [W.askName(water, [], true), W.askName(ethanol, [], true)], fg = W.askName(tren, []);
await Promise.all([...bg, fg].map((r, k) => r.result.then(() => order.push(["water", "ethanol", "tren"][k]))));
assert.deepEqual(order, ["water", "tren", "ethanol"], "the first background request had started; tren goes next");

// A worker that never loads: the running and the waiting requests fail after the load time, not the request time.
made.length = 0;
fakes({});
t = performance.now();
const [n1, n2] = [W.askName(water, []), W.askName(ethanol, [])];
assert.deepEqual(await n1.result, { done: false, why: "failed" });
assert.deepEqual(await n2.result, { done: false, why: "failed" });
assert.ok(performance.now() - t >= 195, "the load time");
assert.ok(made[0].ended);
// One that cannot load (ready false) fails at once; one that fails while it works fails its requests too.
made.length = 0;
fakes({ load: 5, bad: true });
assert.deepEqual(await W.askName(water, []).result, { done: false, why: "failed" });
fakes({ load: 5, takes: 50 });
const e1 = W.askName(water, []), e2 = W.askName(ethanol, []);
await sleep(20);
made.at(-1)!.fail();
assert.deepEqual(await e1.result, { done: false, why: "failed" });
assert.deepEqual(await e2.result, { done: false, why: "failed" });
// A new stand-in fails what the old one still had.
const left = W.askName(stuck, []);
fakes({ load: 5 });
assert.deepEqual(await left.result, { done: false, why: "failed" });
assert.equal(W.namingBusy(), false);
// Afterwards a new worker answers.
const o4 = await W.askMixtureName(mix, []).result;
assert.ok(o4.done && o4.answer === nameMixture(mix));
W.setNamingWorker(undefined);

console.log("namingworker.check: passed");
