// Settings page. Values are stored per device in localStorage.
// To add a setting: add it to `Settings`, apply it in `apply()`, and add a
// section to #settings-page in index.html.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isIOS, isNative } from "./backend";
import { currentVersion, findUpdate, open as openLink } from "./updates";

type Theme = "system" | "light" | "dark";

interface Settings {
  theme: Theme;
}

const KEY = "projectmd.settings";
const DEFAULTS: Settings = { theme: "system" };

let settings: Settings = { ...DEFAULTS };
try {
  settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || "{}") };
} catch {
  /* fall back to defaults */
}

function apply() {
  const root = document.documentElement;
  if (settings.theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", settings.theme);
  // Desktop: match the window's title bar to the theme.
  if (isNative && !isIOS) {
    getCurrentWindow()
      .setTheme(settings.theme === "system" ? null : settings.theme)
      .catch(() => {});
  }
}
apply();

function set<K extends keyof Settings>(key: K, value: Settings[K]) {
  settings[key] = value;
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* kept for this session only */
  }
  apply();
  paint();
}

const page = document.querySelector<HTMLElement>("#settings-page")!;
const themeRows = page.querySelectorAll<HTMLButtonElement>("[data-theme-option]");

function paint() {
  for (const b of themeRows) {
    const on = b.dataset.themeOption === settings.theme;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", String(on));
  }
}
for (const b of themeRows) b.addEventListener("click", () => set("theme", b.dataset.themeOption as Theme));
paint();

export function settingsOpen() {
  return !page.hidden;
}

export function openSettings() {
  if (settingsOpen()) return;
  page.hidden = false;
  window.addEventListener("keydown", onKey, true);
  // Keyboard users land on the current choice; touch screens get no focus ring.
  if (!isIOS) page.querySelector<HTMLElement>(".on")?.focus({ focusVisible: false } as FocusOptions);
}

export function closeSettings() {
  page.hidden = true;
  window.removeEventListener("keydown", onKey, true);
}

// Capture phase, so board shortcuts don't run behind the page.
function onKey(e: KeyboardEvent) {
  const mod = e.metaKey || e.ctrlKey;
  if (e.key === "Escape" || (mod && e.key === ",")) {
    e.preventDefault();
    e.stopPropagation();
    closeSettings();
  } else if (!mod) {
    e.stopPropagation(); // default actions (Tab, Space on a row) still happen
  }
}

page.querySelector("#settings-done")!.addEventListener("click", closeSettings);

// ---------------------------------------------------------------- intro & about

for (const a of page.querySelectorAll<HTMLElement>(".intro-link")) {
  a.addEventListener("click", () => openLink(a.dataset.href!));
}

currentVersion().then((v) => {
  page.querySelector("#app-version")!.textContent = isNative ? v : "dev";
});

// The Mac app checks GitHub; on iPhone and iPad the App Store handles updates.
const updateRow = page.querySelector<HTMLButtonElement>("#check-updates")!;
const updateLabel = page.querySelector<HTMLElement>("#update-label")!;
const updateStatus = page.querySelector<HTMLElement>("#update-status")!;
let updateUrl = "";
if (isIOS) updateRow.hidden = true;
updateRow.addEventListener("click", async () => {
  if (updateUrl) {
    openLink(updateUrl);
    return;
  }
  updateRow.disabled = true;
  updateStatus.textContent = "Checking…";
  try {
    const update = await findUpdate();
    if (update) {
      updateUrl = update.url;
      updateLabel.textContent = `Download ${update.version}`;
      updateStatus.textContent = "Available";
    } else {
      updateStatus.textContent = "Up to date";
    }
  } catch {
    updateStatus.textContent = "Couldn't check";
  }
  updateRow.disabled = false;
});
