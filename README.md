# Project MD

A minimal Kanban board where every board is a plain Markdown file.

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
- `⇧1`–`⇧3` set the urgency (`!`, `!!`, `!!!`), `⇧0` removes it. `⌃1`–`⌃3` work too,
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
