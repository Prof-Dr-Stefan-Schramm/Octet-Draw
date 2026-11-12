// Adapted from ReShiki (https://github.com/Ameyanagi/ReShiki), src/naming/browser.rs, MIT OR Apache-2.0, © 2026 Ameyanagi and ReShiki contributors.
// Structure to Name in a worker (naming.worker.ts) that Octet can stop, so a structure that is slow to name never
// stops the window. One worker, started when first needed, does one request at a time; Structure to Name's requests go
// before the screen reader's background ones. The worker has NAMING.load ms to load the names engine, then
// NAMING.deadline ms for each request. A request past its time, a request stopped while it runs, and a worker that
// fails end the worker; the next request starts a new one (which loads again). Without Worker (the Node checks) each
// request runs at once in place, with the same code (namepart.ts), so both give the same names.
import type { OwnName } from "./names.ts";
import { nameMixture, namePart, type MixturePart, type NamedPart } from "./namepart.ts";
import type { NamingAsk } from "./naming.worker.ts";
import type { Mol } from "./render.ts";

// ReShiki's limits (browser.rs DEADLINE, LOAD_DEADLINE). A check may set shorter ones.
export const NAMING = { load: 60_000, deadline: 15_000 };

// A request's end: its answer, or why there is none. late: past its time; stopped: cancelled; failed: the worker
// failed or did not load.
export type Outcome<T> = { done: true; answer: T } | { done: false; why: "late" | "stopped" | "failed" };
export type Request<T> = { result: Promise<Outcome<T>>; cancel: () => void };

// What the client needs of a Worker, so a check can give it a stand-in (setNamingWorker).
export type WorkerLike = { postMessage(message: unknown): void; terminate(): void; onmessage: ((e: MessageEvent) => void) | null; onerror: ((e: ErrorEvent) => void) | null };
let make: (() => WorkerLike) | undefined = typeof Worker === "undefined" ? undefined : () => new Worker(new URL("./naming.worker.ts", import.meta.url), { type: "module" });
// For the checks: the worker to start (undefined: run in place). Requests running or waiting fail.
export function setNamingWorker(f: (() => WorkerLike) | undefined) { broken(); make = f; }

type Job = { ask: NamingAsk; background: boolean; done: (o: Outcome<unknown>) => void };
const queue: Job[] = [];
let worker: WorkerLike | undefined, loaded = false, running: Job | undefined, timer: ReturnType<typeof setTimeout> | undefined;

// Whether a request is running or waiting.
export const namingBusy = () => !!running || queue.length > 0;

// A structure's checked name (namepart.ts namePart). own: the user's own dictionary, as the window has it.
export const askName = (part: Mol, own: OwnName[], background = false): Request<NamedPart> => ask({ own, part }, background, () => namePart(part));
// A grouped mixture's name (namepart.ts nameMixture).
export const askMixtureName = (mixture: MixturePart[], own: OwnName[]): Request<string | undefined> => ask({ own, mixture }, false, () => nameMixture(mixture));

function ask<T>(request: NamingAsk, background: boolean, here: () => T): Request<T> {
  if (!make) {
    let answer: Outcome<T>;
    try { answer = { done: true, answer: here() }; } catch { answer = { done: false, why: "failed" }; }
    return { result: Promise.resolve(answer), cancel: () => {} };
  }
  let job!: Job;
  const result = new Promise<Outcome<T>>((done) => { job = { ask: request, background, done: done as Job["done"] }; });
  const at = background ? -1 : queue.findIndex((j) => j.background);
  queue.splice(at < 0 ? queue.length : at, 0, job);
  next();
  const cancel = () => {
    const k = queue.indexOf(job);
    if (k >= 0) { queue.splice(k, 1); job.done({ done: false, why: "stopped" }); }
    else if (running === job) { stop(); finish({ done: false, why: "stopped" }); }
  };
  return { result, cancel };
}

// Ends the worker (ReShiki's Drop for Request): the next request starts another.
function stop() {
  clearTimeout(timer);
  if (worker) { worker.onmessage = worker.onerror = null; worker.terminate(); }
  worker = undefined;
  loaded = false;
}
function finish(o: Outcome<unknown>) {
  const job = running;
  running = undefined;
  clearTimeout(timer);
  job?.done(o);
  next();
}
// The worker failed or did not load: every request waiting fails too, so none waits for another load in vain.
function broken() {
  stop();
  const waiting = queue.splice(0);
  finish({ done: false, why: "failed" });
  for (const j of waiting) j.done({ done: false, why: "failed" });
}
const late = () => { stop(); finish({ done: false, why: "late" }); };
function next() {
  if (running || !queue.length) return;
  running = queue.shift()!;
  if (!worker) start();
  else timer = setTimeout(late, NAMING.deadline);
  worker!.postMessage(running.ask);
}
function start() {
  const w = make!();
  worker = w;
  loaded = false;
  timer = setTimeout(broken, NAMING.load);
  w.onmessage = (e: MessageEvent) => {
    const data = e.data as { ready: boolean } | { answer: unknown };
    if ("ready" in data) {
      if (!data.ready) return broken();
      // Loaded: the request now has its own time.
      loaded = true;
      clearTimeout(timer);
      if (running) timer = setTimeout(late, NAMING.deadline);
      return;
    }
    if (running && loaded) finish({ done: true, answer: data.answer });
  };
  w.onerror = () => broken();
}
