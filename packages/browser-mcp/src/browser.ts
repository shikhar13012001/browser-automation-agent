import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import puppeteer, { type Browser, type ElementHandle, type Frame, type HTTPRequest, type Page, type Target } from "puppeteer-core";
import { EXTRACT_SRC } from "./extract-src.js";
import { formatState, type FrameData } from "./format.js";

const CDP_URL = process.env.INTENT_BROWSER_CDP_URL ?? "http://127.0.0.1:9222";
export const SCREENSHOT_PATH = join(tmpdir(), "intent-browser", "latest.jpg");
const FRAME_STRIDE = 100_000;

let browser: Browser | undefined;
let current: Page | undefined;
const ownedPages = new Set<Page>();
const notes: string[] = [];

// Frame -> id base, so element ids from iframes never collide with the main frame's.
const frameBase = new WeakMap<Frame, number>();
const baseFrame = new Map<number, Frame>();
const baseGen = new Map<number, string>();
let nextBase = FRAME_STRIDE;

type ItemKey = { kind: string; label: string; section: string };
const lastItems = new Map<number, ItemKey>();
let lastDialogs = "";

// What the model was looking at: the latest state's element identities and open dialogs.
export function snapshot(): { dialogs: string; items: Map<number, ItemKey> } {
  return { dialogs: lastDialogs, items: new Map(lastItems) };
}

export function itemKey(id: number): ItemKey | undefined {
  return lastItems.get(id);
}

// The one element in the latest state with the same kind and label (and section, when that breaks a
// tie). Returns undefined when there's no match or it's ambiguous -- five "Delete" buttons in a
// list must not be guessed between.
export function findSameItem(key: ItemKey): number | undefined {
  const same = [...lastItems.entries()].filter(([, v]) => v.kind === key.kind && v.label === key.label);
  if (same.length === 1) return same[0][0];
  const inSection = same.filter(([, v]) => v.section === key.section);
  return inSection.length === 1 ? inSection[0][0] : undefined;
}

export function takeNotes(): string[] {
  return notes.splice(0, notes.length);
}

async function getBrowser(): Promise<Browser> {
  if (browser?.connected) return browser;
  browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null, protocolTimeout: 60_000 });
  browser.on("targetcreated", onTargetCreated);
  browser.on("disconnected", () => {
    browser = undefined;
    current = undefined;
    ownedPages.clear();
  });
  return browser;
}

const watched = new WeakSet<Page>();

// Chrome stops rendering a window that other apps cover, and the user being away usually means
// exactly that. A hidden page never runs requestAnimationFrame/IntersectionObserver callbacks and
// gets its timers throttled, so puppeteer's click() (which waits on an IntersectionObserver) hung
// until the 60s protocol timeout on every action. Focus emulation makes Chrome treat the page as
// visible and focused, whatever is on top of it. It lasts as long as this CDP session stays open.
async function keepRendering(page: Page): Promise<void> {
  try {
    const s = await page.createCDPSession();
    await s.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  } catch {
    // older Chrome or a closing tab; actions still work, just slower when the window is covered
  }
}

function watchPage(page: Page): Promise<void> {
  if (watched.has(page)) return Promise.resolve();
  watched.add(page);
  const rendering = keepRendering(page);
  page.on("dialog", (d) => {
    notes.push(`Browser ${d.type()} dialog said ${JSON.stringify(d.message())} -- accepted it.`);
    void d.accept().catch(() => {});
  });
  return rendering;
}

// A click that opens a new tab (target=_blank "Apply" buttons) moves work into that tab, which is
// what a person would do; the previous tab stays open in the background.
async function onTargetCreated(target: Target): Promise<void> {
  if (target.type() !== "page" || !current) return;
  const opener = target.opener();
  if (!opener || opener !== current.target()) return;
  const page = await target.page();
  if (!page) return;
  const openerPage = current;
  ownedPages.add(page);
  void rememberOwned(page);
  current = page;
  await watchPage(page);
  // Chrome throttles background tabs (timers, rendering); work in the tab the user would be looking at.
  await page.bringToFront().catch(() => {});
  notes.push(`A new tab opened (${target.url() || "loading"}) -- now working in it.`);
  // Sign-in popups ("Continue with Google") close themselves when done; carry on in the tab that opened them.
  page.once("close", () => {
    ownedPages.delete(page);
    if (current === page) {
      current = openerPage && !openerPage.isClosed() ? openerPage : undefined;
      notes.push("That tab closed itself (e.g. a sign-in popup finished) -- back in the original tab.");
    }
  });
}

const HOME_TAB_FILE = join(tmpdir(), "intent-browser", "home-tab.txt");
// Tabs the agent opened (Apply buttons, popups), across server restarts: ownedPages only knows the
// current process's, so leftovers from earlier runs piled up (9 tabs after a day of benchmarks).
const OWNED_TABS_FILE = join(tmpdir(), "intent-browser", "owned-tabs.txt");

async function rememberOwned(page: Page): Promise<void> {
  const id = targetId(page);
  if (!id) return;
  await mkdir(dirname(OWNED_TABS_FILE), { recursive: true }).catch(() => {});
  await appendFile(OWNED_TABS_FILE, id + "\n").catch(() => {});
}

async function closeLeftoverTabs(b: Browser, keep: Page): Promise<void> {
  let ids: string[] = [];
  try {
    ids = (await readFile(OWNED_TABS_FILE, "utf8")).split("\n").filter(Boolean);
  } catch {
    return;
  }
  const keepId = targetId(keep);
  for (const p of await b.pages()) {
    const id = targetId(p);
    if (id && id !== keepId && ids.includes(id)) await p.close().catch(() => {});
  }
  await writeFile(OWNED_TABS_FILE, "").catch(() => {});
}

function targetId(page: Page): string | undefined {
  return (page.target() as unknown as { _targetId?: string })._targetId;
}

// Reuse the agent's tab from a previous run (daemon restarts spawn a fresh server) instead of
// opening a new one every time; tabs piling up slows Chrome and confuses tab-aware tools.
async function adoptHomeTab(b: Browser): Promise<Page | undefined> {
  try {
    const id = (await readFile(HOME_TAB_FILE, "utf8")).trim();
    if (!id) return undefined;
    return (await b.pages()).find((p) => targetId(p) === id);
  } catch {
    return undefined;
  }
}

export async function getPage(): Promise<Page> {
  const b = await getBrowser();
  if (current && !current.isClosed()) return current;
  let page = await adoptHomeTab(b);
  if (!page) {
    page = await b.newPage();
    const id = targetId(page);
    if (id) {
      await mkdir(dirname(HOME_TAB_FILE), { recursive: true }).catch(() => {});
      await writeFile(HOME_TAB_FILE, id).catch(() => {});
    }
  }
  ownedPages.add(page);
  await watchPage(page);
  current = page;
  return page;
}

// Start of a new task: one agent tab, navigated in place. Tabs the agent opened earlier are closed
// so they don't pile up (piled-up tabs made chrome-devtools-mcp's new_page time out).
export async function openUrl(url: string): Promise<void> {
  const page = await getPage();
  for (const p of ownedPages) {
    if (p !== page && !p.isClosed()) await p.close().catch(() => {});
  }
  for (const p of [...ownedPages]) if (p.isClosed()) ownedPages.delete(p);
  await closeLeftoverTabs(await getBrowser(), page);
  await page.bringToFront().catch(() => {});
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await settle(page, true);
  // Client-side redirects (auth checks, SPA routing) often fire just after the page looks done.
  for (let i = 0; i < 2; i++) {
    const before = page.url();
    await new Promise((r) => setTimeout(r, 400));
    if (page.url() === before) break;
    await settle(page, true);
  }
}

export async function listTabs(): Promise<{ pages: Page[]; index: number }> {
  const b = await getBrowser();
  const pages = (await b.pages()).filter((p) => !p.url().startsWith("devtools://"));
  const page = await getPage();
  return { pages, index: Math.max(0, pages.indexOf(page)) };
}

export async function switchTab(index: number): Promise<void> {
  const { pages } = await listTabs();
  const p = pages[index];
  if (!p) throw new Error(`No tab ${index + 1}; there are ${pages.length}.`);
  current = p;
  await watchPage(p);
  await p.bringToFront().catch(() => {});
}

export async function closeTab(index: number): Promise<void> {
  const { pages } = await listTabs();
  const p = pages[index];
  if (!p) throw new Error(`No tab ${index + 1}; there are ${pages.length}.`);
  await p.close();
  if (p === current) current = undefined;
  ownedPages.delete(p);
}

async function domQuiet(page: Page, quietMs: number, capMs: number): Promise<void> {
  await page
    .evaluate(
      (quiet, cap) =>
        new Promise<void>((resolve) => {
          let t = setTimeout(done, quiet);
          const cap_ = setTimeout(done, cap);
          const mo = new MutationObserver(() => {
            clearTimeout(t);
            t = setTimeout(done, quiet);
          });
          function done() {
            mo.disconnect();
            clearTimeout(t);
            clearTimeout(cap_);
            resolve();
          }
          mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
        }),
      quietMs,
      capMs,
    )
    .catch(() => {});
}

// Waits for whatever an action caused: a navigation, a new tab, or client-side re-rendering.
// Waits for whatever an action caused. DOM-quiet alone isn't enough: an app that is checking a saved
// login shows its sign-in screen and sits silent while the session request is in flight, then
// redirects -- so network activity has to go quiet too, not just the DOM.
export async function settle(page: Page, afterNavigation = false): Promise<Page> {
  const p = current && !current.isClosed() ? current : page;
  // Interval polling, not the default requestAnimationFrame: rAF never fires in a page Chrome isn't rendering.
  await p.waitForFunction(() => document.readyState !== "loading", { timeout: 20_000, polling: 100 }).catch(() => {});
  await networkQuiet(p, afterNavigation ? 400 : 200, afterNavigation ? 5000 : 2000);
  await domQuiet(p, 200, afterNavigation ? 3000 : 1500);
  return p;
}

// Only requests that change what the page shows count: documents, XHR/fetch, scripts, stylesheets.
// Images, fonts, media, beacons and sockets don't, and anything open longer than LONG_LIVED_MS is
// treated as long-polling/streaming. puppeteer's waitForNetworkIdle counts everything, so on real
// sites (analytics, chat widgets, live updates) every click waited out its full timeout.
const COUNTED = new Set(["document", "xhr", "fetch", "script", "stylesheet"]);
const LONG_LIVED_MS = 1500;
const inflight = new WeakMap<Page, Map<HTTPRequest, number>>();

function trackNetwork(page: Page): void {
  if (inflight.has(page)) return;
  const m = new Map<HTTPRequest, number>();
  inflight.set(page, m);
  page.on("request", (r) => {
    if (COUNTED.has(r.resourceType())) m.set(r, Date.now());
  });
  const done = (r: HTTPRequest) => void m.delete(r);
  page.on("requestfinished", done);
  page.on("requestfailed", done);
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame()) for (const [r, t] of m) if (Date.now() - t > LONG_LIVED_MS) m.delete(r);
  });
}

async function networkQuiet(page: Page, idleMs: number, capMs: number): Promise<void> {
  trackNetwork(page);
  const m = inflight.get(page)!;
  const end = Date.now() + capMs;
  let quietSince = Date.now();
  while (Date.now() < end) {
    const now = Date.now();
    let busy = false;
    for (const t of m.values()) if (now - t < LONG_LIVED_MS) busy = true;
    if (busy) quietSince = now;
    else if (now - quietSince >= idleMs) return;
    await new Promise((r) => setTimeout(r, 40));
  }
}

export async function withNavigation<T>(page: Page, fn: () => Promise<T>): Promise<T> {
  let navigated = false;
  const onNav = (f: Frame) => {
    if (f === page.mainFrame()) navigated = true;
  };
  page.on("framenavigated", onNav);
  try {
    const result = await fn();
    // Long enough for a click's navigation or new tab to start, short enough not to add up.
    await new Promise((r) => setTimeout(r, 150));
    if (navigated) {
      await page.waitForFunction(() => document.readyState !== "loading", { timeout: 30_000, polling: 100 }).catch(() => {});
    }
    return result;
  } finally {
    page.off("framenavigated", onNav);
  }
}

function baseFor(frame: Frame, isMain: boolean): number {
  if (isMain) return 0;
  let b = frameBase.get(frame);
  if (b === undefined) {
    b = nextBase;
    nextBase += FRAME_STRIDE;
    frameBase.set(frame, b);
  }
  baseFrame.set(b, frame);
  return b;
}

export async function readState(opts: { all?: boolean; text?: boolean } = {}): Promise<string> {
  const page = await getPage();
  const frames: FrameData[] = [];
  for (const frame of page.frames()) {
    const isMain = frame === page.mainFrame();
    if (!isMain && (frame.detached || frame.url() === "about:blank" || !frame.url())) continue;
    let data: FrameData;
    try {
      data = (await frame.evaluate(`${EXTRACT_SRC}(${JSON.stringify({ all: !!opts.all, text: !!opts.text && isMain })})`)) as FrameData;
    } catch {
      continue;
    }
    if (!isMain && !data.items.length) continue;
    const base = baseFor(frame, isMain);
    if (isMain) baseFrame.set(0, frame);
    baseGen.set(base, data.gen);
    if (base) for (const it of data.items) it.id += base;
    frames.push(data);
  }
  if (!frames.length) return "(could not read the page -- it may be mid-navigation; try state again)";
  lastItems.clear();
  lastDialogs = frames.flatMap((f) => f.dialogs).join("|");
  for (const f of frames) for (const it of f.items) lastItems.set(it.id, { kind: it.kind, label: it.label, section: it.section ?? "" });
  const { pages, index } = await listTabs();
  return formatState(frames, { tabIndex: index, tabCount: pages.length });
}

// Resolves an id from the latest state to a live element, refusing ids from an earlier document so
// a stale id can never silently hit a different element on a new page.
export async function resolve(id: number): Promise<{ handle: ElementHandle<Element>; frame: Frame }> {
  const base = Math.floor(id / FRAME_STRIDE) * FRAME_STRIDE;
  const frame = baseFrame.get(base);
  if (!frame || frame.detached) throw new Error(`[${id}] is from a page that is gone -- call state again.`);
  const gen = baseGen.get(base);
  const local = id - base;
  const handle = (await frame.evaluateHandle(
    (lid, g) => {
      const reg = (window as unknown as { __ib?: { gen: string; byId: Map<number, Element> } }).__ib;
      if (!reg || reg.gen !== g) return "stale";
      const el = reg.byId.get(lid);
      if (!el || !el.isConnected) return "gone";
      return el;
    },
    local,
    gen,
  )) as ElementHandle<Element> | { jsonValue(): Promise<unknown> };
  const asEl = (handle as ElementHandle<Element>).asElement?.();
  if (!asEl) {
    const v = await (handle as { jsonValue(): Promise<unknown> }).jsonValue();
    if (v === "stale") throw new Error(`[${id}] is from before the page changed -- use the ids in the latest state.`);
    throw new Error(`[${id}] is no longer on the page -- use the ids in the latest state.`);
  }
  return { handle: asEl as ElementHandle<Element>, frame };
}

// Only used to attach to attention alerts, so it never holds up the agent: it runs in the
// background (one at a time, latest request wins) with a short timeout -- capturing a tab Chrome
// considers hidden can stall until the 60s CDP timeout, which once added minutes to a run.
let shotRunning = false;
let shotPending: Page | undefined;
export async function saveScreenshot(page: Page): Promise<void> {
  shotPending = page;
  if (shotRunning) return;
  shotRunning = true;
  void (async () => {
    try {
      while (shotPending) {
        const p = shotPending;
        shotPending = undefined;
        if (p.isClosed()) continue;
        await mkdir(join(tmpdir(), "intent-browser"), { recursive: true }).catch(() => {});
        await Promise.race([
          p.screenshot({ path: SCREENSHOT_PATH as `${string}.jpeg`, type: "jpeg", quality: 60 }).catch(() => {}),
          new Promise((r) => setTimeout(r, 4000)),
        ]);
      }
    } finally {
      shotRunning = false;
    }
  })();
}

// Downscaled so it fits the model's inline image limit (a full-resolution viewport was dropped as
// "could not be resized below the inline image size limit") and costs fewer image tokens.
export async function screenshotBase64(): Promise<{ data: string; mime: string }> {
  const page = await getPage();
  // Cap the longest side, in real pixels: a portrait monitor gives a tall viewport (1152x1914 at
  // 125% scaling = ~1440x2390 px), so capping only the width still produced an oversized image.
  const { w, h, dpr } = await page.evaluate(() => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio || 1 }));
  const scale = Math.min(1, 1280 / (Math.max(w, h, 1) * dpr));
  const format = process.env.INTENT_BROWSER_SHOT_FORMAT === "jpeg" ? "jpeg" : "png";
  const data = (await page.screenshot({
    type: format,
    ...(format === "jpeg" ? { quality: 55 } : {}),
    encoding: "base64",
    clip: { x: 0, y: 0, width: w, height: h, scale },
  })) as string;
  return { data, mime: `image/${format}` };
}
