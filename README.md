# Project MD

A super lightweight Kanban board for one-person teams. Every board is a plain
Markdown file, so your boards work on any device and in any editor.

**Website:** https://ir-idler.github.io/project-md/

## Download

| Platform | |
| --- | --- |
| **macOS** (Apple silicon & Intel) | [Download Project-MD-macOS.dmg](https://github.com/IR-Idler/project-md/releases/latest/download/Project-MD-macOS.dmg) · [all releases](https://github.com/IR-Idler/project-md/releases) |
| **iPhone & iPad** | TestFlight coming soon |
| **Windows** | Coming later |

**First launch on a Mac:** the app isn't notarized by Apple yet. Open the `.dmg`,
drag Project MD to Applications, then if macOS blocks it go to
*System Settings → Privacy & Security* and click *Open Anyway*. If macOS says the
app is damaged, run this once in Terminal:

```bash
xattr -dr com.apple.quarantine "/Applications/Project MD.app"
```

## Board format

```
## List name            -> a column
### Card title 🟩       -> a card (optional color: 🟥 🟧 🟨 🟩 🟦 🟪)
Text below the card     -> the card's notes
### Card title ❗❗ 🟩    -> urgency 1-3 (❗ to ❗❗❗), before the color
- [ ] item / - [x] item -> checklist items inside a card
```

## Use

**Cards**
- Click a card to select it · double-click / Enter to open it · Esc closes
- Space (or the › arrow) expands a card to show its notes on the board; ⌥ does the whole list
- `1`–`6` set the color, `0` (or the same number again) removes it
- `⌥1`–`⌥3` or `⇧1`–`⇧3` set the urgency (`!`, `!!`, `!!!`), `⌥0` removes it. `⌃1`–`⌃3` work too,
  unless macOS uses them for switching desktops (System Settings → Keyboard →
  Keyboard Shortcuts → Mission Control)
- Checklists: in a card press ⌘L or "☐ Checklist"; Enter adds the next item. Tick items on the expanded card
- Notes show **bold**, *italic*, `code`, bullets and clickable links
- Arrow keys move the selection, ⌥ + arrows move the card
- Backspace deletes the selected card · ⌘Z / ⇧⌘Z undo / redo

**Lists**
- Drag cards between lists, drag list headers to reorder, double-click a header to rename
- The header shows the card count; hover it for "sort by urgency" and delete, › hides the cards

**Board**
- ⌘F search (matches are highlighted) · Filter button: by color and urgency
- ⌘+ / ⌘− / ⌘0 zoom · ⌘O open files · ⌘N new board · ⌘W close tab · ⌘1–9 switch tabs
- Drag tabs to reorder them
- Drop `.md` files on the window, or use Finder's "Open With → Project MD"

Changes are saved to the file immediately; edits made in other apps (or synced
in by iCloud / Google Drive) show up live, also while a card is open.

## Develop

```bash
npm install
npm run tauri dev      # run the app with live reload
npm run tauri build    # build src-tauri/target/release/bundle/macos/Project MD.app
```

Needs Node and Rust (`rustup`). Stack: Tauri 2 (Rust) + TypeScript/Vite, no framework.

## Release

Bump `version` in `src-tauri/tauri.conf.json` and `package.json`, then push a tag:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

GitHub Actions ([release.yml](.github/workflows/release.yml)) builds a universal
macOS `.dmg` and attaches it to the release as `Project-MD-macOS.dmg`.
The website lives in [`docs/`](docs/) and is served by GitHub Pages from `main`.
