// Typing Greek and the other characters chemistry needs, without leaving the keyboard:
// "\delta" becomes δ, "\ddagger" becomes ‡, "\degree" becomes °. A name is replaced as soon
// as it is complete, so typing \delta then + gives δ+.
//
// The characters are real Unicode, never a letter in a Symbol font. ChemDraw's way is to
// switch the run to Symbol, where typing d draws δ — the file then holds a Latin d that
// only looks Greek, which is why a ChemDraw hv opens elsewhere as hn. Octet already refuses
// that on the way in (cdxml.ts: "Symbol is left out"), and this is the other half: a way to
// type the character that keeps the text searchable, copyable and right for a screen reader.
//
// LaTeX's spellings, because they are already muscle memory for the people Octet is for:
// \delta is δ and \Delta is Δ, by case, as in LaTeX.

// A name must be a word on its own: letters only, so "\alpha" ends where a non-letter starts.
const NAME = /\\([A-Za-z]+)/g;

export const ESCAPES: Record<string, string> = {
  // Greek, lower case.
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", zeta: "ζ", eta: "η",
  theta: "θ", iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ",
  pi: "π", rho: "ρ", sigma: "σ", tau: "τ", upsilon: "υ", phi: "φ", chi: "χ",
  psi: "ψ", omega: "ω",
  // Greek, upper case. LaTeX's rule: the capitalised name is the capital letter.
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ",
  Upsilon: "Υ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
  // The signs a scheme needs.
  degree: "°", deg: "°",
  pm: "±", mp: "∓", times: "×", cdot: "·",
  minus: "−", // U+2212, the real minus, not a hyphen
  ne: "≠", le: "≤", ge: "≥", approx: "≈", sim: "∼", propto: "∝", infty: "∞",
  // Arrows, for conditions text and schemes written as a line.
  to: "→", gets: "←", rightarrow: "→", leftarrow: "←", leftrightarrow: "↔",
  rightleftharpoons: "⇌", uparrow: "↑", downarrow: "↓",
  // Marks that sit on a species or a state.
  ddagger: "‡", dagger: "†", prime: "′", Prime: "″", bullet: "•",
  angstrom: "Å", micro: "µ", permil: "‰", ohm: "Ω",
  // Set and logic signs that turn up in mechanisms and kinetics.
  hbar: "ħ", partial: "∂", nabla: "∇", int: "∫", sum: "∑", sqrt: "√",
};

// The longest name, so a caller can tell how far back an unfinished escape may reach.
export const LONGEST = Object.keys(ESCAPES).reduce((n, k) => Math.max(n, k.length), 0);

export const isEscape = (name: string) => ESCAPES[name] !== undefined;

// Each replacement `text` asks for: where it starts, how many characters it eats, and what
// it becomes. The longest known name wins, so "\DeltaT" is Δ then T — a chemist types that,
// and LaTeX's own rule of needing "\Delta T" would be a trap here. An unknown name is left
// exactly as typed, so a Windows path or a stray backslash is never quietly changed.
function* found(text: string): Generator<{ at: number; eats: number; to: string }> {
  if (!text.includes("\\")) return;
  for (const m of text.matchAll(NAME)) {
    const letters = m[1];
    for (let n = letters.length; n > 0; n--) {
      const to = ESCAPES[letters.slice(0, n)];
      if (to !== undefined) { yield { at: m.index, eats: n + 1, to }; break; }
    }
  }
}

// `text` with every complete escape replaced.
export function expandEscapes(text: string): string {
  let out = "", from = 0;
  for (const r of found(text)) { out += text.slice(from, r.at) + r.to; from = r.at + r.eats; }
  return from ? out + text.slice(from) : text;
}

// Where the caret goes after `expandEscapes`, given where it was. A replacement that ends
// at or before the caret shortens the text in front of it; one the caret sits inside has
// not happened yet as far as the caret is concerned.
export function caretAfter(text: string, caret: number): number {
  let moved = caret;
  for (const r of found(text)) {
    if (r.at + r.eats > caret) break;
    moved -= r.eats - [...r.to].length;
  }
  return Math.max(0, moved);
}
