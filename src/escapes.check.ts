// Run: node src/escapes.check.ts. Fails loudly if typing \delta stops giving δ, if an
// unknown name is changed, or if the caret lands in the wrong place after a replacement
// (issue 25).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ESCAPES, LONGEST, caretAfter, expandEscapes, isEscape } from "./escapes.ts";

// The characters chemistry actually needs.
assert.equal(expandEscapes("\\delta+"), "δ+", "a name followed by a sign");
assert.equal(expandEscapes("h\\nu"), "hν", "the photon, which is what issue 21 is about");
assert.equal(expandEscapes("\\DeltaT = 25 \\degreeC"), "ΔT = 25 °C");
assert.equal(expandEscapes("\\Delta G\\ddagger"), "Δ G‡");
assert.equal(expandEscapes("\\lambda_max"), "λ_max", "the name ends at the underscore");
assert.equal(expandEscapes("A \\to B"), "A → B");
// The longest known name wins, so a name running straight into text is not a dead end.
assert.equal(expandEscapes("\\DeltaT"), "ΔT", "a chemist types this, and LaTeX would need \\Delta T");
assert.equal(expandEscapes("\\Delta T"), "Δ T", "and a space still works");
assert.equal(expandEscapes("\\degreeC"), "°C");
assert.equal(expandEscapes("\\alpha-D-glucose"), "α-D-glucose");

// LaTeX's case rule: the capitalised name is the capital letter.
assert.equal(expandEscapes("\\delta"), "δ");
assert.equal(expandEscapes("\\Delta"), "Δ");
assert.notEqual(ESCAPES.delta, ESCAPES.Delta, "case matters, as in LaTeX");

// A real minus, not a hyphen: it is a different character and chemists want the right one.
assert.equal(ESCAPES.minus, "\u2212");
assert.notEqual(ESCAPES.minus, "-");

// Nothing unknown is touched. A path or a stray backslash stays exactly as typed.
assert.equal(expandEscapes("\\unknownname"), "\\unknownname");
assert.equal(expandEscapes("C:\\Users\\temp"), "C:\\Users\\temp", "a Windows path is left alone");
assert.equal(expandEscapes("\\"), "\\");
assert.equal(expandEscapes("\\\\delta"), "\\δ", "the second backslash starts the name");
assert.equal(expandEscapes("no backslash here"), "no backslash here");

// Every value is a real character, and no name maps to a letter that only looks Greek.
for (const [name, ch] of Object.entries(ESCAPES)) {
  assert.ok(/^[A-Za-z]+$/.test(name), `${name} is letters only, so it ends at a non-letter`);
  assert.ok([...ch].length === 1, `${name} is one character, not ${[...ch].length}`);
  assert.ok(ch.codePointAt(0)! > 127, `${name} is not a plain ASCII letter wearing a costume`);
}
assert.ok(isEscape("delta") && !isEscape("deltaX"));
assert.equal(LONGEST, Object.keys(ESCAPES).reduce((n, k) => Math.max(n, k.length), 0));

// The caret: it keeps its place relative to the text around it.
assert.equal(caretAfter("\\delta+", 6), 1, "after the name, before the +");
assert.equal(caretAfter("\\delta+", 7), 2, "at the end");
assert.equal(caretAfter("h\\nu", 4), 2, "hν is two characters");
assert.equal(caretAfter("\\delta", 3), 3, "inside an escape, nothing has been replaced yet before it");
assert.equal(caretAfter("plain text", 5), 5, "no escape, no move");
assert.equal(caretAfter("\\unknown+", 9), 9, "an unknown name does not move the caret");

// The table holds what the chemistry this is for actually uses, so a rename cannot quietly
// drop one: these are the characters issue 21 and issue 25 name.
for (const [name, ch] of [["nu", "ν"], ["delta", "δ"], ["Delta", "Δ"], ["degree", "°"], ["ddagger", "‡"], ["angstrom", "Å"]] as const) {
  assert.equal(ESCAPES[name], ch, `\\${name} is ${ch}`);
}

// Octet keeps refusing the Symbol font, which is the whole reason this exists.
assert.match(readFileSync(new URL("cdxml.ts", import.meta.url), "utf8"),
  /Symbol is left out: ChemDraw writes Greek in it as Latin letters\./);

// Both places text is kept expand it: a caption (commitWriting) and an atom label.
const editor = readFileSync(new URL("Editor.tsx", import.meta.url), "utf8");
assert.match(editor, /import \{ expandEscapes \} from "\.\/escapes"/);
const writing = editor.slice(editor.indexOf("function commitWriting()"), editor.indexOf("\n  }", editor.indexOf("function commitWriting()")));
assert.match(writing, /\(w\.runs \?\? \[\{ text: w\.value \}\]\)\.map\(\(r\) => \(\{ \.\.\.r, text: expandEscapes\(r\.text\) \}\)\)/, "a caption expands as it is kept");
assert.match(writing, /const text = plainOf\(written\)\.replace\(\/\\s\+\$\/, ""\)/, "and its text comes from the expanded runs");
assert.match(editor, /trimLines\(\(editing\.runs \?\? \[\{ text: editing\.value \}\]\)\.map\(\(r\) => \(\{ \.\.\.r, text: expandEscapes\(r\.text\) \}\)\)\)/, "an atom label expands as it is kept");

console.log("escapes: ok");
