// Board <-> Markdown.
//
//   text before the first "##"   -> preamble (kept as is)
//   ## Heading                   -> a list (column)
//   ### Heading                  -> a card inside the current list
//   lines below a ### heading    -> the card's text
//   trailing 🟥 🟧 🟨 🟩 🟦 🟪 in a card heading -> the card's color
//   trailing ❗ / ❗❗ / ❗❗❗ in a card heading  -> the card's urgency (1-3)
//   "- [ ] text" / "- [x] text" lines in a card -> checklist items
//
// Headings inside fenced code blocks (``` or ~~~) are treated as plain text.

export const COLORS = ["🟥", "🟧", "🟨", "🟩", "🟦", "🟪"] as const;
export const COLOR_NAMES = ["Red", "Orange", "Yellow", "Green", "Blue", "Purple"];

export const URGENT = "❗";
export type Card = { id: string; title: string; color: number | null; urgency: number; body: string };

/** A checklist line: [1] indent, [2] " " or "x", [3] text. */
export const CHECK_RE = /^(\s*)[-*+] \[([ xX])\] ?(.*)$/;

export function checklistProgress(body: string): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const line of body.split("\n")) {
    const m = line.match(CHECK_RE);
    if (!m) continue;
    total++;
    if (m[2] !== " ") done++;
  }
  return { done, total };
}

/** Tick / untick the checklist item on the given line of a card's text. */
export function toggleCheck(body: string, lineIndex: number): string {
  const lines = body.split("\n");
  const line = lines[lineIndex];
  if (line == null || !CHECK_RE.test(line)) return body;
  lines[lineIndex] = line.replace(/\[([ xX])\]/, (_, c) => (c === " " ? "[x]" : "[ ]"));
  return lines.join("\n");
}
export type List = { id: string; title: string; body: string; cards: Card[] };
export type Board = { preamble: string; lists: List[]; crlf: boolean };

let counter = 0;
export const uid = () => "n" + (++counter).toString(36);

function trimBlank(lines: string[]): string {
  let s = 0;
  let e = lines.length;
  while (s < e && lines[s].trim() === "") s++;
  while (e > s && lines[e - 1].trim() === "") e--;
  return lines.slice(s, e).join("\n");
}

/** Split "Title ❗❗ 🟩" into its title, urgency and color. */
function splitMeta(raw: string): { title: string; color: number | null; urgency: number } {
  let title = raw.trim();
  let color: number | null = null;
  let urgency = 0;
  for (;;) {
    const ci: number = color == null ? COLORS.findIndex((c) => title.endsWith(c)) : -1;
    if (ci >= 0) {
      color = ci;
      title = title.slice(0, -COLORS[ci].length).trimEnd();
      continue;
    }
    const m = title.match(/❗\uFE0F?$/);
    if (m) {
      urgency++;
      title = title.slice(0, -m[0].length).trimEnd();
      continue;
    }
    break;
  }
  if (color == null) {
    const ci = COLORS.findIndex((c) => title.startsWith(c));
    if (ci >= 0) {
      color = ci;
      title = title.slice(COLORS[ci].length).trimStart();
    }
  }
  return { title, color, urgency: Math.min(urgency, 3) };
}

const LIST_RE = /^##(?!#)(?:[ \t]+(.*))?$/;
const CARD_RE = /^###(?!#)(?:[ \t]+(.*))?$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

/** True if a card's text contains lines that would be read back as a list or card. */
export function hasStructuralHeading(text: string): boolean {
  return text.split("\n").some((l) => LIST_RE.test(l) || CARD_RE.test(l));
}

export function parse(text: string): Board {
  const crlf = text.includes("\r\n");
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const preamble: string[] = [];
  const lists: List[] = [];
  let list: List | null = null;
  let card: Card | null = null;
  let buf: string[] = preamble;
  let fence: string | null = null;

  const flush = () => {
    if (card) card.body = trimBlank(buf);
    else if (list) list.body = trimBlank(buf);
  };

  for (const line of lines) {
    const f = line.match(FENCE_RE);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      buf.push(line);
      continue;
    }
    if (!fence) {
      let m = line.match(LIST_RE);
      if (m) {
        flush();
        list = { id: uid(), title: (m[1] ?? "").trim(), body: "", cards: [] };
        lists.push(list);
        card = null;
        buf = [];
        continue;
      }
      m = line.match(CARD_RE);
      if (m && list) {
        flush();
        card = { id: uid(), ...splitMeta(m[1] ?? ""), body: "" };
        list.cards.push(card);
        buf = [];
        continue;
      }
    }
    buf.push(line);
  }
  flush();
  return { preamble: trimBlank(preamble), lists, crlf };
}

export function serialize(board: Board): string {
  const out: string[] = [];
  if (board.preamble) out.push(board.preamble, "");
  for (const l of board.lists) {
    out.push(`## ${l.title}`.trimEnd(), "");
    const lb = trimBlank(l.body.split("\n"));
    if (lb) out.push(lb, "");
    for (const c of l.cards) {
      const mark = (c.urgency ? " " + URGENT.repeat(c.urgency) : "") + (c.color != null ? " " + COLORS[c.color] : "");
      out.push(`### ${c.title}${mark}`.trimEnd(), "");
      const cb = trimBlank(c.body.split("\n"));
      if (cb) out.push(cb, "");
    }
  }
  const text = out.join("\n");
  return board.crlf ? text.replace(/\n/g, "\r\n") : text;
}
