# Project MD

A minimal Kanban board where every board is a plain Markdown file.

```
## List name            -> a column
### Card title 🟩       -> a card (optional color: 🟥 🟧 🟨 🟩 🟦 🟪)
Text below the card     -> the card's notes
```

## Use

- Click a card to select it · double-click / Enter to open it · Esc closes
- Space (or the › arrow) expands a card to show its notes on the board; ⌥ does the whole list
- `1`–`6` set the color, `0` (or the same number again) removes it
- Arrow keys move the selection, ⌥ + arrows move the card
- Backspace deletes the selected card · ⌘Z / ⇧⌘Z undo / redo
- Drag cards between lists, drag list headers to reorder, double-click a header to rename
- ⌘F search · ⌘O open files · ⌘N new board · ⌘1–9 switch tabs
- Drop `.md` files on the window, or use Finder's "Open With → Project MD"

Changes are saved to the file immediately; edits made in other apps (or synced
in by iCloud / Google Drive) show up live.

## Develop

```bash
npm install
npm run tauri dev      # run the app with live reload
npm run tauri build    # build src-tauri/target/release/bundle/macos/Project MD.app
```

Needs Node and Rust (`rustup`). Stack: Tauri 2 (Rust) + TypeScript/Vite, no framework.
