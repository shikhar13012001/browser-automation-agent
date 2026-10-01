import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

// The agent drives a Chrome started with a debug port. If that Chrome was closed or crashed while
// nobody was watching, every queued task would fail on its first tool call -- so before each task the
// daemon checks the port and, if it's down, starts that Chrome again (a separate instance with its
// own profile; the user's everyday Chrome is left alone).
const CDP_URL = process.env.INTENT_BROWSER_CDP_URL ?? "http://127.0.0.1:9222";
const PROFILE = process.env.INTENT_AGENT_CHROME_PROFILE;
const AUTOSTART = process.env.INTENT_AGENT_CHROME_AUTOSTART !== "0";

const CANDIDATES: Record<string, string[]> = {
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    `${process.env.LOCALAPPDATA ?? ""}\\Google\\Chrome\\Application\\chrome.exe`,
  ],
  darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
  linux: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"],
};

async function reachable(): Promise<boolean> {
  try {
    const res = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

function chromePath(): string | undefined {
  if (process.env.INTENT_AGENT_CHROME_PATH) return process.env.INTENT_AGENT_CHROME_PATH;
  return (CANDIDATES[process.platform] ?? []).find((p) => existsSync(p));
}

// Resolves when the debug port answers; throws a message meant for the user when it can't be made to.
export async function ensureChrome(): Promise<void> {
  if (await reachable()) return;
  const port = new URL(CDP_URL).port || "9222";
  const exe = chromePath();
  if (!AUTOSTART || !PROFILE || !exe) {
    throw new Error(
      `Chrome is not reachable on ${CDP_URL}. Start it with remote debugging (scripts/start-debug-chrome.ps1)` +
        (PROFILE ? "" : ", or set INTENT_AGENT_CHROME_PROFILE in apps/daemon/.env so the daemon can start it itself") +
        ".",
    );
  }
  console.log(`[chrome] debug port ${port} is down -- starting Chrome with profile ${PROFILE}`);
  // The last three keep a covered/background window rendering at full speed (the tool also uses
  // focus emulation, but these cover tabs it hasn't touched yet).
  const flags = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${PROFILE}`,
    "--no-first-run",
    "--restore-last-session",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
  ];
  // Extensions inject content scripts into every page: with a copied everyday profile (~30 of them)
  // a navigation took ~1.6s instead of ~90ms. Logins live in cookies, so they still work without them.
  if (process.env.INTENT_AGENT_CHROME_EXTENSIONS !== "1") flags.push("--disable-extensions");
  const child = spawn(exe, flags, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  for (let waited = 0; waited < 30_000; waited += 1000) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await reachable()) {
      console.log("[chrome] Chrome is back");
      return;
    }
  }
  throw new Error(`Started Chrome but its debug port ${port} did not come up within 30s.`);
}
