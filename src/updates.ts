// Update notice for the Mac app, which is downloaded from GitHub Releases
// (the App Store handles updates on iPhone and iPad). Once a day the app asks
// GitHub for the latest release; if it is newer, a small card offers the
// download. The user installs it themselves.
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isIOS, isNative } from "./backend";

const LATEST_URL = "https://api.github.com/repos/IR-Idler/project-md/releases/latest";
const RELEASES_PAGE = "https://github.com/IR-Idler/project-md/releases/latest";
const LAST_CHECK_KEY = "projectmd.update-check";
const DAY = 24 * 60 * 60 * 1000;

interface Release {
  version: string;
  url: string;
}

/** "v1.2.10" > "1.2.9"; anything after "-" or "+" is ignored. */
export function isNewer(latest: string, current: string): boolean {
  const parts = (v: string) =>
    v.replace(/^v/, "").split(/[-+]/)[0].split(".").map((n) => parseInt(n, 10) || 0);
  const a = parts(latest);
  const b = parts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

export async function currentVersion(): Promise<string> {
  // The browser preview (npm run dev) has no app version: treat it as old.
  return isNative ? getVersion() : "0.0.0";
}

async function fetchLatest(): Promise<Release> {
  const res = await fetch(LATEST_URL, { headers: { Accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error("GitHub answered " + res.status);
  const data = await res.json();
  if (typeof data.tag_name !== "string") throw new Error("no tag_name");
  return { version: data.tag_name.replace(/^v/, ""), url: data.html_url || RELEASES_PAGE };
}

export function open(url: string) {
  if (isNative) openUrl(url).catch(() => {});
  else window.open(url, "_blank");
}

/** A card in the corner that stays until the user picks a button. */
function notice(text: string, buttons: { label: string; primary?: boolean; run?: () => void }[]) {
  document.querySelector(".update-note")?.remove();
  const box = document.createElement("div");
  box.className = "update-note";
  box.setAttribute("role", "status");
  const p = document.createElement("p");
  p.textContent = text;
  const row = document.createElement("div");
  row.className = "update-actions";
  for (const b of buttons) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn" + (b.primary ? " primary" : "");
    btn.textContent = b.label;
    btn.addEventListener("click", () => {
      box.remove();
      b.run?.();
    });
    row.append(btn);
  }
  box.append(p, row);
  document.body.append(box);
}

/** The newer release, or null when this version is the latest. Throws if GitHub can't be reached. */
export async function findUpdate(): Promise<Release | null> {
  const [current, latest] = await Promise.all([currentVersion(), fetchLatest()]);
  try {
    localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
  } catch {
    /* checks again next launch */
  }
  return isNewer(latest.version, current) ? latest : null;
}

/**
 * Look for a newer release. `manual` (from the menu) always checks and also
 * reports "up to date" or a failed check; otherwise it runs at most once a day
 * and stays silent unless there is an update.
 */
export async function checkForUpdates(manual = false) {
  if (isIOS) return;
  if (!manual) {
    let last = 0;
    try {
      last = Number(localStorage.getItem(LAST_CHECK_KEY)) || 0;
    } catch {
      /* check anyway */
    }
    if (Date.now() - last < DAY) return;
  }
  try {
    const [current, latest] = await Promise.all([currentVersion(), findUpdate()]);
    if (latest) {
      notice(`Project MD ${latest.version} is available. You have ${current}.`, [
        { label: "Later" },
        { label: "Download", primary: true, run: () => open(latest.url) },
      ]);
    } else if (manual) {
      notice(`You're up to date (Project MD ${current}).`, [{ label: "OK", primary: true }]);
    }
  } catch (err) {
    console.warn("update check failed", err);
    if (manual) {
      notice("Couldn't check for updates. Check your internet connection.", [
        { label: "OK" },
        { label: "Open Releases", primary: true, run: () => open(RELEASES_PAGE) },
      ]);
    }
  }
}
