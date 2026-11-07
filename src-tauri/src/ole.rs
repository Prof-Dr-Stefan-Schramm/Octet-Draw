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
// The clipboard format, aspect, medium and direction an embedded drawing is offered on, the
// numbers the registration and the presentation stream both need (wingdi.h, objidl.h).
const CF_ENHMETAFILE: u32 = 14;
const CF_METAFILEPICT: u32 = 3;
const DVASPECT_CONTENT: u32 = 1;
const TYMED_ENHMF: u32 = 64;
const TYMED_MFPICT: u32 = 32;
const DATADIR_GET: u32 = 1;

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
    v.extend_from_slice(&DVASPECT_CONTENT.to_le_bytes()); // Aspect
    v.extend_from_slice(&(-1i32).to_le_bytes()); // Lindex
    v.extend_from_slice(&0u32.to_le_bytes()); // Advf
    v.extend_from_slice(&0u32.to_le_bytes()); // Reserved1
    v.extend_from_slice(&w.to_le_bytes());
    v.extend_from_slice(&h.to_le_bytes());
    v.extend_from_slice(&(emf.len() as u32).to_le_bytes());
    v.extend_from_slice(emf);
    v
}

/// The name of the stream Octet keeps its own drawing in.
pub const CONTENTS: &str = "CONTENTS";

/// The four streams an embedded Octet drawing is made of, in the order they are written.
///
/// `drawing` is what Octet needs to open it again (the bytes of a .oct), and `emf` is the
/// picture the document shows until Octet is asked to edit it. `w` and `h` are HIMETRIC.
///
/// Both ways of handing over an object use this: the clipboard, which puts the streams in a
/// compound file of its own (`embed_source`), and the server, which writes them into the
/// storage the host gives it (`ole_server`). They have to agree, or a drawing pasted into
/// Word and a drawing saved from Word would not be the same object.
pub fn streams(drawing: &[u8], emf: &[u8], w: i32, h: i32) -> Vec<(&'static str, Vec<u8>)> {
    vec![
        ("\u{1}CompObj", comp_obj()),
        ("\u{1}Ole", ole_stream()),
        ("\u{2}OlePres000", presentation(emf, w, h)),
        (CONTENTS, drawing.to_vec()),
    ]
}

/// The "Embed Source" format: the whole object as a compound file.
pub fn embed_source(drawing: &[u8], emf: &[u8], w: i32, h: i32) -> Result<Vec<u8>, String> {
    let mut file = cfb::CompoundFile::create(Cursor::new(Vec::new())).map_err(|e| e.to_string())?;
    file.set_storage_clsid("/", uuid_of(CLSID)).map_err(|e| e.to_string())?;
    for (name, bytes) in streams(drawing, emf, w, h) {
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

/// The class registration, as a flat list of (subkey, value name, data).
///
/// Under `HKEY_CURRENT_USER\Software\Classes`, which needs no administrator and no
/// installer: Windows merges it into `HKEY_CLASSES_ROOT` for this user. An all-users
/// install can write the same table to `HKEY_LOCAL_MACHINE` instead.
///
/// Modelled on what ChemDraw 25.5 registers on the bench machine, which is the shape Word
/// expects: an out-of-process server with ole32.dll as the in-process handler, `Insertable`
/// so it appears in Insert > Object, and the two verbs Word shows in the object's menu.
///
/// `exe` is the full path to Octet. The server is started with `-Embedding`, which is how
/// Windows tells a program it was launched to serve an object rather than by a user.
pub fn registration(exe: &str) -> Vec<(String, Option<&'static str>, String)> {
    let guid = guid_string(CLSID);
    let clsid = format!("CLSID\\{guid}");
    let mut keys = vec![
        (clsid.clone(), None, USER_TYPE.to_string()),
        (format!("{clsid}\\LocalServer32"), None, format!("\"{exe}\" -Embedding")),
        // The standard handler. It draws the cached picture when Octet is not running,
        // which is what stops an embedded drawing showing as an empty frame.
        (format!("{clsid}\\InprocHandler32"), None, "ole32.dll".to_string()),
        (format!("{clsid}\\ProgID"), None, PROGID.to_string()),
        (format!("{clsid}\\VersionIndependentProgID"), None, "OctetDraw.Drawing".to_string()),
        (format!("{clsid}\\Insertable"), None, String::new()),
        (format!("{clsid}\\DefaultIcon"), None, format!("{exe},0")),
        // AuxUserType\2 is the short name Word puts in its menus, \3 the program's name.
        (format!("{clsid}\\AuxUserType\\2"), None, "Octet Draw".to_string()),
        (format!("{clsid}\\AuxUserType\\3"), None, "Octet Draw".to_string()),
        // The verbs, in the order the object's menu shows them. "0,2" is: no menu flags,
        // and the verb may be run on an object that is not already active.
        (format!("{clsid}\\Verb\\0"), None, "&Edit,0,2".to_string()),
        (format!("{clsid}\\Verb\\1"), None, "&Open,0,2".to_string()),
        // What the object can give a host, as format,aspect,medium,direction: an enhanced
        // metafile (CF_ENHMETAFILE) of its content (DVASPECT_CONTENT) on an enhanced
        // metafile handle (TYMED_ENHMF), which the object can give but not take.
        //
        // The medium has to be TYMED_ENHMF, 64. It said 32 — TYMED_GDI, a bitmap handle —
        // and that one wrong number was enough: Word read this entry, asked GetData for a
        // metafile on a bitmap medium, got DV_E_FORMATETC because that is not a medium Octet
        // has, and refused to insert the object at all, reporting only "command failed".
        (
            format!("{clsid}\\DataFormats\\GetSet\\0"),
            None,
            format!("{CF_ENHMETAFILE},{DVASPECT_CONTENT},{TYMED_ENHMF},{DATADIR_GET}"),
        ),
        // And the old Windows metafile, which is the one a host's cache actually asks for.
        (
            format!("{clsid}\\DataFormats\\GetSet\\1"),
            None,
            format!("{CF_METAFILEPICT},{DVASPECT_CONTENT},{TYMED_MFPICT},{DATADIR_GET}"),
        ),
        (format!("{clsid}\\DataFormats\\DefaultFile"), None, format!("{CF_METAFILEPICT}")),
        // The ProgID side, so Insert > Object can find the class by name.
        (PROGID.to_string(), None, USER_TYPE.to_string()),
        (format!("{PROGID}\\CLSID"), None, guid.clone()),
        (format!("{PROGID}\\Insertable"), None, String::new()),
        ("OctetDraw.Drawing".to_string(), None, USER_TYPE.to_string()),
        ("OctetDraw.Drawing\\CLSID".to_string(), None, guid),
    ];
    keys.sort_by(|a, b| a.0.cmp(&b.0));
    keys
}

/// Writes the class registration, so Windows can find Octet when a host asks for the class.
///
/// Under `HKEY_CURRENT_USER\Software\Classes`: no administrator, no installer, and
/// `unregister` takes it away again. Written at every start rather than once at install
/// time, so `LocalServer32` still names the right file after Octet is moved, renamed or
/// updated. A stale path there is what makes Windows say the server application cannot be
/// found, and an embedded object unopenable.
///
/// Registering must never stop Octet starting, so the caller logs the error and carries on.
#[cfg(windows)]
pub fn register(exe: &str) -> Result<(), String> {
    write_registration(&classes_key()?, exe)
}

/// Takes the registration away again: the three trees `register` writes, and nothing else.
/// The uninstaller's half of `register`; nothing in the running app calls it.
#[allow(dead_code)]
#[cfg(windows)]
pub fn unregister() -> Result<(), String> {
    remove_registration(&classes_key()?)
}

#[cfg(windows)]
fn classes_key() -> Result<windows_registry::Key, String> {
    windows_registry::CURRENT_USER
        .create(r"Software\Classes")
        .map_err(|why| format!(r"Software\Classes: {why}"))
}

// The two halves, against any root key, so a test can use a scratch one instead of the
// live class registration.
#[cfg(windows)]
fn write_registration(root: &windows_registry::Key, exe: &str) -> Result<(), String> {
    for (subkey, name, data) in registration(exe) {
        let key = root.create(&subkey).map_err(|why| format!("{subkey}: {why}"))?;
        key.set_string(name.unwrap_or(""), &data).map_err(|why| format!("{subkey}: {why}"))?;
    }
    Ok(())
}

#[cfg(windows)]
fn remove_registration(root: &windows_registry::Key) -> Result<(), String> {
    for tree in [format!(r"CLSID\{}", guid_string(CLSID)), PROGID.to_string(), "OctetDraw.Drawing".to_string()] {
        if let Err(why) = root.remove_tree(&tree) {
            // Already gone is the state we wanted.
            if root.open(&tree).is_ok() {
                return Err(format!("{tree}: {why}"));
            }
        }
    }
    Ok(())
}

/// `{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}`, as the registry writes a class id.
pub fn guid_string(b: [u8; 16]) -> String {
    format!(
        "{{{:08X}-{:04X}-{:04X}-{:02X}{:02X}-{:02X}{:02X}{:02X}{:02X}{:02X}{:02X}}}",
        u32::from_le_bytes([b[0], b[1], b[2], b[3]]),
        u16::from_le_bytes([b[4], b[5]]),
        u16::from_le_bytes([b[6], b[7]]),
        b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15]
    )
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
    fn the_registration_has_what_word_needs_to_activate_an_object() {
        let keys = registration(r"C:\Program Files\Octet\octet.exe");
        let at = |k: &str| keys.iter().find(|(n, _, _)| n == k).map(|(_, _, v)| v.clone());
        let guid = guid_string(CLSID);
        // The server, started the way Windows starts one.
        assert_eq!(
            at(&format!("CLSID\\{guid}\\LocalServer32")).as_deref(),
            Some(r#""C:\Program Files\Octet\octet.exe" -Embedding"#)
        );
        // The standard handler draws the cached picture while Octet is not running.
        assert_eq!(at(&format!("CLSID\\{guid}\\InprocHandler32")).as_deref(), Some("ole32.dll"));
        // Insert > Object finds it, by class and by name.
        assert!(at(&format!("CLSID\\{guid}\\Insertable")).is_some());
        assert_eq!(at(&format!("{PROGID}\\CLSID")).as_deref(), Some(guid.as_str()));
        assert_eq!(at(&format!("CLSID\\{guid}\\ProgID")).as_deref(), Some(PROGID));
        // The verbs the object's menu shows, in order, as ChemDraw registers its own.
        assert_eq!(at(&format!("CLSID\\{guid}\\Verb\\0")).as_deref(), Some("&Edit,0,2"));
        assert_eq!(at(&format!("CLSID\\{guid}\\Verb\\1")).as_deref(), Some("&Open,0,2"));
        // Nothing is written outside the class and its ProgIDs.
        for (k, _, _) in &keys {
            assert!(
                k.starts_with("CLSID\\") || k.starts_with("OctetDraw.Drawing"),
                "{k} is under the class or its ProgID"
            );
        }
    }

    #[test]
    fn the_class_id_reads_as_a_guid() {
        // Fixed for ever once a document holds it: this is a change-detector on purpose.
        assert_eq!(guid_string(CLSID), "{5E8A3F2D-149C-B247-A671-0E83D5C91140}");
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

    #[test]
    fn the_registration_offers_the_picture_on_a_medium_octet_can_give() {
        let keys = registration(r"C:\Octet\octet.exe");
        let (_, _, formats) = keys.iter().find(|(k, ..)| k.ends_with(r"DataFormats\GetSet\0")).expect("a data format");
        // format, aspect, medium, direction. The medium is the one that matters: a metafile
        // offered on a bitmap medium makes a host ask for something Octet has not got, and
        // Word then refuses the object outright.
        assert_eq!(formats, "14,1,64,1");
        // And the old Windows metafile, on the medium that goes with it: this is the format
        // Word's cache asks GetData for, and the object has to be able to give it.
        let (_, _, old_style) = keys.iter().find(|(k, ..)| k.ends_with(r"DataFormats\GetSet\1")).expect("a second data format");
        assert_eq!(old_style, "3,1,32,1");
        // No MiscStatus: ChemDraw registers none either, and OLE reads no flags as none.
        assert!(!keys.iter().any(|(k, ..)| k.ends_with("MiscStatus")), "no MiscStatus key");
        // The verbs a host shows in the object's menu, and nothing else.
        let verbs: Vec<&str> = keys.iter().filter(|(k, ..)| k.contains(r"\Verb\")).map(|(_, _, v)| v.as_str()).collect();
        assert_eq!(verbs, ["&Edit,0,2", "&Open,0,2"]);
    }

    #[test]
    #[cfg(windows)]
    fn the_registration_is_written_and_taken_away_again() {
        // Against a scratch key, never the live class registration, so running the tests
        // cannot break an Octet that is installed on the same computer.
        let root = windows_registry::CURRENT_USER
            .create(r"Software\Octet Draw\ole-registration-test")
            .expect("a scratch key");
        let exe = r"C:\Program Files\Octet Draw\Octet Draw.exe";
        write_registration(&root, exe).expect("written");

        let clsid = format!(r"CLSID\{}", guid_string(CLSID));
        let class = root.open(&clsid).expect("the class key");
        assert_eq!(class.get_string("").unwrap(), USER_TYPE);
        // The server line is what makes a double-click able to start Octet: the full path
        // in quotes, then -Embedding.
        assert_eq!(
            root.open(format!(r"{clsid}\LocalServer32")).unwrap().get_string("").unwrap(),
            format!("\"{exe}\" -Embedding"),
        );
        // ole32.dll draws the cached picture when Octet is not running.
        assert_eq!(root.open(format!(r"{clsid}\InprocHandler32")).unwrap().get_string("").unwrap(), "ole32.dll");
        // Insert > Object finds the class by name, and the name finds the class id back.
        assert!(root.open(format!(r"{clsid}\Insertable")).is_ok());
        assert_eq!(root.open(format!(r"{PROGID}\CLSID")).unwrap().get_string("").unwrap(), guid_string(CLSID));
        assert_eq!(root.open(r"OctetDraw.Drawing\CLSID").unwrap().get_string("").unwrap(), guid_string(CLSID));

        // Written twice over is the same as written once: Octet registers at every start.
        write_registration(&root, exe).expect("written again");
        assert_eq!(root.open(&clsid).unwrap().get_string("").unwrap(), USER_TYPE);

        remove_registration(&root).expect("taken away");
        assert!(root.open(&clsid).is_err(), "the class key is gone");
        assert!(root.open(PROGID).is_err(), "the ProgID is gone");
        assert!(root.open("OctetDraw.Drawing").is_err(), "the version-independent ProgID is gone");
        // Taking away what is not there is not an error.
        remove_registration(&root).expect("taken away twice");

        let _ = windows_registry::CURRENT_USER.remove_tree(r"Software\Octet Draw\ole-registration-test");
    }
}
