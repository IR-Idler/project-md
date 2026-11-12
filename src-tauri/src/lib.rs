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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Shared::default())
        .manage(PendingOpens::default())
        .setup(|app| {
            let args: Vec<String> = std::env::args()
                .skip(1)
                .filter(|a| !a.starts_with('-'))
                .collect();
            request_open(app.handle(), args);
            #[cfg(mobile)]
            open_documents_folder(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            watch_file,
            unwatch_file,
            take_pending_opens
        ])
        .build(tauri::generate_context!())
        .expect("error while building Project MD")
        .run(|_app, _event| {
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            if let tauri::RunEvent::Opened { urls } = _event {
                let paths = urls
                    .into_iter()
                    .filter_map(|u| u.to_file_path().ok())
                    .map(|p| p.to_string_lossy().into_owned())
                    .collect();
                request_open(_app, paths);
            }
        });
}
