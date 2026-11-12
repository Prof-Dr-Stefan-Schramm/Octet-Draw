// Adapted from ReShiki (https://github.com/Ameyanagi/ReShiki), src/app/pictures.rs (Ticket, picture_loaded), MIT OR
// Apache-2.0, © 2026 Ameyanagi and ReShiki contributors.
// Run: node src/insertpicture.check.ts. Fails loudly if File > Insert Picture… (issue 72) is lost, if it makes anything
// other than the picture object a dropped or pasted picture makes, if the page can name the file Rust reads, or if a
// picture ready after the drawing changed still goes in (ReShiki's stale-result rule).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import { toCdxml, fromCdxml } from "./cdxml.ts";
import { hex } from "./cdx.ts";
import { DEFAULT_STYLE } from "./docstyle.ts";
import { EMPTY, insertMol } from "./edit.ts";
import { readOct, writeOct } from "./oct.ts";
import { CHANGED, kindOf, pictureFate, pictureMol } from "./picture.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const editor = read("Editor.tsx"), main = read("../src-tauri/src/main.rs"), open = read("../src-tauri/src/open.rs");

// The menu item, in the File menu under Import a Structure…, and its command in the page and in the command palette.
assert.match(main, /&item\("import", "Import a Structure…", ""\)\?,\n\s+&item\("insert_picture", "Insert Picture…", ""\)\?,/);
assert.match(editor, /insert_picture: \(\) => void insertPicture\(\),/);
assert.match(editor, /insert_picture: \["Insert picture…", "", <FileImage size=\{18\} \/>\]/);

// Rust: the picker takes no path from the page, offers the picture types a drop takes, and reads with a drop's limit
// (64 MB) and its error. The command is registered.
assert.match(main, /async fn pick_picture\(app: AppHandle\) -> Result<Option<\(String, String\)>, String> \{/);
assert.match(main, /add_filter\("Pictures", &open::PICTURES\)\.blocking_pick_file\(\)/);
assert.match(main, /let bytes = open::picture\(&path, &name\)\?;/);
assert.match(main, /generate_handler!\[[^\]]*\bpick_picture\b/);
assert.match(open, /pub\(crate\) fn picture\(path: &Path, name: &str\) -> Result<Vec<u8>, String> \{\n\s+match fs::metadata\(path\) \{[\s\S]{0,200}m\.len\(\) > MAX_BYTES/);

// The page: the bytes go through pictureDrawing (readPicture: type by content, size and pixel limits, the drawing's
// 12 MB of pictures), then in at the window's centre, selected, as one step to undo. Never as markup.
const body = editor.slice(editor.indexOf("async function insertPicture()"), editor.indexOf("// A drawing read from a file, into the editor."));
assert.match(body, /await pictureDrawing\(picked\[1\], style\.bond, MAX_PICTURE - pictureBytes\(asked\), `Octet cannot insert \$\{picked\[0\]\}\.`\)/);
assert.match(body, /pictureFate\(asked, now\.current, homeOpen\.current\)/);
assert.match(body, /insertMol\(asked, m, toDoc\(innerWidth \/ 2, innerHeight \/ 2\)\);\n\s+set\(r\.mol, true\);/);
assert.match(body, /f\.size > 64 << 20/, "the browser's file is not read past 64 MB");
assert.doesNotMatch(body, /innerHTML|dangerouslySetInnerHTML|eval\(/);

// Stale results (ReShiki's ticket): the picture goes in only to the drawing as it was asked for. An edit, or another
// drawing in its place, drops it with a notice; Home showing drops it without one.
const asked = { ...EMPTY, style: DEFAULT_STYLE };
assert.equal(pictureFate(asked, asked, false), "insert");
assert.equal(pictureFate(asked, { ...asked }, false), "changed");
assert.equal(pictureFate(asked, asked, true), "away");
assert.match(CHANGED, /^The drawing changed while Octet read the picture\. Choose Insert Picture again\.$/);

// A real 2 by 2 pixel PNG, made here: recognised by its bytes, and inserted as Octet's own picture object (the one
// a drop, a paste and ChemDraw's <embeddedobject> give) at 1 pt per pixel. It stays through .oct and CDXML.
const chunk = (type: string, data: Uint8Array) => {
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]), len = Buffer.alloc(4), crc = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(2, 0);
ihdr.writeUInt32BE(2, 4);
ihdr.set([8, 2, 0, 0, 0], 8); // 8 bits, RGB
const rows = Buffer.from([0, 255, 0, 0, 0, 0, 255, 0, 0, 255, 0, 255, 255, 255]); // each row: filter 0, two pixels
const png = new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", new Uint8Array())]));
assert.equal(kindOf(png), "png");
const style = DEFAULT_STYLE, drawn = insertMol(asked, pictureMol({ PNG: hex(png) }, 2, 2, style.bond), [0, 0]).mol;
const sh = drawn.shapes!.find((x) => x.kind === "picture")!;
assert.deepEqual([(sh.to[0] - sh.from[0]) * style.bond, (sh.to[1] - sh.from[1]) * style.bond], [2, 2]);
for (const back of [readOct(writeOct(drawn, style)).mol, fromCdxml(toCdxml(drawn, style)).mol]) {
  assert.deepEqual(back.shapes!.find((x) => x.kind === "picture")!.picture, { PNG: hex(png) });
}
assert.match(toCdxml(drawn, style), /<embeddedobject\s[^>]*PNG="89504E47/);

console.log("insertpicture.check: menu item and picker, same checks as a drop, stale pictures dropped, 2 by 2 PNG kept ok");
