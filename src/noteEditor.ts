// The card notes editor. A textarea can't style single lines, so checklist
// items couldn't get a hanging indent (wrapped lines fell back to the left
// edge). Instead this is a contenteditable with one <div> per line: checklist
// lines show a box in place of the "- [ ]" marker and indent their text, so
// wrapped lines line up under the item. The Markdown text stays the source of
// truth: the DOM is read back after every edit and only lines that no longer
// match are redrawn, so ordinary typing never touches the browser's text nodes.

const ITEM_RE = /^(\s*)([-*+] \[([ xX])\])( ?)(.*)$/;

type State = { value: string; start: number; end: number };

export class NoteEditor {
  readonly el: HTMLDivElement;
  private val = "";
  private sel = { start: 0, end: 0 };
  private undoStack: State[] = [];
  private redoStack: State[] = [];
  private lastPush = 0;
  private composing = false;
  /** Called after every change made by the user (not by setting `value`). */
  oninput: () => void = () => {};

  constructor(el: HTMLDivElement) {
    this.el = el;
    el.contentEditable = "true";
    el.setAttribute("role", "textbox");
    el.setAttribute("aria-multiline", "true");
    this.render();

    el.addEventListener("beforeinput", (e) => this.beforeInput(e));
    el.addEventListener("input", () => {
      if (!this.composing) this.sync();
    });
    el.addEventListener("compositionstart", () => (this.composing = true));
    el.addEventListener("compositionend", () => {
      this.composing = false;
      this.sync();
    });
    document.addEventListener("selectionchange", () => {
      const s = this.readSelection();
      if (s) this.sel = s;
    });
    // Tap targets for the boxes live in a layer above the field, not inside
    // it: iOS starts editing (and shows the keyboard) on any tap inside an
    // editable area, before a script can stop it.
    this.hits = document.createElement("div");
    this.hits.className = "cb-hits";
    el.after(this.hits);
    const keep = (e: Event) => e.preventDefault(); // keep focus and caret where they are
    this.hits.addEventListener("pointerdown", keep);
    this.hits.addEventListener("mousedown", keep);
    this.hits.addEventListener("touchend", (e) => {
      const hit = (e.target as HTMLElement).closest<HTMLElement>(".cb-hit");
      if (!hit) return;
      e.preventDefault(); // no click follows
      this.toggle(+hit.dataset.line!);
    });
    this.hits.addEventListener("click", (e) => {
      const hit = (e.target as HTMLElement).closest<HTMLElement>(".cb-hit");
      if (hit) this.toggle(+hit.dataset.line!);
    });
    el.addEventListener("scroll", () => this.placeHits());
    new ResizeObserver(() => this.placeHits()).observe(el);
  }

  private hits: HTMLDivElement;

  /** Put a tap target over each box (after redraws, scrolling and resizes). */
  private placeHits() {
    const frag = document.createDocumentFragment();
    Array.from(this.el.children).forEach((line, i) => {
      const box = (line as HTMLElement).querySelector<HTMLElement>(":scope > .cb");
      if (!box) return;
      const l = line as HTMLElement;
      const hit = document.createElement("button");
      hit.type = "button";
      hit.className = "cb-hit";
      hit.tabIndex = -1;
      hit.dataset.line = String(i);
      hit.setAttribute("aria-label", l.classList.contains("on") ? "Untick" : "Tick");
      const top = this.el.offsetTop + l.offsetTop + box.offsetTop - this.el.scrollTop;
      const left = this.el.offsetLeft + l.offsetLeft + box.offsetLeft;
      hit.style.top = top + box.offsetHeight / 2 + "px";
      hit.style.left = left + box.offsetWidth / 2 + "px";
      frag.append(hit);
    });
    this.hits.replaceChildren(frag);
  }

  // ---- textarea-like API

  get value() {
    return this.val;
  }
  set value(v: string) {
    this.val = v.replace(/\r\n?/g, "\n");
    this.undoStack = [];
    this.redoStack = [];
    this.sel = { start: this.val.length, end: this.val.length };
    this.render();
  }
  get selectionStart() {
    return (this.readSelection() ?? this.sel).start;
  }
  get selectionEnd() {
    return (this.readSelection() ?? this.sel).end;
  }
  get scrollTop() {
    return this.el.scrollTop;
  }
  set scrollTop(n: number) {
    this.el.scrollTop = n;
  }
  get scrollHeight() {
    return this.el.scrollHeight;
  }
  focus() {
    this.el.focus({ preventScroll: true });
    this.setSelectionRange(this.sel.start, this.sel.end);
  }
  blur() {
    this.el.blur();
  }
  setSelectionRange(start: number, end: number) {
    this.sel = { start, end };
    if (document.activeElement !== this.el) return;
    const a = this.point(start);
    const b = this.point(end);
    window.getSelection()?.setBaseAndExtent(a[0], a[1], b[0], b[1]);
  }

  /** Replace the selection with `text`, caret after it (undoable). */
  insertText(text: string) {
    const { start, end } = this.selection();
    this.replace(start, end, text, start + text.length, text.length <= 1 ? "type" : "edit");
  }

  undo() {
    this.step(this.undoStack, this.redoStack);
  }
  redo() {
    this.step(this.redoStack, this.undoStack);
  }

  // ---- editing

  private selection() {
    return this.readSelection() ?? this.sel;
  }

  private replace(start: number, end: number, text: string, caret: number, kind: string) {
    this.record(kind);
    this.val = this.val.slice(0, start) + text + this.val.slice(end);
    this.sel = { start: caret, end: caret };
    this.render();
    this.setSelectionRange(caret, caret);
    this.scrollCaretIntoView();
    this.oninput();
  }

  private beforeInput(e: InputEvent) {
    const t = e.inputType;
    if (t === "historyUndo" || t === "historyRedo") {
      e.preventDefault();
      t === "historyUndo" ? this.undo() : this.redo();
    } else if (t === "insertParagraph" || t === "insertLineBreak") {
      e.preventDefault();
      this.newline();
    } else if (t === "insertFromPaste" || t === "insertFromDrop" || t === "insertReplacementText") {
      const text = e.dataTransfer?.getData("text/plain") ?? e.data;
      if (t === "insertReplacementText" && text == null) return;
      e.preventDefault();
      if (text) this.insertText(text.replace(/\r\n?/g, "\n"));
    } else if (t.startsWith("format")) {
      e.preventDefault();
    } else if (t === "deleteContentBackward" || t === "deleteContentForward") {
      // Browsers won't reliably delete next to the box (it's not editable),
      // so line starts and ends are handled here; the rest stays native.
      const { start, end } = this.selection();
      if (start !== end) return;
      const lineStart = this.val.lastIndexOf("\n", start - 1) + 1;
      let lineEnd = this.val.indexOf("\n", start);
      if (lineEnd < 0) lineEnd = this.val.length;
      const m = this.val.slice(lineStart, lineEnd).match(ITEM_RE);
      const textStart = m ? lineEnd - m[5].length : lineStart;
      if (t === "deleteContentBackward" && start <= textStart) {
        e.preventDefault();
        // At the start of an item: drop the box, keep the text.
        if (m) this.replace(lineStart + m[1].length, textStart, "", lineStart + m[1].length, "edit");
        else if (start > 0) this.replace(start - 1, start, "", start - 1, "edit");
      } else if (t === "deleteContentForward" && start === lineEnd && lineEnd < this.val.length) {
        e.preventDefault();
        this.replace(start, start + 1, "", start, "edit");
      }
    }
  }

  /** Enter continues a checklist / bullet list; Enter on an empty item ends it. */
  private newline() {
    const { start, end } = this.selection();
    const lineStart = this.val.lastIndexOf("\n", start - 1) + 1;
    const m = start === end && this.val.slice(lineStart, start).match(/^(\s*)([-*+]) (\[[ xX]\] ?)?(.*)$/);
    if (m && !m[4].trim()) this.replace(lineStart, start, "", lineStart, "edit");
    else if (m) this.insertText("\n" + m[1] + m[2] + " " + (m[3] ? "[ ] " : ""));
    else this.insertText("\n");
  }

  private toggle(i: number) {
    const lines = this.val.split("\n");
    const m = lines[i].match(ITEM_RE);
    if (!m) return;
    const at = lines.slice(0, i).join("\n").length + (i ? 1 : 0) + m[1].length + 3;
    const keep = this.sel;
    this.record("edit");
    this.val = this.val.slice(0, at) + (m[3] === " " ? "x" : " ") + this.val.slice(at + 1);
    this.render();
    this.setSelectionRange(keep.start, keep.end);
    this.oninput();
  }

  private record(kind: string) {
    const now = Date.now();
    // Typing within a second of the last keystroke undoes as one step.
    if (kind !== "type" || now - this.lastPush > 1000) {
      this.undoStack.push({ value: this.val, ...this.sel });
      if (this.undoStack.length > 300) this.undoStack.shift();
    }
    this.lastPush = kind === "type" ? now : 0;
    this.redoStack = [];
  }

  private step(from: State[], to: State[]) {
    const s = from.pop();
    if (!s) return;
    to.push({ value: this.val, ...this.sel });
    this.val = s.value;
    this.lastPush = 0;
    this.render();
    this.setSelectionRange(s.start, s.end);
    this.oninput();
  }

  /** After the browser edited the DOM: read the text back and tidy the lines. */
  private sync() {
    const sel = this.readSelection() ?? this.sel;
    const value = readLines(this.el).join("\n");
    const changed = value !== this.val;
    if (changed) {
      this.record(Math.abs(value.length - this.val.length) <= 1 ? "type" : "edit");
      this.val = value;
    }
    this.sel = sel;
    if (this.render()) this.setSelectionRange(sel.start, sel.end);
    if (changed) this.oninput();
  }

  // ---- DOM

  /** Bring the DOM in line with the text. Returns true if anything was redrawn. */
  private render(): boolean {
    const lines = this.val.split("\n");
    const kids = this.el.childNodes;
    let changed = false;
    lines.forEach((line, i) => {
      const node = kids[i];
      if (node && matches(node, line)) return;
      const fresh = lineEl(line);
      if (node) this.el.replaceChild(fresh, node);
      else this.el.append(fresh);
      changed = true;
    });
    while (kids.length > lines.length) {
      this.el.lastChild!.remove();
      changed = true;
    }
    this.el.classList.toggle("is-empty", !this.val);
    // Line wrapping can move boxes even when no line was redrawn.
    if (this.hits) this.placeHits();
    return changed;
  }

  /** DOM position for a text offset. */
  private point(offset: number): [Node, number] {
    const lines = this.val.split("\n");
    let i = 0;
    while (i < lines.length - 1 && offset > lines[i].length) {
      offset -= lines[i].length + 1;
      i++;
    }
    const div = this.el.children[i] as HTMLElement | undefined;
    if (!div) return [this.el, this.el.childNodes.length];
    const m = lines[i].match(ITEM_RE);
    const col = m ? Math.max(0, offset - (lines[i].length - m[5].length)) : offset;
    const text = div.lastChild;
    if (text instanceof Text) return [text, Math.min(col, text.length)];
    return [div, m ? 1 : 0];
  }

  /** Text offsets of the current selection, or null if it isn't in the editor. */
  private readSelection(): { start: number; end: number } | null {
    const s = window.getSelection();
    if (!s || !s.rangeCount || !this.el.contains(s.anchorNode) || !this.el.contains(s.focusNode)) return null;
    const r = s.getRangeAt(0);
    const start = this.offsetOf(r.startContainer, r.startOffset);
    const end = r.collapsed ? start : this.offsetOf(r.endContainer, r.endOffset);
    return { start, end };
  }

  private offsetOf(node: Node, offset: number) {
    const r = document.createRange();
    r.setStart(this.el, 0);
    r.setEnd(node, offset);
    const holder = document.createElement("div");
    holder.append(r.cloneContents());
    return readLines(holder).join("\n").length;
  }

  private scrollCaretIntoView() {
    const s = window.getSelection();
    if (!s?.rangeCount || document.activeElement !== this.el) return;
    const rect = s.getRangeAt(0).getBoundingClientRect();
    const box = this.el.getBoundingClientRect();
    if (!rect.height) return;
    if (rect.bottom > box.bottom - 8) this.el.scrollTop += rect.bottom - box.bottom + 24;
    else if (rect.top < box.top + 8) this.el.scrollTop -= box.top - rect.top + 24;
  }
}

// ---- lines

function lineEl(line: string): HTMLDivElement {
  const div = document.createElement("div");
  div.className = "ln";
  const m = line.match(ITEM_RE);
  let text = line;
  if (m) {
    const on = m[3] !== " ";
    div.className = "ln item" + (on ? " on" : "");
    div.style.setProperty("--indent", String(indentWidth(m[1])));
    const box = document.createElement("span");
    box.className = "cb";
    box.contentEditable = "false";
    box.dataset.src = m[1] + m[2] + m[4];
    div.append(box);
    text = m[5];
  }
  div.append(text ? document.createTextNode(text) : document.createElement("br"));
  return div;
}

const indentWidth = (ws: string) => ws.replace(/\t/g, "    ").length;

/** Is this DOM node exactly what lineEl(line) would draw? */
function matches(node: Node, line: string) {
  if (!(node instanceof HTMLDivElement)) return false;
  const m = line.match(ITEM_RE);
  const kids = node.childNodes;
  let i = 0;
  if (m) {
    const box = kids[0];
    if (
      node.className !== "ln item" + (m[3] !== " " ? " on" : "") ||
      !(box instanceof HTMLElement) ||
      box.className !== "cb" ||
      box.dataset.src !== m[1] + m[2] + m[4]
    )
      return false;
    i = 1;
  } else if (node.className !== "ln" || node.style.length) return false;
  const text = m ? m[5] : line;
  if (kids.length !== i + 1) return false;
  const k = kids[i];
  return text ? k instanceof Text && k.data === text : k instanceof HTMLBRElement;
}

/** The text in an editor element (or a fragment of one), as lines. */
function readLines(root: Node): string[] {
  const lines: string[] = [];
  let cur: string | null = null; // inline content not inside a line <div>
  const flush = () => {
    if (cur !== null) lines.push(cur);
    cur = null;
  };
  for (const child of Array.from(root.childNodes)) {
    if (child instanceof HTMLElement && /^(DIV|P)$/.test(child.tagName)) {
      flush();
      lines.push(...blockLines(child));
    } else if (child instanceof HTMLBRElement) {
      lines.push(cur ?? "");
      cur = null;
    } else {
      cur = (cur ?? "") + inlineText(child);
    }
  }
  flush();
  return lines.length ? lines : [""];
}

function blockLines(block: HTMLElement): string[] {
  const out = [""];
  const kids = Array.from(block.childNodes);
  kids.forEach((n, i) => {
    if (n instanceof HTMLElement && /^(DIV|P)$/.test(n.tagName)) {
      out.push(...blockLines(n));
    } else if (n instanceof HTMLBRElement) {
      // A <br> at the end of a line only keeps an empty line open.
      if (i < kids.length - 1) out.push("");
    } else {
      out[out.length - 1] += inlineText(n);
    }
  });
  return out;
}

function inlineText(n: Node): string {
  if (n instanceof Text) return n.data.replace(/\n/g, " ");
  if (n instanceof HTMLElement && n.classList.contains("cb")) return n.dataset.src ?? "";
  if (n instanceof HTMLBRElement) return "";
  return Array.from(n.childNodes).map(inlineText).join("");
}
