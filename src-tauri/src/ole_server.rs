// Octet as an OLE server on Windows: double-click a drawing in Word and Octet opens it,
// edit it, and Word's picture changes (issue #24).
//
// ole.rs makes the object: the streams that hold a drawing and the picture a host shows.
// This file is the other half, the part that answers when a host wants the drawing edited.
//
// What happens when the user double-clicks an embedded drawing in Word:
//
//   1. Word reads our class id from the object's storage and asks COM for the class.
//   2. COM reads LocalServer32 from the registration (ole.rs register) and starts Octet
//      with -Embedding, unless an Octet is already running and has registered its factory.
//   3. Word gets IClassFactory and asks it for an object.
//   4. IPersistStorage::Load reads the CONTENTS stream: the drawing, as a .oct holds it.
//   5. IOleObject::SetClientSite, then DoVerb, and we open an Octet window on the drawing.
//   6. The user edits and saves. The window hands the drawing back (`embedded_save`), we
//      ask the client site to save us, Word calls IPersistStorage::Save, and we write the
//      streams again — the new drawing AND a new cached picture, so the page changes.
//   7. The window closes, we tell the site, and Word takes its object back.
//
// Octet is an "outside-in" server, as ChemDraw is: it edits in a window of its own rather
// than inside Word's page. That is why GetMiscStatus returns no OLEMISC_INSIDEOUT, and why
// the registration has the Edit and Open verbs and nothing else.
//
// Threading, which is the part that has to be right.
//
// The objects live on a thread of their own: a single-threaded apartment with a message-only
// window and a message pump (`offer_class`). COM marshals every call from a host into that
// thread's queue, so the calls arrive one at a time and in order, and the objects can hold
// plain `RefCell` state and the host's own interface pointers.
//
// That only holds because every object a host is given says `Agile = false`. windows-rs makes
// an implemented object agile by default: it answers IAgileObject and hands out an IMarshal
// that marshals it to any apartment, which tells COM the object is safe to call anywhere, so
// calls are delivered on RPC worker threads instead of here. This was written that way at
// first and it broke quietly in both directions: the `RefCell` state was touched by two
// threads at once, and a pointer the host passed in — IOleClientSite — belonged to the RPC
// thread that passed it, so calling it back from here failed with RPC_E_WRONG_THREAD
// (0x8001010E). In Word that looked like a page that never redrew after an edit: SaveObject
// answered that error, so Word never called IPersistStorage::Save and never re-fetched the
// picture.
//
// Registering the class from Tauri's main thread instead does not work, and does not fail
// loudly either: that thread is not an STA, so COM treats Octet as a free-threaded server
// and delivers calls on RPC worker threads, several at once. The first attempt did that, and
// the first call Word made came in on a thread-pool thread and took the process down.
//
// Work crosses into the apartment by posting to its window, never by calling into it:
//   - `hand_back` (from the `embedded_save` command, on a Tauri worker thread) leaves the
//     drawing in HANDBACK and posts WM_HANDBACK.
//   - The task that opens a drawing window leaves its label in WINDOWS and posts WM_OPENED.
// Work crosses the other way through Tauri, which takes calls from any thread: nothing in
// here may block, so DoVerb spawns the window and returns at once.

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use tauri::{AppHandle, Emitter, Manager};
use windows::Win32::Foundation::{E_FAIL, E_NOTIMPL, HWND, LPARAM, LRESULT, RECT, S_FALSE, S_OK, SIZE, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, HWND_MESSAGE, MSG, PostMessageW, PostThreadMessageW, RegisterClassW, WINDOW_EX_STYLE,
    WINDOW_STYLE, WM_APP, WM_QUIT, WNDCLASSW,
};
use windows::Win32::System::Com::StructuredStorage::{IPersistStorage_Impl, IStorage};
use windows::Win32::System::Com::{
    CLSCTX_LOCAL_SERVER, COINIT_APARTMENTTHREADED, CoInitializeEx, CoRegisterClassObject, CoRevokeClassObject, CoUninitialize, CreateDataAdviseHolder,
    DATADIR_GET, DVASPECT, DVASPECT_CONTENT, FORMATETC, IAdviseSink, IClassFactory, IDataAdviseHolder,
    IClassFactory_Impl, IDataObject, IDataObject_Impl, IEnumFORMATETC, IEnumSTATDATA, IMoniker, IPersist_Impl, REGCLS_MULTIPLEUSE, STGMEDIUM,
    IStream, STATFLAG_NONAME, STATSTG, STGC_DEFAULT, STGM, STGM_CREATE, STGM_READ, STGM_READWRITE, STGM_SHARE_EXCLUSIVE, TYMED_ENHMF, TYMED_MFPICT,
};
use windows::Win32::System::Ole::{
    IEnumOLEVERB, IOleAdviseHolder, IOleClientSite, IOleObject_Impl, OLECLOSE, OLECLOSE_NOSAVE, OLEGETMONIKER, OLEMISC, OLEWHICHMK, USERCLASSTYPE,
    USERCLASSTYPE_SHORT,
};
use windows::core::{BOOL, ComObject, GUID, IUnknown, Interface, PCWSTR, PWSTR, Ref, Result, implement};

use crate::ole;

// A line for each call a host makes, when OCTET_OLE_LOG is set in the environment. An OLE
// server can only be watched from the outside — a host calls it, decides it does not like an
// answer, and gives the user "the object cannot be inserted" with nothing to go on — so
// Octet can say what it was asked and what it answered. Off, it costs one read of a static.
static TRACING: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

pub fn tracing() -> bool {
    *TRACING.get_or_init(|| std::env::var_os("OCTET_OLE_LOG").is_some())
}

macro_rules! trace {
    ($($arg:tt)*) => {
        if crate::ole_server::tracing() {
            eprintln!("octet ole: {}", format_args!($($arg)*));
        }
    };
}

// OLE's verbs (ole2.h). Word sends PRIMARY for a double-click and OPEN for Object > Open.
const OLEIVERB_PRIMARY: i32 = 0;
const OLEIVERB_SHOW: i32 = -1;
const OLEIVERB_OPEN: i32 = -2;
const OLEIVERB_HIDE: i32 = -3;
const CF_ENHMETAFILE: u16 = 14;
// The old Windows metafile, in a METAFILEPICT. This is the one a host's cache asks for:
// Word's cache asked GetData for format 3 on TYMED_MFPICT and nothing else, and refused the
// object outright when Octet offered only the enhanced metafile. ChemDraw registers no data
// formats at all and works, which is the clue: what matters is what the object will GIVE,
// not what it advertises.
const CF_METAFILEPICT: u16 = 3;

// What the apartment is told to do, each posted to its window.
const WM_HANDBACK: u32 = WM_APP + 1;
const WM_OPENED: u32 = WM_APP + 2;

// The next edit's number, the drawings waiting to go back to a host, the windows waiting to
// be noted against their object, and the apartment itself.
static NEXT: AtomicU64 = AtomicU64::new(1);
static HANDBACK: Mutex<Option<HashMap<u64, Handback>>> = Mutex::new(None);
static WINDOWS: Mutex<Option<HashMap<u64, String>>> = Mutex::new(None);
static APARTMENT: Mutex<Option<Apartment>> = Mutex::new(None);

// Where to post work for the objects. The window handle is kept as an integer because an
// HWND is not Send, and posting to a window is safe from any thread.
struct Apartment {
    window: isize,
    thread: u32,
}

fn post(message: u32, edit: u64) {
    let window = APARTMENT.lock().unwrap().as_ref().map(|a| a.window);
    if let Some(window) = window {
        let _ = unsafe { PostMessageW(Some(HWND(window as *mut _)), message, WPARAM(edit as usize), LPARAM(0)) };
    }
}

// What a drawing window hands back: a drawing to save, if any, and whether the edit is
// over. Ending the edit carries no drawing, so "Don't Save" cannot save by accident: the
// document keeps whatever the last handback with a drawing gave it.
struct Handback {
    drawing: Option<(String, Vec<u8>)>,
    closing: bool,
}

thread_local! {
    // The objects this process is serving, by edit number. On the apartment's thread only:
    // a COM object made in an STA belongs to the thread that made it, and every call for it
    // arrives there.
    static LIVE: RefCell<HashMap<u64, ComObject<Drawing>>> = RefCell::new(HashMap::new());
}

/// True when Windows started this Octet to serve an embedded object rather than for a
/// person: then no Home window opens, and Octet ends when the host lets go of the object.
pub fn embedding(args: impl IntoIterator<Item = std::ffi::OsString>) -> bool {
    args.into_iter().any(|a| {
        let a = a.to_string_lossy().to_ascii_lowercase();
        a == "-embedding" || a == "/embedding"
    })
}

/// Offers the class to COM on a thread of its own, so a host can ask for an embedded drawing.
///
/// Called at every start, not only with -Embedding: an Octet that is already running then
/// serves the double-click itself, instead of Windows starting a second copy.
///
/// The thread is the apartment the objects live in. It initialises COM as a single-threaded
/// apartment, makes a message-only window to take work from the rest of Octet, registers the
/// class and pumps messages until Octet ends. REGCLS_MULTIPLEUSE: one Octet serves every
/// object every host asks for.
///
/// Returns once the class is registered, or with the error that stopped it.
pub fn offer_class(app: &AppHandle) -> Result<()> {
    if APARTMENT.lock().unwrap().is_some() {
        return Ok(());
    }
    let (tell, listen) = std::sync::mpsc::channel::<std::result::Result<(isize, u32), String>>();
    let app = app.clone();
    std::thread::Builder::new()
        .name("octet-ole".into())
        .spawn(move || apartment(app, tell))
        .map_err(|why| windows::core::Error::new(E_FAIL, why.to_string()))?;
    match listen.recv() {
        Ok(Ok((window, thread))) => {
            *APARTMENT.lock().unwrap() = Some(Apartment { window, thread });
            Ok(())
        }
        Ok(Err(why)) => Err(windows::core::Error::new(E_FAIL, why)),
        Err(why) => Err(windows::core::Error::new(E_FAIL, why.to_string())),
    }
}

// The apartment's thread, start to finish.
fn apartment(app: AppHandle, tell: std::sync::mpsc::Sender<std::result::Result<(isize, u32), String>>) {
    let started = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    if started.is_err() {
        let _ = tell.send(Err(format!("COM refused an apartment: {started:?}")));
        return;
    }
    let outcome = (|| -> Result<(HWND, u32)> {
        let instance = unsafe { GetModuleHandleW(None)? };
        let name = windows::core::w!("OctetDrawOleApartment");
        let class = WNDCLASSW { lpfnWndProc: Some(handle_message), hInstance: instance.into(), lpszClassName: name, ..Default::default() };
        // Registering the same class twice is no reason to stop: the window below is what
        // fails if the class really is not there.
        unsafe { RegisterClassW(&class) };
        let window = unsafe {
            CreateWindowExW(WINDOW_EX_STYLE(0), name, name, WINDOW_STYLE(0), 0, 0, 0, 0, Some(HWND_MESSAGE), None, Some(instance.into()), None)?
        };
        let factory: IClassFactory = ComObject::new(Factory { app }).into_interface();
        let cookie = unsafe { CoRegisterClassObject(&guid(), &factory, CLSCTX_LOCAL_SERVER, REGCLS_MULTIPLEUSE)? };
        // The factory lives as long as the thread does, which is as long as Octet does, and
        // COM is told when that ends (withdraw_class).
        std::mem::forget(factory);
        Ok((window, cookie))
    })();
    let (window, cookie) = match outcome {
        Ok(got) => got,
        Err(why) => {
            let _ = tell.send(Err(why.to_string()));
            unsafe { CoUninitialize() };
            return;
        }
    };
    let _ = tell.send(Ok((window.0 as isize, unsafe { GetCurrentThreadId() })));

    // The pump. Every call from a host, and every piece of work the rest of Octet posts,
    // comes through here, one at a time.
    let mut message = MSG::default();
    while unsafe { GetMessageW(&mut message, None, 0, 0) }.as_bool() {
        unsafe { DispatchMessageW(&message) };
    }
    let _ = unsafe { CoRevokeClassObject(cookie) };
    unsafe { CoUninitialize() };
}

// The apartment's window: the work the rest of Octet posts to it.
unsafe extern "system" fn handle_message(window: HWND, message: u32, edit: WPARAM, extra: LPARAM) -> LRESULT {
    match message {
        WM_HANDBACK => {
            finish(edit.0 as u64);
            LRESULT(0)
        }
        WM_OPENED => {
            window_opened(edit.0 as u64);
            LRESULT(0)
        }
        _ => unsafe { DefWindowProcW(window, message, edit, extra) },
    }
}

/// Takes the class back as Octet ends, by asking the apartment to stop pumping. Callable
/// from any thread.
pub fn withdraw_class() {
    if let Some(apartment) = APARTMENT.lock().unwrap().take() {
        let _ = unsafe { PostThreadMessageW(apartment.thread, WM_QUIT, WPARAM(0), LPARAM(0)) };
    }
}

// Octet's class id, as COM wants it: the same sixteen bytes ole.rs writes.
fn guid() -> GUID {
    GUID::from_values(
        u32::from_le_bytes([ole::CLSID[0], ole::CLSID[1], ole::CLSID[2], ole::CLSID[3]]),
        u16::from_le_bytes([ole::CLSID[4], ole::CLSID[5]]),
        u16::from_le_bytes([ole::CLSID[6], ole::CLSID[7]]),
        [ole::CLSID[8], ole::CLSID[9], ole::CLSID[10], ole::CLSID[11], ole::CLSID[12], ole::CLSID[13], ole::CLSID[14], ole::CLSID[15]],
    )
}

// ---------------------------------------------------------------------------------------
// The handback from a drawing window
// ---------------------------------------------------------------------------------------

/// A drawing window that is editing an embedded object hands its drawing back.
///
/// Called from the `embedded_save` command, on a Tauri worker thread, so it only leaves the
/// drawing where the apartment can find it and posts to say so.
pub fn hand_back(edit: u64, drawing: Option<(String, Vec<u8>)>, closing: bool) {
    HANDBACK.lock().unwrap().get_or_insert_with(HashMap::new).insert(edit, Handback { drawing, closing });
    post(WM_HANDBACK, edit);
}

// In the apartment: give the host what the window handed back.
fn finish(edit: u64) {
    let Some(given) = HANDBACK.lock().unwrap().as_mut().and_then(|m| m.remove(&edit)) else { return };
    let object = LIVE.with(|live| live.borrow().get(&edit).cloned());
    let Some(object) = object else { return };
    let saved = match given.drawing {
        None => true, // nothing to save: the edit is simply over
        Some((text, emf)) => {
            let (site, holder) = {
                let mut state = object.get().state.borrow_mut();
                state.drawing = text;
                state.emf = emf;
                state.dirty = true;
                (state.site.clone(), state.advise.clone())
            };
            // Asking the site to save us makes the host call IPersistStorage::Save, which is
            // where the new streams are written. Then OnSave tells it to redraw the page.
            // Nothing is borrowed while that happens: Save comes straight back in here.
            match site {
                Some(site) => {
                    let ok = unsafe { site.SaveObject() }.is_ok();
                    if let Some(holder) = holder {
                        let _ = unsafe { holder.SendOnSave() };
                    }
                    // And the cache, so the picture on the page is drawn again rather than
                    // the one it kept from before the edit.
                    let cache = object.get().state.borrow().data_advise.clone();
                    if let (Some(cache), Ok(me)) = (cache, object.get().cast_self::<IDataObject>()) {
                        let _ = unsafe { cache.SendOnDataChange(&me, None, 0) };
                    }
                    ok
                }
                None => false,
            }
        }
    };
    if given.closing {
        let (site, holder) = {
            let mut state = object.get().state.borrow_mut();
            state.window = None;
            (state.site.clone(), state.advise.clone())
        };
        if let Some(site) = site {
            let _ = unsafe { site.OnShowWindow(false) };
        }
        if let Some(holder) = holder {
            let _ = unsafe { holder.SendOnClose() };
        }
        LIVE.with(|live| live.borrow_mut().remove(&edit));
    }
    if !saved {
        eprintln!("octet: the host would not save the embedded drawing");
    }
}

// ---------------------------------------------------------------------------------------
// The class factory
// ---------------------------------------------------------------------------------------

#[implement(Agile = false, IClassFactory)]
struct Factory {
    app: AppHandle,
}

impl IClassFactory_Impl for Factory_Impl {
    fn CreateInstance(&self, outer: Ref<IUnknown>, iid: *const GUID, out: *mut *mut core::ffi::c_void) -> Result<()> {
        trace!("CreateInstance");
        if out.is_null() {
            return Err(E_FAIL.into());
        }
        unsafe { *out = std::ptr::null_mut() };
        // No aggregation: Octet's object is never part of another.
        if !outer.is_null() {
            return Err(windows::Win32::Foundation::CLASS_E_NOAGGREGATION.into());
        }
        let edit = NEXT.fetch_add(1, Ordering::Relaxed);
        let object = ComObject::new(Drawing {
            app: self.app.clone(),
            edit,
            state: RefCell::new(State::default()),
        });
        LIVE.with(|live| live.borrow_mut().insert(edit, object.clone()));
        unsafe { object.to_interface::<IUnknown>().query(&*iid, out).ok() }
    }

    fn LockServer(&self, _lock: BOOL) -> Result<()> {
        trace!("LockServer");
        // Octet outlives its objects either way: it is a normal app, not a server that ends
        // when the last object goes.
        Ok(())
    }
}

// ---------------------------------------------------------------------------------------
// The object
// ---------------------------------------------------------------------------------------

#[derive(Default)]
struct State {
    drawing: String,       // the drawing, as a .oct holds it
    emf: Vec<u8>,          // the picture the host shows
    dirty: bool,           // edited since the host last saved it
    site: Option<IOleClientSite>,
    advise: Option<IOleAdviseHolder>,
    data_advise: Option<IDataAdviseHolder>,
    window: Option<String>, // the Octet window editing it, if one is open
    extent: Option<SIZE>,   // a size the host set, in HIMETRIC
}

#[implement(Agile = false, windows::Win32::System::Ole::IOleObject, windows::Win32::System::Com::StructuredStorage::IPersistStorage, IDataObject)]
struct Drawing {
    app: AppHandle,
    edit: u64,
    state: RefCell<State>,
}

// An empty frame, for an object created new (Insert > Object) before anything is drawn in
// it. Without one the host asks for a picture, gets nothing, and refuses to insert the
// object at all — which is exactly what Word did. Built through Octet's own SVG and metafile
// writers, so it is the same kind of picture as every other.
//
// 144 by 108 pt: big enough to see on the page and to double-click, and the drawing resizes
// the frame as soon as there is one.
fn blank_picture() -> Vec<u8> {
    const W: u32 = 144;
    const H: u32 = 108;
    let svg = format!(r#"<svg xmlns="http://www.w3.org/2000/svg" width="{W}pt" height="{H}pt" viewBox="0 0 {W} {H}"></svg>"#);
    match crate::export::tree(&svg) {
        Ok(tree) => crate::vector::make_emf(&tree, None),
        Err(why) => {
            trace!("no blank picture: {why}");
            Vec::new()
        }
    }
}

// An enhanced metafile as a METAFILEPICT on an HGLOBAL, which is what a host's cache wants.
//
// GDI converts the records (GetWinMetaFileBits); the METAFILEPICT around them carries the
// size, in HIMETRIC for MM_ANISOTROPIC, so the picture is placed at its true size rather
// than scaled to whatever the host guesses. The handle goes to the host, which frees it.
fn metafile_pict(emf: &[u8], size: SIZE) -> Result<windows::Win32::Foundation::HGLOBAL> {
    use windows::Win32::Graphics::Gdi::{DeleteEnhMetaFile, GetWinMetaFileBits, MM_ANISOTROPIC, SetEnhMetaFileBits, SetMetaFileBitsEx};
    use windows::Win32::System::DataExchange::METAFILEPICT;
    use windows::Win32::System::Memory::{GHND, GlobalAlloc, GlobalLock, GlobalUnlock};

    let enhanced = unsafe { SetEnhMetaFileBits(emf) };
    if enhanced.is_invalid() {
        return Err(E_FAIL.into());
    }
    // A screen DC only to tell GDI what the picture is being converted for; nothing is drawn.
    let screen = unsafe { windows::Win32::Graphics::Gdi::GetDC(None) };
    let bytes = unsafe { GetWinMetaFileBits(enhanced, None, MM_ANISOTROPIC.0, screen) } as usize;
    let old = if bytes == 0 {
        None
    } else {
        let mut buffer = vec![0u8; bytes];
        let got = unsafe { GetWinMetaFileBits(enhanced, Some(&mut buffer), MM_ANISOTROPIC.0, screen) } as usize;
        (got != 0).then_some(buffer)
    };
    if !screen.is_invalid() {
        unsafe { windows::Win32::Graphics::Gdi::ReleaseDC(None, screen) };
    }
    let _ = unsafe { DeleteEnhMetaFile(Some(enhanced)) };
    let Some(old) = old else {
        trace!("GDI cannot turn {} bytes of enhanced metafile into a Windows one", emf.len());
        return Err(E_FAIL.into());
    };

    let metafile = unsafe { SetMetaFileBitsEx(&old) };
    if metafile.is_invalid() {
        return Err(E_FAIL.into());
    }
    let memory = unsafe { GlobalAlloc(GHND, std::mem::size_of::<METAFILEPICT>())? };
    let at = unsafe { GlobalLock(memory) } as *mut METAFILEPICT;
    if at.is_null() {
        return Err(E_FAIL.into());
    }
    unsafe {
        *at = METAFILEPICT { mm: MM_ANISOTROPIC.0, xExt: size.cx, yExt: size.cy, hMF: metafile };
        let _ = GlobalUnlock(memory);
    }
    Ok(memory)
}

impl Drawing {
    // The picture to give a host: the drawing's, or an empty frame while there is no drawing.
    fn picture(&self) -> Vec<u8> {
        let emf = self.state.borrow().emf.clone();
        if emf.is_empty() { blank_picture() } else { emf }
    }

    // The drawing's size in HIMETRIC: what the host set, else the picture's own frame.
    fn size(&self) -> SIZE {
        trace!("size");
        if let Some(size) = self.state.borrow().extent {
            return size;
        }
        let (cx, cy) = ole::himetric_of(&self.picture());
        SIZE { cx, cy }
    }

    // The data advise holder, made the first time a host asks for one.
    fn data_holder(&self) -> Result<IDataAdviseHolder> {
        let holder = self.state.borrow().data_advise.clone();
        match holder {
            Some(holder) => Ok(holder),
            None => {
                let made = unsafe { CreateDataAdviseHolder()? };
                self.state.borrow_mut().data_advise = Some(made.clone());
                Ok(made)
            }
        }
    }

    // This object as one of its own interfaces. The generated *_Impl type cannot cast
    // itself, so it goes through the ComObject the factory kept in LIVE.
    fn cast_self<I: windows::core::Interface>(&self) -> Result<I>
    where
        Drawing_Impl: windows::core::ComObjectInterface<I>,
    {
        LIVE.with(|live| live.borrow().get(&self.edit).map(|o| o.to_interface::<I>())).ok_or_else(|| E_FAIL.into())
    }

    // Opens an Octet window on this drawing, or brings the open one to the front.
    //
    // Spawned, never done here: making a window on the main thread deadlocks Tauri, and a
    // host is entitled to a prompt answer from DoVerb.
    fn edit_in_a_window(&self) -> Result<()> {
        trace!("edit_in_a_window");
        if let Some(label) = self.state.borrow().window.clone() {
            let app = self.app.clone();
            tauri::async_runtime::spawn(async move {
                if let Some(window) = app.get_webview_window(&label) {
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            });
            return Ok(());
        }
        let (app, edit, drawing) = (self.app.clone(), self.edit, self.state.borrow().drawing.clone());
        let start = serde_json::json!({ "embedded": { "edit": edit, "text": drawing } });
        tauri::async_runtime::spawn(async move {
            match crate::windows::new_drawing_window(&app, start).await {
                Ok(label) => {
                    WINDOWS.lock().unwrap().get_or_insert_with(HashMap::new).insert(edit, label);
                    post(WM_OPENED, edit);
                }
                Err(why) => eprintln!("octet: cannot open the embedded drawing: {why}"),
            }
        });
        Ok(())
    }
}

// In the apartment: the drawing window is open, so note it against the object and tell the
// host its object is showing.
fn window_opened(edit: u64) {
    let Some(label) = WINDOWS.lock().unwrap().as_mut().and_then(|m| m.remove(&edit)) else { return };
    let object = LIVE.with(|live| live.borrow().get(&edit).cloned());
    let Some(object) = object else { return };
    let site = {
        let mut state = object.get().state.borrow_mut();
        state.window = Some(label);
        state.site.clone()
    };
    if let Some(site) = site {
        let _ = unsafe { site.OnShowWindow(true) };
    }
}

impl IOleObject_Impl for Drawing_Impl {
    fn SetClientSite(&self, site: Ref<IOleClientSite>) -> Result<()> {
        trace!("SetClientSite");
        self.state.borrow_mut().site = site.cloned();
        Ok(())
    }

    fn GetClientSite(&self) -> Result<IOleClientSite> {
        trace!("GetClientSite");
        self.state.borrow().site.clone().ok_or_else(|| E_FAIL.into())
    }

    fn SetHostNames(&self, _app: &PCWSTR, _object: &PCWSTR) -> Result<()> {
        trace!("SetHostNames");
        // Octet's window is titled after the drawing, not after the document it sits in.
        Ok(())
    }

    fn Close(&self, save: &OLECLOSE) -> Result<()> {
        trace!("Close");
        // Everything is taken out of the state before any call into the host, which is
        // entitled to call back in while it runs.
        let (dirty, site, holder) = {
            let state = self.state.borrow();
            (state.dirty, state.site.clone(), state.advise.clone())
        };
        if let (true, Some(site)) = (*save != OLECLOSE_NOSAVE && dirty, &site) {
            let _ = unsafe { site.SaveObject() };
        }
        if let Some(holder) = &holder {
            let _ = unsafe { holder.SendOnClose() };
        }
        // The window goes with the object: an Octet window left open on a drawing Word no
        // longer holds would save into nothing. The page is told first, so it drops the edit
        // rather than trying to hand the drawing back as it is torn down; destroying the
        // window then makes sure it goes even if the page cannot answer.
        if let Some(label) = self.state.borrow_mut().window.take() {
            tell_window_closed(&self.app, &label);
            let app = self.app.clone();
            tauri::async_runtime::spawn(async move {
                if let Some(window) = app.get_webview_window(&label) {
                    let _ = window.destroy();
                }
            });
        }
        let edit = self.edit;
        self.state.borrow_mut().site = None;
        self.state.borrow_mut().advise = None;
        let _ = self.app.run_on_main_thread(move || {
            LIVE.with(|live| live.borrow_mut().remove(&edit));
        });
        Ok(())
    }

    fn SetMoniker(&self, _which: &OLEWHICHMK, _moniker: Ref<IMoniker>) -> Result<()> {
        trace!("SetMoniker");
        // Octet's objects are embedded, never linked, so they have no name of their own.
        Err(E_NOTIMPL.into())
    }

    fn GetMoniker(&self, _assign: &OLEGETMONIKER, _which: &OLEWHICHMK) -> Result<IMoniker> {
        trace!("GetMoniker");
        Err(E_NOTIMPL.into())
    }

    fn InitFromData(&self, _data: Ref<IDataObject>, _creation: BOOL, _reserved: u32) -> Result<()> {
        trace!("InitFromData");
        // Insert > Object > Create New gives an empty drawing, which InitNew already made.
        Err(E_NOTIMPL.into())
    }

    fn GetClipboardData(&self, _reserved: u32) -> Result<IDataObject> {
        trace!("GetClipboardData");
        // The same object, asked for as a data source: a host that wants the picture rather
        // than the storage gets it from IDataObject::GetData below.
        self.cast_self()
    }

    fn DoVerb(
        &self,
        verb: i32,
        _message: *const windows::Win32::UI::WindowsAndMessaging::MSG,
        site: Ref<IOleClientSite>,
        _index: i32,
        _parent: HWND,
        _rect: *const RECT,
    ) -> Result<()> {
        if self.state.borrow().site.is_none() {
            self.state.borrow_mut().site = site.cloned();
        }
        match verb {
            // Edit and Open both open Octet's own window: Octet does not edit in place.
            OLEIVERB_PRIMARY | OLEIVERB_SHOW | OLEIVERB_OPEN => self.edit_in_a_window(),
            OLEIVERB_HIDE => {
                if let Some(label) = self.state.borrow().window.clone() {
                    let app = self.app.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Some(window) = app.get_webview_window(&label) {
                            let _ = window.hide();
                        }
                    });
                }
                Ok(())
            }
            // A verb Octet does not have. OLEOBJ_S_INVALIDVERB tells the host to fall back
            // to the primary verb, which is the behaviour a user expects.
            _ => Err(windows::core::Error::from_hresult(windows::core::HRESULT(0x0004_0180))),
        }
    }

    fn EnumVerbs(&self) -> Result<IEnumOLEVERB> {
        trace!("EnumVerbs");
        // The host reads the verbs from the registration instead (OLE_S_USEREG).
        Err(windows::core::Error::from_hresult(windows::core::HRESULT(0x0004_0000)))
    }

    fn Update(&self) -> Result<()> {
        trace!("Update");
        // Nothing to update: an embedded drawing has no link to a source.
        Ok(())
    }

    fn IsUpToDate(&self) -> Result<()> {
        trace!("IsUpToDate");
        Ok(())
    }

    fn GetUserClassID(&self) -> Result<GUID> {
        trace!("GetUserClassID");
        Ok(guid())
    }

    fn GetUserType(&self, form: &USERCLASSTYPE) -> Result<PWSTR> {
        trace!("GetUserType");
        let text = if *form == USERCLASSTYPE_SHORT { "Octet Draw" } else { ole::USER_TYPE };
        task_string(text)
    }

    fn SetExtent(&self, _aspect: DVASPECT, size: *const SIZE) -> Result<()> {
        trace!("SetExtent");
        if size.is_null() {
            return Err(E_FAIL.into());
        }
        // Octet's drawings are drawn at their own size, as ChemDraw's are: the host may
        // scale the picture, but the drawing itself does not reflow. Remembering the size
        // keeps GetExtent honest, which is what stops Word resizing the frame on its own.
        self.state.borrow_mut().extent = Some(unsafe { *size });
        Ok(())
    }

    fn GetExtent(&self, _aspect: DVASPECT) -> Result<SIZE> {
        trace!("GetExtent");
        Ok(self.size())
    }

    fn Advise(&self, sink: Ref<IAdviseSink>) -> Result<u32> {
        trace!("Advise");
        // The borrow is taken and dropped before anything else happens. Writing this as
        // `match self.state.borrow().advise.clone() { ... }` reads the same and is not: the
        // scrutinee's borrow lives for the whole match, so taking it again inside an arm
        // panics, and a panic through a COM vtable aborts the process. It did.
        let holder = self.state.borrow().advise.clone();
        let holder = match holder {
            Some(holder) => holder,
            None => {
                let made = unsafe { windows::Win32::System::Ole::CreateOleAdviseHolder()? };
                self.state.borrow_mut().advise = Some(made.clone());
                made
            }
        };
        unsafe { holder.Advise(sink.as_ref()) }
    }

    fn Unadvise(&self, connection: u32) -> Result<()> {
        trace!("Unadvise");
        let holder = self.state.borrow().advise.clone();
        match holder {
            Some(holder) => unsafe { holder.Unadvise(connection) },
            None => Err(E_FAIL.into()),
        }
    }

    fn EnumAdvise(&self) -> Result<IEnumSTATDATA> {
        trace!("EnumAdvise");
        let holder = self.state.borrow().advise.clone();
        match holder {
            Some(holder) => unsafe { holder.EnumAdvise() },
            None => Err(E_FAIL.into()),
        }
    }

    fn GetMiscStatus(&self, _aspect: DVASPECT) -> Result<OLEMISC> {
        trace!("GetMiscStatus");
        // No flags, as the registration's MiscStatus says. In particular no
        // OLEMISC_INSIDEOUT: Octet edits in a window of its own.
        Ok(OLEMISC(0))
    }

    fn SetColorScheme(&self, _palette: *const windows::Win32::Graphics::Gdi::LOGPALETTE) -> Result<()> {
        trace!("SetColorScheme");
        // Octet's drawings carry their own colours.
        Err(E_NOTIMPL.into())
    }
}

impl IPersist_Impl for Drawing_Impl {
    fn GetClassID(&self) -> Result<GUID> {
        trace!("GetClassID");
        Ok(guid())
    }
}

impl IPersistStorage_Impl for Drawing_Impl {
    fn IsDirty(&self) -> windows::core::HRESULT {
        trace!("IsDirty");
        if self.state.borrow().dirty { S_OK } else { S_FALSE }
    }

    fn InitNew(&self, storage: Ref<IStorage>) -> Result<()> {
        trace!("InitNew");
        // Insert > Object > Create New: an empty drawing, with our class on the storage so
        // the host knows whose it is before anything is saved.
        if let Some(storage) = storage.as_ref() {
            let _ = unsafe { storage.SetClass(&guid()) };
        }
        let mut state = self.state.borrow_mut();
        state.drawing = String::new();
        state.emf = blank_picture();
        state.dirty = true;
        Ok(())
    }

    fn Load(&self, storage: Ref<IStorage>) -> Result<()> {
        trace!("Load");
        let storage = storage.ok()?;
        let drawing = read_stream(storage, ole::CONTENTS)?;
        // Nothing here trusts what it reads: the drawing is text the editor parses, with
        // the same limits a file opened from disk gets, and anything else is refused.
        if drawing.len() as u64 > crate::MAX_BYTES {
            return Err(E_FAIL.into());
        }
        self.state.borrow_mut().drawing = String::from_utf8_lossy(&drawing).into_owned();
        // The cached picture, so the object has one to give back before it is edited, and
        // the size that was stored with it. A storage without one is not an error: Save
        // writes a fresh one anyway.
        //
        // The size comes from the stream's own fields, not from the metafile's frame. The
        // frame is rounded up to whole device pixels by the metafile writer, so taking the
        // size from it made an object 8% larger every time it was read back: 144 by 108 pt
        // went in and 156 by 117 came out. The stream records the size on purpose.
        if let Ok(cached) = read_stream(storage, "\u{2}OlePres000") {
            let (emf, size) = picture_of(&cached);
            let mut state = self.state.borrow_mut();
            state.emf = emf;
            if size.is_some() {
                state.extent = size;
            }
        }
        self.state.borrow_mut().dirty = false;
        Ok(())
    }

    fn Save(&self, storage: Ref<IStorage>, _same_as_load: BOOL) -> Result<()> {
        trace!("Save");
        let storage = storage.ok()?;
        let drawing = self.state.borrow().drawing.clone();
        let emf = self.picture();
        let size = self.size();
        if let Err(why) = unsafe { storage.SetClass(&guid()) } {
            trace!("  SetClass: {why}");
            return Err(why);
        }
        for (name, bytes) in ole::streams(drawing.as_bytes(), &emf, size.cx, size.cy) {
            match write_stream(storage, name, &bytes) {
                Ok(()) => trace!("  wrote {name}, {} bytes", bytes.len()),
                Err(why) => {
                    trace!("  {name}: {why}");
                    return Err(why);
                }
            }
        }
        // The streams are in the storage; the host commits it when it is ready.
        trace!("  saved {} characters of drawing and {} of picture", drawing.len(), emf.len());
        self.state.borrow_mut().dirty = false;
        Ok(())
    }

    fn SaveCompleted(&self, _new: Ref<IStorage>) -> Result<()> {
        trace!("SaveCompleted");
        Ok(())
    }

    fn HandsOffStorage(&self) -> Result<()> {
        trace!("HandsOffStorage");
        // Octet keeps the drawing in memory, never a handle on the host's storage, so there
        // is nothing to let go of.
        Ok(())
    }
}

// Octet gives a host one format: an enhanced metafile of the drawing. The host has the
// drawing itself in the storage, so it never needs to ask for it here.
impl IDataObject_Impl for Drawing_Impl {
    fn GetData(&self, wanted: *const FORMATETC) -> Result<STGMEDIUM> {
        if wanted.is_null() {
            trace!("GetData with no format");
            return Err(E_FAIL.into());
        }
        let wanted = unsafe { *wanted };
        trace!("GetData format {} aspect {} lindex {} tymed {}", wanted.cfFormat, wanted.dwAspect, wanted.lindex, wanted.tymed);
        let emf = self.picture();
        let mut medium = STGMEDIUM { tymed: 0, u: unsafe { std::mem::zeroed() }, pUnkForRelease: std::mem::ManuallyDrop::new(None) };
        // The enhanced metafile where a host will take it, and the old one where it insists.
        // Both are the same drawing; the enhanced one keeps more of it.
        if wanted.cfFormat == CF_ENHMETAFILE && wanted.tymed & TYMED_ENHMF.0 as u32 != 0 {
            let handle = unsafe { windows::Win32::Graphics::Gdi::SetEnhMetaFileBits(&emf) };
            if handle.is_invalid() {
                trace!("  SetEnhMetaFileBits refused {} bytes", emf.len());
                return Err(E_FAIL.into());
            }
            trace!("  gave an enhanced metafile of {} bytes", emf.len());
            medium.tymed = TYMED_ENHMF.0 as u32;
            medium.u.hEnhMetaFile = handle;
            return Ok(medium);
        }
        if wanted.cfFormat == CF_METAFILEPICT && wanted.tymed & TYMED_MFPICT.0 as u32 != 0 {
            let memory = metafile_pict(&emf, self.size())?;
            trace!("  gave a METAFILEPICT from {} bytes", emf.len());
            medium.tymed = TYMED_MFPICT.0 as u32;
            medium.u.hGlobal = memory;
            return Ok(medium);
        }
        trace!("  refused: Octet offers format {CF_ENHMETAFILE} on tymed {} and format {CF_METAFILEPICT} on tymed {}", TYMED_ENHMF.0, TYMED_MFPICT.0);
        Err(windows::Win32::Foundation::DV_E_FORMATETC.into())
    }

    fn GetDataHere(&self, _wanted: *const FORMATETC, _medium: *mut STGMEDIUM) -> Result<()> {
        trace!("GetDataHere");
        Err(E_NOTIMPL.into())
    }

    fn QueryGetData(&self, wanted: *const FORMATETC) -> windows::core::HRESULT {
        trace!("QueryGetData");
        if wanted.is_null() {
            return E_FAIL;
        }
        let wanted = unsafe { *wanted };
        if offered().iter().any(|f| f.cfFormat == wanted.cfFormat && wanted.tymed & f.tymed != 0) {
            S_OK
        } else {
            windows::Win32::Foundation::DV_E_FORMATETC
        }
    }

    fn GetCanonicalFormatEtc(&self, _wanted: *const FORMATETC, out: *mut FORMATETC) -> windows::core::HRESULT {
        trace!("GetCanonicalFormatEtc");
        if !out.is_null() {
            unsafe { (*out).ptd = std::ptr::null_mut() };
        }
        // The format asked for is already the canonical one.
        S_FALSE
    }

    fn SetData(&self, _format: *const FORMATETC, _medium: *const STGMEDIUM, _release: BOOL) -> Result<()> {
        trace!("SetData");
        // A host does not put data into an Octet drawing; it edits it in Octet.
        Err(E_NOTIMPL.into())
    }

    fn EnumFormatEtc(&self, direction: u32) -> Result<IEnumFORMATETC> {
        trace!("EnumFormatEtc");
        if direction != DATADIR_GET.0 as u32 {
            return Err(E_NOTIMPL.into());
        }
        Ok(ComObject::new(Formats { next: RefCell::new(0) }).into_interface())
    }

    // The host's cache asks to hear when the picture changes, and refusing it leaves the
    // page showing a stale drawing. OLE's own holder does the bookkeeping; Octet only has to
    // tell it when the drawing has changed (`told_the_cache`).
    fn DAdvise(&self, format: *const FORMATETC, flags: u32, sink: Ref<IAdviseSink>) -> Result<u32> {
        trace!("DAdvise");
        if format.is_null() {
            return Err(E_FAIL.into());
        }
        let holder = self.data_holder()?;
        let me: IDataObject = self.cast_self()?;
        unsafe { holder.Advise(&me, format, flags, sink.as_ref()) }
    }

    fn DUnadvise(&self, connection: u32) -> Result<()> {
        trace!("DUnadvise");
        let holder = self.state.borrow().data_advise.clone();
        match holder {
            Some(holder) => unsafe { holder.Unadvise(connection) },
            None => Err(windows::Win32::Foundation::OLE_E_NOCONNECTION.into()),
        }
    }

    fn EnumDAdvise(&self) -> Result<IEnumSTATDATA> {
        trace!("EnumDAdvise");
        let holder = self.state.borrow().data_advise.clone();
        match holder {
            Some(holder) => unsafe { holder.EnumAdvise() },
            None => Err(windows::Win32::Foundation::OLE_E_ADVISENOTSUPPORTED.into()),
        }
    }
}

// The one format Octet offers, as an enumerator, because IDataObject has to have one.
#[implement(Agile = false, IEnumFORMATETC)]
struct Formats {
    next: RefCell<u32>,
}

// What Octet will give a host, best first.
fn offered() -> [FORMATETC; 2] {
    let one = |format: u16, tymed: i32| FORMATETC {
        cfFormat: format,
        ptd: std::ptr::null_mut(),
        dwAspect: DVASPECT_CONTENT.0,
        lindex: -1,
        tymed: tymed as u32,
    };
    [one(CF_ENHMETAFILE, TYMED_ENHMF.0), one(CF_METAFILEPICT, TYMED_MFPICT.0)]
}

impl windows::Win32::System::Com::IEnumFORMATETC_Impl for Formats_Impl {
    fn Next(&self, count: u32, out: *mut FORMATETC, fetched: *mut u32) -> windows::core::HRESULT {
        trace!("Next");
        let all = offered();
        let mut given = 0u32;
        if !out.is_null() {
            while given < count {
                let at = *self.next.borrow() as usize;
                let Some(format) = all.get(at) else { break };
                unsafe { *out.add(given as usize) = *format };
                *self.next.borrow_mut() += 1;
                given += 1;
            }
        }
        if !fetched.is_null() {
            unsafe { *fetched = given };
        }
        if given == count { S_OK } else { S_FALSE }
    }

    fn Skip(&self, count: u32) -> Result<()> {
        trace!("Skip");
        let left = (offered().len() as u32).saturating_sub(*self.next.borrow());
        *self.next.borrow_mut() += count.min(left);
        if count <= left { Ok(()) } else { Err(S_FALSE.into()) }
    }

    fn Reset(&self) -> Result<()> {
        trace!("Reset");
        *self.next.borrow_mut() = 0;
        Ok(())
    }

    fn Clone(&self) -> Result<IEnumFORMATETC> {
        trace!("Clone");
        Ok(ComObject::new(Formats { next: RefCell::new(*self.next.borrow()) }).into_interface())
    }
}

// ---------------------------------------------------------------------------------------
// Storage, in and out
// ---------------------------------------------------------------------------------------

// A stream of a host's storage, whole. Refuses anything larger than a drawing may be, so a
// document cannot make Octet read a gigabyte into memory.
fn read_stream(storage: &IStorage, name: &str) -> Result<Vec<u8>> {
    let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    let stream = unsafe { storage.OpenStream(PCWSTR(wide.as_ptr()), None, STGM(STGM_READ.0 | STGM_SHARE_EXCLUSIVE.0), 0)? };
    let mut stat = STATSTG::default();
    unsafe { stream.Stat(&mut stat, STATFLAG_NONAME)? };
    if stat.cbSize > crate::MAX_BYTES {
        return Err(E_FAIL.into());
    }
    read_whole(&stream, stat.cbSize as usize)
}

// A stream read to its end, however little it gives at a time.
//
// IStream::Read may return fewer bytes than asked for with more still to come, and the stream
// a host hands an out-of-process server is a MARSHALLED PROXY — that is why the
// ISequentialStream cast below failed — so a large drawing really does arrive in whatever
// chunks the RPC buffer holds. Taking the first chunk for the whole stream would load a
// truncated drawing: a fault that shows up only on somebody's biggest file.
fn read_whole(stream: &IStream, size: usize) -> Result<Vec<u8>> {
    let mut out = vec![0u8; size];
    let mut got = 0usize;
    while got < out.len() {
        let mut read = 0u32;
        // Through IStream itself, never a cast to ISequentialStream. IStream inherits Read and
        // Write, so the cast buys nothing — and the IStream a host hands over is a proxy that
        // answers E_NOINTERFACE for ISequentialStream, so the cast failed and every stream Octet
        // tried to write was silently lost.
        unsafe { stream.Read(out[got..].as_mut_ptr() as *mut _, (out.len() - got) as u32, Some(&mut read)).ok()? };
        if read == 0 {
            break;
        }
        got += read as usize;
    }
    out.truncate(got);
    Ok(out)
}

// One stream of a host's storage, written over.
fn write_stream(storage: &IStorage, name: &str, bytes: &[u8]) -> Result<()> {
    let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    let stream = unsafe {
        storage.CreateStream(PCWSTR(wide.as_ptr()), STGM(STGM_CREATE.0 | STGM_READWRITE.0 | STGM_SHARE_EXCLUSIVE.0), 0, 0)?
    };
    write_whole(&stream, bytes)?;
    unsafe { stream.Commit(STGC_DEFAULT)? };
    Ok(())
}

// All of the bytes written, for the same reason the read loops: a proxy may take fewer than
// offered and expect the rest. A write that stops taking bytes without saying why is still a
// failure — the drawing would be saved half-written — so it gives up rather than spinning.
fn write_whole(stream: &IStream, bytes: &[u8]) -> Result<()> {
    let mut sent = 0usize;
    while sent < bytes.len() {
        let mut written = 0u32;
        unsafe { stream.Write(bytes[sent..].as_ptr() as *const _, (bytes.len() - sent) as u32, Some(&mut written)).ok()? };
        if written == 0 {
            return Err(E_FAIL.into());
        }
        sent += written as usize;
    }
    Ok(())
}

// The metafile inside an \x02OlePres000 stream, and the size stored with it (HIMETRIC).
// The header is seven 4-byte fields, then the width, the height and the metafile's own
// length (MS-OLEDS 2.3.4, and ole.rs presentation, which writes it).
fn picture_of(stream: &[u8]) -> (Vec<u8>, Option<SIZE>) {
    const WIDTH: usize = 4 * 7;
    const HEAD: usize = 4 * 10;
    let at = |k: usize| stream.get(k..k + 4).and_then(|b| b.try_into().ok()).map(i32::from_le_bytes);
    let length = at(HEAD - 4).unwrap_or(0).max(0) as usize;
    let emf = stream.get(HEAD..HEAD + length).map(<[u8]>::to_vec).unwrap_or_default();
    let size = match (at(WIDTH), at(WIDTH + 4)) {
        (Some(cx), Some(cy)) if cx > 0 && cy > 0 && !emf.is_empty() => Some(SIZE { cx, cy }),
        _ => None,
    };
    (emf, size)
}

// A string for a host, in memory the host frees with CoTaskMemFree, as OLE requires.
fn task_string(text: &str) -> Result<PWSTR> {
    let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let bytes = wide.len() * 2;
    let memory = unsafe { windows::Win32::System::Com::CoTaskMemAlloc(bytes) } as *mut u16;
    if memory.is_null() {
        return Err(windows::Win32::Foundation::E_OUTOFMEMORY.into());
    }
    unsafe { std::ptr::copy_nonoverlapping(wide.as_ptr(), memory, wide.len()) };
    Ok(PWSTR(memory))
}

// ---------------------------------------------------------------------------------------
// The command the drawing window calls
// ---------------------------------------------------------------------------------------

/// A drawing window editing an embedded object hands its drawing back to the host.
///
/// `closing` is set when the window is being closed, which ends the edit.
#[tauri::command]
pub fn embedded_save(app: AppHandle, edit: u64, text: String, picture: String, closing: bool) -> std::result::Result<(), String> {
    trace!("embedded_save edit {edit}: {} characters, {} of picture, closing {closing}", text.len(), picture.len());
    if text.len() as u64 > crate::MAX_BYTES {
        return Err("This drawing is larger than 64 MB.".into());
    }
    // No text is the window saying the edit is over and nothing is to be saved.
    let drawing = if text.is_empty() {
        None
    } else {
        // The window sends the drawing's SVG; the EMF is made here, as the clipboard's is,
        // with the drawing hidden in it so a picture copied out of Word is editable again.
        let tree = crate::export::tree(&picture)?;
        Some((text.clone(), crate::vector::make_emf(&tree, Some(&text))))
    };
    let _ = &app;
    hand_back(edit, drawing, closing);
    Ok(())
}

/// Tells a drawing window's page that Word has taken its object back, so the window closes.
pub fn tell_window_closed(app: &AppHandle, label: &str) {
    let _ = app.emit_to(label, "embedded-closed", ());
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::Foundation::E_NOINTERFACE;
    use windows::Win32::System::Com::{ISequentialStream_Impl, IStream_Impl, LOCKTYPE, STATFLAG, STGC, STREAM_SEEK};

    #[test]
    fn the_class_id_matches_the_one_written_into_an_object() {
        // ole.rs writes the sixteen bytes; COM wants them as a GUID. The two must agree, or
        // a document would hold a class id no server answers for.
        assert_eq!(format!("{{{:?}}}", guid()).to_uppercase(), ole::guid_string(ole::CLSID));
    }

    // COM asks an object whether it is agile by asking it for this interface. Nothing else
    // names it: windows-rs keeps its own copy private, so the id is written out here.
    const IID_IAGILEOBJECT: GUID = GUID::from_u128(0x94ea_2b94_e9cc_49e0_c0ff_ee64_ca8f_5b90);

    #[test]
    fn an_object_a_host_is_given_is_bound_to_the_apartment() {
        // An agile object is one COM may call on any thread, so it stops marshalling calls
        // into the apartment and delivers them on RPC workers instead. Then two threads share
        // the objects' RefCell state, and a pointer the host hands in belongs to the thread it
        // came in on: calling it back from the apartment fails with RPC_E_WRONG_THREAD. Word
        // showed that as a page that never redrew after an edit.
        //
        // windows-rs makes an implemented object agile unless it is told not to, so this is
        // the one question these objects have to answer no to.
        let object: IUnknown = ComObject::new(Formats { next: RefCell::new(0) }).into_interface();
        let mut agile = std::ptr::null_mut();
        let answer = unsafe { object.query(&IID_IAGILEOBJECT, &mut agile) };
        assert_eq!(answer, E_NOINTERFACE, "an object a host holds must not call itself agile");
        assert!(agile.is_null());
    }

    #[test]
    fn every_object_a_host_is_given_says_so() {
        // Drawing and Factory need a running Tauri app to make, so they cannot be asked the
        // way Formats is above. What can be checked is that nothing in here is implemented
        // without saying which apartment it belongs to: the default is the wrong one, and it
        // fails quietly.
        let source = include_str!("ole_server.rs");
        let plain: Vec<&str> = source
            .lines()
            .map(str::trim)
            .filter(|line| line.starts_with("#[implement(") && !line.contains("Agile ="))
            .collect();
        // The one exception is the test stream below, which never leaves this process.
        assert_eq!(plain, ["#[implement(IStream)]"], "every COM object a host sees needs Agile = false");
    }

    #[test]
    fn a_launch_to_serve_an_object_is_told_apart_from_a_launch_by_a_person() {
        let args = |list: &[&str]| list.iter().map(std::ffi::OsString::from).collect::<Vec<_>>();
        assert!(embedding(args(&["octet.exe", "-Embedding"])));
        assert!(embedding(args(&["octet.exe", "/embedding"])), "either slash, either case");
        assert!(!embedding(args(&["octet.exe"])));
        assert!(!embedding(args(&["octet.exe", "luminol.oct"])));
        // Not a file that merely reads like the switch.
        assert!(!embedding(args(&["octet.exe", "embedding.oct"])));
    }

    // A stream that hands over a few bytes at a time, the way a marshalled proxy does.
    #[implement(IStream)]
    struct Dribble {
        bytes: RefCell<Vec<u8>>,
        at: RefCell<usize>,
        most: usize,
    }

    #[allow(non_snake_case)]
    impl ISequentialStream_Impl for Dribble_Impl {
        fn Read(&self, buffer: *mut core::ffi::c_void, want: u32, done: *mut u32) -> windows::core::HRESULT {
            let (bytes, mut at) = (self.bytes.borrow(), self.at.borrow_mut());
            let n = (bytes.len() - *at).min(want as usize).min(self.most);
            unsafe {
                std::ptr::copy_nonoverlapping(bytes[*at..].as_ptr(), buffer as *mut u8, n);
                if !done.is_null() {
                    *done = n as u32;
                }
            }
            *at += n;
            S_OK
        }
        fn Write(&self, buffer: *const core::ffi::c_void, have: u32, done: *mut u32) -> windows::core::HRESULT {
            let n = (have as usize).min(self.most);
            let mut bytes = self.bytes.borrow_mut();
            unsafe {
                bytes.extend_from_slice(std::slice::from_raw_parts(buffer as *const u8, n));
                if !done.is_null() {
                    *done = n as u32;
                }
            }
            S_OK
        }
    }

    #[allow(non_snake_case)]
    impl IStream_Impl for Dribble_Impl {
        fn Seek(&self, _: i64, _: STREAM_SEEK, _: *mut u64) -> Result<()> { Ok(()) }
        fn SetSize(&self, _: u64) -> Result<()> { Ok(()) }
        fn CopyTo(&self, _: Ref<IStream>, _: u64, _: *mut u64, _: *mut u64) -> Result<()> { Err(E_NOTIMPL.into()) }
        fn Commit(&self, _: &STGC) -> Result<()> { Ok(()) }
        fn Revert(&self) -> Result<()> { Ok(()) }
        fn LockRegion(&self, _: u64, _: u64, _: &LOCKTYPE) -> Result<()> { Err(E_NOTIMPL.into()) }
        fn UnlockRegion(&self, _: u64, _: u64, _: u32) -> Result<()> { Err(E_NOTIMPL.into()) }
        fn Stat(&self, out: *mut STATSTG, _: &STATFLAG) -> Result<()> {
            unsafe { (*out).cbSize = self.bytes.borrow().len() as u64 };
            Ok(())
        }
        fn Clone(&self) -> Result<IStream> { Err(E_NOTIMPL.into()) }
    }

    // A stream is read and written to the end, however little it gives at a time.
    //
    // IStream::Read may return fewer bytes than asked for with more still to come, and Write
    // may take fewer than offered. The stream a host hands an out-of-process server is a
    // marshalled proxy, so a large drawing really does arrive in chunks. Reading once would
    // load a truncated drawing and writing once would save half of one — faults that appear
    // only on somebody's biggest file, and only on the real cross-process path, which no
    // bench of ours exercises.
    #[test]
    fn a_stream_is_read_and_written_whole_however_little_it_gives_at_a_time() {
        let drawing: Vec<u8> = (0..5_000u32).map(|i| (i % 251) as u8).collect();
        for most in [1, 7, 4096, usize::MAX] {
            let source = Dribble { bytes: RefCell::new(drawing.clone()), at: RefCell::new(0), most };
            let back = read_whole(&source.into(), drawing.len()).unwrap();
            assert_eq!(back, drawing, "{most} bytes at a time: read {} of {}", back.len(), drawing.len());

            let sink = ComObject::new(Dribble { bytes: RefCell::new(Vec::new()), at: RefCell::new(0), most });
            write_whole(&sink.to_interface(), &drawing).unwrap();
            assert_eq!(*sink.get().bytes.borrow(), drawing, "{most} bytes at a time: wrote it all, in order");
        }
        // A stream that takes nothing gives up instead of spinning for ever.
        let stuck = Dribble { bytes: RefCell::new(Vec::new()), at: RefCell::new(0), most: 0 };
        assert!(write_whole(&stuck.into(), b"a drawing").is_err(), "a write that takes nothing is a failure");
        // And one that gives nothing returns what it had rather than a buffer of zeros.
        let empty = Dribble { bytes: RefCell::new(Vec::new()), at: RefCell::new(0), most: 0 };
        assert!(read_whole(&empty.into(), 9).unwrap().is_empty(), "a read that gives nothing is not nine zero bytes");
    }

    #[test]
    fn the_cached_picture_is_read_back_out_of_its_stream() {
        // What ole.rs writes, read back: the round trip the Load path depends on.
        let emf = b"pretend this is an enhanced metafile".to_vec();
        let streams = ole::streams(b"<CDXML/>", &emf, 2000, 1500);
        let (_, cached) = streams.iter().find(|(name, _)| *name == "\u{2}OlePres000").unwrap();
        let (back, size) = picture_of(cached);
        assert_eq!(back, emf);
        // The size comes back from the stream, not from the metafile's own frame, which
        // the metafile writer rounds up to whole device pixels: read from the frame
        // instead, an object grew by 8% every time a document was opened.
        let size = size.expect("the size is stored with the picture");
        assert_eq!((size.cx, size.cy), (2000, 1500));
        // A truncated or empty stream gives nothing rather than reading past its end.
        assert!(picture_of(&cached[..20]).0.is_empty());
        assert!(picture_of(&[]).0.is_empty());
        assert!(picture_of(&[]).1.is_none(), "no picture, no size");
    }
}
