use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

/// Watches the folders that contain open boards and tells the UI when one of
/// the open files changes on disk (edited in another app, or synced in by
/// iCloud / Google Drive). Folders are watched instead of files so that
/// editors that save by replacing the file are still noticed.
#[derive(Default)]
struct WatchState {
    watcher: Option<RecommendedWatcher>,
    /// canonical path -> path string the UI knows the file by
    files: HashMap<PathBuf, String>,
    /// watched folder -> number of open files inside it
    dirs: HashMap<PathBuf, usize>,
}

type Shared = Mutex<WatchState>;

/// Files the app was asked to open (Finder "Open With", `open -a`, or command
/// line) before the UI was ready to receive them.
#[derive(Default)]
struct PendingOpens(Mutex<Vec<String>>);

#[tauri::command]
fn take_pending_opens(state: State<PendingOpens>) -> Vec<String> {
    state.0.lock().map(|mut v| std::mem::take(&mut *v)).unwrap_or_default()
}

fn request_open(app: &AppHandle, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    if let Ok(mut v) = app.state::<PendingOpens>().0.lock() {
        v.extend(paths.iter().cloned());
    }
    let _ = app.emit("open-files", ());
}

/// Accepts plain paths and file:// URLs (what the file picker returns on iOS).
fn to_path(p: &str) -> PathBuf {
    #[cfg(target_os = "ios")]
    if let Some(path) = scoped::access(p) {
        return path;
    }
    if p.starts_with("file://") {
        if let Ok(u) = tauri::Url::parse(p) {
            if let Ok(path) = u.to_file_path() {
                return path;
            }
        }
    }
    PathBuf::from(p)
}

fn canon(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(to_path(&path)).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(to_path(&path), contents).map_err(|e| e.to_string())
}

#[tauri::command]
fn watch_file(app: AppHandle, state: State<Shared>, path: String) -> Result<(), String> {
    let mut s = state.lock().map_err(|e| e.to_string())?;
    if s.watcher.is_none() {
        let handle = app.clone();
        let watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
            let Ok(ev) = res else { return };
            if matches!(ev.kind, EventKind::Access(_)) {
                return;
            }
            let st = handle.state::<Shared>();
            let Ok(s) = st.lock() else { return };
            for p in &ev.paths {
                let known = s.files.get(&canon(p)).or_else(|| s.files.get(p));
                if let Some(orig) = known {
                    let _ = handle.emit("file-changed", orig.clone());
                }
            }
        })
        .map_err(|e| e.to_string())?;
        s.watcher = Some(watcher);
    }

    let file = canon(&to_path(&path));
    if s.files.contains_key(&file) {
        return Ok(());
    }
    let dir = file.parent().ok_or("file has no parent folder")?.to_path_buf();
    s.files.insert(file, path);
    let count = {
        let c = s.dirs.entry(dir.clone()).or_insert(0);
        *c += 1;
        *c
    };
    if count == 1 {
        if let Some(w) = s.watcher.as_mut() {
            w.watch(&dir, RecursiveMode::NonRecursive)
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
fn unwatch_file(state: State<Shared>, path: String) -> Result<(), String> {
    let mut s = state.lock().map_err(|e| e.to_string())?;
    let file = canon(&to_path(&path));
    if s.files.remove(&file).is_none() {
        return Ok(());
    }
    let Some(dir) = file.parent().map(Path::to_path_buf) else { return Ok(()) };
    let remaining = match s.dirs.get_mut(&dir) {
        Some(c) => {
            *c = c.saturating_sub(1);
            *c
        }
        None => return Ok(()),
    };
    if remaining == 0 {
        s.dirs.remove(&dir);
        if let Some(w) = s.watcher.as_mut() {
            let _ = w.unwatch(&dir);
        }
    }
    Ok(())
}

/// iOS: files picked outside the app (iCloud Drive, other apps' folders) can
/// only be read and written after asking for security-scoped access. A
/// bookmark is kept for each one so it can be reopened after a relaunch.
#[cfg(target_os = "ios")]
mod scoped {
    use objc2::rc::Retained;
    use objc2::runtime::Bool;
    use objc2_foundation::{NSData, NSString, NSURLBookmarkCreationOptions, NSURLBookmarkResolutionOptions, NSURL};
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::{Mutex, OnceLock};

    static STORE: OnceLock<PathBuf> = OnceLock::new();
    static OPEN: Mutex<Option<HashMap<String, PathBuf>>> = Mutex::new(None);

    pub fn init(data_dir: PathBuf) {
        let _ = std::fs::create_dir_all(&data_dir);
        let _ = STORE.set(data_dir.join("bookmarks.json"));
    }

    fn load() -> HashMap<String, Vec<u8>> {
        STORE
            .get()
            .and_then(|f| std::fs::read(f).ok())
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    fn store(key: &str, data: Vec<u8>) {
        let Some(f) = STORE.get() else { return };
        let mut all = load();
        all.insert(key.to_string(), data);
        if let Ok(json) = serde_json::to_vec(&all) {
            let _ = std::fs::write(f, json);
        }
    }

    fn path_of(url: &NSURL) -> Option<PathBuf> {
        url.path().map(|p| PathBuf::from(p.to_string()))
    }

    fn bookmark(url: &NSURL) -> Option<Vec<u8>> {
        url.bookmarkDataWithOptions_includingResourceValuesForKeys_relativeToURL_error(
            NSURLBookmarkCreationOptions::empty(),
            None,
            None,
        )
        .ok()
        .map(|d| d.to_vec())
    }

    /// Starts access for a file:// URL and returns the path to use for it.
    /// Returns None for anything that does not need it.
    pub fn access(p: &str) -> Option<PathBuf> {
        if !p.starts_with("file://") {
            return None;
        }
        let mut open = OPEN.lock().ok()?;
        let open = open.get_or_insert_with(HashMap::new);
        if let Some(path) = open.get(p) {
            return Some(path.clone());
        }
        // Inside the app's own container no permission is needed.
        let url: Retained<NSURL> = NSURL::URLWithString(&NSString::from_str(p))?;
        let mut path = path_of(&url)?;
        let home = std::env::var("HOME").unwrap_or_default();
        if !home.is_empty() && path.starts_with(&home) {
            open.insert(p.to_string(), path.clone());
            return Some(path);
        }

        // Granted in this run (just picked, or handed over by the Files app)?
        let mut ok = unsafe { url.startAccessingSecurityScopedResource() };
        if ok {
            if let Some(b) = bookmark(&url) {
                store(p, b);
            }
        } else if let Some(data) = load().get(p) {
            // Picked in an earlier run: resolve the saved bookmark.
            let data = NSData::with_bytes(data);
            let mut stale = Bool::NO;
            if let Ok(resolved) = unsafe {
                NSURL::URLByResolvingBookmarkData_options_relativeToURL_bookmarkDataIsStale_error(
                    &data,
                    NSURLBookmarkResolutionOptions::empty(),
                    None,
                    &mut stale,
                )
            } {
                ok = unsafe { resolved.startAccessingSecurityScopedResource() };
                if ok {
                    if let Some(rp) = path_of(&resolved) {
                        path = rp;
                    }
                    if stale.as_bool() {
                        if let Some(b) = bookmark(&resolved) {
                            store(p, b);
                        }
                    }
                }
            }
        }
        // Access stays open for the rest of the run (the URL is not stopped).
        if ok {
            open.insert(p.to_string(), path.clone());
        }
        Some(path)
    }
}

/// Creates a new board in the app's Documents folder (shown in the Files app
/// as "On My iPhone › Project MD") and returns its path.
#[tauri::command]
fn create_board(app: AppHandle, name: String) -> Result<String, String> {
    let dir = app.path().document_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let clean: String = name
        .trim()
        .trim_end_matches(".md")
        .chars()
        .map(|c| if matches!(c, '/' | '\\' | ':') { '-' } else { c })
        .collect();
    let base = if clean.trim().is_empty() { "Board".to_string() } else { clean.trim().to_string() };
    let mut path = dir.join(format!("{base}.md"));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{base} {n}.md"));
        n += 1;
    }
    std::fs::write(&path, "## To do\n\n## Doing\n\n## Done\n").map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// On phones, boards live in the app's Documents folder (visible in the Files
/// app). Open every board there, and create a starter board on first launch.
#[cfg(mobile)]
fn open_documents_folder(app: &AppHandle) {
    let Ok(dir) = app.path().document_dir() else { return };
    let _ = std::fs::create_dir_all(&dir);
    let list = |dir: &Path| -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(dir)
            .map(|rd| {
                rd.filter_map(|e| e.ok())
                    .map(|e| e.path())
                    .filter(|p| p.extension().is_some_and(|x| x == "md" || x == "markdown"))
                    .map(|p| p.to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        v.sort();
        v
    };
    let mut boards = list(&dir);
    if boards.is_empty() {
        let welcome = dir.join("Welcome.md");
        let _ = std::fs::write(&welcome, include_str!("../../example/hello.md"));
        boards = list(&dir);
    }
    request_open(app, boards);
}

/// Native menu bar. Items send their id to the UI, which runs the action.
#[cfg(desktop)]
fn build_menu(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
    let item = |id: &str, label: &str, accel: Option<&str>| {
        let mut b = MenuItemBuilder::with_id(id, label);
        if let Some(a) = accel {
            b = b.accelerator(a);
        }
        b.build(app)
    };

    let app_menu = SubmenuBuilder::new(app, "Project MD")
        .about(None)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;
    let file = SubmenuBuilder::new(app, "File")
        .item(&item("new", "New Board…", Some("CmdOrCtrl+N"))?)
        .item(&item("open", "Open…", Some("CmdOrCtrl+O"))?)
        .separator()
        .item(&item("close-tab", "Close Tab", Some("CmdOrCtrl+W"))?)
        .build()?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .item(&item("undo", "Undo", Some("CmdOrCtrl+Z"))?)
        .item(&item("redo", "Redo", Some("CmdOrCtrl+Shift+Z"))?)
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator()
        .item(&item("find", "Find", Some("CmdOrCtrl+F"))?)
        .build()?;
    let card = SubmenuBuilder::new(app, "Card")
        .item(&item("urgency-1", "Urgency !", Some("Ctrl+1"))?)
        .item(&item("urgency-2", "Urgency !!", Some("Ctrl+2"))?)
        .item(&item("urgency-3", "Urgency !!!", Some("Ctrl+3"))?)
        .item(&item("urgency-0", "No Urgency", Some("Ctrl+0"))?)
        .separator()
        .item(&item("sort-urgency", "Sort List by Urgency", None)?)
        .item(&item("clear-filter", "Clear Filter", None)?)
        .build()?;
    let view = SubmenuBuilder::new(app, "View")
        .item(&item("zoom-in", "Zoom In", Some("CmdOrCtrl+="))?)
        .item(&item("zoom-out", "Zoom Out", Some("CmdOrCtrl+-"))?)
        .item(&item("zoom-reset", "Actual Size", Some("CmdOrCtrl+0"))?)
        .separator()
        .fullscreen()
        .build()?;
    let window = SubmenuBuilder::new(app, "Window").minimize().maximize().build()?;

    let menu = MenuBuilder::new(app)
        .items(&[&app_menu, &file, &edit, &card, &view, &window])
        .build()?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        let _ = app.emit("menu", event.id().as_ref());
    });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init());
    // Remember the window's size and position between launches.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_window_state::Builder::default().build());
    builder
        .manage(Shared::default())
        .manage(PendingOpens::default())
        .setup(|app| {
            let args: Vec<String> = std::env::args()
                .skip(1)
                .filter(|a| !a.starts_with('-'))
                .collect();
            request_open(app.handle(), args);
            #[cfg(target_os = "ios")]
            if let Ok(d) = app.path().app_data_dir() {
                scoped::init(d);
            }
            #[cfg(mobile)]
            open_documents_folder(app.handle());
            #[cfg(desktop)]
            build_menu(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            watch_file,
            unwatch_file,
            take_pending_opens,
            create_board
        ])
        .build(tauri::generate_context!())
        .expect("error while building Project MD")
        .run(|_app, _event| {
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            if let tauri::RunEvent::Opened { urls } = _event {
                // iOS: keep the URL so security-scoped access can be requested.
                #[cfg(target_os = "ios")]
                let paths = urls
                    .into_iter()
                    .filter(|u| u.scheme() == "file")
                    .map(|u| u.to_string())
                    .collect();
                #[cfg(not(target_os = "ios"))]
                let paths = urls
                    .into_iter()
                    .filter_map(|u| u.to_file_path().ok())
                    .map(|p| p.to_string_lossy().into_owned())
                    .collect();
                request_open(_app, paths);
            }
        });
}
