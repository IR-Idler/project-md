import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ask, open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { highlight, renderNotes } from "./markdown";
import { createBoard, haptic, isIOS, isNative, onFileChanged, onMenu, onOpenRequest, readFile, unwatchFile, watchFile, writeFile } from "./backend";
import {
  Board,
  Card,
  CHECK_RE,
  checklistProgress,
  COLORS,
  COLOR_NAMES,
  hasStructuralHeading,
  List,
  parse,
  serialize,
  toggleCheck,
  uid,
} from "./parser";
import "./styles.css";

// ---------------------------------------------------------------- state

type Tab = {
  path: string;
  name: string;
  board: Board;
  lastText: string; // what we last read from / wrote to disk
  undo: string[];
  redo: string[];
  scrollLeft: number;
  pendingReload: boolean;
};

type ModalState = {
  tab: Tab;
  card: Card;
  before: string;
  isNew: boolean;
  wasOpen: boolean;
  key: string; // identifies the card in the file (see cardKey)
  listTitle: string;
  dirty: boolean; // edited here since it was opened / last merged
};

const SESSION_KEY = "projectmd.session";
const MD_EXT = /\.(md|markdown|txt)$/i;

let tabs: Tab[] = [];
let active = -1;
let selected: string | null = null;
let query = "";
let modal: ModalState | null = null;

const cur = (): Tab | undefined => tabs[active];

// Which cards are expanded on the board. This is view state, not part of the
// Markdown, so it lives in local storage: file path -> card titles.
const EXPANDED_KEY = "projectmd.expanded";
let expanded: Record<string, string[]> = {};
try {
  expanded = JSON.parse(localStorage.getItem(EXPANDED_KEY) || "{}") || {};
} catch {
  expanded = {};
}

/**
 * A stable name for a card across re-reads of the file: its title, plus "#n"
 * for the n-th further card with the same title.
 */
function cardKey(t: Tab, c: Card) {
  let n = 0;
  for (const l of t.board.lists) {
    for (const x of l.cards) {
      if (x === c) return n ? `${c.title}#${n}` : c.title;
      if (x.title === c.title) n++;
    }
  }
  return c.title;
}

function findByKey(b: Board, key: string): Card | null {
  const seen = new Map<string, number>();
  for (const l of b.lists) {
    for (const c of l.cards) {
      const n = seen.get(c.title) ?? 0;
      seen.set(c.title, n + 1);
      if ((n ? `${c.title}#${n}` : c.title) === key) return c;
    }
  }
  return null;
}

// Collapsed lists (view state): file path -> list titles.
const FOLDED_KEY = "projectmd.folded";
let folded: Record<string, string[]> = {};
try {
  folded = JSON.parse(localStorage.getItem(FOLDED_KEY) || "{}") || {};
} catch {
  folded = {};
}
const isFolded = (t: Tab, l: List) => (folded[t.path] ?? []).includes(l.title);
function toggleFold(t: Tab, l: List) {
  const set = new Set(folded[t.path] ?? []);
  set.has(l.title) ? set.delete(l.title) : set.add(l.title);
  if (set.size) folded[t.path] = [...set];
  else delete folded[t.path];
  try {
    localStorage.setItem(FOLDED_KEY, JSON.stringify(folded));
  } catch {
    /* view state only */
  }
  render();
}

// Board zoom (view state).
const ZOOM_KEY = "projectmd.zoom";
let zoom = 1;
function setZoom(z: number) {
  zoom = Math.min(1.6, Math.max(0.7, Math.round(z * 10) / 10));
  document.documentElement.style.setProperty("--z", String(zoom));
  try {
    localStorage.setItem(ZOOM_KEY, String(zoom));
  } catch {
    /* view state only */
  }
}
try {
  setZoom(parseFloat(localStorage.getItem(ZOOM_KEY) || "1") || 1);
} catch {
  setZoom(1);
}

// Filter: show only cards with these colors and at least this urgency.
const filterColors = new Set<number>();
let filterUrgency = 0;
const filtering = () => !!query || filterColors.size > 0 || filterUrgency > 0;

function isExpanded(t: Tab, c: Card) {
  return !!c.body.trim() && (expanded[t.path] ?? []).includes(cardKey(t, c));
}

function setExpanded(t: Tab, cards: Card[], open: boolean) {
  const set = new Set(expanded[t.path] ?? []);
  for (const c of cards) open ? set.add(cardKey(t, c)) : set.delete(cardKey(t, c));
  if (set.size) expanded[t.path] = [...set];
  else delete expanded[t.path];
  try {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify(expanded));
  } catch {
    /* view state only */
  }
}

/** Expand/collapse one card; with `wholeList`, apply the result to every card in its list. */
function toggleCard(id: string, wholeList = false) {
  const t = cur();
  const f = t && findCard(t.board, id);
  if (!t || !f || !f.card.body.trim()) return;
  const open = !isExpanded(t, f.card);
  setExpanded(t, wholeList ? f.list.cards : [f.card], open);
  render();
  updateSelection();
}

// ---------------------------------------------------------------- dom

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const boardEl = $("#board");
const tabsEl = $("#tabs");
const emptyEl = $("#empty");
const searchEl = $<HTMLInputElement>("#search");
const searchClear = $("#search-clear");
const backdrop = $("#modal-backdrop");
const mTitle = $<HTMLInputElement>("#m-title");
const mBody = $<HTMLTextAreaElement>("#m-body");
const mColors = $("#m-colors");
const mUrgency = $("#m-urgency");
const mMirror = $("#m-mirror");

/** Redraw the layer over the notes field: same text, checklist markers as boxes. */
function syncMirror() {
  const frag = document.createDocumentFragment();
  const lines = mBody.value.split("\n");
  lines.forEach((line, i) => {
    const m = line.match(/^(\s*)([-*+] \[([ xX])\])( ?)(.*)$/);
    if (m) {
      const done = m[3] !== " ";
      const box = el("span", "cb" + (done ? " on" : ""));
      box.textContent = m[2];
      const rest = el("span", done ? "cb-done" : "");
      rest.textContent = m[5];
      frag.append(m[1], box, m[4], rest);
    } else {
      frag.append(line);
    }
    if (i < lines.length - 1) frag.append("\n");
  });
  // A trailing newline needs something after it to take up a line.
  frag.append("\u200b");
  mMirror.replaceChildren(frag);
  mMirror.scrollTop = mBody.scrollTop;
}

const isApple = /Mac|iPhone|iPad/.test(navigator.userAgent);

/** Urgency shortcut: Ctrl+0-3 on Apple devices, Alt+0-3 elsewhere (Ctrl is the command key there). */
function urgencyDigit(e: KeyboardEvent): number | null {
  // Shift+0-3 also works (outside text fields): macOS can reserve Ctrl+digits
  // for switching desktops, in which case the app never sees them.
  const shift = e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && !inInput();
  const option = isApple && e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && !inInput();
  const held = shift || option || (isApple ? e.ctrlKey && !e.metaKey : e.altKey && !e.ctrlKey);
  const m = held ? e.code.match(/^Digit([0-3])$/) : null;
  return m ? +m[1] : null;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

const inInput = () => {
  const a = document.activeElement;
  return a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement;
};

// ---------------------------------------------------------------- helpers

function baseName(p: string) {
  let name = p.split(/[\\/]/).pop() || p;
  if (p.startsWith("file://")) {
    try {
      name = decodeURIComponent(name);
    } catch {
      /* keep as is */
    }
  }
  return name.replace(MD_EXT, "");
}

function findCard(b: Board, id: string | null) {
  if (!id) return null;
  for (const list of b.lists) {
    const index = list.cards.findIndex((c) => c.id === id);
    if (index >= 0) return { list, index, card: list.cards[index] };
  }
  return null;
}

const findList = (b: Board, id: string) => b.lists.find((l) => l.id === id);

function matches(c: Card) {
  if (query && !(c.title + "\n" + c.body).toLowerCase().includes(query)) return false;
  if (filterColors.size && (c.color == null || !filterColors.has(c.color))) return false;
  if (filterUrgency && c.urgency < filterUrgency) return false;
  return true;
}

function persist() {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ paths: tabs.map((t) => t.path), active }));
  } catch {
    /* storage unavailable: tabs just won't be restored */
  }
}

// ---------------------------------------------------------------- saving & undo

const saveTimers = new Map<Tab, number>();

async function save(t: Tab) {
  saveTimers.delete(t);
  const text = serialize(t.board);
  if (text === t.lastText) return;
  t.lastText = text;
  try {
    await writeFile(t.path, text);
  } catch (e) {
    console.error("save failed", e);
    alertError(`Could not save ${t.name}: ${e}`);
  }
}

function scheduleSave(t: Tab, delay = 0) {
  clearTimeout(saveTimers.get(t));
  saveTimers.set(t, window.setTimeout(() => save(t), delay));
}

function pushUndo(t: Tab, before: string) {
  t.undo.push(before);
  if (t.undo.length > 300) t.undo.shift();
  t.redo = [];
}

/** Apply a change to the current board, record undo, save, re-render. */
function mutate(fn: (b: Board) => void) {
  const t = cur();
  if (!t) return;
  const before = serialize(t.board);
  fn(t.board);
  if (serialize(t.board) !== before) {
    pushUndo(t, before);
    scheduleSave(t);
  }
  render();
}

function restore(t: Tab, text: string) {
  const sel = findCard(t.board, selected);
  t.board = parse(text);
  // keep the selection on the "same" card if it still exists
  selected = null;
  if (sel) {
    for (const l of t.board.lists) {
      const c = l.cards.find((c) => c.title === sel.card.title);
      if (c) {
        selected = c.id;
        break;
      }
    }
  }
}

function undo() {
  const t = cur();
  if (!t || !t.undo.length) return;
  t.redo.push(serialize(t.board));
  restore(t, t.undo.pop()!);
  scheduleSave(t);
  render();
}

function redo() {
  const t = cur();
  if (!t || !t.redo.length) return;
  t.undo.push(serialize(t.board));
  restore(t, t.redo.pop()!);
  scheduleSave(t);
  render();
}

// ---------------------------------------------------------------- files & tabs

async function openPath(path: string, activate = true) {
  const existing = tabs.findIndex((t) => t.path === path);
  if (existing >= 0) {
    if (activate) switchTab(existing);
    return;
  }
  let text: string;
  try {
    text = await readFile(path);
  } catch (e) {
    console.error("open failed", path, e);
    return;
  }
  tabs.push({
    path,
    name: baseName(path),
    board: parse(text),
    lastText: text,
    undo: [],
    redo: [],
    scrollLeft: 0,
    pendingReload: false,
  });
  watchFile(path).catch((e) => console.error("watch failed", e));
  if (activate) switchTab(tabs.length - 1);
  else render();
  persist();
}

function switchTab(i: number) {
  const t = cur();
  if (t) t.scrollLeft = boardEl.scrollLeft;
  active = i;
  selected = null;
  render(true);
  persist();
}

function closeTab(i: number) {
  const [t] = tabs.splice(i, 1);
  if (saveTimers.has(t)) {
    clearTimeout(saveTimers.get(t));
    save(t);
  }
  unwatchFile(t.path).catch(() => {});
  if (i < active || active >= tabs.length) active--;
  selected = null;
  render(true);
  persist();
}

async function addFiles() {
  const res = await openDialog({
    multiple: true,
    filters: [{ name: "Markdown", extensions: ["md", "markdown", "txt"] }],
    canCreateDirectories: true,
    // iOS: edit the file where it is (iCloud Drive etc.), not a copy.
    fileAccessMode: "scoped",
  });
  if (!res) return;
  for (const p of Array.isArray(res) ? res : [res]) await openPath(p);
}

/** Small in-app sheet asking for a board name. Resolves null on cancel. */
function askBoardName(): Promise<string | null> {
  return new Promise((resolve) => {
    const back = el("div", "sheet-backdrop");
    const form = el("form", "sheet") as HTMLFormElement;
    const label = el("label", "sheet-label");
    label.textContent = "New board";
    const input = el("input", "sheet-input") as HTMLInputElement;
    input.type = "text";
    input.value = "Board";
    input.placeholder = "Board name";
    input.spellcheck = false;
    input.autocapitalize = "words";
    input.setAttribute("enterkeyhint", "done");
    const row = el("div", "sheet-actions");
    const cancel = el("button", "btn") as HTMLButtonElement;
    cancel.type = "button";
    cancel.textContent = "Cancel";
    const ok = el("button", "btn primary") as HTMLButtonElement;
    ok.type = "submit";
    ok.textContent = "Create";
    row.append(cancel, ok);
    const hint = el("p", "sheet-hint");
    hint.textContent = isIOS ? "Saved in Files › On My iPhone › Project MD" : "";
    form.append(label, input, hint, row);
    back.append(form);
    document.body.append(back);
    const done = (v: string | null) => {
      back.remove();
      resolve(v);
    };
    cancel.addEventListener("click", () => done(null));
    back.addEventListener("pointerdown", (e) => {
      if (e.target === back) done(null);
    });
    form.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        done(null);
      }
    });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      done(input.value.trim() || "Board");
    });
    input.focus();
    input.select();
  });
}

async function newBoard() {
  if (isIOS) {
    // iOS has no "save as" panel that leaves a file we can keep writing to,
    // so boards are created in the app's own Documents folder.
    const name = await askBoardName();
    if (name == null) return;
    try {
      await openPath(await createBoard(name));
    } catch (e) {
      alertError(`Could not create the board: ${e}`);
    }
    return;
  }
  if (!isNative) {
    // Browser preview: make an in-memory board.
    let n = 1;
    while (tabs.some((t) => t.path === `/demo/Board ${n}.md`)) n++;
    const path = `/demo/Board ${n}.md`;
    await writeFile(path, "## To do\n\n## Doing\n\n## Done\n");
    await openPath(path);
    return;
  }
  const p = await saveDialog({
    title: "New board",
    defaultPath: "Board.md",
    filters: [{ name: "Markdown", extensions: ["md"] }],
    canCreateDirectories: true,
  });
  if (!p) return;
  const path = MD_EXT.test(p) ? p : p + ".md";
  await writeFile(path, "## To do\n\n## Doing\n\n## Done\n");
  await openPath(path);
}

async function reloadFromDisk(t: Tab) {
  const editing = () => (modal && modal.tab === t ? modal : null);
  if (!editing() && saveTimers.has(t)) return; // our own change is about to be written
  let text: string;
  try {
    text = await readFile(t.path);
  } catch {
    return; // file missing for a moment (being replaced / synced)
  }
  if (text === t.lastText) return;
  const m = editing();
  if (m) {
    // The file changed elsewhere while a card is open here. Take the new file
    // and carry only this card's edits over, so neither side is lost.
    const next = parse(text);
    const mine = m.card;
    let target = findByKey(next, m.key);
    if (target && m.dirty) {
      Object.assign(target, { title: mine.title, color: mine.color, urgency: mine.urgency, body: mine.body });
    } else if (!target && (m.dirty || m.isNew)) {
      const l = next.lists.find((l) => l.title === m.listTitle) ?? next.lists[0];
      if (!l) return;
      target = { ...mine, id: uid() };
      l.cards.push(target);
    }
    pushUndo(t, serialize(t.board));
    t.board = next;
    t.lastText = text;
    if (!target) {
      // The card was removed elsewhere and nothing was edited here.
      modal = null;
      backdrop.hidden = true;
      selected = null;
    } else {
      m.card = target;
      m.key = cardKey(t, target);
      selected = target.id;
      if (!m.dirty) {
        mTitle.value = target.title;
        mBody.value = target.body;
        syncMirror();
        renderSwatches();
        renderUrgency();
      }
      scheduleSave(t, 300);
    }
    if (t === cur()) render();
    return;
  }
  pushUndo(t, serialize(t.board));
  t.lastText = text;
  if (t === cur()) {
    restore(t, text);
    render();
  } else {
    t.board = parse(text);
  }
}

const reloadTimers = new Map<string, number>();
onFileChanged((path) => {
  clearTimeout(reloadTimers.get(path));
  reloadTimers.set(
    path,
    window.setTimeout(() => {
      const t = tabs.find((t) => t.path === path);
      if (t) reloadFromDisk(t);
    }, 120),
  );
});

function alertError(msg: string) {
  const n = el("div", "toast");
  n.textContent = msg;
  document.body.append(n);
  setTimeout(() => n.remove(), 5000);
}

// ---------------------------------------------------------------- rendering

function renderTabs() {
  tabsEl.replaceChildren(
    ...tabs.map((t, i) => {
      const d = el("div", "tab" + (i === active ? " active" : ""));
      d.title = t.path;
      const name = el("span", "tab-name");
      name.textContent = t.name;
      const x = el("button", "tab-close");
      x.textContent = "×";
      x.title = "Close";
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        closeTab(i);
      });
      d.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || (e.target as HTMLElement).closest(".tab-close")) return;
        beginTabDrag(e, t);
        if (i !== active) switchTab(i);
      });
      d.append(name, x);
      return d;
    }),
  );
  renderSwitcher();
  // Keep the active tab visible when the bar scrolls (narrow screens).
  const a = tabsEl.children[active] as HTMLElement | undefined;
  if (a) {
    const left = a.offsetLeft - tabsEl.offsetLeft;
    if (left < tabsEl.scrollLeft) tabsEl.scrollLeft = left;
    else if (left + a.offsetWidth > tabsEl.scrollLeft + tabsEl.clientWidth)
      tabsEl.scrollLeft = left + a.offsetWidth - tabsEl.clientWidth;
  }
}

/** Drag a tab sideways to reorder it. */
function beginTabDrag(e: PointerEvent, tab: Tab) {
  const startX = e.clientX;
  let moving = false;
  const move = (ev: PointerEvent) => {
    if (!moving && Math.abs(ev.clientX - startX) < 6) return;
    moving = true;
    const els = [...tabsEl.children] as HTMLElement[];
    const from = tabs.indexOf(tab);
    if (from < 0) return;
    let to = els.findIndex((x) => ev.clientX < x.getBoundingClientRect().right);
    if (to < 0) to = tabs.length - 1;
    if (to === from) return;
    const r = els[to].getBoundingClientRect();
    const mid = r.left + r.width / 2;
    if ((to > from && ev.clientX < mid) || (to < from && ev.clientX > mid)) return;
    const act = cur();
    tabs.splice(from, 1);
    tabs.splice(to, 0, tab);
    if (act) active = tabs.indexOf(act);
    renderTabs();
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    if (moving) persist();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}

function render(useTabScroll = false) {
  renderTabs();
  const t = cur();
  emptyEl.hidden = !!t;
  boardEl.hidden = !t;
  if (!t) {
    boardEl.replaceChildren();
    document.title = "Project MD";
    return;
  }
  document.title = `${t.name} - Project MD`;

  const left = useTabScroll ? t.scrollLeft : boardEl.scrollLeft;
  const colScroll = new Map<string, number>();
  boardEl.querySelectorAll<HTMLElement>(".column").forEach((c) => {
    colScroll.set(c.dataset.list!, c.querySelector(".cards")!.scrollTop);
  });

  const frag = document.createDocumentFragment();
  for (const l of t.board.lists) {
    const col = el("section", "column");
    col.dataset.list = l.id;

    const closed = isFolded(t, l);
    if (closed) col.classList.add("folded");
    const head = el("div", "col-head");
    const fold = el("button", "col-fold" + (closed ? "" : " open"));
    fold.textContent = "›";
    fold.title = closed ? "Show cards" : "Hide cards";
    const title = el("span", "col-title");
    title.textContent = l.title || "Untitled";
    title.title = "Double-click to rename";
    const count = el("span", "col-count");
    count.textContent = String(l.cards.length);
    count.title = `${l.cards.length} card${l.cards.length === 1 ? "" : "s"}`;
    const sort = el("button", "col-sort");
    sort.textContent = "!↓";
    sort.title = "Sort by urgency";
    const del = el("button", "col-del");
    del.textContent = "×";
    del.title = "Delete list";
    head.append(fold, title, count, sort, del);

    const cards = el("div", "cards");
    for (const c of l.cards) {
      const ce = el("div", "card");
      ce.dataset.card = c.id;
      if (c.color != null) ce.classList.add("c" + c.color);
      if (c.id === selected) ce.classList.add("selected");
      if (filtering()) ce.classList.add(matches(c) ? "match" : "dim");
      const row = el("div", "card-row");
      const tt = el("span", "card-title");
      if (c.title) highlight(tt, c.title, query);
      else {
        tt.textContent = "Untitled";
        tt.classList.add("untitled");
      }
      row.append(tt);
      if (c.urgency) {
        const u = el("span", "card-urg");
        u.textContent = "!".repeat(c.urgency);
        u.title = `Urgency ${c.urgency}`;
        row.append(u);
      }
      const prog = checklistProgress(c.body);
      if (prog.total) {
        const p = el("span", "card-prog" + (prog.done === prog.total ? " all" : ""));
        p.textContent = `${prog.done}/${prog.total}`;
        p.title = "Checklist";
        row.append(p);
      }
      if (c.body.trim()) {
        // A search hit inside the notes opens the card so the match is visible.
        const open = isExpanded(t, c) || (!!query && c.body.toLowerCase().includes(query));
        const tg = el("button", "card-toggle" + (open ? " open" : ""));
        tg.textContent = "›";
        tg.title = open ? "Collapse (Space) · ⌥-click: whole list" : "Expand (Space) · ⌥-click: whole list";
        row.append(tg);
        ce.append(row);
        if (open) {
          const body = el("div", "card-body");
          renderNotes(body, c.body, query);
          ce.append(body);
        }
      } else {
        ce.append(row);
      }
      cards.append(ce);
    }

    const add = el("button", "add-card");
    add.textContent = "+ card";
    col.append(head, cards, add);
    frag.append(col);
  }
  const addList = el("button", "add-list");
  addList.textContent = "+ list";
  frag.append(addList);
  boardEl.replaceChildren(frag);

  boardEl.scrollLeft = left;
  boardEl.querySelectorAll<HTMLElement>(".column").forEach((c) => {
    const s = colScroll.get(c.dataset.list!);
    if (s) c.querySelector(".cards")!.scrollTop = s;
  });
}

function updateSelection() {
  boardEl.querySelectorAll(".card.selected").forEach((c) => c.classList.remove("selected"));
  if (!selected) return;
  const ce = boardEl.querySelector<HTMLElement>(`.card[data-card="${selected}"]`);
  if (ce) {
    ce.classList.add("selected");
    ce.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
}

function select(id: string | null) {
  selected = id;
  updateSelection();
}

// ---------------------------------------------------------------- board actions

function addCard(listId: string) {
  const t = cur();
  const l = t && findList(t.board, listId);
  if (!t || !l) return;
  const before = serialize(t.board);
  const card: Card = { id: uid(), title: "", color: null, urgency: 0, body: "" };
  l.cards.push(card);
  selected = card.id;
  render();
  openModal(t, card, before, true);
}

function addList() {
  const l: List = { id: uid(), title: "New list", body: "", cards: [] };
  mutate((b) => b.lists.push(l));
  boardEl.scrollLeft = boardEl.scrollWidth;
  startRename(l.id);
}

async function deleteList(listId: string) {
  const t = cur();
  const l = t && findList(t.board, listId);
  if (!t || !l) return;
  if (l.cards.length) {
    const msg = `Delete the list “${l.title}” and its ${l.cards.length} card${l.cards.length > 1 ? "s" : ""}?`;
    const ok = isNative ? await ask(msg, { title: "Delete list", kind: "warning" }) : confirm(msg);
    if (!ok) return;
  }
  mutate((b) => b.lists.splice(b.lists.indexOf(l), 1));
}

function deleteCard(id: string) {
  const t = cur();
  const f = t && findCard(t.board, id);
  if (!f) return;
  const next = f.list.cards[f.index + 1] ?? f.list.cards[f.index - 1] ?? null;
  mutate(() => f.list.cards.splice(f.index, 1));
  select(next?.id ?? null);
}

function setColor(id: string, n: number) {
  const t = cur();
  const f = t && findCard(t.board, id);
  if (!f) return;
  const color = n === 0 || f.card.color === n - 1 ? null : n - 1;
  mutate(() => (f.card.color = color));
}

function setUrgency(id: string, n: number) {
  const t = cur();
  const f = t && findCard(t.board, id);
  if (!f) return;
  const urgency = f.card.urgency === n ? 0 : n;
  mutate(() => (f.card.urgency = urgency));
}

function sortByUrgency(listId: string) {
  mutate((b) => {
    const l = findList(b, listId);
    // Array.sort is stable: cards with the same urgency keep their order.
    if (l) l.cards.sort((a, c) => c.urgency - a.urgency);
  });
}

function moveCard(id: string, listId: string, index: number) {
  mutate((b) => {
    const f = findCard(b, id);
    const target = findList(b, listId);
    if (!f || !target) return;
    f.list.cards.splice(f.index, 1);
    target.cards.splice(Math.min(index, target.cards.length), 0, f.card);
  });
}

function moveList(id: string, index: number) {
  mutate((b) => {
    const i = b.lists.findIndex((l) => l.id === id);
    if (i < 0) return;
    const [l] = b.lists.splice(i, 1);
    b.lists.splice(index, 0, l);
  });
}

function startRename(listId: string) {
  const t = cur();
  const l = t && findList(t.board, listId);
  const span = boardEl.querySelector(`.column[data-list="${listId}"] .col-title`);
  if (!l || !span) return;
  const input = el("input", "col-input");
  input.value = l.title;
  input.spellcheck = false;
  span.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (commit: boolean) => {
    if (done) return;
    done = true;
    const v = input.value.replace(/\s+/g, " ").trim();
    if (commit && v && v !== l.title) mutate(() => (l.title = v));
    else render();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      // Otherwise the window's Enter shortcut opens the selected card once the
      // input is gone.
      e.stopPropagation();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));
}

/** Arrow keys: move the selection, or (with ⌥) move the card itself. */
function navigate(key: string, moveIt: boolean) {
  const t = cur();
  if (!t) return;
  const b = t.board;
  const f = findCard(b, selected);
  if (!f) {
    const first = b.lists.find((l) => l.cards.length)?.cards[0];
    if (first) select(first.id);
    return;
  }
  const li = b.lists.indexOf(f.list);
  if (key === "ArrowUp" || key === "ArrowDown") {
    const ni = f.index + (key === "ArrowUp" ? -1 : 1);
    if (ni < 0 || ni >= f.list.cards.length) return;
    if (moveIt) moveCard(f.card.id, f.list.id, ni);
    else select(f.list.cards[ni].id);
    if (moveIt) updateSelection();
    return;
  }
  const step = key === "ArrowLeft" ? -1 : 1;
  if (moveIt) {
    const target = b.lists[li + step];
    if (!target) return;
    moveCard(f.card.id, target.id, f.index);
    updateSelection();
    return;
  }
  for (let i = li + step; i >= 0 && i < b.lists.length; i += step) {
    const cs = b.lists[i].cards;
    if (cs.length) {
      select(cs[Math.min(f.index, cs.length - 1)].id);
      return;
    }
  }
}

// ---------------------------------------------------------------- card modal

function renderSwatches() {
  if (!modal) return;
  const { card } = modal;
  mColors.replaceChildren(
    ...[0, 1, 2, 3, 4, 5, 6].map((n) => {
      const b = el("button", "swatch" + (n ? " c" + (n - 1) : " none"));
      b.title = n ? `${COLOR_NAMES[n - 1]} (${n})` : "No color (0)";
      if ((n === 0 && card.color == null) || card.color === n - 1) b.classList.add("on");
      b.addEventListener("click", () => {
        modal!.card.color = n ? n - 1 : null;
        modal!.dirty = true;
        scheduleSave(modal!.tab, 300);
        renderSwatches();
      });
      return b;
    }),
  );
}

/** Set urgency on the open card, or else on the selected card. Same level again clears it. */
function applyUrgency(n: number) {
  if (modal) {
    modal.card.urgency = modal.card.urgency === n ? 0 : n;
    modal.dirty = true;
    scheduleSave(modal.tab, 300);
    renderUrgency();
  } else if (selected) {
    setUrgency(selected, n);
  }
}

function renderUrgency() {
  if (!modal) return;
  const { card } = modal;
  mUrgency.replaceChildren(
    ...[1, 2, 3].map((n) => {
      const b = el("button", "urg" + (card.urgency === n ? " on" : ""));
      b.textContent = "!".repeat(n);
      b.title = `Urgency ${n} (${isApple ? "⌥" : "Alt+"}${n} or ⇧${n})`;
      b.addEventListener("click", () => {
        applyUrgency(n);
      });
      return b;
    }),
  );
}

// ---- checklist helpers for the notes field

function insertText(text: string) {
  // execCommand keeps the field's own undo history; fall back if unavailable.
  const ok = text ? document.execCommand("insertText", false, text) : document.execCommand("delete");
  if (!ok) {
    mBody.setRangeText(text, mBody.selectionStart, mBody.selectionEnd, "end");
    mBody.dispatchEvent(new Event("input"));
  }
}

function currentLine() {
  const v = mBody.value;
  const pos = mBody.selectionStart;
  const start = v.lastIndexOf("\n", pos - 1) + 1;
  let end = v.indexOf("\n", pos);
  if (end < 0) end = v.length;
  return { start, end, pos, text: v.slice(start, end) };
}

/** Turn the current line into a checklist item, or add a new item below one. */
function insertChecklistItem() {
  mBody.focus();
  const l = currentLine();
  const item = l.text.match(CHECK_RE);
  if (item) {
    mBody.setSelectionRange(l.end, l.end);
    insertText("\n" + item[1] + "- [ ] ");
  } else if (!l.text.trim()) {
    mBody.setSelectionRange(l.start, l.end);
    insertText("- [ ] ");
  } else {
    const m = l.text.match(/^(\s*)(?:[-*+] )?(.*)$/)!;
    mBody.setSelectionRange(l.start, l.end);
    insertText(`${m[1]}- [ ] ${m[2]}`);
  }
}

function openModal(tab: Tab, card: Card, before = serialize(tab.board), isNew = false) {
  modal = {
    tab,
    card,
    before,
    isNew,
    wasOpen: isExpanded(tab, card),
    key: cardKey(tab, card),
    listTitle: findCard(tab.board, card.id)?.list.title ?? "",
    dirty: false,
  };
  mTitle.value = card.title;
  mBody.value = card.body;
  syncMirror();
  renderSwatches();
  renderUrgency();
  backdrop.hidden = false;
  if (isNew || !card.title) mTitle.focus();
  else if (lastPointerType === "touch") {
    // On a phone, opening a card is mostly for reading: don't cover half the
    // screen with the keyboard. Tapping the notes starts editing.
    (document.activeElement as HTMLElement | null)?.blur();
    mBody.scrollTop = 0;
  } else {
    mBody.focus();
    mBody.setSelectionRange(mBody.value.length, mBody.value.length);
    mBody.scrollTop = mBody.scrollHeight;
  }
}

async function closeModal(remove = false) {
  if (!modal) return;
  const { tab, card, before, isNew, wasOpen } = modal;
  if (wasOpen) setExpanded(tab, [card], true);
  modal = null;
  backdrop.hidden = true;
  mTitle.blur();
  mBody.blur();

  const empty = !card.title.trim() && !card.body.trim();
  if (remove || (isNew && empty)) {
    const f = findCard(tab.board, card.id);
    if (f) f.list.cards.splice(f.index, 1);
    if (selected === card.id) selected = null;
  } else {
    selected = card.id;
  }
  // Typing "## x" or "### x" into a card's notes really creates a list/card in
  // the file, so re-read the board to show what the file now contains.
  if (hasStructuralHeading(card.body)) tab.board = parse(serialize(tab.board));

  if (serialize(tab.board) !== before && !(isNew && empty)) pushUndo(tab, before);
  clearTimeout(saveTimers.get(tab));
  await save(tab);
  render();
  updateSelection();
  if (tab.pendingReload) {
    tab.pendingReload = false;
    reloadFromDisk(tab);
  }
}

mTitle.addEventListener("input", () => {
  if (!modal) return;
  modal.dirty = true;
  modal.card.title = mTitle.value.replace(/[\r\n]+/g, " ");
  scheduleSave(modal.tab, 500);
});
mBody.addEventListener("input", () => {
  if (!modal) return;
  syncMirror();
  modal.dirty = true;
  modal.card.body = mBody.value;
  scheduleSave(modal.tab, 500);
});
mTitle.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    mBody.focus();
  }
});
mBody.addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() === "l" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    insertChecklistItem();
    return;
  }
  // Enter continues a checklist / bullet list; Enter on an empty item ends it.
  if (e.key !== "Enter" || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.isComposing) return;
  if (mBody.selectionStart !== mBody.selectionEnd) return;
  const l = currentLine();
  const m = mBody.value.slice(l.start, l.pos).match(/^(\s*)([-*+]) (\[[ xX]\] ?)?(.*)$/);
  if (!m) return;
  e.preventDefault();
  if (!m[4].trim()) {
    mBody.setSelectionRange(l.start, l.pos);
    insertText("");
  } else {
    insertText("\n" + m[1] + m[2] + " " + (m[3] ? "[ ] " : ""));
  }
});
mBody.addEventListener("scroll", () => {
  mMirror.scrollTop = mBody.scrollTop;
});
// Clicking a checklist box ticks it: the click puts the caret inside the
// "- [ ]" marker, which is otherwise never a useful place to type.
mBody.addEventListener("click", () => {
  if (mBody.selectionStart !== mBody.selectionEnd) return;
  const l = currentLine();
  const m = l.text.match(CHECK_RE);
  if (!m) return;
  const marker = l.start + m[1].length;
  if (l.pos < marker || l.pos > marker + 5) return;
  mBody.setSelectionRange(marker + 3, marker + 4);
  insertText(m[2] === " " ? "x" : " ");
  const end = mBody.value.indexOf("\n", marker);
  const at = end < 0 ? mBody.value.length : end;
  mBody.setSelectionRange(at, at);
});
// Keep the caret in the notes when the button is pressed.
$("#m-check").addEventListener("pointerdown", (e) => e.preventDefault());
$("#m-check").addEventListener("mousedown", (e) => e.preventDefault());
$("#m-check").addEventListener("click", insertChecklistItem);

backdrop.addEventListener("mousedown", (e) => {
  if (e.target === backdrop) closeModal();
});
$("#m-delete").addEventListener("click", () => closeModal(true));
$("#m-done").addEventListener("click", () => closeModal());

// Keep the card editor above the on-screen keyboard on phones.
// It's an app, not a web page: no pinch-zoom on iPhone/iPad (the viewport
// meta tag covers most cases; WebKit's gesture events catch the rest).
for (const type of ["gesturestart", "gesturechange"]) {
  document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
}

const vv = window.visualViewport;
if (vv) {
  const fit = () => {
    const root = document.documentElement;
    root.style.setProperty("--vvh", vv.height + "px");
    root.style.setProperty("--vvt", vv.offsetTop + "px");
    // On-screen keyboard: the app shrinks to the visible area (see styles.css),
    // so keep a field being edited on the board in view above the keyboard.
    const kb = window.innerHeight - vv.height > 80;
    root.classList.toggle("kb-open", kb);
    const a = document.activeElement as HTMLElement | null;
    if (kb && a && boardEl.contains(a)) {
      requestAnimationFrame(() => a.scrollIntoView({ block: "nearest" }));
    }
  };
  vv.addEventListener("resize", fit);
  vv.addEventListener("scroll", fit);
  fit();
}

// ---------------------------------------------------------------- drag & drop
// Pointer-based (not HTML5 drag events) so it behaves the same with a mouse,
// a trackpad, and later on touch screens.

type Press = {
  kind: "card" | "list";
  el: HTMLElement;
  id: string;
  x: number;
  y: number;
  touch: boolean;
  armed: boolean; // touch: held long enough to start dragging
  timer: number;
};
type Drag = Press & { ghost: HTMLElement; ph: HTMLElement; dx: number; dy: number; raf: number };

let press: Press | null = null;
let drag: Drag | null = null;

/** Lists stacked top to bottom (phone layout) instead of side by side. */
const isVertical = () => getComputedStyle(boardEl).flexDirection === "column";

function beginPress(e: PointerEvent, kind: Press["kind"], target: HTMLElement) {
  const id = kind === "card" ? target.dataset.card! : target.dataset.list!;
  const touch = e.pointerType === "touch";
  press = { kind, el: target, id, x: e.clientX, y: e.clientY, touch, armed: !touch, timer: 0 };
  if (touch) {
    // On touch screens a quick swipe scrolls; press and hold to pick a card up.
    press.timer = window.setTimeout(() => {
      if (!press) return;
      press.armed = true;
      press.el.classList.add("lifting");
      haptic("lift");
    }, 350);
  }
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);
}

function onPointerMove(e: PointerEvent) {
  if (!press) return;
  if (!drag) {
    const dist = Math.hypot(e.clientX - press.x, e.clientY - press.y);
    if (!press.armed) {
      if (dist > 8) cancelPress(); // the finger is scrolling
      return;
    }
    if (dist < 5) return;
    startDrag();
  }
  moveDrag(e.clientX, e.clientY);
}

function cancelPress() {
  window.removeEventListener("pointermove", onPointerMove);
  window.removeEventListener("pointerup", onPointerUp);
  window.removeEventListener("pointercancel", onPointerUp);
  if (press) {
    clearTimeout(press.timer);
    press.el.classList.remove("lifting");
  }
  press = null;
}

function onPointerUp(e: PointerEvent) {
  const p = press;
  cancelPress();
  if (drag) {
    endDrag(e.type === "pointercancel");
    return;
  }
  if (!p || e.type === "pointercancel" || p.touch) return; // touch taps: see "click"
  if (p.kind === "card") select(p.id);
}

let lastPointerType = "mouse";

// While a touch drag is active, stop the page from scrolling under the finger.
document.addEventListener(
  "touchmove",
  (e) => {
    if (drag || press?.armed) e.preventDefault();
  },
  { passive: false },
);

function startDrag() {
  if (!press) return;
  press.el.classList.remove("lifting");
  const src = press.el;
  const r = src.getBoundingClientRect();
  const ghost = src.cloneNode(true) as HTMLElement;
  ghost.classList.add("ghost");
  ghost.classList.remove("selected");
  Object.assign(ghost.style, {
    width: r.width + "px",
    height: r.height + "px",
    left: r.left + "px",
    top: r.top + "px",
  });
  document.body.append(ghost);
  const ph = el("div", press.kind === "card" ? "placeholder" : "col-placeholder");
  ph.style.height = r.height + "px";
  src.after(ph);
  src.style.display = "none";
  drag = { ...press, ghost, ph, dx: press.x - r.left, dy: press.y - r.top, raf: 0 };
  document.body.classList.add("dragging");
  drag.raf = requestAnimationFrame(autoScroll);
}

let lastX = 0;
let lastY = 0;

function moveDrag(x: number, y: number) {
  if (!drag) return;
  lastX = x;
  lastY = y;
  drag.ghost.style.left = x - drag.dx + "px";
  drag.ghost.style.top = y - drag.dy + "px";

  const cols = [...boardEl.querySelectorAll<HTMLElement>(".column")].filter((c) => c !== drag!.el);

  if (drag.kind === "card") {
    if (!cols.length) return;
    const vertical = isVertical();
    const pos = vertical ? y : x;
    const span = (r: DOMRect) => (vertical ? [r.top, r.bottom] : [r.left, r.right]);
    let col = cols.find((c) => {
      const [a, b] = span(c.getBoundingClientRect());
      return pos >= a && pos <= b;
    });
    if (!col) {
      const dist = (c: HTMLElement) => {
        const [a, b] = span(c.getBoundingClientRect());
        return Math.abs(pos - (a + b) / 2);
      };
      col = cols.reduce((best, c) => (dist(c) < dist(best) ? c : best));
    }
    markTarget(col);
    const list = col.querySelector<HTMLElement>(".cards")!;
    const items = [...list.children].filter((c) => c.classList.contains("card") && c !== drag!.el);
    const before = items.find((it) => {
      const r = it.getBoundingClientRect();
      return y < r.top + r.height / 2;
    });
    if (before) {
      if (drag.ph.nextElementSibling !== before) {
        list.insertBefore(drag.ph, before);
        tick();
      }
    } else if (list.lastElementChild !== drag.ph) {
      list.append(drag.ph);
      tick();
    }
  } else {
    const vertical = isVertical();
    const before = cols.find((c) => {
      const r = c.getBoundingClientRect();
      return vertical ? y < r.top + r.height / 2 : x < r.left + r.width / 2;
    });
    const anchor = before ?? boardEl.querySelector(".add-list");
    if (anchor && drag.ph.nextElementSibling !== anchor) {
      boardEl.insertBefore(drag.ph, anchor);
      tick();
    }
  }
}

/** Highlight the list a card would land in. */
function markTarget(col: HTMLElement | null) {
  for (const c of boardEl.querySelectorAll(".column.drop-target")) if (c !== col) c.classList.remove("drop-target");
  col?.classList.add("drop-target");
}

/** A light haptic tick each time the drop spot moves (rate-limited). */
let lastTick = 0;
function tick() {
  const now = performance.now();
  if (now - lastTick < 70) return;
  lastTick = now;
  haptic("tick");
}

function autoScroll() {
  if (!drag) return;
  const edge = 70;
  const br = boardEl.getBoundingClientRect();
  let moved = false;
  if (isVertical()) {
    if (lastY < br.top + edge) {
      boardEl.scrollTop -= (br.top + edge - lastY) / 4;
      moved = true;
    } else if (lastY > br.bottom - edge) {
      boardEl.scrollTop += (lastY - (br.bottom - edge)) / 4;
      moved = true;
    }
  } else if (lastX < br.left + edge) {
    boardEl.scrollLeft -= (br.left + edge - lastX) / 4;
    moved = true;
  } else if (lastX > br.right - edge) {
    boardEl.scrollLeft += (lastX - (br.right - edge)) / 4;
    moved = true;
  }
  if (drag.kind === "card") {
    const list = drag.ph.parentElement;
    if (list?.classList.contains("cards")) {
      const r = list.getBoundingClientRect();
      if (lastY < r.top + 40) {
        list.scrollTop -= (r.top + 40 - lastY) / 3;
        moved = true;
      } else if (lastY > r.bottom - 40) {
        list.scrollTop += (lastY - (r.bottom - 40)) / 3;
        moved = true;
      }
    }
  }
  if (moved) moveDrag(lastX, lastY);
  drag.raf = requestAnimationFrame(autoScroll);
}

function endDrag(cancel: boolean) {
  if (!drag) return;
  const d = drag;
  drag = null;
  cancelAnimationFrame(d.raf);
  d.ghost.remove();
  document.body.classList.remove("dragging");
  if (cancel) {
    render();
    return;
  }
  let index = 0;
  if (d.kind === "card") {
    for (let n = d.ph.previousElementSibling; n; n = n.previousElementSibling) {
      if (n.classList.contains("card") && n !== d.el) index++;
    }
    const listId = d.ph.closest<HTMLElement>(".column")!.dataset.list!;
    selected = d.id;
    moveCard(d.id, listId, index);
  } else {
    for (let n = d.ph.previousElementSibling; n; n = n.previousElementSibling) {
      if (n.classList.contains("column") && n !== d.el) index++;
    }
    moveList(d.id, index);
  }
  haptic("drop");
  // Let the card or list that just landed settle into place.
  requestAnimationFrame(() => {
    const sel = d.kind === "card" ? `.card[data-card="${d.id}"]` : `.column[data-list="${d.id}"]`;
    const landed = boardEl.querySelector<HTMLElement>(sel);
    if (!landed) return;
    landed.classList.add("dropped");
    landed.addEventListener("animationend", () => landed.classList.remove("dropped"), { once: true });
  });
}

// ---------------------------------------------------------------- board events

boardEl.addEventListener("pointerdown", (e) => {
  lastPointerType = e.pointerType;
  if (e.button !== 0) return;
  const target = e.target as HTMLElement;
  if (target.closest("button, input, a")) return;
  if (inInput()) (document.activeElement as HTMLElement).blur();
  const card = target.closest<HTMLElement>(".card");
  if (card) {
    if (e.pointerType !== "touch") e.preventDefault();
    beginPress(e, "card", card);
    return;
  }
  const head = target.closest<HTMLElement>(".col-head");
  if (head) {
    if (e.pointerType !== "touch") e.preventDefault();
    beginPress(e, "list", head.parentElement!);
    return;
  }
  select(null);
});

boardEl.addEventListener("dblclick", (e) => {
  const target = e.target as HTMLElement;
  if (target.closest("button")) return;
  const card = target.closest<HTMLElement>(".card");
  const t = cur();
  if (card && t) {
    const f = findCard(t.board, card.dataset.card!);
    if (f) openModal(t, f.card);
    return;
  }
  const head = target.closest<HTMLElement>(".col-head");
  if (head && !target.closest("button")) startRename(head.parentElement!.dataset.list!);
});

boardEl.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  const col = target.closest<HTMLElement>(".column");
  const a = target.closest<HTMLElement>(".md-link");
  if (a) {
    const url = a.dataset.href ?? "";
    if (/^(https?:\/\/|mailto:)/.test(url)) {
      if (isNative) openUrl(url).catch((err) => console.error("open link failed", err));
      else window.open(url, "_blank", "noopener");
    }
    return;
  }
  const headCol = target.closest<HTMLElement>(".column");
  const tabNow = cur();
  if (headCol && tabNow && target.closest(".col-fold")) {
    const l = findList(tabNow.board, headCol.dataset.list!);
    if (l) toggleFold(tabNow, l);
    return;
  }
  if (headCol && target.closest(".col-sort")) {
    sortByUrgency(headCol.dataset.list!);
    return;
  }
  const check = target.closest<HTMLElement>(".check");
  if (check) {
    const id = check.closest<HTMLElement>(".card")!.dataset.card!;
    const t = cur();
    const f = t && findCard(t.board, id);
    if (f) {
      selected = id;
      mutate(() => (f.card.body = toggleCheck(f.card.body, +check.dataset.line!)));
      updateSelection();
    }
    return;
  }
  const toggle = target.closest(".card-toggle");
  if (lastPointerType === "touch" && !toggle && !drag) {
    // No keyboard on a phone: a tap opens the card (colors are in the editor),
    // and a tap on a list title renames it.
    const card = target.closest<HTMLElement>(".card");
    const t = cur();
    if (card && t) {
      const f = findCard(t.board, card.dataset.card!);
      if (f) {
        select(f.card.id);
        openModal(t, f.card);
      }
      return;
    }
    if (target.closest(".col-title") && col) {
      startRename(col.dataset.list!);
      return;
    }
  }
  if (toggle) {
    const id = toggle.closest<HTMLElement>(".card")!.dataset.card!;
    select(id);
    toggleCard(id, e.altKey);
  } else if (target.closest(".add-card") && col) addCard(col.dataset.list!);
  else if (target.closest(".col-del") && col) deleteList(col.dataset.list!);
  else if (target.closest(".add-list")) addList();
});

// Vertical mouse-wheel scrolling over the empty board area scrolls sideways.
boardEl.addEventListener(
  "wheel",
  (e) => {
    if (e.deltaX !== 0 || e.shiftKey || isVertical()) return;
    if ((e.target as HTMLElement).closest(".cards")) return;
    boardEl.scrollLeft += e.deltaY;
  },
  { passive: true },
);

// ---------------------------------------------------------------- search

function setQuery(v: string) {
  query = v.trim().toLowerCase();
  searchClear.hidden = !v;
  render();
}
searchEl.addEventListener("input", () => setQuery(searchEl.value));
searchClear.addEventListener("click", () => {
  searchEl.value = "";
  setQuery("");
  searchEl.focus();
});

// Phone: search opens over the header from a small icon.
const topbarEl = $("#topbar");
function openSearch() {
  topbarEl.classList.add("searching");
  searchEl.focus();
  searchEl.select();
}
function closeSearch() {
  searchEl.value = "";
  setQuery("");
  searchEl.blur();
  topbarEl.classList.remove("searching");
}
$("#search-toggle").addEventListener("click", openSearch);
$("#search-cancel").addEventListener("click", closeSearch);
searchEl.addEventListener("blur", () => {
  // Keep the field showing while a search is filtering the board.
  if (!searchEl.value) topbarEl.classList.remove("searching");
});

// ---------------------------------------------------------------- board switcher (phone)

const switchBtn = $("#board-switch");
const boardPop = $("#board-pop");
const boardNameEl = $("#board-name");

function renderSwitcher() {
  boardNameEl.textContent = cur()?.name ?? "Project MD";
  if (boardPop.hidden) return;
  const items: HTMLElement[] = tabs.map((t, i) => {
    const b = el("button", "menu-item" + (i === active ? " active" : ""));
    const mark = el("span", "menu-check");
    mark.textContent = i === active ? "✓" : "";
    const name = el("span", "menu-name");
    name.textContent = t.name;
    const x = el("span", "menu-close");
    x.textContent = "×";
    x.title = "Close board";
    x.setAttribute("role", "button");
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(i);
    });
    b.append(mark, name, x);
    b.addEventListener("click", () => {
      boardPop.hidden = true;
      if (i !== active) switchTab(i);
    });
    return b;
  });
  if (items.length) items.push(el("div", "menu-sep"));
  const mk = (label: string, fn: () => void) => {
    const b = el("button", "menu-item");
    const pad = el("span", "menu-check");
    const name = el("span", "menu-name");
    name.textContent = label;
    b.append(pad, name);
    b.addEventListener("click", () => {
      boardPop.hidden = true;
      fn();
    });
    return b;
  };
  items.push(mk("New board…", newBoard), mk("Open file…", addFiles));
  boardPop.replaceChildren(...items);
}

switchBtn.addEventListener("click", () => {
  boardPop.hidden = !boardPop.hidden;
  renderSwitcher();
});
document.addEventListener("pointerdown", (e) => {
  if (!boardPop.hidden && !(e.target as HTMLElement).closest("#switch-wrap")) boardPop.hidden = true;
});

// ---------------------------------------------------------------- filter

const filterBtn = $("#filter-btn");
const filterPop = $("#filter-pop");

function renderFilter() {
  const active = filterColors.size > 0 || filterUrgency > 0;
  filterBtn.classList.toggle("on", active);
  const colors = el("div", "filter-row");
  COLORS.forEach((_, i) => {
    const b = el("button", `swatch c${i}` + (filterColors.has(i) ? " on" : ""));
    b.title = COLOR_NAMES[i];
    b.addEventListener("click", () => {
      filterColors.has(i) ? filterColors.delete(i) : filterColors.add(i);
      renderFilter();
      render();
    });
    colors.append(b);
  });
  const urg = el("div", "filter-row");
  [1, 2, 3].forEach((n) => {
    const b = el("button", "urg" + (filterUrgency === n ? " on" : ""));
    b.textContent = "!".repeat(n);
    b.title = n === 3 ? "Only urgency !!!" : `Urgency ${"!".repeat(n)} or higher`;
    b.addEventListener("click", () => {
      filterUrgency = filterUrgency === n ? 0 : n;
      renderFilter();
      render();
    });
    urg.append(b);
  });
  const clear = el("button", "btn filter-clear");
  clear.textContent = "Clear";
  clear.disabled = !active;
  clear.addEventListener("click", clearFilter);
  urg.append(clear);
  filterPop.replaceChildren(colors, urg);
}

function clearFilter() {
  filterColors.clear();
  filterUrgency = 0;
  renderFilter();
  render();
}

filterBtn.addEventListener("click", () => {
  filterPop.hidden = !filterPop.hidden;
});
document.addEventListener("pointerdown", (e) => {
  if (!filterPop.hidden && !(e.target as HTMLElement).closest("#filter-wrap")) filterPop.hidden = true;
});
renderFilter();

// ---------------------------------------------------------------- actions
// Shared by keyboard shortcuts and the native menu bar.

const lastRun = new Map<string, number>();

function runAction(id: string) {
  // A menu shortcut can arrive both as a menu event and as a key press.
  const now = performance.now();
  // Urgency toggles, so a duplicate would undo itself: give it a wider window.
  const windowMs = id.startsWith("urgency-") ? 300 : 40;
  if (now - (lastRun.get(id) ?? -1e9) < windowMs) return;
  lastRun.set(id, now);

  const urgency = id.match(/^urgency-([0-3])$/);
  if (urgency) {
    applyUrgency(+urgency[1]);
    return;
  }
  switch (id) {
    case "open":
      addFiles();
      break;
    case "new":
      newBoard();
      break;
    case "close-tab":
      if (modal) closeModal();
      else if (cur()) closeTab(active);
      else if (isNative) getCurrentWindow().close();
      break;
    case "undo":
    case "redo":
      // In a text field, undo typing; otherwise undo the last board change.
      if (inInput()) document.execCommand(id);
      else if (id === "undo") undo();
      else redo();
      break;
    case "find":
      if (modal) break;
      openSearch();
      break;
    case "zoom-in":
      setZoom(zoom + 0.1);
      break;
    case "zoom-out":
      setZoom(zoom - 0.1);
      break;
    case "zoom-reset":
      setZoom(1);
      break;
    case "sort-urgency": {
      const t = cur();
      const f = t && findCard(t.board, selected);
      if (f) sortByUrgency(f.list.id);
      break;
    }
    case "clear-filter":
      clearFilter();
      break;
  }
}
onMenu(runAction);

// ---------------------------------------------------------------- keyboard

window.addEventListener("keydown", (e) => {
  const mod = isApple ? e.metaKey : e.ctrlKey;
  const urg = urgencyDigit(e);

  if (urg != null) {
    e.preventDefault();
    runAction("urgency-" + urg);
    return;
  }

  // Shortcuts that also exist in the native menu bar go through runAction,
  // which ignores the duplicate if both the menu and this handler fire.
  if (mod) {
    const k = e.key.toLowerCase();
    const action =
      k === "z" ? (e.shiftKey ? "redo" : "undo")
      : k === "w" ? "close-tab"
      : k === "o" ? "open"
      : k === "n" ? "new"
      : k === "f" ? "find"
      : k === "=" || k === "+" ? "zoom-in"
      : k === "-" ? "zoom-out"
      : k === "0" ? "zoom-reset"
      : null;
    if (action) {
      e.preventDefault();
      runAction(action);
      return;
    }
  }

  if (modal) {
    if (e.key === "Escape" || (mod && e.key === "Enter")) {
      e.preventDefault();
      closeModal();
    }
    return;
  }

  if (mod) {
    if (/^[1-9]$/.test(e.key) && +e.key <= tabs.length) {
      e.preventDefault();
      switchTab(+e.key - 1);
    }
    return;
  }

  if (inInput()) {
    if (e.key === "Escape" && document.activeElement === searchEl) {
      searchEl.value = "";
      setQuery("");
      searchEl.blur();
    }
    return;
  }

  if (e.key === "Escape") {
    if (!boardPop.hidden) boardPop.hidden = true;
    else if (!filterPop.hidden) filterPop.hidden = true;
    else if (query) closeSearch();
    else select(null);
    return;
  }

  if (e.key.startsWith("Arrow")) {
    e.preventDefault();
    navigate(e.key, e.altKey);
    return;
  }

  if (!selected) return;
  const t = cur();
  if (!t) return;

  if (/^[0-6]$/.test(e.key)) {
    e.preventDefault();
    setColor(selected, +e.key);
  } else if (e.key === " ") {
    e.preventDefault();
    toggleCard(selected, e.altKey);
  } else if (e.key === "Enter") {
    e.preventDefault();
    const f = findCard(t.board, selected);
    if (f) openModal(t, f.card);
  } else if (e.key === "Backspace" || e.key === "Delete") {
    e.preventDefault();
    deleteCard(selected);
  }
});

// ---------------------------------------------------------------- top bar & startup

const addPop = $("#add-pop");
$("#add-btn").addEventListener("click", () => {
  addPop.hidden = !addPop.hidden;
  if (addPop.hidden) return;
  // Keep the menu on screen when the button sits near the right edge.
  addPop.style.left = "";
  const r = addPop.getBoundingClientRect();
  const over = r.right - (window.innerWidth - 8);
  if (over > 0) addPop.style.left = -over + "px";
});
$("#add-new").addEventListener("click", () => {
  addPop.hidden = true;
  newBoard();
});
$("#add-open").addEventListener("click", () => {
  addPop.hidden = true;
  addFiles();
});
document.addEventListener("pointerdown", (e) => {
  if (!addPop.hidden && !(e.target as HTMLElement).closest("#add-wrap")) addPop.hidden = true;
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !addPop.hidden) addPop.hidden = true;
});
$("#empty-open").addEventListener("click", addFiles);
$("#empty-new").addEventListener("click", newBoard);

if (isNative && /Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints === 0) {
  document.documentElement.classList.add("mac");
}

if (isNative) {
  // Dropping .md files onto the window opens them.
  getCurrentWebview().onDragDropEvent((e) => {
    if (e.payload.type === "drop") {
      for (const p of e.payload.paths) if (MD_EXT.test(p)) openPath(p);
    }
  });
}

(async () => {
  let session: { paths?: string[]; active?: number } | null = null;
  try {
    session = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
  } catch {
    session = null;
  }
  const paths = session?.paths?.length ? session.paths : isNative ? [] : ["/demo/hello.md"];
  for (const p of paths) await openPath(p, false);
  if (tabs.length) active = Math.min(Math.max(session?.active ?? 0, 0), tabs.length - 1);
  render(true);
  persist();
  onOpenRequest(async (ps) => {
    // One file (Finder / Files "Open With") is brought to the front. A batch
    // (iOS opens every board in its Documents folder at launch) keeps the
    // board that was showing.
    const focus = ps.length === 1 || !tabs.length;
    for (const p of ps) await openPath(p, false);
    if (focus) {
      const i = tabs.findIndex((t) => t.path === ps[ps.length - 1]);
      if (i >= 0) switchTab(i);
    }
  });
})();

