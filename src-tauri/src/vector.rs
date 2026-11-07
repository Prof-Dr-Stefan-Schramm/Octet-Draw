// Export as EPS and EMF (Windows Enhanced Metafile, the picture Windows Office uses), from the same SVG as the PDF
// (export.rs). Both are vector: every shape is a path, filled or stroked in one colour. The EPS draws text as its glyph
// outlines (usvg's flattened text), so it needs no fonts. The EMF writes text as text in a font every Windows has, at
// usvg's glyph positions, and outlines only the text it cannot (pick_runs). Neither format has transparency: a colour drawn at
// part opacity is blended with white, as it shows on white paper, and a gradient (a shaded shape) takes the mean of its
// stops' colours. A picture in the drawing (an image it holds) goes in as pixels, on white, in the same place and at
// the same size as in the PDF.

use svg2pdf::usvg::{self, tiny_skia_path::{PathSegment, Point, Transform}, Node, Paint};

// One shape: its outline in pt (y down, from the picture's top left), as subpaths of MoveTo, LineTo and cubic CurveTo
// segments, and how it is painted.
enum Seg {
    Move(f32, f32),
    Line(f32, f32),
    Curve(f32, f32, f32, f32, f32, f32),
    Close,
}
struct Stroke {
    rgb: [u8; 3],
    width: f32,       // pt
    cap: u8,          // 0 butt, 1 round, 2 square
    join: u8,         // 0 miter, 1 round, 2 bevel
    dash: Vec<f32>,   // pt
}
struct Shape {
    segs: Vec<Seg>,
    fill: Option<([u8; 3], bool)>, // colour, even-odd
    stroke: Option<Stroke>,
}
// A picture: its pixels as RGB rows from the top, on white, and where its pixel grid goes (pixel x, y to pt).
struct Picture {
    width: u32,
    height: u32,
    rgb: Vec<u8>,
    place: Transform,
}
// A run of text as GDI draws it: one font, one baseline, one colour. Each character's origin is usvg's, so GDI's
// advances (EXTTEXTOUTW's dx) put every glyph where the PDF has it.
struct Run {
    face: &'static str, // a font every Windows has (windows_font)
    size: f32,          // em, pt
    weight: u16,
    italic: bool,
    rgb: [u8; 3],
    y: f32,          // baseline, pt
    chars: Vec<u16>, // UTF-16, one glyph each
    xs: Vec<f32>,    // each character's origin, pt
    end: f32,        // where the last character's advance ends, pt
}
// What the drawing paints, in order.
enum Mark {
    Shape(Shape),
    Picture(Picture),
    Text(Run),
}

// A paint's colour on white paper at `opacity` (0 to 1).
fn colour(p: &Paint, opacity: f32) -> [u8; 3] {
    let (c, a) = match p {
        Paint::Color(c) => ([c.red, c.green, c.blue].map(f32::from), opacity),
        Paint::LinearGradient(g) => mean(g.stops(), opacity),
        Paint::RadialGradient(g) => mean(g.stops(), opacity),
        Paint::Pattern(_) => ([0.0; 3], opacity),
    };
    c.map(|v| (v * a + 255.0 * (1.0 - a)).round().clamp(0.0, 255.0) as u8)
}
fn mean(stops: &[usvg::Stop], opacity: f32) -> ([f32; 3], f32) {
    if stops.is_empty() {
        return ([0.0; 3], opacity);
    }
    let n = stops.len() as f32;
    let sum = stops.iter().fold([0.0f32; 4], |s, x| {
        let c = x.color();
        [s[0] + f32::from(c.red), s[1] + f32::from(c.green), s[2] + f32::from(c.blue), s[3] + x.opacity().get()]
    });
    ([sum[0] / n, sum[1] / n, sum[2] / n], opacity * sum[3] / n)
}

// Every visible path and picture in the tree, in drawing order, in pt. usvg measures in CSS px (96 to the inch); pt
// are 72. With `text` (the EMF), text goes in as runs where it can; otherwise all of it as glyph outlines.
fn marks(tree: &usvg::Tree, text: bool) -> Vec<Mark> {
    let mut out = Vec::new();
    walk(tree.root(), 1.0, Transform::identity(), text.then(|| tree.fontdb().as_ref()), &mut out);
    out
}
// `base`: what takes the group's own frame to the page. A text's flattened glyphs carry transforms from the text, not
// from the page, so they get the text's (issue 16: the labels fell outside the picture in Word on Windows).
fn walk(g: &usvg::Group, opacity: f32, base: Transform, text: Option<&usvg::fontdb::Database>, out: &mut Vec<Mark>) {
    for node in g.children() {
        match node {
            Node::Group(c) => walk(c, opacity * c.opacity().get(), base, text, out),
            Node::Text(t) => match text.and_then(|db| pick_runs(t, db, base, opacity)) {
                Some(runs) => {
                    for r in runs {
                        // A label Octet draws a letter at a time (the O, then the H before it, of HO) is one string, as
                        // ChemDraw writes it: a run that ends where the last one starts, or starts where it ends.
                        match out.pop() {
                            Some(Mark::Text(p)) if abut(&p, &r) => out.push(Mark::Text(join(p, r))),
                            last => out.extend(last.into_iter().chain([Mark::Text(r)])),
                        }
                    }
                }
                None => walk(t.flattened(), opacity, base.pre_concat(t.abs_transform()), None, out),
            },
            Node::Image(img) if img.is_visible() => out.extend(picture(node, img, opacity).map(Mark::Picture)),
            Node::Image(_) => {}
            Node::Path(p) if p.is_visible() => {
                let t = base.pre_concat(p.abs_transform()).post_scale(0.75, 0.75);
                let at = |q: Point| {
                    let mut q = q;
                    t.map_point(&mut q);
                    (q.x, q.y)
                };
                let mut segs = Vec::new();
                let mut last = Point::zero();
                for s in p.data().segments() {
                    match s {
                        PathSegment::MoveTo(a) => { last = a; let (x, y) = at(a); segs.push(Seg::Move(x, y)); }
                        PathSegment::LineTo(a) => { last = a; let (x, y) = at(a); segs.push(Seg::Line(x, y)); }
                        PathSegment::QuadTo(c, a) => {
                            // A quadratic as the cubic it equals.
                            let c1 = Point::from_xy(last.x + 2.0 / 3.0 * (c.x - last.x), last.y + 2.0 / 3.0 * (c.y - last.y));
                            let c2 = Point::from_xy(a.x + 2.0 / 3.0 * (c.x - a.x), a.y + 2.0 / 3.0 * (c.y - a.y));
                            last = a;
                            let ((x1, y1), (x2, y2), (x, y)) = (at(c1), at(c2), at(a));
                            segs.push(Seg::Curve(x1, y1, x2, y2, x, y));
                        }
                        PathSegment::CubicTo(c1, c2, a) => {
                            last = a;
                            let ((x1, y1), (x2, y2), (x, y)) = (at(c1), at(c2), at(a));
                            segs.push(Seg::Curve(x1, y1, x2, y2, x, y));
                        }
                        PathSegment::Close => segs.push(Seg::Close),
                    }
                }
                let k = scale(&t);
                let fill = p.fill().map(|f| (colour(f.paint(), opacity * f.opacity().get()), f.rule() == usvg::FillRule::EvenOdd));
                let stroke = p.stroke().map(|s| Stroke {
                    rgb: colour(s.paint(), opacity * s.opacity().get()),
                    width: s.width().get() * k,
                    cap: match s.linecap() { usvg::LineCap::Butt => 0, usvg::LineCap::Round => 1, usvg::LineCap::Square => 2 },
                    join: match s.linejoin() { usvg::LineJoin::Round => 1, usvg::LineJoin::Bevel => 2, _ => 0 },
                    dash: s.dasharray().map(|d| d.iter().map(|v| v * k).collect()).unwrap_or_default(),
                });
                out.push(Mark::Shape(Shape { segs, fill, stroke }));
            }
            Node::Path(_) => {}
        }
    }
}

// Whether two runs are one string: the same font, colour and baseline, one's advances ending where the other starts.
fn abut(a: &Run, b: &Run) -> bool {
    (a.face, a.size, a.weight, a.italic, a.rgb) == (b.face, b.size, b.weight, b.italic, b.rgb)
        && (a.y - b.y).abs() < 0.005
        && ((b.xs[0] - a.end).abs() < 0.05 || (a.xs[0] - b.end).abs() < 0.05)
}
fn join(a: Run, b: Run) -> Run {
    let (mut left, right) = if a.xs[0] <= b.xs[0] { (a, b) } else { (b, a) };
    left.chars.extend(right.chars);
    left.xs.extend(right.xs);
    left.end = right.end;
    left
}

// The Windows font for a face usvg drew with: one every Windows 10 and 11 has, or the one with the same widths that
// a Mac or Linux face stands in for. None for any other face: its text goes in as outlines, as Word would otherwise
// draw it in a font of its own choosing.
fn windows_font(family: &str) -> Option<&'static str> {
    const SAME: [&str; 19] = ["Arial", "Arial Black", "Calibri", "Cambria", "Candara", "Comic Sans MS", "Consolas", "Constantia", "Corbel",
        "Courier New", "Georgia", "Impact", "Lucida Console", "Palatino Linotype", "Segoe UI", "Tahoma", "Times New Roman", "Trebuchet MS", "Verdana"];
    const LIKE: [(&str, &str); 9] = [("Helvetica", "Arial"), ("Liberation Sans", "Arial"), ("Arimo", "Arial"), ("Times", "Times New Roman"),
        ("Liberation Serif", "Times New Roman"), ("Tinos", "Times New Roman"), ("Courier", "Courier New"), ("Liberation Mono", "Courier New"), ("Cousine", "Courier New")];
    SAME.into_iter().find(|f| f.eq_ignore_ascii_case(family)).or_else(|| LIKE.into_iter().find(|(f, _)| f.eq_ignore_ascii_case(family)).map(|(_, w)| w))
}

// A text as runs GDI can draw (issue 20: ChemDraw's EMF has its labels as text, so Word and PowerPoint can search
// them). None, so the text goes in as outlines, if any glyph is turned, slanted or mirrored, has a stroke or a
// decoration, is in a face windows_font has no font for, stands for anything but one character of the Basic
// Multilingual Plane, is a missing glyph, or runs right to left.
fn pick_runs(t: &usvg::Text, db: &usvg::fontdb::Database, base: Transform, opacity: f32) -> Option<Vec<Run>> {
    let to = base.pre_concat(t.abs_transform()).post_scale(0.75, 0.75);
    let upright = |m: &Transform| m.kx.abs() <= 1e-4 * m.sx && m.ky.abs() <= 1e-4 * m.sx && m.sx > 0.0 && (m.sy - m.sx).abs() <= 1e-4 * m.sx;
    if !upright(&to) {
        return None;
    }
    let mut runs: Vec<Run> = Vec::new();
    for span in t.layouted() {
        if span.stroke.is_some() || span.underline.is_some() || span.overline.is_some() || span.line_through.is_some() {
            return None;
        }
        let Some(fill) = span.fill.as_ref().filter(|_| span.visible) else { continue };
        let rgb = colour(fill.paint(), opacity * fill.opacity().get());
        let size = span.font_size.get() * to.sx;
        for g in &span.positioned_glyphs {
            let m = to.pre_concat(g.transform());
            let mut chars = g.text.chars();
            let (Some(c), None) = (chars.next(), chars.next()) else { return None };
            if !upright(&m) || g.id.0 == 0 || c.is_control() || u32::from(c) > 0xFFFF {
                return None;
            }
            let face = db.face(g.font)?;
            let (font, weight, italic) = (windows_font(&face.families.first()?.0)?, face.weight.0, face.style != usvg::fontdb::Style::Normal);
            let (x, y) = (m.tx, m.ty);
            match runs.last_mut() {
                Some(r) if r.face == font && r.size == size && r.weight == weight && r.italic == italic && r.rgb == rgb && (r.y - y).abs() < 0.005 => {
                    if x < *r.xs.last()? {
                        return None;
                    }
                    r.xs.push(x);
                    r.chars.push(u32::from(c) as u16);
                }
                _ => runs.push(Run { face: font, size, weight, italic, rgb, y, chars: vec![u32::from(c) as u16], xs: vec![x], end: x }),
            }
        }
    }
    // Where each run's last advance ends: where the next run starts, if that is further right (a subscript after its
    // letter), or else the right of the text's box, which usvg makes from the advances. GDI only moves its pen by it.
    let right = to.sx * t.bounding_box().right() + to.tx;
    let starts: Vec<f32> = runs.iter().skip(1).map(|r| r.xs[0]).chain([right]).collect();
    for (r, next) in runs.iter_mut().zip(starts) {
        let last = *r.xs.last()?;
        r.end = if next > last { next } else if right > last { right } else { last + r.size / 2.0 };
    }
    Some(runs)
}

// A picture's pixels: its own (a PNG's, a JPEG's), but no more than 300 dpi of the size it is drawn at and 16 million
// in all, drawn on white at its opacity. None if it has no size or cannot be drawn.
fn picture(node: &Node, img: &usvg::Image, opacity: f32) -> Option<Picture> {
    let to_pt = img.abs_transform().post_scale(0.75, 0.75);
    let (w, h) = (img.size().width(), img.size().height());
    // Its drawn size in pt along each of its sides.
    let (dw, dh) = (w * to_pt.sx.hypot(to_pt.ky), h * to_pt.kx.hypot(to_pt.sy));
    let (pw, ph) = (w.min(dw * 300.0 / 72.0), h.min(dh * 300.0 / 72.0));
    let k = (16e6 / (pw * ph)).sqrt().min(1.0);
    let (pw, ph) = ((pw * k).round().max(1.0), (ph * k).round().max(1.0));
    let mut pixmap = resvg::tiny_skia::Pixmap::new(pw as u32, ph as u32)?;
    // resvg draws an image node in its own units (0 to its size), after taking its box's corner to the origin.
    let bbox = node.abs_layer_bounding_box()?;
    resvg::render_node(node, Transform::from_scale(pw / w, ph / h).pre_translate(bbox.x(), bbox.y()), &mut pixmap.as_mut())?;
    // Premultiplied colour on white: each channel at the opacity, plus the white the picture leaves.
    let rgb = pixmap.pixels().iter().flat_map(|p| {
        let white = 255.0 - f32::from(p.alpha()) * opacity;
        [p.red(), p.green(), p.blue()].map(|c| (f32::from(c) * opacity + white).round().clamp(0.0, 255.0) as u8)
    }).collect();
    Some(Picture { width: pw as u32, height: ph as u32, rgb, place: to_pt.pre_scale(w / pw, h / ph) })
}
// How much a transform scales lengths (the square root of its area scale).
fn scale(t: &Transform) -> f32 {
    (t.sx * t.sy - t.kx * t.ky).abs().sqrt()
}

// The picture's size in pt.
fn size(tree: &usvg::Tree) -> (f32, f32) {
    (tree.size().width() * 0.75, tree.size().height() * 0.75)
}

// ---- EPS ----

// An EPS file (PostScript level 2, EPSF 3.0) of the SVG at true size, its bounding box the picture's.
pub fn make_eps(tree: &usvg::Tree) -> Vec<u8> {
    let (w, h) = size(tree);
    let n = |v: f32| format!("{}", (v * 1000.0).round() / 1000.0);
    let mut s = format!(
        "%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 {} {}\n%%HiResBoundingBox: 0 0 {} {}\n%%Creator: Octet\n%%LanguageLevel: 2\n%%Pages: 1\n%%EndComments\n%%BeginProlog\n%%EndProlog\n%%Page: 1 1\ngsave\n0 {} translate 1 -1 scale\n",
        w.ceil(), h.ceil(), n(w), n(h), n(h)
    );
    for mark in marks(tree, false) {
        let sh = match mark {
            Mark::Shape(sh) => sh,
            Mark::Text(_) => continue,
            Mark::Picture(p) => {
                // The pixel grid placed in pt, then the pixels in hex, 64 to a line.
                let t = p.place;
                s += &format!(
                    "gsave\n[{} {} {} {} {} {}] concat\n/DeviceRGB setcolorspace\n<< /ImageType 1 /Width {} /Height {} /BitsPerComponent 8 /Decode [0 1 0 1 0 1] /ImageMatrix [1 0 0 1 0 0] /DataSource currentfile /ASCIIHexDecode filter >> image\n",
                    n(t.sx), n(t.ky), n(t.kx), n(t.sy), n(t.tx), n(t.ty), p.width, p.height
                );
                for line in p.rgb.chunks(64) {
                    s.extend(line.iter().map(|b| format!("{b:02X}")));
                    s.push('\n');
                }
                s += ">\ngrestore\n";
                continue;
            }
        };
        let mut path = String::from("newpath\n");
        for seg in &sh.segs {
            match *seg {
                Seg::Move(x, y) => path += &format!("{} {} moveto\n", n(x), n(y)),
                Seg::Line(x, y) => path += &format!("{} {} lineto\n", n(x), n(y)),
                Seg::Curve(a, b, c, d, e, f) => path += &format!("{} {} {} {} {} {} curveto\n", n(a), n(b), n(c), n(d), n(e), n(f)),
                Seg::Close => path += "closepath\n",
            }
        }
        let rgb = |c: [u8; 3]| format!("{} {} {} setrgbcolor\n", n(f32::from(c[0]) / 255.0), n(f32::from(c[1]) / 255.0), n(f32::from(c[2]) / 255.0));
        if let Some((c, even)) = sh.fill {
            s += &path;
            s += &rgb(c);
            s += if even { "eofill\n" } else { "fill\n" };
        }
        if let Some(st) = &sh.stroke {
            s += &path;
            s += &rgb(st.rgb);
            s += &format!("{} setlinewidth {} setlinecap {} setlinejoin [{}] 0 setdash stroke\n", n(st.width), st.cap, st.join, st.dash.iter().map(|d| n(*d)).collect::<Vec<_>>().join(" "));
        }
    }
    s += "grestore\nshowpage\n%%EOF\n";
    s.into_bytes()
}

// ---- EMF ----

// Logical units per pt (so 1/20 pt), and the reference device the metafile is recorded on: 96 dpi, so 4 device px
// every 3 pt and exactly 15 logical units a device px, 20 by 15 in (508 by 381 mm, 1,920 by 1,440 px, all whole
// numbers). The drawing itself is still laid down in logical units of 1/20 pt, so the reference resolution costs the
// geometry no precision; it only decides what the bounds are counted in.
//
// It has to be 96, because Word sizes an enhanced metafile two different ways and only at 96 dpi do the two agree.
// Measured in Word 365 16.0.17932 on Windows 11 (issue 55), pasting the same drawing recorded at each reference:
//
//                        bounds   rclFrame   Word's scale on paste   at 100% scale
//   with text, 720 dpi   563 px   56.21 pt   13%                     422.25 pt  (7.51x)
//   with text,  96 dpi    75 px   56.21 pt   98%                      57.00 pt  (1.01x)
//   no text,   720 dpi   720 px   72.00 pt   100%                     72.10 pt  (1.00x)
//   no text,    96 dpi    96 px   72.00 pt   99%                      72.75 pt  (1.01x)
//
// A metafile that CONTAINS TEXT is sized from `rclBounds`, read as though the device were 96 dpi: 563 px that way is
// 5.8646 in, which is 422.25 pt, exactly what Word gave it. One with no text is sized from `rclFrame`, which is
// physical and right at any reference — which is why 720 dpi looked fine the first time it was tested, with a
// picture whose text usvg had dropped. Every real drawing has atom labels.
//
// So recorded at 720 dpi a drawing still ARRIVES looking right, because Word compensates with a 13% picture scale.
// What is wrong is the size Word believes it to be. Reset that picture to 100% — which a template, a macro or a
// journal's submission workflow does — and it is 7.51 times too large, which is 720/96. At 96 dpi the bounds read at
// 96 dpi ARE the frame, so both of Word's paths give the same answer and there is nothing to get wrong.
// `an_emf_is_the_size_it_says_it_is` holds the two sizes together.
//
// The frame is written as the BOUNDS, not as the ink. Bounds are whole device px, so a drawing whose size is not a
// whole number of them rounds up: at 96 dpi that is at most 0.75 pt an axis. Taking the frame from the ink instead
// leaves the two a fraction of a pixel apart, and then the same drawing lands at one size with an atom label on it
// and another without, because those are Word's two paths. Up to 0.75 pt of margin, always, beats up to 0.75 pt of
// disagreement, sometimes. `frame_and_bounds_are_one_size` is that invariant.
//
// Issue 20 raised this to 720 because some programs draw a metafile into pixels at its reference resolution, and
// GDI+'s DrawImage was said to do that at 96 dpi: bonds grew fat and a hashed wedge's hashes ran together. Measured
// again on Windows 11 for issue 55, with thin bonds, a six-hash wedge and a double bond, GDI+ draws the 96 dpi and
// the 720 dpi metafile identically at 1x, 2x and 4x — same hashes apart, same lines apart, the same ink to the
// pixel. Whatever that was, it is not the reference resolution now, and 720 only costs the size.
const UNIT: f32 = 20.0;
const PER_PX: i32 = 15;
const DEVICE: (i32, i32) = (1_920, 1_440);
const DEVICE_MM: (i32, i32) = (508, 381);

struct Emf {
    out: Vec<u8>,
    records: u32,
}
impl Emf {
    fn record(&mut self, kind: u32, body: &[i32]) {
        self.record_with(kind, body, &[]);
    }
    // A record whose body ends in bytes (a bitmap), padded to whole 4-byte words.
    fn record_with(&mut self, kind: u32, body: &[i32], bytes: &[u8]) {
        let pad = (4 - bytes.len() % 4) % 4;
        let size = 8 + 4 * body.len() as u32 + (bytes.len() + pad) as u32;
        self.out.extend_from_slice(&kind.to_le_bytes());
        self.out.extend_from_slice(&size.to_le_bytes());
        for v in body {
            self.out.extend_from_slice(&v.to_le_bytes());
        }
        self.out.extend_from_slice(bytes);
        self.out.extend(std::iter::repeat_n(0, pad));
        self.records += 1;
    }
}
const COLORREF: fn([u8; 3]) -> i32 = |c| i32::from(c[0]) | (i32::from(c[1]) << 8) | (i32::from(c[2]) << 16);
// Stock objects: NULL_BRUSH, NULL_PEN and SYSTEM_FONT.
const NULL_BRUSH: i32 = 0x8000_0005u32 as i32;
const NULL_PEN: i32 = 0x8000_0008u32 as i32;
const SYSTEM_FONT: i32 = 0x8000_000Du32 as i32;
// A box in logical units as device px (bounds records are in device px), rounded outward.
fn device(r: [i32; 4]) -> [i32; 4] {
    [r[0].div_euclid(PER_PX), r[1].div_euclid(PER_PX), r[2].saturating_add(PER_PX - 1).div_euclid(PER_PX), r[3].saturating_add(PER_PX - 1).div_euclid(PER_PX)]
}

// A run of text as GDI records it: the font (EMR_EXTCREATEFONTINDIRECTW, object 3), its colour, then the characters
// from the first one's origin on the baseline (EMR_EXTTEXTOUTW), each advance in dx so every glyph lands at its
// origin in the run; then the font goes. `at`: pt to logical units.
fn text_record(e: &mut Emf, r: &Run, at: impl Fn(f32) -> i32) {
    // LOGFONTW: height (negative, so it is the em height), width, escapement, orientation, weight; italic, underline,
    // strike-out, DEFAULT_CHARSET, OUT_TT_PRECIS, clip, quality and pitch; the face, 32 UTF-16 units. Then the rest of
    // a LogFontPanose (320 bytes in all) left empty, the size older GDI expects; MS-EMF reads it as a LogFont.
    let height = -((r.size * UNIT).round() as i32).max(1);
    let mut font = vec![u8::from(r.italic), 0, 0, 1, 4, 0, 0, 0];
    font.extend(r.face.encode_utf16().chain(std::iter::repeat(0)).take(32).flat_map(u16::to_le_bytes));
    font.resize(320 - 20, 0);
    e.record_with(82, &[3, height, 0, 0, 0, i32::from(r.weight)], &font);
    e.record(37, &[3]); // EMR_SELECTOBJECT
    e.record(24, &[COLORREF(r.rgb)]); // EMR_SETTEXTCOLOR
    let xs: Vec<i32> = r.xs.iter().map(|x| at(*x)).collect();
    let end = at(r.end).max(xs[xs.len() - 1]);
    let dx: Vec<i32> = xs.iter().enumerate().map(|(i, x)| xs.get(i + 1).copied().unwrap_or(end).saturating_sub(*x)).collect();
    let (n, y) = (r.chars.len(), at(r.y));
    let mut bytes: Vec<u8> = r.chars.iter().flat_map(|c| c.to_le_bytes()).collect();
    bytes.resize((2 * n + 3) & !3, 0);
    let off_dx = 76 + bytes.len() as i32;
    bytes.extend(dx.iter().flat_map(|d| d.to_le_bytes()));
    // Bounds in device px: the advances across, an em above the baseline and a quarter below.
    let em = at(r.size);
    let b = device([xs[0], y.saturating_sub(em), end, y.saturating_add(em / 4)]);
    // EMR_EXTTEXTOUTW: bounds; GM_COMPATIBLE and its scale (logical units to 0.01 mm); then EMRTEXT: the reference
    // point, the number of characters, where they are, no options, no rectangle, and where dx is.
    let scale = (2540.0 / 72.0 / UNIT).to_bits() as i32;
    e.record_with(84, &[b[0], b[1], b[2], b[3], 1, scale, scale, xs[0], y, n as i32, 76, 0, 0, 0, -1, -1, off_dx], &bytes);
    e.record(37, &[SYSTEM_FONT]);
    e.record(40, &[3]); // EMR_DELETEOBJECT
}

// A picture as GDI draws one: the world transform takes its pixel grid to its place in logical units, StretchDIBits
// draws its pixels (a 24-bit bitmap, bottom row first), and the transform goes back. `device`: device px per pt, for
// the record's bounds.
fn picture_record(e: &mut Emf, p: &Picture, device: (f32, f32)) {
    let t = p.place;
    e.record(21, &[4]); // EMR_SETSTRETCHBLTMODE HALFTONE: smooth when drawn smaller than its pixels
    // EMR_SETWORLDTRANSFORM: eM11, eM12, eM21, eM22, eDx, eDy.
    e.record(35, &[t.sx, t.ky, t.kx, t.sy, t.tx, t.ty].map(|v| (v * UNIT).to_bits() as i32));
    let (w, h) = (p.width as usize, p.height as usize);
    let row = (w * 3 + 3) & !3;
    let mut bits = Vec::with_capacity(40 + row * h);
    for v in [40, w as i32, h as i32] {
        bits.extend(v.to_le_bytes());
    }
    bits.extend(1u16.to_le_bytes()); // planes
    bits.extend(24u16.to_le_bytes()); // bits per pixel
    bits.extend([0u8; 24]); // BI_RGB, image size, resolutions, colours used, colours important
    for y in (0..h).rev() {
        let start = bits.len();
        for c in p.rgb[y * w * 3..(y + 1) * w * 3].chunks_exact(3) {
            bits.extend([c[2], c[1], c[0]]);
        }
        bits.resize(start + row, 0);
    }
    // Bounds in device px: round the corners of its place.
    let (mut lo, mut hi) = ([f32::MAX; 2], [f32::MIN; 2]);
    for (x, y) in [(0, 0), (w, 0), (0, h), (w, h)] {
        let mut q = Point::from_xy(x as f32, y as f32);
        t.map_point(&mut q);
        let q = [q.x * device.0, q.y * device.1];
        (lo, hi) = ([lo[0].min(q[0]), lo[1].min(q[1])], [hi[0].max(q[0]), hi[1].max(q[1])]);
    }
    let (w, h) = (w as i32, h as i32);
    // EMR_STRETCHDIBITS: bounds; destination x, y; source x, y, width, height; where the bitmap's header and bits are
    // in the record, and their sizes; DIB_RGB_COLORS; SRCCOPY; destination width, height; then the bitmap.
    let head = [lo[0].floor() as i32, lo[1].floor() as i32, hi[0].ceil() as i32, hi[1].ceil() as i32, 0, 0, 0, 0, w, h, 80, 40, 120, row as i32 * h, 0, 0x00CC_0020, w, h];
    e.record_with(81, &head, &bits);
    // EMR_MODIFYWORLDTRANSFORM with MWT_IDENTITY: back to no transform.
    let mut back = [1.0f32, 0.0, 0.0, 1.0, 0.0, 0.0].map(|v| v.to_bits() as i32).to_vec();
    back.push(1);
    e.record(36, &back);
}

// The comment Octet's EMF on the Windows clipboard carries: this tag, then the drawing's CDXML, so a picture copied
// back out of Word or PowerPoint pastes into Octet as the drawing (as the CDXML in the Mac's PDF does).
const CDXML_TAG: &[u8] = b"Octet CDXML\0";

// An EMF of the SVG at true size: its frame (which Word, PowerPoint and Keynote place it by) is the picture's size.
// With `cdxml`, the drawing goes in an EMR_COMMENT after the header, which GDI and Office skip when they draw.
pub fn make_emf(tree: &usvg::Tree, cdxml: Option<&str>) -> Vec<u8> {
    let (w, h) = size(tree);
    // The picture in device px (whole ones, the logical units fifteen to each), and its frame in hundredths of a mm.
    let px = |pt: f32| (((pt * UNIT).ceil().max(1.0) as i32).saturating_add(PER_PX - 1)) / PER_PX;
    let (dw, dh) = (px(w), px(h));
    let (lw, lh) = (dw * PER_PX, dh * PER_PX);
    // The frame is those whole device px turned into hundredths of a mm at the reference device's own resolution,
    // not the ink's own size: see `frame_and_bounds_are_one_size` for why the two have to be the same picture.
    let mm100 = |px: i32, device: i32, mm: i32| (f64::from(px) * f64::from(mm) * 100.0 / f64::from(device)).round() as i32;
    let (fw, fh) = (mm100(dw, DEVICE.0, DEVICE_MM.0), mm100(dh, DEVICE.1, DEVICE_MM.1));
    let mut e = Emf { out: Vec::new(), records: 0 };
    // EMR_HEADER (filled in at the end with the totals): bounds, frame, " EMF", version, bytes, records, handles,
    // reserved, description, palette, device, millimetres, pixel format, OpenGL, micrometres.
    e.record(1, &[0, 0, dw - 1, dh - 1, 0, 0, fw, fh, 0x464D_4520, 0x10000, 0, 0, 4, 0, 0, 0, DEVICE.0, DEVICE.1, DEVICE_MM.0, DEVICE_MM.1, 0, 0, 0, DEVICE_MM.0 * 1000, DEVICE_MM.1 * 1000]);
    if let Some(x) = cdxml {
        let data = [CDXML_TAG, x.as_bytes()].concat();
        e.record_with(70, &[data.len() as i32], &data); // EMR_COMMENT: the data's size, then the data
    }
    e.record(17, &[8]); // EMR_SETMAPMODE MM_ANISOTROPIC
    e.record(9, &[lw, lh]); // EMR_SETWINDOWEXTEX
    e.record(10, &[0, 0]); // EMR_SETWINDOWORGEX
    e.record(11, &[dw, dh]); // EMR_SETVIEWPORTEXTEX
    e.record(12, &[0, 0]); // EMR_SETVIEWPORTORGEX
    e.record(18, &[1]); // EMR_SETBKMODE TRANSPARENT
    e.record(22, &[24]); // EMR_SETTEXTALIGN TA_BASELINE, TA_LEFT
    let at = |v: f32| (v * UNIT).round() as i32;
    for mark in marks(tree, true) {
        let sh = match mark {
            Mark::Shape(sh) => sh,
            Mark::Text(r) => {
                text_record(&mut e, &r, at);
                continue;
            }
            Mark::Picture(p) => {
                let k = UNIT / PER_PX as f32;
                picture_record(&mut e, &p, (k, k));
                continue;
            }
        };
        // The outline as a GDI path, with its bounds.
        let path = |e: &mut Emf| {
            e.record(59, &[]); // EMR_BEGINPATH
            for seg in &sh.segs {
                match *seg {
                    Seg::Move(x, y) => e.record(27, &[at(x), at(y)]), // EMR_MOVETOEX
                    Seg::Line(x, y) => e.record(54, &[at(x), at(y)]), // EMR_LINETO
                    Seg::Curve(a, b, c, d, x, y) => {
                        let xs = [at(a), at(c), at(x)];
                        let ys = [at(b), at(d), at(y)];
                        let bounds = device([*xs.iter().min().unwrap(), *ys.iter().min().unwrap(), *xs.iter().max().unwrap(), *ys.iter().max().unwrap()]);
                        e.record(5, &[bounds[0], bounds[1], bounds[2], bounds[3], 3, xs[0], ys[0], xs[1], ys[1], xs[2], ys[2]]); // EMR_POLYBEZIERTO
                    }
                    Seg::Close => e.record(61, &[]), // EMR_CLOSEFIGURE
                }
            }
            e.record(60, &[]); // EMR_ENDPATH
        };
        let bounds = [0, 0, dw - 1, dh - 1];
        if let Some((c, even)) = sh.fill {
            e.record(19, &[if even { 1 } else { 2 }]); // EMR_SETPOLYFILLMODE ALTERNATE or WINDING
            e.record(39, &[1, 0, COLORREF(c), 0]); // EMR_CREATEBRUSHINDIRECT 1: BS_SOLID
            e.record(37, &[1]); // EMR_SELECTOBJECT
            e.record(37, &[NULL_PEN]);
            path(&mut e);
            e.record(62, &bounds); // EMR_FILLPATH
            e.record(37, &[NULL_BRUSH]);
            e.record(40, &[1]); // EMR_DELETEOBJECT
        }
        if let Some(st) = &sh.stroke {
            // PS_GEOMETRIC, solid or the dashes (PS_USERSTYLE), with the cap and join.
            let cap = [0x200, 0, 0x100][st.cap as usize];
            let join = [0x2000, 0, 0x1000][st.join as usize];
            let dashes: Vec<i32> = st.dash.iter().map(|d| at(*d).max(1)).collect();
            let style = 0x10000 | cap | join | if dashes.is_empty() { 0 } else { 7 };
            let mut body = vec![2, 0, 0, 0, 0, style, at(st.width).max(1), 0, COLORREF(st.rgb), 0, dashes.len() as i32];
            body.extend(dashes);
            e.record(95, &body); // EMR_EXTCREATEPEN 2
            e.record(37, &[2]);
            e.record(37, &[NULL_BRUSH]);
            path(&mut e);
            e.record(64, &bounds); // EMR_STROKEPATH
            e.record(37, &[NULL_PEN]);
            e.record(40, &[2]);
        }
    }
    e.record(14, &[0, 16, 20]); // EMR_EOF: no palette, nSizeLast
    let (bytes, records) = (e.out.len() as u32, e.records);
    e.out[48..52].copy_from_slice(&bytes.to_le_bytes());
    e.out[52..56].copy_from_slice(&records.to_le_bytes());
    e.out
}

// The CDXML in an EMF's Octet comment, if it has one. The records are walked with bounds checks (the bytes come from
// the clipboard and are hostile): each must fit in the file, and at most 100,000 are read.
pub fn cdxml_from_emf(emf: &[u8]) -> Option<String> {
    let u32_at = |k: usize| emf.get(k..k + 4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize);
    let mut at = 0;
    for _ in 0..100_000 {
        let (kind, size) = (u32_at(at)?, u32_at(at + 4)?);
        if size < 8 || size % 4 != 0 || at.checked_add(size)? > emf.len() {
            return None;
        }
        if kind == 70 {
            let n = u32_at(at + 8)?;
            let data = emf.get(at + 12..(at + 12).checked_add(n)?.min(at + size))?;
            if let Some(x) = data.strip_prefix(CDXML_TAG) {
                return std::str::from_utf8(x).ok().filter(|t| t.contains("<CDXML")).map(str::to_string);
            }
        }
        if kind == 14 {
            return None; // EMR_EOF
        }
        at += size;
    }
    None
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    fn tree(svg: &str) -> usvg::Tree {
        usvg::Tree::from_str(svg, &usvg::Options::default()).unwrap()
    }
    const SVG: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" width="72pt" height="36pt" viewBox="0 0 72 36"><path d="M0 0L72 36" stroke="#000" stroke-width="2"/><rect x="10" y="10" width="20" height="10" fill="#213C99" fill-opacity="0.5"/></svg>"##;

    #[test]
    fn eps_has_its_box_and_paths() {
        let eps = String::from_utf8(make_eps(&tree(SVG))).unwrap();
        assert!(eps.starts_with("%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 72 36\n"));
        assert!(eps.contains("2 setlinewidth"));
        assert!(eps.contains(" curveto\n") || eps.contains(" lineto\n"));
        // Half-opacity Octet Blue on white paper.
        assert!(eps.contains("0.565 0.62 0.8 setrgbcolor"), "{eps}");
        assert!(eps.ends_with("showpage\n%%EOF\n"));
    }

    #[test]
    fn emf_header_and_records_add_up() {
        let emf = make_emf(&tree(SVG), None);
        assert_eq!(cdxml_from_emf(&emf), None);
        let cdxml = "<?xml version=\"1.0\"?><CDXML><page/></CDXML>";
        let with = make_emf(&tree(SVG), Some(cdxml));
        assert_eq!(cdxml_from_emf(&with).as_deref(), Some(cdxml));
        assert_eq!(cdxml_from_emf(&with[..with.len() / 2]), Some(cdxml.to_string()), "the comment comes first");
        assert_eq!(cdxml_from_emf(&[70, 0, 0, 0, 255, 255, 255, 255]), None, "a record larger than the file");
        let u = |at: usize| u32::from_le_bytes(emf[at..at + 4].try_into().unwrap());
        assert_eq!(u(0), 1);
        assert_eq!(u(40), 0x464D_4520);
        assert_eq!(u(48) as usize, emf.len());
        // The frame: 1 in by 0.5 in, in hundredths of a mm.
        assert_eq!((u(24), u(28), u(32), u(36)), (0, 0, 2540, 1270));
        // Every record's size takes the next record to the end, which is EMR_EOF.
        let (mut at, mut count, mut last) = (0, 0, 0);
        while at < emf.len() {
            last = u(at);
            at += u(at + 4) as usize;
            count += 1;
        }
        assert_eq!(at, emf.len());
        assert_eq!(count, u(52));
        assert_eq!(last, 14);
    }

    // Issue 16: a copy's view box starts where the selection does, and the labels must land inside the picture with
    // the bonds, as standaloneSvg writes them (text inside a scaled group).
    #[test]
    fn text_lands_inside_the_picture() {
        let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="60pt" height="30pt" viewBox="-302 -425 60 30"><g transform="scale(0.75)"><path d="M-400 -560h40v4h-40z" fill="#000"/><text x="-395" y="-540" fill="#000" font-family="Arial, Helvetica, sans-serif" font-size="13.3333px">NH</text></g></svg>"##;
        let marks = marks(&crate::export::tree(svg).unwrap(), false);
        assert!(marks.len() > 1, "the label has glyphs");
        for m in &marks {
            let Mark::Shape(sh) = m else { continue };
            for seg in &sh.segs {
                if let Seg::Move(x, y) | Seg::Line(x, y) | Seg::Curve(_, _, _, _, x, y) = *seg {
                    assert!((-1.0..=61.0).contains(&x) && (-1.0..=31.0).contains(&y), "({x}, {y}) is outside the 60 by 30 pt picture");
                }
            }
        }
    }

    // The records of an EMF: each one's kind and where it starts. Every record's size takes the next to the end.
    fn records(emf: &[u8]) -> Vec<(u32, usize)> {
        let u = |at: usize| u32::from_le_bytes(emf[at..at + 4].try_into().unwrap());
        let (mut at, mut out) = (0, Vec::new());
        while at < emf.len() {
            out.push((u(at), at));
            at += u(at + 4) as usize;
        }
        assert_eq!((at, u(48) as usize, u(52) as usize), (emf.len(), emf.len(), out.len()));
        out
    }
    fn i32_at(emf: &[u8], at: usize) -> i32 {
        i32::from_le_bytes(emf[at..at + 4].try_into().unwrap())
    }

    // The metafile is recorded against a 96 dpi device, the logical units exactly 15 device px, and every bounds
    // record in device px.
    #[test]
    fn emf_reference_device_is_96_dpi() {
        let emf = make_emf(&tree(SVG), None);
        let v = |at: usize| i32_at(&emf, at);
        assert_eq!((v(8), v(12), v(16), v(20)), (0, 0, 95, 47), "bounds: 72 by 36 pt is 96 by 48 px");
        assert_eq!((v(24), v(28), v(32), v(36)), (0, 0, 2540, 1270), "the frame, in 0.01 mm, is the picture");
        assert_eq!(v(56), 4, "handles: none, a brush, a pen and a font");
        assert_eq!((v(72), v(76), v(80), v(84)), (1_920, 1_440, 508, 381));
        assert_eq!((v(100), v(104)), (508_000, 381_000));
        assert_eq!((f64::from(v(72)) * 25.4 / f64::from(v(80)), f64::from(v(76)) * 25.4 / f64::from(v(84))), (96.0, 96.0));
        let all = records(&emf);
        let body = |kind: u32| all.iter().find(|r| r.0 == kind).map(|r| (i32_at(&emf, r.1 + 8), i32_at(&emf, r.1 + 12))).unwrap();
        assert_eq!((body(9), body(11)), ((1440, 720), (96, 48)), "window 1/20 pt, viewport device px");
        for &(kind, at) in &all {
            if kind == 62 || kind == 64 {
                assert_eq!((v(at + 8), v(at + 12), v(at + 16), v(at + 20)), (0, 0, 95, 47), "path bounds in device px");
            }
        }
    }

    // The bounds and the frame describe the same picture: the bounds, read at the reference device's own resolution,
    // are the frame's physical size. This is the one a host relies on and the one 1.1.1 broke — Word reads the bounds
    // at 96 dpi and ignores the frame, so a metafile whose two sizes disagree is placed by however much they differ
    // (issue 55). Checked over a range of sizes, because the bounds are whole device px and the frame is whole 0.01
    // mm, so each is rounded and they have to agree anyway.
    #[test]
    fn an_emf_is_the_size_it_says_it_is() {
        for (w, h) in [(72.0, 36.0), (48.0, 24.0), (144.0, 108.0), (86.0, 65.0), (56.55, 55.28)] {
            let svg = format!(
                r##"<svg xmlns="http://www.w3.org/2000/svg" width="{w}pt" height="{h}pt" viewBox="0 0 {w} {h}"><path d="M0 0L{w} {h}" stroke="#000" stroke-width="0.6"/></svg>"##
            );
            let emf = make_emf(&tree(&svg), None);
            let v = |at: usize| i32_at(&emf, at);
            let dpi = f64::from(v(72)) * 25.4 / f64::from(v(80));
            assert_eq!(dpi, 96.0, "{w} by {h}: the reference device");
            // Bounds are inclusive, so the width in px is right minus left plus one.
            let (bw, bh) = (f64::from(v(16) - v(8) + 1), f64::from(v(20) - v(12) + 1));
            let (fw, fh) = (f64::from(v(32) - v(24)) / 2540.0, f64::from(v(36) - v(28)) / 2540.0);
            // The frame IS the bounds, so these agree to the hundredth of a mm the frame is written in.
            let quantum = 0.01 / 25.4;
            assert!((bw / dpi - fw).abs() <= quantum, "{w} by {h}: bounds {bw} px at {dpi} dpi is not the frame's {fw} in");
            assert!((bh / dpi - fh).abs() <= quantum, "{w} by {h}: bounds {bh} px at {dpi} dpi is not the frame's {fh} in");
            // And what Word will do with it: the bounds read at 96 dpi are the picture's true size in pt.
            assert!((bw * 72.0 / 96.0 - f64::from(w)).abs() <= 1.0, "{w} by {h}: Word would place it {} pt wide", bw * 72.0 / 96.0);
        }
        // A drawing with text in it, which is the case that actually goes wrong: Word sizes a metafile holding text
        // from the bounds and one holding none from the frame, so only a picture with labels ever showed the
        // disagreement. L-proline is 56.21 by 36.55 pt, and at 720 dpi Word made it 422.25 pt.
        let emf = make_emf(&crate::export::tree(PROLINE).unwrap(), None);
        let v = |at: usize| i32_at(&emf, at);
        let bw = f64::from(v(16) - v(8) + 1);
        assert!(!texts(&emf).is_empty(), "the sample has text in it, or this proves nothing");
        assert!((bw * 72.0 / 96.0 - 56.21).abs() <= 1.0, "L-proline: Word would place it {} pt wide, not 56.21", bw * 72.0 / 96.0);
    }

    // Word sizes a metafile holding text from `rclBounds` and one holding none from `rclFrame` (issue 55). So the
    // same drawing has to measure the same both ways, or putting one atom label on it changes the size it pastes
    // at. The bounds are whole device px and cannot be anything else, so the frame is taken from them: the ink is
    // given up to one device px of margin, and in exchange the two never disagree.
    #[test]
    fn frame_and_bounds_are_one_size() {
        // Sizes that are a whole number of device px (72 pt is 96) and sizes that are not, which is the case the
        // rounding is there for. L-proline is the one measured in Word: 56.21 by 36.55 pt is 75 by 49 px.
        let mut with_text = vec![make_emf(&crate::export::tree(PROLINE).unwrap(), None)];
        for (w, h) in [(72.0, 36.0), (56.21, 36.55), (86.0, 65.0), (56.55, 55.28), (13.3, 7.7)] {
            let svg = format!(
                r##"<svg xmlns="http://www.w3.org/2000/svg" width="{w}pt" height="{h}pt" viewBox="0 0 {w} {h}"><path d="M0 0L{w} {h}" stroke="#000" stroke-width="0.6"/></svg>"##
            );
            with_text.push(make_emf(&tree(&svg), None));
        }
        for emf in &with_text {
            let v = |at: usize| i32_at(emf, at);
            // What Word does with a picture that has text in it: the bounds, read at 96 dpi, in pt.
            let (bw, bh) = (f64::from(v(16) - v(8) + 1) * 72.0 / 96.0, f64::from(v(20) - v(12) + 1) * 72.0 / 96.0);
            // And with one that has none: the frame, which is physical, in pt.
            let (fw, fh) = (f64::from(v(32) - v(24)) * 72.0 / 2540.0, f64::from(v(36) - v(28)) * 72.0 / 2540.0);
            // A hundredth of a mm is 0.0284 pt, and that is all the frame can say.
            let quantum = 0.01 / 25.4 * 72.0;
            assert!((bw - fw).abs() <= quantum, "with a label {bw} pt wide, without one {fw}");
            assert!((bh - fh).abs() <= quantum, "with a label {bh} pt tall, without one {fh}");
        }
    }

    // What an EMF writes as text: each EXTTEXTOUTW's string, reference point and dx, and the font it is in (face,
    // height, weight, italic).
    fn texts(emf: &[u8]) -> Vec<(String, (i32, i32), Vec<i32>, (String, i32, i32, u8))> {
        let mut font = None;
        let mut out = Vec::new();
        for (kind, at) in records(emf) {
            if kind == 82 {
                assert_eq!(i32_at(emf, at + 4), 332, "a LogFontPanose");
                let face: Vec<u16> = emf[at + 40..at + 104].chunks(2).map(|c| u16::from_le_bytes([c[0], c[1]])).take_while(|c| *c != 0).collect();
                font = Some((String::from_utf16(&face).unwrap(), i32_at(emf, at + 12), i32_at(emf, at + 28), emf[at + 32]));
            }
            if kind == 84 {
                assert_eq!(i32_at(emf, at + 24), 1, "GM_COMPATIBLE");
                let n = i32_at(emf, at + 44) as usize;
                let (s, d) = (i32_at(emf, at + 48) as usize, i32_at(emf, at + 72) as usize);
                assert_eq!((s, i32_at(emf, at + 52)), (76, 0));
                let chars: Vec<u16> = emf[at + s..at + s + 2 * n].chunks(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
                let dx = (0..n).map(|i| i32_at(emf, at + d + 4 * i)).collect();
                assert_eq!(d + 4 * n, i32_at(emf, at + 4) as usize, "dx ends the record");
                out.push((String::from_utf16(&chars).unwrap(), (i32_at(emf, at + 36), i32_at(emf, at + 40)), dx, font.clone().expect("a font first")));
            }
        }
        out
    }

    // Issue 20: labels go in as text, as ChemDraw's do, each character where the PDF has it. Arial's advances (Liberation
    // Sans has the same) in 1/2048 em: N, H and C 1479, O 1593, 3 1139, + 1196. At 10 pt in 1/20 pt: 200 / 2048 each.
    #[test]
    fn labels_are_text_at_their_glyph_positions() {
        let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="120pt" height="72pt" viewBox="0 0 120 72"><g transform="scale(0.75)"><path d="M0 0h20v1h-20z" fill="#000"/><g font-family="Arial, Helvetica, sans-serif" font-size="13.3333px" fill="rgb(15, 23, 42)"><text x="20" y="30">NH</text><text x="20" y="50">OH</text><text x="60" y="30">H</text><text x="69.62890625" y="30">O</text><text x="100" y="30">O</text><text x="80" y="60">CH<tspan dy="2.827" font-size="10px">3</tspan></text><text x="20" y="80">NH<tspan dy="-4" font-size="10px">+</tspan></text></g></g></svg>"##;
        let emf = make_emf(&crate::export::tree(svg).unwrap(), None);
        let all = records(&emf);
        let count = |k: u32| all.iter().filter(|r| r.0 == k).count();
        // Record histogram: the bond is the only path; each run has its font made, chosen, coloured and deleted.
        assert_eq!((count(62), count(82), count(84), count(24), count(22)), (1, 8, 8, 8, 1));
        assert_eq!(count(40), 1 + 8, "the bond's brush and the fonts are deleted");
        let t = texts(&emf);
        let strings: Vec<&str> = t.iter().map(|x| x.0.as_str()).collect();
        assert_eq!(strings, ["NH", "OH", "HO", "O", "CH", "3", "NH", "+"]);
        let arial = |h: i32| ("Arial".to_string(), h, 400, 0u8);
        assert!(t.iter().all(|x| x.3 == arial(if x.0.len() == 1 && x.0 != "O" { -150 } else { -200 })), "{t:?}");
        // Reference points on the baseline, in 1/20 pt (px * 0.75 * 20).
        let at = |px: f64| (px * 15.0).round() as i32;
        let adv = |units: f64, pt: f64| units * pt / 2048.0 * 20.0;
        let starts: Vec<(i32, i32)> = t.iter().map(|x| x.1).collect();
        assert_eq!(starts[..5], [(at(20.0), at(30.0)), (at(20.0), at(50.0)), (at(60.0), at(30.0)), (at(100.0), at(30.0)), (at(80.0), at(60.0))]);
        // The subscript starts where CH's advances end, 0.212 em below; the superscript where NH's do, 3 pt above.
        let (sub, sup) = (at(80.0) as f64 + adv(2.0 * 1479.0, 10.0), at(20.0) as f64 + adv(2.0 * 1479.0, 10.0));
        assert!((starts[5].0 as f64 - sub).abs() <= 1.0 && starts[5].1 == at(62.827), "{:?} {sub}", starts[5]);
        assert!((starts[7].0 as f64 - sup).abs() <= 1.0 && starts[7].1 == at(76.0), "{:?} {sup}", starts[7]);
        // Each advance as Arial's, to a twentieth of a pt; HO's H ends where its O starts.
        let near = |dx: &[i32], units: &[f64], pt: f64| dx.len() == units.len() && dx.iter().zip(units).all(|(d, u)| (f64::from(*d) - adv(*u, pt)).abs() <= 1.0);
        assert!(near(&t[0].2, &[1479.0, 1479.0], 10.0), "{:?}", t[0].2);
        assert!(near(&t[1].2, &[1593.0, 1479.0], 10.0), "{:?}", t[1].2);
        assert!(near(&t[2].2, &[1479.0, 1593.0], 10.0), "{:?}", t[2].2);
        assert!(near(&t[5].2, &[1139.0], 7.5) && near(&t[7].2, &[1196.0], 7.5), "{t:?}");
        // The text records' bounds are inside the picture's, in device px.
        for (kind, at) in all {
            if kind == 84 {
                let b = [8, 12, 16, 20].map(|k| i32_at(&emf, at + k));
                assert!(b[0] >= 0 && b[1] >= 0 && b[2] <= 1199 && b[3] <= 719 && b[0] < b[2] && b[1] < b[3], "{b:?}");
            }
        }
    }

    // Text GDI cannot draw as usvg did goes in as outlines: turned, or underlined.
    #[test]
    fn turned_or_underlined_text_is_outlines() {
        for attrs in [r#"transform="rotate(30 40 40)""#, r#"text-decoration="underline""#] {
            let svg = format!(r##"<svg xmlns="http://www.w3.org/2000/svg" width="80pt" height="80pt" viewBox="0 0 80 80"><text x="30" y="40" font-family="Arial, Helvetica, sans-serif" font-size="10pt" {attrs}>OH</text></svg>"##);
            let all = records(&make_emf(&crate::export::tree(&svg).unwrap(), None));
            assert!(!all.iter().any(|r| r.0 == 84) && all.iter().any(|r| r.0 == 62), "{attrs}: {:?}", all.iter().map(|r| r.0).collect::<Vec<_>>());
        }
        assert_eq!((windows_font("Arial"), windows_font("Liberation Sans"), windows_font("helvetica")), (Some("Arial"), Some("Arial"), Some("Arial")));
        assert_eq!((windows_font("Tinos"), windows_font("Menlo"), windows_font("Instrument Sans")), (Some("Times New Roman"), None, None));
    }

    // Issue 20: the frame fits the ink. L-proline as Octet 1.1.1 copies it (standaloneSvg in Chromium with Arial, the
    // view box from the glyphs' ink): the ink is within 0.01 pt of each edge with Arial (0.1 pt allowed here). Linux
    // without Arial draws Liberation Sans, Arial's widths but not its outlines: 0.3 pt there. Octet 1.1.0 made this 58 by 41 pt, from the labels' line boxes and whole points.
    // The frame itself is the bounds rounded out to whole device px (`frame_and_bounds_are_one_size`), so it is the
    // ink plus under a pixel: 1984 by 1296 hundredths of a mm is 56.24 by 36.73 pt around ink of 56.21 by 36.55.
    pub(crate) const PROLINE: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" fill="rgb(0, 0, 0)" width="56.21pt" height="36.55pt" viewBox="-33.1 -21.54 56.21 36.55"><g transform="scale(0.75)"><g id="world"><g><defs/><path d="M-26.26 8.63L-25.61 9.10L-20.04 1.43L-19.10 -0.55L-18.24 -2.41ZM-17.48 -0.18L-16.75 -0.50L-21.93 -12.15L-22.66 -11.82ZM-20.64 1.23L-19.91 0.90L-25.09 -10.74L-25.82 -10.42ZM-0.29 1.77L-0.00 1.46L-0.22 1.10L-18.24 -2.41L-19.10 -0.55L-20.04 1.43ZM0.49 1.51L-0.00 1.46L-0.29 1.77L9.40 18.54L9.60 18.09L9.80 17.64ZM9.80 17.64L9.60 18.09L9.40 18.54L28.74 14.43L28.38 14.10L28.01 13.76ZM28.01 13.76L28.38 14.10L28.74 14.43L30.81 -5.25L30.38 -5.00L29.96 -4.75ZM29.96 -4.75L30.38 -5.00L30.81 -5.25L19.41 -10.32L19.09 -9.59ZM7.36 -6.12L6.77 -6.66L-0.22 1.10L-0.00 1.46L0.49 1.51Z" fill="rgb(15, 23, 42)"/><g><text x="-35.56808929443359" y="19.84140815734863" fill="rgb(15, 23, 42)" font-family="Arial, Helvetica, sans-serif" font-size="13.3333px">O</text><text x="-45.194584655761716" y="19.84140815734863" fill="rgb(15, 23, 42)" font-family="Arial, Helvetica, sans-serif" font-size="13.3333px">H</text><text x="-32.09196014404297" y="-13.231793975830076" fill="rgb(15, 23, 42)" font-family="Arial, Helvetica, sans-serif" font-size="13.3333px">O</text><text x="8.030521774291993" y="-8.037777423858643" fill="rgb(15, 23, 42)" font-family="Arial, Helvetica, sans-serif" font-size="13.3333px">N</text><text x="8.030521774291993" y="-19.173156544685362" fill="rgb(15, 23, 42)" font-family="Arial, Helvetica, sans-serif" font-size="13.3333px">H</text></g></g></g></g></svg>"##;
    #[test]
    fn the_frame_fits_the_ink() {
        let tree = crate::export::tree(PROLINE).unwrap();
        let (w, h) = size(&tree);
        assert!((w - 56.21).abs() < 1e-3 && (h - 36.55).abs() < 1e-3, "{w} by {h} pt");
        let ink = tree.root().abs_stroke_bounding_box();
        let slack = [ink.left(), ink.top(), w / 0.75 - ink.right(), h / 0.75 - ink.bottom()].map(|v| v * 0.75);
        let arial = tree.fontdb().faces().any(|f| f.families.iter().any(|(n, _)| n == "Arial"));
        let room = if arial { 0.1 } else { 0.3 };
        assert!(slack.iter().all(|s| (-room..=room).contains(s)), "{slack:?}");
        let emf = make_emf(&tree, None);
        assert_eq!([24, 28, 32, 36].map(|k| i32_at(&emf, k)), [0, 0, 1984, 1296], "the frame in 0.01 mm");
        let t = texts(&emf);
        assert_eq!(t.iter().map(|x| x.0.as_str()).collect::<Vec<_>>(), ["HO", "O", "N", "H"]);
    }

    // A picture as standaloneSvg writes one (src/export.ts): a red PNG of 4 by 2 px, drawn 36 by 18 pt at (18, 9) on a
    // page of 72 by 36 pt.
    pub(crate) fn picture_svg() -> String {
        use base64::Engine;
        let mut png = Vec::new();
        let mut enc = png::Encoder::new(&mut png, 4, 2);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.write_header().unwrap().write_image_data(&[255, 0, 0, 255].repeat(8)).unwrap();
        let png = base64::engine::general_purpose::STANDARD.encode(png);
        format!(r#"<svg xmlns="http://www.w3.org/2000/svg" width="72pt" height="36pt" viewBox="0 0 72 36"><g transform="scale(1)"><image href="data:image/png;base64,{png}" x="18" y="9" width="36" height="18" preserveAspectRatio="none"/></g></svg>"#)
    }

    #[test]
    fn pictures_go_in_eps_and_emf_where_the_pdf_has_them() {
        let svg = picture_svg();
        // EPS: the 4 by 2 pixels, 9 pt each, from (18, 9) pt; all red.
        let eps = String::from_utf8(make_eps(&tree(&svg))).unwrap();
        assert!(eps.contains("[9 0 0 9 18 9] concat\n"), "{eps}");
        assert!(eps.contains("/Width 4 /Height 2 /BitsPerComponent 8"));
        assert!(eps.contains(&format!("image\n{}\n>\ngrestore\n", "FF0000".repeat(8))), "{eps}");
        // EMF: the world transform takes the pixels there in 1/20 pt; StretchDIBits draws 4 by 2, bottom row first, BGR.
        let emf = make_emf(&tree(&svg), None);
        let u = |at: usize| u32::from_le_bytes(emf[at..at + 4].try_into().unwrap());
        let f = |at: usize| f32::from_bits(u(at));
        let (mut at, mut seen) = (0, Vec::new());
        while at < emf.len() {
            seen.push(u(at));
            if u(at) == 35 {
                assert_eq!((8..32).step_by(4).map(|k| f(at + k)).collect::<Vec<_>>(), [180.0, 0.0, 0.0, 180.0, 360.0, 180.0]);
            }
            if u(at) == 81 {
                // Source and destination 4 by 2, SRCCOPY, a 40-byte header at 80, and the bits at 120: 12 bytes a row.
                assert_eq!((u(at + 40), u(at + 44), u(at + 48), u(at + 52), u(at + 56), u(at + 60)), (4, 2, 80, 40, 120, 24));
                assert_eq!((u(at + 68), u(at + 72), u(at + 76)), (0x00CC_0020, 4, 2));
                assert_eq!((u(at + 84), u(at + 88)), (4, 2));
                assert_eq!(&emf[at + 120..at + 126], &[0, 0, 255, 0, 0, 255]);
                assert_eq!(u(at + 4) as usize, 120 + 24);
            }
            at += u(at + 4) as usize;
        }
        assert_eq!((at, u(48) as usize, u(52) as usize), (emf.len(), emf.len(), seen.len()));
        let k = seen.iter().position(|&r| r == 81).expect("a StretchDIBits record");
        assert_eq!(&seen[k - 2..k + 2], &[21, 35, 81, 36]);
    }
}
