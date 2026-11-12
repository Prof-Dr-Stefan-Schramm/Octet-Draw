// Adapted from ReShiki (https://github.com/Ameyanagi/ReShiki), packages/editor/src/worker.js, MIT OR Apache-2.0, © 2026 Ameyanagi and ReShiki contributors.
// Structure to Name away from the page (namingworker.ts), so a structure that is slow to name never stops the window.
// It loads Indigo and the names engine (OPSIN, the dictionary), says { ready } once (ready false when they fail to
// load), then answers each request with namePart or nameMixture, the same code the window runs (namepart.ts).
import { ready } from "./chem.ts";
import { loadNames, setOwnNames, type OwnName } from "./names.ts";
import { nameMixture, namePart, type MixturePart } from "./namepart.ts";
import type { Mol } from "./render.ts";

export type NamingAsk = { own: OwnName[] } & ({ part: Mol } | { mixture: MixturePart[] });

const loading = Promise.all([ready, loadNames()]).then(() => true, () => false);
void loading.then((ok) => postMessage({ ready: ok }));

self.onmessage = async (e: MessageEvent<NamingAsk>) => {
  const ask = e.data;
  if (!(await loading)) return;
  // The user's own dictionary: it reads first when a name is read back, and gives its own abbreviation.
  setOwnNames(ask.own);
  let answer: unknown;
  try { answer = "part" in ask ? namePart(ask.part) : nameMixture(ask.mixture); } catch { answer = "part" in ask ? { mol: ask.part } : undefined; }
  postMessage({ answer });
};
