// Run: node src/windowsmods.check.ts. Fails loudly if Ctrl stops being the selection
// modifier on Windows and Linux (issues 32 and 33).
//
// Ctrl means two things there, as it does in Explorer and in ChemDraw for Windows: on
// something not already chosen it adds it to the selection, as Shift does; on the selection
// it drags a copy, as Option does. What is under the press decides which, not the drag.
//
// On a Mac Ctrl is the right-click (onContextMenu), so it must not reach the press at all.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const editor = readFileSync(new URL("Editor.tsx", import.meta.url), "utf8");
const down = editor.slice(editor.indexOf("function onPointerDown("), editor.indexOf("function onPointerMove("));
assert.ok(down.length > 0, "found onPointerDown in Editor.tsx; update this check");

const at = down.indexOf('if (tool === "select") {');
assert.ok(at > 0, "found the Select press in onPointerDown; update this check");
const block = down.slice(at, down.indexOf("\n    }", at));

// Ctrl is read, and only off the Mac, where it belongs to the context menu.
assert.match(block, /const ctrl = !MAC && e\.ctrlKey/, "Ctrl counts only off the Mac");
// What is under the press decides which of Ctrl's two meanings applies.
assert.match(block, /const onChosen = ctrl &&/, "the press decides, not the drag");
// Off the selection it adds, as Shift does. On the selection it copies, as Option does.
assert.match(block, /const shift = e\.shiftKey \|\| \(ctrl && !onChosen\)/, "Ctrl off the selection adds to it");
assert.match(block, /copy = e\.altKey \|\| onChosen/, "Ctrl on the selection drags a copy");
// Shift and Option keep working on their own, on every platform.
assert.ok(/e\.shiftKey \|\|/.test(block) && /e\.altKey \|\|/.test(block), "Shift and Option still work");
// Both reach the press, and pressMods keeps what was held for the rest of the drag.
assert.match(block, /pressMods\.current = \{ shift, alt: copy, atoms: selection, picks: picked \}/);
assert.match(block, /return pressSelect\(p, t, shift, screen, copy\)/);

// The copy itself is Option-drag's, untouched: startMove makes the copies at the press and
// keeps them only if the pointer moves, so a Ctrl-click that does not move changes nothing.
assert.match(editor, /\/\/ Option-drag moves copies, made now and kept only if the pointer moves\./);

// The Mac's Ctrl-click still goes to the context menu before any of this.
assert.ok(down.indexOf("if (MAC && e.ctrlKey)") < at, "the Mac's Ctrl-click is handled before the Select press");

console.log("windowsmods: ok");
