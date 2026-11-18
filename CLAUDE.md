# Project MD: guide for AI sessions

Read this first. It explains what the app is, how the code is laid out and the
rules that are easy to break. `README.md` is the user-facing manual (board
format, keyboard shortcuts, release steps); `overview.md` is the one-page
status card for this app.

## What the app is

A lightweight Kanban board for one person. **Every board is a plain Markdown
file** on disk, so boards also work in any text editor and sync through iCloud
Drive or Google Drive. The app never keeps a copy of a board in its own
database: the `.md` file is the only source of truth, and it is rewritten as
soon as anything changes.

```
## To do                 <- a list (column)
### Write intro ❗❗ 🟩    <- a card: title, urgency 1-3 (❗), color (🟥🟧🟨🟩🟦🟪)
Notes under the card     <- the card's text
- [ ] item               <- checklist item inside the card
```

Text before the first `##` is kept untouched, and so are headings inside
fenced code blocks. Files with CRLF line endings stay CRLF.

Erik builds this alone and is not a programmer. Explain things, git steps
included, in plain language.

## Platforms and how each one ships

| Platform | How it ships | Status |
|---|---|---|
| macOS, GitHub download | `.dmg` built by GitHub Actions when a `v*` tag is pushed (`.github/workflows/release.yml`). Not notarized. | Live |
| macOS, Mac App Store | Same code built with the Cargo feature `app-store` by `scripts/build-mac-app-store.sh <build number>`, uploaded with Transporter | Prepared, not submitted yet |
| iPhone and iPad | Tauri iOS project in `src-tauri/gen/apple`, archived in Xcode and uploaded to TestFlight | TestFlight beta |
| Windows, Android | Not started | Later |

Bundle ID everywhere: `com.projectmd.board`, team `PYSRU834C2`. The Mac App
Store version is meant to share the iPhone app's App Store Connect record.

Version number lives in **both** `src-tauri/tauri.conf.json` and `package.json`.
Bump them together.

## Stack

Tauri 2. Rust backend (`src-tauri/`) + TypeScript frontend built with Vite
(`src/`). **No UI framework**: the UI is hand-built DOM, re-rendered by plain
functions. `index.html` holds the static markup (top bar, card modal,
settings page).

```bash
npm install
npm run dev            # UI only in a browser, with in-memory demo boards
npm run tauri dev      # the real Mac app with live reload
npm run tauri build    # Mac .app / .dmg
npx tsc --noEmit       # type check
cd src-tauri && cargo check [--features app-store]
```

`.claude/launch.json` has `web-ui` (browser preview on port 1420) and `site`
(the website on port 4173).

## Code map

### Frontend (`src/`)

| File | What it does |
|---|---|
| `main.ts` | Almost everything: tabs, rendering, card modal, drag and drop, keyboard, search, filter, phone board switcher, menu actions, startup. Split into sections by `// ------ name` comment lines. |
| `parser.ts` | Markdown ⇄ `Board` (`parse`, `serialize`). Card color/urgency parsing, checklist helpers. The board format is defined here. |
| `backend.ts` | Thin layer over the Rust commands (`readFile`, `writeFile`, `watchFile`, …). In a plain browser it falls back to in-memory demo files. Also `isNative`, `isIOS`, `isAppStoreBuild`, haptics. |
| `noteEditor.ts` | The card notes editor: a contenteditable with one `<div>` per line so checklist items get a hanging indent. The Markdown text stays the source of truth. |
| `markdown.ts` | Read-only rendering of card notes on the board (bold, italic, code, links, checklists, search highlight). Builds DOM nodes, **never `innerHTML`**, so file content can't inject markup. |
| `settings.ts` | Settings page (theme, version, update row, shortcut list). Settings are per device in `localStorage`. |
| `updates.ts` | GitHub Mac app only: once a day asks the GitHub Releases API for a newer version and shows a notice. Skipped on iOS and in the App Store build. |
| `styles.css` | All styling, light and dark. |

Main state in `main.ts`: `tabs` (one per open file: `path`, parsed `board`,
`lastText` = what was last read from or written to disk, undo/redo stacks),
`active`, `selected`, `modal`.

### Backend (`src-tauri/src/lib.rs`)

- Commands: `read_file`, `write_file`, `watch_file`, `unwatch_file`,
  `take_pending_opens`, `create_board` (iOS), `app_store_build`.
- `to_path()` turns whatever path the UI has into a real path. It is where
  file URLs, security-scoped access and moved iOS Documents folders are handled.
- **File watching:** the folder that holds each open board is watched (not the
  file itself), so editors that save by replacing the file are still noticed.
  A change emits `file-changed` to the UI.
- **Opening files from the OS** (Finder "Open With", drop on the Dock icon,
  iOS Files app): `RunEvent::Opened` → `request_open` → `open-files` event →
  UI calls `take_pending_opens`.
- **Mac menu bar** (`build_menu`): every item just emits its id as a `menu`
  event; `runAction()` in `main.ts` does the work.
- `mod scoped`: security-scoped bookmarks, see below.

## How saving and syncing work

1. Every edit goes through `mutate()` in `main.ts`: it pushes the old text on
   the undo stack, changes `tab.board`, re-renders and schedules a save.
2. `save()` serializes the board and writes the whole file. `lastText` is
   updated so the app doesn't react to its own write.
3. When the file changes on disk (another editor, iCloud), `reloadFromDisk()`
   re-reads it. If a card is open in the modal, the new file is taken and only
   that card's edits are carried over (found again by `cardKey`: title plus
   "#n" for duplicates), so neither side is lost.
4. Open tabs are remembered in `localStorage` (`projectmd.session`) as paths
   and reopened at launch. Expanded cards are view state in `localStorage`
   too, never written into the Markdown.

## File access rules per platform (important)

- **Mac, GitHub build:** not sandboxed. Plain paths work everywhere.
- **Mac App Store build** (`--features app-store`): runs in Apple's sandbox
  (`src-tauri/appstore/Entitlements.plist`). It can only touch files the user
  picked in a dialog, dropped on the window or opened from Finder. For each such
  file `scoped::access_path` saves a security-scoped bookmark
  (`bookmarks.json` in the app data folder); at the next launch restored tabs
  are reached through it. A board made with the save panel gets its bookmark
  after its first write. Paths passed on the command line are **not** allowed in
  the sandbox. Tested on 2026-11-18: open, outside edits, replace-saves and
  relaunch all work, and an unpicked file is refused.
- **iOS:** files picked through the Files app arrive as `file://` URLs and need
  security-scoped access too (`scoped::access`). New boards are created in the
  app's own Documents folder ("On My iPhone › Project MD") because iOS has no
  save panel that leaves a file we can keep writing to. That folder's absolute
  path changes on every update, so `relocate()` maps old saved paths onto it.

Anything new that reads or writes files must go through `to_path()`, or it
will break in the sandbox and on iOS.

## App Store build differences

All behind the Cargo feature `app-store` (Rust) and `isAppStoreBuild` (UI):
no "Check for Updates…" menu item, no update row in Settings, no daily GitHub
check (Apple doesn't allow self-updating apps), plus the sandbox and bookmarks.
Store-only config: `src-tauri/tauri.appstore.conf.json`. The provisioning profile
`src-tauri/appstore/embedded.provisionprofile` is git-ignored and must be
downloaded from developer.apple.com. One-time setup steps are in `README.md`.

## Website

`docs/` is the website (one static `index.html`), served by GitHub Pages from
`main` at https://ir-idler.github.io/project-md/. Changes to it go live when
pushed to `main`.

## Working rules

- Keep it lightweight: no UI framework, no new dependencies without a good reason.
- The Markdown file must stay readable and editable by hand. Anything that is
  only view state (expanded cards, zoom, tabs) belongs in `localStorage`, not the file.
- Never use `innerHTML` with file content.
- Check changes in both builds: `cargo check` and `cargo check --features app-store`,
  plus `npx tsc --noEmit`. iOS-only code sits behind `#[cfg(target_os = "ios")]` / `isIOS`.
- `main` is what users have. Larger features go on their own branch (existing
  examples: `shortcuts`, `drag-feedback`, `iphone-touch-fixes`, `mac-app-store`).
  Ask Erik before creating one, and commit or push only when he asks.
- When something ships or changes state, update `overview.md` (status) and
  `README.md` (user-facing instructions).
