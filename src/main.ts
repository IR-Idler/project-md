import { getCurrentWebview } from "@tauri-apps/api/webview";
import { ask, open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { isNative, onFileChanged, onOpenRequest, readFile, unwatchFile, watchFile, writeFile } from "./backend";
import { Board, Card, COLOR_NAMES, hasStructuralHeading, List, parse, serialize, uid } from "./parser";
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

type ModalState = { tab: Tab; card: Card; before: string; isNew: boolean; wasOpen: boolean };

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

function isExpanded(t: Tab, c: Card) {
  return !!c.body.trim() && (expanded[t.path] ?? []).includes(c.title);
}

function setExpanded(t: Tab, cards: Card[], open: boolean) {
  const set = new Set(expanded[t.path] ?? []);
  for (const c of cards) open ? set.add(c.title) : set.delete(c.title);
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
  return (p.split(/[\\/]/).pop() || p).replace(MD_EXT, "");
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
  return !query || (c.title + "\n" + c.body).toLowerCase().includes(query);
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
  });
  if (!res) return;
  for (const p of Array.isArray(res) ? res : [res]) await openPath(p);
}

async function newBoard() {
  if (!isNative) return;
  const p = await saveDialog({
    defaultPath: "Board.md",
    filters: [{ name: "Markdown", extensions: ["md"] }],
  });
  if (!p) return;
  const path = MD_EXT.test(p) ? p : p + ".md";
  await writeFile(path, "## To do\n\n## Doing\n\n## Done\n");
  await openPath(path);
}

async function reloadFromDisk(t: Tab) {
  if (modal && modal.tab === t) {
    t.pendingReload = true;
    return;
  }
  if (saveTimers.has(t)) return; // our own change is about to be written
  let text: string;
  try {
    text = await readFile(t.path);
  } catch {
    return; // file missing for a moment (being replaced / synced)
  }
  if (text === t.lastText) return;
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
      d.addEventListener("mousedown", (e) => {
        if (e.button === 0 && !(e.target as HTMLElement).closest(".tab-close")) switchTab(i);
      });
      d.append(name, x);
      return d;
    }),
  );
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

    const head = el("div", "col-head");
    const title = el("span", "col-title");
    title.textContent = l.title || "Untitled";
    title.title = "Double-click to rename";
    const del = el("button", "col-del");
    del.textContent = "×";
    del.title = "Delete list";
    head.append(title, del);

    const cards = el("div", "cards");
    for (const c of l.cards) {
      const ce = el("div", "card");
      ce.dataset.card = c.id;
      if (c.color != null) ce.classList.add("c" + c.color);
      if (c.id === selected) ce.classList.add("selected");
      if (query) ce.classList.add(matches(c) ? "match" : "dim");
      const row = el("div", "card-row");
      const tt = el("span", "card-title");
      tt.textContent = c.title || "Untitled";
      if (!c.title) tt.classList.add("untitled");
      row.append(tt);
      if (c.body.trim()) {
        const open = isExpanded(t, c);
        const tg = el("button", "card-toggle" + (open ? " open" : ""));
        tg.textContent = "›";
        tg.title = open ? "Collapse (Space) · ⌥-click: whole list" : "Expand (Space) · ⌥-click: whole list";
        row.append(tg);
        ce.append(row);
        if (open) {
          const body = el("div", "card-body");
          body.textContent = c.body;
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
  const card: Card = { id: uid(), title: "", color: null, body: "" };
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
        card.color = n ? n - 1 : null;
        scheduleSave(modal!.tab, 300);
        renderSwatches();
      });
      return b;
    }),
  );
}

function openModal(tab: Tab, card: Card, before = serialize(tab.board), isNew = false) {
  modal = { tab, card, before, isNew, wasOpen: isExpanded(tab, card) };
  mTitle.value = card.title;
  mBody.value = card.body;
  renderSwatches();
  backdrop.hidden = false;
  if (isNew || !card.title) mTitle.focus();
  else {
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
  modal.card.title = mTitle.value.replace(/[\r\n]+/g, " ");
  scheduleSave(modal.tab, 500);
});
mBody.addEventListener("input", () => {
  if (!modal) return;
  modal.card.body = mBody.value;
  scheduleSave(modal.tab, 500);
});
mTitle.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    mBody.focus();
  }
});
backdrop.addEventListener("mousedown", (e) => {
  if (e.target === backdrop) closeModal();
});
$("#m-delete").addEventListener("click", () => closeModal(true));

// ---------------------------------------------------------------- drag & drop
// Pointer-based (not HTML5 drag events) so it behaves the same with a mouse,
// a trackpad, and later on touch screens.

type Press = { kind: "card" | "list"; el: HTMLElement; id: string; x: number; y: number };
type Drag = Press & { ghost: HTMLElement; ph: HTMLElement; dx: number; dy: number; raf: number };

let press: Press | null = null;
let drag: Drag | null = null;

function beginPress(e: PointerEvent, kind: Press["kind"], target: HTMLElement) {
  const id = kind === "card" ? target.dataset.card! : target.dataset.list!;
  press = { kind, el: target, id, x: e.clientX, y: e.clientY };
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);
}

function onPointerMove(e: PointerEvent) {
  if (!press) return;
  if (!drag) {
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < 5) return;
    startDrag();
  }
  moveDrag(e.clientX, e.clientY);
}

function onPointerUp(e: PointerEvent) {
  window.removeEventListener("pointermove", onPointerMove);
  window.removeEventListener("pointerup", onPointerUp);
  window.removeEventListener("pointercancel", onPointerUp);
  if (drag) endDrag(e.type === "pointercancel");
  else if (press?.kind === "card") select(press.id);
  press = null;
}

function startDrag() {
  if (!press) return;
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
    let col = cols.find((c) => {
      const r = c.getBoundingClientRect();
      return x >= r.left && x <= r.right;
    });
    if (!col) {
      col = cols.reduce((best, c) => {
        const r = c.getBoundingClientRect();
        const b = best.getBoundingClientRect();
        return Math.abs(x - (r.left + r.right) / 2) < Math.abs(x - (b.left + b.right) / 2) ? c : best;
      });
    }
    const list = col.querySelector<HTMLElement>(".cards")!;
    const items = [...list.children].filter((c) => c.classList.contains("card") && c !== drag!.el);
    const before = items.find((it) => {
      const r = it.getBoundingClientRect();
      return y < r.top + r.height / 2;
    });
    if (before) {
      if (drag.ph.nextElementSibling !== before) list.insertBefore(drag.ph, before);
    } else if (list.lastElementChild !== drag.ph) {
      list.append(drag.ph);
    }
  } else {
    const before = cols.find((c) => {
      const r = c.getBoundingClientRect();
      return x < r.left + r.width / 2;
    });
    const anchor = before ?? boardEl.querySelector(".add-list");
    if (anchor && drag.ph.nextElementSibling !== anchor) boardEl.insertBefore(drag.ph, anchor);
  }
}

function autoScroll() {
  if (!drag) return;
  const edge = 70;
  const br = boardEl.getBoundingClientRect();
  let moved = false;
  if (lastX < br.left + edge) {
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
}

// ---------------------------------------------------------------- board events

boardEl.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  const target = e.target as HTMLElement;
  if (target.closest("button, input")) return;
  if (inInput()) (document.activeElement as HTMLElement).blur();
  const card = target.closest<HTMLElement>(".card");
  if (card) {
    e.preventDefault();
    beginPress(e, "card", card);
    return;
  }
  const head = target.closest<HTMLElement>(".col-head");
  if (head) {
    e.preventDefault();
    beginPress(e, "list", head.parentElement!);
    return;
  }
  select(null);
});

boardEl.addEventListener("dblclick", (e) => {
  const target = e.target as HTMLElement;
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
  const toggle = target.closest(".card-toggle");
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
    if (e.deltaX !== 0 || e.shiftKey) return;
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

// ---------------------------------------------------------------- keyboard

window.addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey;

  if (modal) {
    if (e.key === "Escape" || (mod && e.key === "Enter")) {
      e.preventDefault();
      closeModal();
    }
    return;
  }

  if (mod) {
    const k = e.key.toLowerCase();
    if (k === "f") {
      e.preventDefault();
      searchEl.focus();
      searchEl.select();
    } else if (k === "o") {
      e.preventDefault();
      addFiles();
    } else if (k === "n") {
      e.preventDefault();
      newBoard();
    } else if (k === "z" && !inInput()) {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    } else if (/^[1-9]$/.test(e.key) && +e.key <= tabs.length) {
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
    if (query) {
      searchEl.value = "";
      setQuery("");
    } else select(null);
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

$("#add-files").addEventListener("click", addFiles);
$("#empty-open").addEventListener("click", addFiles);
$("#empty-new").addEventListener("click", newBoard);

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
    for (const p of ps) await openPath(p);
  });
})();
