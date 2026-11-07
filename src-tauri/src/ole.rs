// Octet as an embedded object on Windows (issue #24).
//
// Pasting a drawing into Word today gives a picture. This builds the two clipboard formats
// that make it an *object* instead, so Word stores the drawing itself and can hand it back
// to Octet to edit:
//
//   "Object Descriptor"  what the object is: its class, its size, its name in Word's menus.
//   "Embed Source"       the object itself, as an OLE compound file (MS-OLEDS).
//
// The compound file holds four streams:
//
//   \x01CompObj     the class's names and its clipboard format (MS-OLEDS 2.3.7)
//   \x01Ole         the OLE stream header (2.3.3)
//   \x02OlePres000  the CACHED PICTURE the host draws (2.3.4)
//   CONTENTS        Octet's own drawing, the same bytes a .oct file holds
//
// \x02OlePres000 is the one to get right. A host does not call the server to draw an
// embedded object it is merely displaying — it blits this cached picture. A server that
// writes the native data and no presentation leaves an empty frame in the document, which
// is what ChemDraw 25.5 does in Word 365 on the bench machine: the drawing is kept and
// comes back on a double-click, but the page shows nothing. Octet writes the EMF here so
// its objects look right from the moment they are pasted.
//
// Nothing in this file trusts what it reads; it only writes.

use std::io::{Cursor, Write};

// Octet's own class id for an embedded drawing, and the names Word shows for it.
//
// PROPOSED, not yet registered: the installer has to write this under HKCR\CLSID with
// LocalServer32, Insertable and the Edit and Open verbs before a double-click can work.
// Sam should confirm the GUID before it ships, because once a document in the wild holds
// it, it can never change.
pub const CLSID: [u8; 16] = [
    0x2d, 0x3f, 0x8a, 0x5e, 0x9c, 0x14, 0x47, 0xb2, 0xa6, 0x71, 0x0e, 0x83, 0xd5, 0xc9, 0x11, 0x40,
];
pub const PROGID: &str = "OctetDraw.Drawing.1";
pub const USER_TYPE: &str = "Octet Draw Drawing";
const CF_ENHMETAFILE: u32 = 14;

// A length-prefixed ANSI string as the CompObj stream wants it: the byte count including
// the terminator, then the bytes, then the terminator.
fn ansi(out: &mut Vec<u8>, s: &str) {
    let bytes: Vec<u8> = s.chars().map(|c| if c.is_ascii() { c as u8 } else { b'?' }).collect();
    out.extend_from_slice(&(bytes.len() as u32 + 1).to_le_bytes());
    out.extend_from_slice(&bytes);
    out.push(0);
}

// The same, in UTF-16, with the count in characters.
fn wide(out: &mut Vec<u8>, s: &str) {
    let units: Vec<u16> = s.encode_utf16().collect();
    out.extend_from_slice(&(units.len() as u32 + 1).to_le_bytes());
    for u in &units {
        out.extend_from_slice(&u.to_le_bytes());
    }
    out.extend_from_slice(&0u16.to_le_bytes());
}

// \x01CompObj (MS-OLEDS 2.3.7): a 28-byte header, then the user type, the clipboard format
// and the ProgID, in ANSI and then again in Unicode.
fn comp_obj() -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(&0xfffe_0001u32.to_le_bytes()); // byte order and version
    v.extend_from_slice(&0x0000_0a03u32.to_le_bytes()); // on Windows
    v.extend_from_slice(&(-1i32).to_le_bytes()); // Windows version, unused
    v.extend_from_slice(&[0u8; 16]); // Reserved CLSID, zero
    ansi(&mut v, USER_TYPE);
    ansi(&mut v, ""); // no ANSI clipboard format
    ansi(&mut v, PROGID);
    v.extend_from_slice(&0x71b2_39f4u32.to_le_bytes()); // the marker that Unicode follows
    wide(&mut v, USER_TYPE);
    wide(&mut v, "");
    wide(&mut v, PROGID);
    v
}

// \x01Ole (MS-OLEDS 2.3.3): an embedded object, no moniker, nothing to update.
fn ole_stream() -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(&0x0200_0001u32.to_le_bytes()); // Version
    v.extend_from_slice(&0u32.to_le_bytes()); // Flags: embedded
    v.extend_from_slice(&0u32.to_le_bytes()); // LinkUpdateOption
    v.extend_from_slice(&0u32.to_le_bytes()); // Reserved1
    v.extend_from_slice(&0u32.to_le_bytes()); // ReservedMonikerStreamSize
    v
}

// \x02OlePres000 (MS-OLEDS 2.3.4): the picture the host draws. An enhanced metafile, at
// `w` by `h` in HIMETRIC units (0.01 mm), which is how OLE measures everything.
fn presentation(emf: &[u8], w: i32, h: i32) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(&0xffff_ffffu32.to_le_bytes()); // a standard format follows, not a name
    v.extend_from_slice(&CF_ENHMETAFILE.to_le_bytes());
    v.extend_from_slice(&4u32.to_le_bytes()); // TargetDeviceSize: none
    v.extend_from_slice(&1u32.to_le_bytes()); // Aspect: DVASPECT_CONTENT
    v.extend_from_slice(&(-1i32).to_le_bytes()); // Lindex
    v.extend_from_slice(&0u32.to_le_bytes()); // Advf
    v.extend_from_slice(&0u32.to_le_bytes()); // Reserved1
    v.extend_from_slice(&w.to_le_bytes());
    v.extend_from_slice(&h.to_le_bytes());
    v.extend_from_slice(&(emf.len() as u32).to_le_bytes());
    v.extend_from_slice(emf);
    v
}

/// The "Embed Source" format: the whole object as a compound file.
///
/// `drawing` is what Octet needs to open it again (the bytes of a .oct), and `emf` is the
/// picture the document shows until Octet is asked to edit it. `w` and `h` are HIMETRIC.
pub fn embed_source(drawing: &[u8], emf: &[u8], w: i32, h: i32) -> Result<Vec<u8>, String> {
    let mut file = cfb::CompoundFile::create(Cursor::new(Vec::new())).map_err(|e| e.to_string())?;
    file.set_storage_clsid("/", uuid_of(CLSID)).map_err(|e| e.to_string())?;
    for (name, bytes) in [
        ("\u{1}CompObj", comp_obj()),
        ("\u{1}Ole", ole_stream()),
        ("\u{2}OlePres000", presentation(emf, w, h)),
        ("CONTENTS", drawing.to_vec()),
    ] {
        let mut s = file.create_stream(name).map_err(|e| e.to_string())?;
        s.write_all(&bytes).map_err(|e| e.to_string())?;
        s.flush().map_err(|e| e.to_string())?;
    }
    Ok(file.into_inner().into_inner())
}

/// The drawing's size in HIMETRIC, taken from the EMF's own frame.
///
/// OLE measures everything in hundredths of a millimetre, and an EMF's `rclFrame` is
/// already in exactly those units (MS-EMF 2.2.9), so this is a subtraction rather than a
/// conversion. Bytes 24..40 of the header are left, top, right, bottom.
pub fn himetric_of(emf: &[u8]) -> (i32, i32) {
    let at = |k: usize| -> i32 {
        emf.get(k..k + 4).and_then(|b| b.try_into().ok()).map(i32::from_le_bytes).unwrap_or(0)
    };
    let (w, h) = (at(32) - at(24), at(36) - at(28));
    // A drawing with no size would make an object Word cannot place; fall back to 1 cm.
    (if w > 0 { w } else { 1000 }, if h > 0 { h } else { 1000 })
}

/// The "Object Descriptor" format (MS-OLEDS 2.2.1): what the object is, so the host can
/// name it in Paste Special and size it before it has drawn anything.
pub fn object_descriptor(w: i32, h: i32) -> Vec<u8> {
    let name: Vec<u16> = USER_TYPE.encode_utf16().chain(std::iter::once(0)).collect();
    let head = 4 + 16 + 4 + 8 + 8 + 4 + 4 + 4; // cbSize..dwSrcOfCopy
    let mut v = Vec::with_capacity(head + name.len() * 2);
    v.extend_from_slice(&((head + name.len() * 2) as u32).to_le_bytes()); // cbSize
    v.extend_from_slice(&CLSID);
    v.extend_from_slice(&1u32.to_le_bytes()); // dwDrawAspect: DVASPECT_CONTENT
    v.extend_from_slice(&w.to_le_bytes()); // sizel.cx, HIMETRIC
    v.extend_from_slice(&h.to_le_bytes()); // sizel.cy
    v.extend_from_slice(&0i32.to_le_bytes()); // pointl.x
    v.extend_from_slice(&0i32.to_le_bytes()); // pointl.y
    v.extend_from_slice(&0u32.to_le_bytes()); // dwStatus
    v.extend_from_slice(&(head as u32).to_le_bytes()); // dwFullUserTypeName: the name follows
    v.extend_from_slice(&0u32.to_le_bytes()); // dwSrcOfCopy: none
    for u in &name {
        v.extend_from_slice(&u.to_le_bytes());
    }
    v
}

// cfb wants a uuid::Uuid; OLE writes a CLSID in its mixed-endian form, which Uuid handles.
fn uuid_of(b: [u8; 16]) -> uuid::Uuid {
    uuid::Uuid::from_fields(
        u32::from_le_bytes([b[0], b[1], b[2], b[3]]),
        u16::from_le_bytes([b[4], b[5]]),
        u16::from_le_bytes([b[6], b[7]]),
        &[b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15]],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_embed_source_is_a_compound_file_with_a_picture_in_it() {
        let emf = b"not really an EMF, but bytes".to_vec();
        let out = embed_source(b"<CDXML/>", &emf, 2000, 1500).unwrap();
        // A compound file, by its signature.
        assert_eq!(&out[..8], &[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
        let mut f = cfb::CompoundFile::open(Cursor::new(out)).unwrap();
        let names: Vec<String> = f.walk().map(|e| e.name().to_string()).collect();
        for want in ["\u{1}CompObj", "\u{1}Ole", "\u{2}OlePres000", "CONTENTS"] {
            assert!(names.iter().any(|n| n == want), "{want} is there: {names:?}");
        }
        // The presentation really carries the picture, after its header.
        let mut s = f.open_stream("\u{2}OlePres000").unwrap();
        let mut got = Vec::new();
        std::io::Read::read_to_end(&mut s, &mut got).unwrap();
        assert!(got.ends_with(&emf), "the EMF is the tail of the presentation stream");
        assert_eq!(u32::from_le_bytes(got[4..8].try_into().unwrap()), CF_ENHMETAFILE);
    }

    #[test]
    fn the_object_descriptor_names_the_class_and_its_size() {
        let d = object_descriptor(2000, 1500);
        assert_eq!(u32::from_le_bytes(d[..4].try_into().unwrap()) as usize, d.len());
        assert_eq!(&d[4..20], &CLSID);
        assert_eq!(i32::from_le_bytes(d[24..28].try_into().unwrap()), 2000);
        assert_eq!(i32::from_le_bytes(d[28..32].try_into().unwrap()), 1500);
        // The name sits where dwFullUserTypeName says it does. That field is at 44:
        // cbSize 0, CLSID 4, dwDrawAspect 20, sizel 24, pointl 32, dwStatus 40,
        // dwFullUserTypeName 44, dwSrcOfCopy 48.
        assert_eq!(u32::from_le_bytes(d[48..52].try_into().unwrap()), 0, "dwSrcOfCopy is none");
        let at = u32::from_le_bytes(d[44..48].try_into().unwrap()) as usize;
        let tail: Vec<u16> = d[at..].chunks(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        assert_eq!(String::from_utf16_lossy(&tail).trim_end_matches('\0'), USER_TYPE);
    }
}
