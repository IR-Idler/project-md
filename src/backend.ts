// Thin layer over the native side. In a plain browser (used only for quick UI
// testing with `npm run dev`) it falls back to an in-memory demo file.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export const isNative = "__TAURI_INTERNALS__" in window;

const demo = new Map<string, string>([
  [
    "/demo/hello.md",
    "## Doing !\n\n### Presentation vidéo 🟩\n\nLet's make it clear what the software does.\n\n### Presentation website 🟥\n\nSimple and to the point\n\n## To Do Later\n\n### Android builds 🟩\n\n### Windows builds 🟩\n\n### Mac builds 🟩\n\n## Done\n\n### Linux build\n\n### Nice ui\n",
  ],
]);

// A large board for checking scrolling in the browser.
demo.set(
  "/demo/big.md",
  Array.from({ length: 9 }, (_, i) =>
    `## List ${i + 1}\n\n` +
    Array.from({ length: 25 }, (_, j) => `### Card ${i + 1}.${j + 1}\n\nSome notes for this card.\nSecond line.\n\n`).join(""),
  ).join(""),
);

export function readFile(path: string): Promise<string> {
  if (isNative) return invoke<string>("read_file", { path });
  const t = demo.get(path);
  return t == null ? Promise.reject("not found") : Promise.resolve(t);
}

export function writeFile(path: string, contents: string): Promise<void> {
  if (isNative) return invoke("write_file", { path, contents });
  demo.set(path, contents);
  return Promise.resolve();
}

export function watchFile(path: string): Promise<void> {
  return isNative ? invoke("watch_file", { path }) : Promise.resolve();
}

export function unwatchFile(path: string): Promise<void> {
  return isNative ? invoke("unwatch_file", { path }) : Promise.resolve();
}

export function onFileChanged(cb: (path: string) => void) {
  if (isNative) listen<string>("file-changed", (e) => cb(e.payload));
}

/** Files the OS asked us to open (Finder "Open With", command line). */
export function onOpenRequest(cb: (paths: string[]) => void) {
  if (!isNative) return;
  const take = () => invoke<string[]>("take_pending_opens").then((p) => p.length && cb(p));
  listen("open-files", take);
  take();
}

/** Native menu bar items (desktop). */
export function onMenu(cb: (id: string) => void) {
  if (isNative) listen<string>("menu", (e) => cb(e.payload));
}
