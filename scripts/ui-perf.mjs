// Budgets for the window: what an interaction costs in a real browser, with a real DOM.
// `src/perf.check.ts` measures the code the editor runs without the window, so it cannot see a slow render or a
// re-render storm — which is what a user means by "performance is terrible" (issue 37, a tool switch on a blank
// document). This measures the page itself: headless Chrome (the system's, or puppeteer's headless shell in
// ~/.cache/puppeteer), driven over the DevTools protocol, no dependencies. It serves the build itself, so there is
// no preview server to start.
//
//   node scripts/ui-perf.mjs                 build the page into a temporary folder, then measure it
//   node scripts/ui-perf.mjs <built-folder>  measure a folder `vite build` has already written
//
// What is measured is the work on the main thread: from the event to the DOM carrying the result, with style and
// layout forced before the clock stops. Not the time to the next frame — a frame is at least 16.7 ms whatever the
// page does, so the frame latency of a 2 ms interaction is the screen's, not Octet's. Both, measured on a Windows
// machine for a tool switch on an empty page:
//
//   full speed: 2.2 ms of work, 16.7 ms to the next frame    8x slower: 21.8 ms of work, 33.4 ms to the next frame
//
// The budgets are for a CPU SLOWER times slower than the one running the check (Chrome's own throttle, as
// scripts/canvas-a11y.mjs uses). On that machine the switch is about 8 ms at 4x, so 50 ms is about 6 times the
// measurement, and GitHub's machines are about 3 times slower than a laptop again (src/cleanup.check.ts).
//
// What this does not cover: the page runs in Chrome, in a browser, so it is Octet's own cost on the main thread and
// not the platform's web view (WebView2 on Windows, WebKitGTK on Linux) or Tauri's calls into Rust. A web view that
// is itself slow — the reading of issue 37 — shows up only in the real app, which scripts/drive/drive.mjs starts on
// Windows and Linux. Octet's own cost is what a budget can hold.
//
// A measurement that does not grow when the CPU is throttled is not measuring the page's work, and the run fails
// saying so rather than passing a number that means nothing. That is how this file was got right: the first version
// read 16.6 ms at every throttle, because it was timing the screen.
//
// That the budget catches what it is for was checked by breaking the page on purpose: about 12 ms of arithmetic added
// to the palette's own render reads 60.6 ms at 4x (14.0 ms at full speed) and fails.
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const SLOWER = 4; // Chrome's CPU throttle while the budgets are measured.
const RUNS = 30; // Interactions timed for each budget, after 6 to warm up.

// Each interaction: what it is (for a person reading the output), its budget in ms at SLOWER times slower, and the
// page script that does it. A script gets `press` (the thing to do) and must leave the DOM changed; `watch` names the
// element and attribute that change, so the measurement ends when the page really shows the result.
const OPS = [
  {
    what: "switch tool on an empty page (Select, Single bond)",
    budget: 50,
    watch: { of: "svg.canvas", attribute: "data-tool" },
    // The tools in the palette, in their own order: Select first, then the bond tool.
    setUp: "const tools = [...document.querySelectorAll('nav.palette button.tool[aria-pressed]')]; if (tools.length < 2) throw new Error('the palette has no tools');",
    press: "tools[i % 2 ? 1 : 0].click()",
    shows: "i % 2 ? 'bond' : 'select'",
  },
];

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".woff": "font/woff", ".png": "image/png", ".ico": "image/x-icon" };

// The page: a folder `vite build` wrote, built here when none is given.
let dir = process.argv[2];
if (!dir) {
  dir = mkdtempSync(join(tmpdir(), "octet-ui-perf-"));
  console.log(`building the page into ${dir}`);
  // Vite's own script, with this Node: no shell, and nothing to escape on Windows (where Node will not run a .cmd
  // without one).
  const vite = fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url));
  if (!existsSync(vite)) throw new Error("no vite in node_modules: run npm ci, or pass a folder vite build has written");
  const built = spawnSync(process.execPath, [vite, "build", "--outDir", dir, "--emptyOutDir"], { stdio: ["ignore", "ignore", "inherit"] });
  if (built.status !== 0) throw new Error("vite build failed");
}
if (!existsSync(join(dir, "index.html"))) throw new Error(`no index.html in ${dir}`);

// Octet is offline, so everything it asks for is in the folder; anything else is the page's own routing and gets
// index.html, as a static host would.
const server = createServer((req, res) => {
  const asked = decodeURIComponent(req.url.split("?")[0]);
  const file = join(dir, normalize(asked === "/" ? "/index.html" : asked));
  try {
    const body = readFileSync(existsSync(file) ? file : join(dir, "index.html"));
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "content-length": body.length });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const url = `http://127.0.0.1:${server.address().port}/?editor`;

// A browser to measure in: puppeteer's headless shell if this machine has one (as scripts/canvas-a11y.mjs uses),
// else the Chrome or Edge the machine already has. GitHub's Linux and Windows machines both have one.
function browser() {
  const cache = join(homedir(), ".cache/puppeteer/chrome-headless-shell");
  if (existsSync(cache)) {
    const build = readdirSync(cache).sort().pop();
    const inside = build && readdirSync(join(cache, build)).find((d) => d.startsWith("chrome-"));
    const shell = inside && join(cache, build, inside, process.platform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell");
    if (shell && existsSync(shell)) return shell;
  }
  const guesses = process.platform === "win32"
    ? ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"]
    : process.platform === "darwin"
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
      : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium-browser", "/usr/bin/chromium"];
  const found = guesses.find(existsSync);
  if (!found) throw new Error("no Chrome, Chromium or Edge on this machine, and no headless shell in ~/.cache/puppeteer");
  return found;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const port = 9600 + Math.floor(Math.random() * 300);
const chrome = spawn(browser(), ["--headless=new", `--remote-debugging-port=${port}`, "--window-size=1400,900", "--no-first-run", "--no-default-browser-check", "--disable-extensions", `--user-data-dir=${mkdtempSync(join(tmpdir(), "octet-ui-perf-profile-"))}`, "about:blank"], { stdio: "ignore" });
const stop = (code) => { chrome.kill(); server.close(); process.exit(code); };
// Anything that goes wrong from here on still closes the browser, so a failed run leaves nothing behind.
for (const end of ["unhandledRejection", "uncaughtException"]) process.on(end, (e) => { console.error(`ui-perf: ${e?.message ?? e}`); stop(1); });

let target;
for (let i = 0; i < 60 && !target; i++) {
  await sleep(250);
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page"); } catch { /* not up yet */ }
}
if (!target) { console.error("the browser never answered on its debugging port"); stop(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((open) => ws.addEventListener("open", open));
let id = 0;
// Each call gives up after two minutes, so a page that stops answering fails the run instead of holding it.
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const n = ++id;
  const timeout = setTimeout(() => reject(new Error(`the browser did not answer ${method}`)), 120_000);
  const on = (e) => {
    const m = JSON.parse(e.data);
    if (m.id !== n) return;
    clearTimeout(timeout);
    ws.removeEventListener("message", on);
    m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result);
  };
  ws.addEventListener("message", on);
  ws.send(JSON.stringify({ id: n, method, params }));
});
const run = async (code) => {
  const r = await call("Runtime.evaluate", { expression: `(async () => { ${code} })()`, awaitPromise: true, returnByValue: true });
  if (r?.exceptionDetails) throw new Error(`the page threw: ${(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails)).slice(0, 300)}`);
  return r?.result?.value;
};

// One budget's measurement, in the page. React does not finish a tool switch in the click's own task, so the clock
// runs until the DOM carries the result (a MutationObserver sees that whenever it happens) and then through a forced
// style and layout.
const measure = (op, runs) => `
  const canvas = document.querySelector(${JSON.stringify(op.watch.of)});
  if (!canvas) throw new Error(${JSON.stringify(`the page has no ${op.watch.of}`)});
  ${op.setUp}
  // The DOM must carry the result within 5 s, which is long even on a throttled CPU. Waiting for a change that never
  // comes (a button that has moved, say) says so, instead of holding the run until the browser call gives up.
  const changed = () => new Promise((shown, never) => {
    const seen = new MutationObserver(() => { clearTimeout(waited); seen.disconnect(); shown(); });
    const waited = setTimeout(() => { seen.disconnect(); never(new Error(${JSON.stringify(op.watch.of + " " + op.watch.attribute)} + " never changed: the interaction did nothing")); }, 5000);
    seen.observe(canvas, { attributes: true, attributeFilter: [${JSON.stringify(op.watch.attribute)}] });
  });
  const settle = () => new Promise((done) => setTimeout(done, 0));
  const read = () => canvas.getAttribute(${JSON.stringify(op.watch.attribute)});
  for (let i = 0; i < 6; i++) { ${op.press}; await settle(); }
  const times = [];
  for (let i = 0; i < ${runs}; i++) {
    const want = ${op.shows};
    const t0 = performance.now();
    const shows = changed();
    ${op.press};
    await shows;
    void document.body.offsetHeight;
    times.push(performance.now() - t0);
    await settle();
    if (read() !== want) throw new Error(${JSON.stringify(op.watch.of + " " + op.watch.attribute)} + " is " + read() + ", not " + want + ": the interaction did not happen");
  }
  return { times, nodes: document.querySelectorAll("*").length };`;

const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const worst = (a) => Math.max(...a);
const at = async (rate, op, runs = RUNS) => {
  await call("Emulation.setCPUThrottlingRate", { rate });
  await sleep(300);
  return run(measure(op, runs));
};

await call("Page.navigate", { url });
await run("for (let i = 0; i < 100 && !document.querySelector('nav.palette button.tool'); i++) await new Promise((r) => setTimeout(r, 100)); return true");
await sleep(500);

const slow = [];
for (const op of OPS) {
  // At full speed first: the throttled measurement must be the slower of the two, or the clock is not on the page's
  // own work (the mistake this file's header describes).
  const fast = await at(1, op, 10);
  // Another program on a busy computer can slow one measurement. Over budget, measure again (3 times at most) and
  // keep the best, as src/perf.check.ts does: an interaction that is really slow is slow every time.
  let r = await at(SLOWER, op), took = median(r.times);
  for (let k = 1; k < 3 && took > op.budget; k++) {
    const again = await at(SLOWER, op);
    if (median(again.times) < took) { r = again; took = median(again.times); }
  }
  const quick = median(fast.times);
  console.log(`ui-perf: ${op.what}`);
  console.log(`  ${took.toFixed(1)} ms on a CPU ${SLOWER} times slower (worst ${worst(r.times).toFixed(1)} ms, budget ${op.budget}), ${quick.toFixed(1)} ms at full speed, ${r.nodes} nodes on the page`);
  if (took < quick * 1.5) {
    console.error(`  FAIL: ${SLOWER} times less CPU made this ${(took / quick).toFixed(1)} times slower, so the clock is not on the page's work. Nothing is measured here.`);
    slow.push(op.what);
  } else if (took > op.budget) {
    console.error(`  FAIL: ${took.toFixed(1)} ms is over the ${op.budget} ms budget.`);
    slow.push(op.what);
  }
}
await call("Emulation.setCPUThrottlingRate", { rate: 1 });
console.log(slow.length ? `${slow.length} of ${OPS.length} over budget.` : `${OPS.length} of ${OPS.length} within budget.`);
stop(slow.length ? 1 : 0);
