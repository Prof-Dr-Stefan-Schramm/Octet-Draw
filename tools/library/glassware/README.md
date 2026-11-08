# Glassware drawings

The source of the library's **Glassware** group: 48 drawings of laboratory glassware, drawn for Octet with
Claude Code and contributed by Stefan Schramm under the repository's Apache-2.0 licence. They are our own
work. Nothing here comes from another program's clip art, templates or sample files.

`tools/library/glassware.mjs` reads them with `tools/library/svg.mjs` and `tools/library/build.mjs` writes
them into `src/library.json`. `src/glassware.check.ts` checks the result.

## What a drawing has to be

Plain SVG line art, so that Octet can hold it as its own pen curves:

- **Lines, not filled outlines.** Every part is a stroked `<path>` or `<ellipse>`. Octet draws each one at
  the document's line width, so a part whose line has been turned into a filled shape ("stroke to path",
  "outline stroke") has nothing left to draw with, and the build rejects it.
- **No text, no gradients, no clipping, no raster images.** One ink colour throughout.
- `<g>` may carry `translate`, `rotate`, `scale` and `matrix`; paths may use any of `M L H V C S Q T A Z`.
- **The line width says the scale.** Each drawing sits on its own page at whatever size suits it, so the
  only thing that says how big the piece really is, is the line it is drawn with: a piece shown larger is
  drawn with a finer line. The build scales every drawing by its own line weight, which is what puts a test
  tube, a flask and a Soxhlet extractor in proportion with each other on the shelf. So keep a drawing's
  line weight honest, and set it on the outermost `<g>`; a finer line inside it marks a finer part.
- **A fine part is left out of the icon.** Anything much smaller than the whole drawing (a stopcock handle,
  a graduation, a hose barb) is dropped from the 20 px icon by itself, so the silhouette is what shows.

## Adding or changing a drawing

1. Put the `.svg` in this folder, numbered and named like the others.
2. Add it to `PIECES` in `tools/library/glassware.mjs` with the name it shows under and the other words the
   library search should find it by. A drawing in this folder that is not in `PIECES` fails the build, so
   none goes missing.
3. `node tools/library/build.mjs`, then `node src/glassware.check.ts`.
