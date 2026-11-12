// Light Markdown rendering for a card's notes on the board: checklists,
// bullets, bold / italic / code, links, and search-term highlighting.
// Everything is built with DOM nodes (never innerHTML), so file content can't inject markup.
import { CHECK_RE } from "./parser";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

/** Append text, wrapping case-insensitive matches of `query` in <mark>. */
export function highlight(parent: HTMLElement, text: string, query: string) {
  if (!query) {
    parent.append(text);
    return;
  }
  const lower = text.toLowerCase();
  let i = 0;
  for (;;) {
    const j = lower.indexOf(query, i);
    if (j < 0) break;
    if (j > i) parent.append(text.slice(i, j));
    const m = el("mark");
    m.textContent = text.slice(j, j + query.length);
    parent.append(m);
    i = j + query.length;
  }
  if (i < text.length) parent.append(text.slice(i));
}

const INLINE =
  /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\((?:https?:\/\/|mailto:)[^)\s]+\))|(https?:\/\/[^\s<>)]+)/g;

function link(parent: HTMLElement, label: string, url: string, query: string) {
  const a = el("a", "md-link");
  a.dataset.href = url;
  a.title = url;
  highlight(a, label, query);
  parent.append(a);
}

/** One line of text with inline formatting. */
export function inline(parent: HTMLElement, text: string, query: string) {
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) highlight(parent, text.slice(last, at), query);
    const tok = m[0];
    if (m[1]) {
      const c = el("code");
      highlight(c, tok.slice(1, -1), query);
      parent.append(c);
    } else if (m[2]) {
      const b = el("strong");
      highlight(b, tok.slice(2, -2), query);
      parent.append(b);
    } else if (m[3]) {
      const i = el("em");
      highlight(i, tok.slice(1, -1), query);
      parent.append(i);
    } else if (m[4]) {
      const mm = tok.match(/^\[([^\]]+)\]\((.+)\)$/)!;
      link(parent, mm[1], mm[2], query);
    } else {
      link(parent, tok, tok, query);
    }
    last = at + tok.length;
  }
  if (last < text.length) highlight(parent, text.slice(last), query);
}

/** A card's notes. Checklist boxes carry data-line so a click can tick the right line. */
export function renderNotes(box: HTMLElement, text: string, query: string) {
  let fence: string | null = null;
  text.split("\n").forEach((line, i) => {
    const f = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (f) {
      fence = fence ? (f[1][0] === fence ? null : fence) : f[1][0];
      return;
    }
    if (fence) {
      const d = el("div", "body-code");
      highlight(d, line, query);
      box.append(d);
      return;
    }
    const check = line.match(CHECK_RE);
    if (check) {
      const done = check[2] !== " ";
      const row = el("div", "check-row" + (done ? " done" : ""));
      row.style.paddingLeft = check[1].length * 0.6 + "em";
      const b = el("button", "check" + (done ? " on" : ""));
      b.dataset.line = String(i);
      b.textContent = done ? "✓" : "";
      b.title = done ? "Untick" : "Tick";
      const s = el("span");
      inline(s, check[3], query);
      row.append(b, s);
      box.append(row);
      return;
    }
    const bullet = line.match(/^(\s*)[-*+] (.*)$/);
    if (bullet) {
      const row = el("div", "bullet-row");
      row.style.paddingLeft = bullet[1].length * 0.6 + "em";
      const dot = el("span", "bullet");
      dot.textContent = "•";
      const s = el("span");
      inline(s, bullet[2], query);
      row.append(dot, s);
      box.append(row);
      return;
    }
    const head = line.match(/^#{1,6} (.*)$/);
    if (head) {
      const d = el("div", "body-head");
      inline(d, head[1], query);
      box.append(d);
      return;
    }
    if (!line.trim()) {
      box.append(el("div", "body-gap"));
      return;
    }
    const d = el("div", "body-line");
    inline(d, line, query);
    box.append(d);
  });
}
