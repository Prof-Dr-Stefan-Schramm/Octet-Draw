// Run: node scripts/recognise-bench.ts [set folder ...] [--models <folder>] [--out <results.json>] [--check]
// Picture to structure's bench (decision 0023). Reads every picture of each test set (tests/recognise/* by default)
// with both models, the way the app reads it: each structure in the picture is found (recognise-find.ts), then read
// by MolScribe and by OCSRGlyph. Each answer is compared with the structure the set expects, by standard InChI
// ("exact", stereo included) and by the InChI without its stereo layers ("skeleton"). Prints a table per set and
// model. --check compares the numbers with tests/recognise/baseline.json and fails if one is lower.
// The models (molscribe.octmodel, glyph.octmodel) are not in the repository: tools/recognise/README.md makes them.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// chem.ts reads the drawing tokens and loads Indigo's wasm as a browser does; these stand in for the browser.
const g = globalThis as Record<string, unknown>;
g.document = { documentElement: {}, createElement: () => ({ getContext: () => ({}) }) };
g.getComputedStyle = () => ({ getPropertyValue: () => "10" });
g.window = globalThis;
g.self = { location: { origin: "file://" } };
const realFetch = globalThis.fetch;
g.fetch = async (u: URL | string) => (String(u).startsWith("file:") ? new Response(readFileSync(new URL(String(u))), { headers: { "content-type": "application/wasm" } }) : realFetch(u));
const { ready } = await import("../src/chem.ts");
const { decodePng, crop } = await import("../src/recognise-image.ts");
const { findScheme } = await import("../src/recognise-find.ts");
const { loadGlyph, loadMolScribe, loadText, readArrows, readGlyph, readMolScribe, readPack } = await import("../src/recognise-models.ts");
const { judge, inchiOf, skeleton } = await import("../src/recognise.ts");
await ready;

const args = process.argv.slice(2), flag = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const check = args.includes("--check") && !!args.splice(args.indexOf("--check"), 1);
const models = flag("--models") ?? process.env.OCTET_RECOGNISE_MODELS ?? join(homedir(), "octet-research/models"), out = flag("--out");
const root = new URL("../tests/recognise/", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const sets = args.length ? args : readdirSync(root).filter((d) => existsSync(join(root, d, "cases.json"))).map((d) => join(root, d));
const pack = (n: string) => join(models, `${n}.octmodel`);
if (!existsSync(pack("molscribe")) || !existsSync(pack("glyph"))) { console.log(`recognise-bench: no models in ${models}, nothing run`); process.exit(0); }
const ms = await loadMolScribe(readPack(new Uint8Array(readFileSync(pack("molscribe")))));
const gl = await loadGlyph(readPack(new Uint8Array(readFileSync(pack("glyph")))));
const tx = existsSync(pack("text")) ? await loadText(readPack(new Uint8Array(readFileSync(pack("text"))))) : undefined;

// smiles: the structure the picture shows (or, for a figure, each in reading order); inchi instead, for a local set
// made from drawings whose structures Octet read itself. score: false for R-group structures, which InChI cannot hold.
// arrows: a figure's reaction arrows with the lines of their conditions (arrowsNow: how many Octet finds today, when
// it cannot read them yet).
type Case = { file: string; kind: "structure" | "figure"; smiles?: string | string[]; inchi?: string; name?: string; score?: false; arrows?: { above: string[]; below: string[] }[]; arrowsNow?: number };
type Score = { n: number; exact: number; skeleton: number };
const tally: Record<string, Record<string, Score>> = {}, rows: unknown[] = [];
const add = (set: string, who: string, want: string | undefined, got: string | undefined) => {
  const s = ((tally[set] ??= {})[who] ??= { n: 0, exact: 0, skeleton: 0 });
  s.n++;
  if (want && got && want === got) s.exact++;
  if (want && got && skeleton(want) === skeleton(got)) s.skeleton++;
};
let seconds = 0, reads = 0;
for (const dir of sets) {
  const set = dir.replace(/[\\/]+$/, "").split(/[\\/]/).pop()!;
  const cases: Case[] = JSON.parse(readFileSync(join(dir, "cases.json"), "utf8"));
  for (const c of cases) {
    const px = await decodePng(new Uint8Array(readFileSync(join(dir, c.file))));
    const scheme = findScheme(px), found = scheme.structures;
    // Arrows: each figure whose arrows are all found counts; conditions: each line of text read exactly as printed.
    if (c.arrows && c.arrowsNow === undefined) {
      const as = ((tally[set] ??= {})["arrows"] ??= { n: 0, exact: 0, skeleton: 0 }), cs = (tally[set]["conditions"] ??= { n: 0, exact: 0, skeleton: 0 });
      as.n++; if (scheme.arrows.length === c.arrows.length) { as.exact++; as.skeleton++; }
      if (tx) {
        const got = (await readArrows(tx, px, scheme.arrows)).flatMap((a) => [...a.above, ...a.below]), want = c.arrows.flatMap((a) => [...a.above, ...a.below]);
        const missed: string[] = [];
        for (const line of want) { cs.n++; const k = got.indexOf(line); if (k >= 0) { cs.exact++; cs.skeleton++; got.splice(k, 1); } else missed.push(line); }
        rows.push({ set, file: c.file, conditions: { want, missed, extra: got } });
      }
    }
    if (c.score === false) { process.stdout.write("-"); continue; }
    const wants = c.inchi ? [c.inchi] : (Array.isArray(c.smiles) ? c.smiles : [c.smiles!]).map((s) => inchiOf(s));
    const t = performance.now();
    const read = [];
    for (const f of found) {
      const part = crop(px, f.box);
      read.push(judge(await readMolScribe(ms, part), await readGlyph(gl, part)));
    }
    seconds += (performance.now() - t) / 1000; reads += found.length;
    // Structures found: as many as the picture has. Each expected structure is matched with the reading in its
    // place (reading order); a picture of one structure must give exactly one.
    const fs = ((tally[set] ??= {})["found"] ??= { n: 0, exact: 0, skeleton: 0 });
    fs.n++; if (found.length === wants.length) { fs.exact++; fs.skeleton++; }
    wants.forEach((want, k) => {
      const r = found.length === wants.length ? read[k] : read.find((x) => x.molscribe.inchi === want || x.glyph.inchi === want) ?? read[k];
      add(set, "molscribe", want, r?.molscribe.inchi);
      add(set, "glyph", want, r?.glyph.inchi);
      add(set, "octet", want, r?.inchi);
      rows.push({ set, file: c.file, k, want, found: found.length, molscribe: r?.molscribe.inchi, glyph: r?.glyph.inchi, octet: r?.inchi, chosen: r?.chosen, agree: r?.agree, sure: r?.sure,
        ms: r && { text: r.molscribe.text, confidence: +r.molscribe.confidence.toFixed(3) }, gl: r && { smiles: r.glyph.smiles, confidence: +r.glyph.confidence.toFixed(3) } });
    });
    process.stdout.write(".");
  }
}
console.log(`\n${reads} structures read in ${seconds.toFixed(0)} s (${(seconds / Math.max(1, reads)).toFixed(1)} s each, both models)\n`);
const pct = (a: number, n: number) => (n ? `${((100 * a) / n).toFixed(0)}%`.padStart(5) : "    -");
console.log("set        reader      pictures/structures  exact  skeleton");
const now: Record<string, Record<string, number>> = {};
for (const [set, by] of Object.entries(tally))
  for (const [who, s] of Object.entries(by)) {
    console.log(`${set.padEnd(10)} ${who.padEnd(11)} ${String(s.n).padStart(6)}               ${pct(s.exact, s.n)}  ${who === "found" ? "" : pct(s.skeleton, s.n)}`);
    (now[set] ??= {})[`${who}.exact`] = Math.round((100 * s.exact) / s.n);
    if (who !== "found") now[set][`${who}.skeleton`] = Math.round((100 * s.skeleton) / s.n);
  }
if (out) writeFileSync(out, JSON.stringify({ tally, rows }, null, 1));
if (check) {
  const base: Record<string, Record<string, number>> = JSON.parse(readFileSync(join(root, "baseline.json"), "utf8"));
  const worse = Object.entries(base).flatMap(([set, m]) => Object.entries(m).filter(([k, v]) => now[set]?.[k] !== undefined && now[set][k] < v).map(([k, v]) => `${set} ${k}: ${now[set][k]}% < ${v}%`));
  for (const w of worse) console.error(`WORSE ${w}`);
  process.exit(worse.length ? 1 : 0);
}
