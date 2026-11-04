// Run: node src/drive.check.ts. The CI drive (scripts/drive/drive.mjs), as its dry run prints it: Home and each drawing
// have a window of their own, so the drive moves WebDriver to the drawing's window before it looks in the drawing.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const drive = fileURLToPath(new URL("../scripts/drive/drive.mjs", import.meta.url));
const cwd = mkdtempSync(path.join(tmpdir(), "drive-")); // the dry run writes drive-out/ here
let out: string;
try { out = execFileSync(process.execPath, [drive, "--dry"], { cwd }).toString(); } finally { rmSync(cwd, { recursive: true, force: true }); }

// Each step's lines, by the start of its name.
const steps = out.split(/^(?=\d+\. )/m);
const step = (name: string) => {
  const s = steps.find((t) => t.replace(/^\d+\. /, "").startsWith(name));
  assert.ok(s, `no step ${name}`);
  return s.split("\n").map((l) => l.trim());
};
const at = (lines: string[], line: string) => {
  const k = lines.indexOf(line);
  assert.ok(k >= 0, `no "${line}" in:\n${lines.join("\n")}`);
  return k;
};
const SWITCH = "WebDriver: POST /session/SESSION/window", NEW = "wait for a new window", FRONT = "wait for the new window in front, named Untitled";

// Quick start: a new window, in front, and WebDriver moves to it before it waits for the drawing.
const quick = step("Home's Quick start");
assert.ok(at(quick, "WebDriver: GET /session/SESSION/window/handles") < at(quick, NEW));
assert.ok(at(quick, NEW) < at(quick, FRONT) && at(quick, FRONT) < at(quick, SWITCH) && at(quick, SWITCH) < at(quick, "wait for the drawing"));
// The command that reads the window in front runs before the wait for its name.
const front = quick.findIndex((l) => /^\$ (powershell.*windows\.ps1.* front|python3 .*linux-menu\.py PID)$/.test(l));
assert.ok(front > at(quick, NEW) && front < at(quick, FRONT), `no front command in:\n${quick.join("\n")}`);
// File > New: another window, the first drawing keeps its two ethanol, and the new one has none.
const fresh = step("File > New");
assert.ok(at(fresh, FRONT) < at(fresh, "wait for 2 ethanol in the drawing") && at(fresh, "wait for 2 ethanol in the drawing") < at(fresh, SWITCH));
assert.ok(at(fresh, SWITCH) < at(fresh, "wait for 0 ethanol in the drawing"));
// File > Exit: the first drawing asks, so WebDriver moves back to it for Don't Save.
const exit = step("File > Exit");
assert.ok(at(exit, SWITCH) < at(exit, "wait for the question") && at(exit, "wait for the question") < at(exit, "wait for Octet to end"));
// Keys go to the window in front: nothing moves the focus to the first window the process has, which can be Home.
assert.ok(!/windowfocus|xdotool search/.test(out));
console.log("drive checks pass");
