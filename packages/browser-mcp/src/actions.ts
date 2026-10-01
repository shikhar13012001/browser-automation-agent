import { existsSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ElementHandle, Frame, Page } from "puppeteer-core";
import { findSameItem, getPage, itemKey, openUrl, readState, resolve, saveScreenshot, settle, snapshot, withNavigation } from "./browser.js";
import { bestOptionIndex } from "./format.js";
import { FIND_TEXT_SRC } from "./find-text-src.js";
import { DATEPICKER_SRC } from "./datepicker-src.js";

export const VERBS = [
  "click",
  "click_text",
  "click_at",
  "fill",
  "select",
  "check",
  "uncheck",
  "upload",
  "press",
  "scroll",
  "wait_for",
  "wait",
  "open",
  "back",
] as const;
export type Verb = (typeof VERBS)[number];
// `label` targets an element by its label instead of an id. It is resolved against the live page
// when the action runs, so one batch can reach fields that only appear after an earlier click (a
// tab's fields, an accordion, the next page of a form) -- one model call instead of two or three.
export type Action = { do: Verb; id?: number; value?: string; label?: string };

// Small models fill every optional schema field with a default (id 0, value "", wait 20000...).
// Treat those as absent so a default can never be read as an instruction.
export function normalizeAction(raw: Record<string, unknown>): Action {
  const verb = String(raw.do ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_") as Verb;
  if (!VERBS.includes(verb)) throw new Error(`unknown action "${raw.do}" -- use one of: ${VERBS.join(", ")}`);
  const idNum = typeof raw.id === "string" ? Number(raw.id) : (raw.id as number | undefined);
  const id = typeof idNum === "number" && Number.isInteger(idNum) && idNum > 0 ? idNum : undefined;
  const value = raw.value === undefined || raw.value === null ? undefined : String(raw.value);
  const takesId = !["wait_for", "wait", "open", "back", "click_text", "click_at"].includes(verb);
  const label = takesId && typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : undefined;
  const a: Action = { do: verb, id: takesId ? id : undefined, value };
  if (label && a.id === undefined) a.label = label;
  return a;
}

// Finds the element for a label-targeted action on the current page, waiting briefly for it to
// appear (tab panels and next pages render a moment after the click). Clicks need an exact label
// match, so a vague label can never press the wrong button; fields also accept one unique partial
// match. Ambiguity is an error, never a guess.
async function idForLabel(a: Action): Promise<number> {
  const want = a.label!.toLowerCase().replace(/\s*\*+\s*$/, "").trim();
  const clicky = a.do === "click" || a.do === "press";
  let reason = "";
  for (let waited = 0; waited <= 3000; waited += 300) {
    if (waited) await new Promise((r) => setTimeout(r, 300));
    await readState();
    const items = [...snapshot().items.entries()].map(([id, v]) => ({ id, kind: v.kind, label: v.label.toLowerCase().replace(/\s*\*+\s*$/, "").trim() }));
    const exact = items.filter((i) => i.label === want);
    if (exact.length === 1) return exact[0].id;
    if (exact.length > 1) {
      reason = `${exact.length} elements are labelled ${JSON.stringify(a.label)} -- use an id`;
      break;
    }
    if (!clicky) {
      const part = items.filter((i) => i.label.includes(want));
      if (part.length === 1) return part[0].id;
      if (part.length > 1) {
        reason = `${part.length} elements match ${JSON.stringify(a.label)} (${part.slice(0, 4).map((p) => JSON.stringify(p.label)).join(", ")}) -- use the exact label or an id`;
        break;
      }
    }
    reason = `no element labelled ${JSON.stringify(a.label)}${clicky ? " (clicks need the exact label)" : ""} -- check the state`;
  }
  throw new Error(reason);
}

function needId(a: Action): number {
  if (a.id === undefined) throw new Error(`"${a.do}" needs an id from the latest state`);
  return a.id;
}

function needValue(a: Action): string {
  if (!a.value) throw new Error(`"${a.do}" needs a value`);
  return a.value;
}

const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ALLOWED_DIRS = (process.env.INTENT_BROWSER_ALLOWED_DIRS ?? REPO_ROOT)
  .split(delimiter)
  .filter(Boolean)
  .map((d) => resolvePath(d));

class StopBatch extends Error {}

// Raised only before anything was sent to the page (element stale/gone, or covered), so retrying is
// safe. A failure after a click was delivered is never retried -- that could submit twice.
class RetryableError extends StopBatch {}

function describe(a: Action): string {
  return JSON.stringify(a);
}

// Upload paths are confined to allowed directories (default: this repo, which holds resumes/) so a
// page can't talk the agent into uploading arbitrary local files.
export function resolveUploadPath(p: string, allowed = ALLOWED_DIRS, root = REPO_ROOT): string {
  const abs = isAbsolute(p) ? resolvePath(p) : resolvePath(root, p);
  if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`File not found: ${abs}`);
  const real = realpathSync(abs);
  const ok = allowed.some((d) => {
    const base = existsSync(d) ? realpathSync(d) : d;
    return real === base || real.startsWith(base.endsWith(sep) ? base : base + sep);
  });
  if (!ok) throw new Error(`Refusing to upload ${real}: outside allowed folders (${allowed.join(", ")}).`);
  return real;
}

async function info(handle: ElementHandle<Element>) {
  return handle.evaluate((el) => {
    const e = el as HTMLInputElement;
    return {
      tag: el.tagName.toLowerCase(),
      type: (e.getAttribute("type") || "").toLowerCase(),
      editable: (el as HTMLElement).isContentEditable,
      role: (el.getAttribute("role") || "").toLowerCase(),
      label: ((el as HTMLElement).innerText || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 40),
      hasPopup: !!el.getAttribute("aria-haspopup") && el.getAttribute("aria-haspopup") !== "false",
      hasList: el.hasAttribute("list"),
      autocomplete: !!el.getAttribute("aria-autocomplete"),
      checkable: (e.getAttribute("type") || "") === "checkbox" || (e.getAttribute("type") || "") === "radio" ||
        ["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"].includes((el.getAttribute("role") || "").toLowerCase()) ||
        el.hasAttribute("aria-pressed") || el.hasAttribute("aria-checked"),
    };
  });
}

// Returns why a click at the element's centre would not reach it (e.g. a cookie banner on top),
// or "" when it's clear. Clicking through an overlay could hit an ad or the wrong control.
// Sticky headers, chat widgets and bottom bars cover whatever scrolls under them, so a covered
// element is tried again at the other scroll positions before giving up.
async function coveredBy(handle: ElementHandle<Element>): Promise<string> {
  return handle.evaluate((el) => {
    let cover = "";
    for (const block of ["center", "end", "start"] as ScrollLogicalPosition[]) {
      el.scrollIntoView({ block, inline: "center" });
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const hit = (el.getRootNode() as Document).elementFromPoint?.(x, y) ?? document.elementFromPoint(x, y);
      if (!hit || hit === el || el.contains(hit) || hit.contains(el)) return "";
      const lab = hit.closest("label");
      if (lab && (lab.contains(el) || (el.id && lab.htmlFor === el.id))) return "";
      const t = ((hit as HTMLElement).innerText || hit.getAttribute("aria-label") || hit.tagName).replace(/\s+/g, " ").trim();
      cover = cover || t.slice(0, 80) || hit.tagName.toLowerCase();
    }
    el.scrollIntoView({ block: "center", inline: "center" });
    return cover;
  });
}

async function realClick(page: Page, handle: ElementHandle<Element>, id: number): Promise<void> {
  const visible = await handle.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1 && (typeof (el as HTMLElement).checkVisibility !== "function" || (el as HTMLElement).checkVisibility());
  });
  if (!visible) {
    // Custom-styled checkbox/radio: the real input is hidden, its label is what users click.
    const labelled = await handle.evaluate((el) => {
      const lab = el.closest("label") || (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null);
      if (lab) {
        (lab as HTMLElement).click();
        return true;
      }
      (el as HTMLElement).click();
      return true;
    });
    if (labelled) return;
  }
  const cover = await coveredBy(handle);
  if (cover) throw new RetryableError(`[${id}] is covered by ${JSON.stringify(cover)} -- close/accept that first.`);
  await withNavigation(page, () => handle.click());
}

const MOD = process.platform === "darwin" ? "Meta" : "Control";

// Presses a key or a combination like "Control+A", "Shift+Tab", "Meta+Enter".
export async function pressCombo(page: Page, combo: string): Promise<void> {
  const keys = combo.split("+").map((k) => k.trim()).filter(Boolean) as Parameters<Page["keyboard"]["press"]>[0][];
  if (keys.length <= 1) return page.keyboard.press(keys[0] ?? "Enter");
  const mods = keys.slice(0, -1);
  for (const m of mods) await page.keyboard.down(m);
  try {
    await page.keyboard.press(keys[keys.length - 1]);
  } finally {
    for (const m of mods.reverse()) await page.keyboard.up(m);
  }
}

async function clearAndType(page: Page, handle: ElementHandle<Element>, value: string): Promise<void> {
  await handle.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await handle.focus();
  // Keyboard select-all clears whatever is focused -- a plain input, a rich-text field, or a code
  // editor (Monaco/CodeMirror/Ace), where selecting the hidden textarea's own value does nothing.
  await pressCombo(page, `${MOD}+A`);
  await page.keyboard.press("Backspace");
  // Input.insertText: one trusted input event for the whole string -- fast even for long answers,
  // and React/Angular controlled inputs accept it like real typing. It fires no key events, though,
  // and older autocompletes and masks filter on keydown/keyup, so the last character is typed as a
  // real key press.
  if (!value) return;
  const chars = Array.from(value);
  const last = chars[chars.length - 1];
  const typable = /^[ -~]$/.test(last);
  const head = typable ? chars.slice(0, -1).join("") : value;
  if (head) await page.keyboard.sendCharacter(head);
  if (typable) await page.keyboard.type(last);
}

async function setNativeValue(handle: ElementHandle<Element>, value: string): Promise<void> {
  await handle.evaluate((el, v) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

async function readValue(handle: ElementHandle<Element>): Promise<string> {
  return handle.evaluate((node) => {
    // Some controlled inputs replace their element on every keystroke; the typing then continued in
    // the new, focused element, so read that one instead of the detached original.
    const el = !node.isConnected && document.activeElement ? document.activeElement : node;
    const e = el as HTMLInputElement;
    return "value" in e && typeof e.value === "string" ? e.value : ((el as HTMLElement).innerText || "").trim();
  });
}

const TEXT_INPUT_TYPES = ["", "text", "email", "tel", "url", "search", "password", "number", "date", "time", "month", "week", "datetime-local", "color", "range"];

function wrongKind(id: number, verb: string, i: { tag: string; type: string; role: string; label?: string }, hint: string): Error {
  const what = i.role || (i.tag === "input" ? `input type=${i.type || "text"}` : i.tag);
  return new Error(`[${id}] is a ${what}${i.label ? ` "${i.label}"` : ""}, not something you can ${verb} -- ${hint}`);
}

const EDITOR_SEL = ".monaco-editor,.CodeMirror,.cm-editor,.ace_editor";

// Code editors auto-indent every typed newline, so typed code gains indentation cumulatively
// (seen on LeetCode's Monaco). Set the text through the editor's own API when it's reachable, else
// through a paste event (editors insert pasted text verbatim), then read the real text back.
async function doFillCode(page: Page, handle: ElementHandle<Element>, id: number, code: string): Promise<string> {
  type W = Window & {
    monaco?: { editor: { getEditors?: () => { getContainerDomNode(): Element; getModel(): { getFullModelRange(): unknown; getValue(): string }; executeEdits(src: string, edits: unknown[]): void; focus(): void; pushUndoStop?(): void }[] } };
    ace?: { edit(el: Element): { setValue(v: string, cursor: number): void; getValue(): string } };
  };
  const viaApi = await handle.evaluate((el, text) => {
    const w = window as unknown as W;
    const mon = el.closest(".monaco-editor");
    if (mon && w.monaco?.editor.getEditors) {
      const ed = w.monaco.editor.getEditors().find((e) => e.getContainerDomNode().contains(el));
      if (ed) {
        ed.focus();
        const model = ed.getModel();
        ed.executeEdits("intent-browser", [{ range: model.getFullModelRange(), text, forceMoveMarkers: true }]);
        ed.pushUndoStop?.();
        return { via: "Monaco API", value: model.getValue() };
      }
    }
    const cm5 = el.closest(".CodeMirror") as (Element & { CodeMirror?: { setValue(v: string): void; getValue(): string } }) | null;
    if (cm5?.CodeMirror) {
      cm5.CodeMirror.setValue(text);
      return { via: "CodeMirror API", value: cm5.CodeMirror.getValue() };
    }
    const cm6 = el.closest(".cm-editor")?.querySelector(".cm-content") as (Element & { cmView?: { view?: { state: { doc: { length: number; toString(): string } }; dispatch(tr: unknown): void } } }) | null;
    const view = cm6?.cmView?.view;
    if (view) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
      return { via: "CodeMirror 6 API", value: view.state.doc.toString() };
    }
    const aceEl = el.closest(".ace_editor");
    if (aceEl && w.ace) {
      const ed = w.ace.edit(aceEl);
      ed.setValue(text, 1);
      return { via: "Ace API", value: ed.getValue() };
    }
    return null;
  }, code);
  if (viaApi) {
    return viaApi.value === code ? `filled [${id}] via the ${viaApi.via}` : `filled [${id}] via the ${viaApi.via}, but it now reads ${JSON.stringify(viaApi.value.slice(0, 200))}`;
  }
  await handle.focus();
  await pressCombo(page, `${MOD}+A`);
  await page.keyboard.press("Backspace");
  await handle.evaluate((el, text) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, code);
  await new Promise((r) => setTimeout(r, 150));
  return `pasted code into [${id}] (no editor API available -- check the editor text in the new state)`;
}

// "2026-11-15", "15 November 2026", "Nov 15, 2026". Slash dates are skipped: 03/04 is ambiguous.
export function parseDate(v: string): { y: number; m: number; d: number } | undefined {
  const iso = v.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) return { y: Number(iso[1]), m: Number(iso[2]) - 1, d: Number(iso[3]) };
  if (!/[a-z]{3}/i.test(v) || !/\d{4}/.test(v)) return undefined;
  const t = Date.parse(v);
  if (Number.isNaN(t)) return undefined;
  const dt = new Date(t);
  return { y: dt.getFullYear(), m: dt.getMonth(), d: dt.getDate() };
}

// Read-only date fields only change through their calendar popup, which used to cost the model
// three or four calls (open, page months, find the day, often a look). Drive it here instead.
async function doFillDate(page: Page, handle: ElementHandle<Element>, id: number, frame: Frame, target: { y: number; m: number; d: number }): Promise<string> {
  const before = await readValue(handle);
  await realClick(page, handle, id);
  let shown = "";
  for (let step = 0; step < 30; step++) {
    await new Promise((r) => setTimeout(r, step ? 120 : 300));
    const r = (await frame.evaluate(`${DATEPICKER_SRC}(${JSON.stringify(target)})`)) as { status: string; shown: string };
    shown = r.shown;
    if (r.status === "nopicker") throw new Error(`[${id}] is read-only and no calendar opened when clicked -- click it and pick the date yourself`);
    if (r.status === "noday" || r.status === "nonav") {
      throw new Error(`[${id}]: the calendar shows ${shown || "a month"} but ${r.status === "noday" ? `day ${target.d} is not selectable` : "no next/previous-month control was found"} -- pick it yourself`);
    }
    const el = await frame.$("[data-ib-click]");
    if (!el) throw new Error(`[${id}]: lost track of the calendar`);
    await withNavigation(page, () => el.click());
    if (r.status === "day") {
      await new Promise((res) => setTimeout(res, 150));
      const now = await readValue(handle);
      return now && now !== before ? `picked ${shown.replace(/^\w/, (c) => c.toUpperCase())} ${target.d} in [${id}] (field shows ${JSON.stringify(now)})` : `clicked day ${target.d} of ${shown} in [${id}] (field shows ${JSON.stringify(now)})`;
    }
  }
  throw new Error(`[${id}]: could not reach ${target.y}-${target.m + 1} in the calendar (stuck at ${shown})`);
}

async function doFill(page: Page, id: number, value: string): Promise<string> {
  const { handle, frame } = await resolve(id);
  const i = await info(handle);
  const date = parseDate(value);
  if (date && i.tag === "input" && (await handle.evaluate((el) => (el as HTMLInputElement).readOnly))) {
    return doFillDate(page, handle, id, frame, date);
  }
  if (i.tag === "select") return doSelect(page, id, value);
  if (await handle.evaluate((el, sel) => !!el.closest(sel), EDITOR_SEL)) return doFillCode(page, handle, id, value);
  const fillable =
    i.tag === "textarea" || i.editable || (i.tag === "input" && TEXT_INPUT_TYPES.includes(i.type)) ||
    ["textbox", "searchbox", "combobox", "spinbutton"].includes(i.role);
  if (!fillable) throw wrongKind(id, "fill", i, "use click for buttons, or the id of the text field");
  if (["date", "time", "month", "week", "datetime-local", "color", "range"].includes(i.type)) {
    await setNativeValue(handle, value);
  } else {
    await clearAndType(page, handle, value);
    const got = await readValue(handle);
    if (got !== value && !i.editable && got.replace(/\D/g, "") !== value.replace(/\D/g, "")) await setNativeValue(handle, value);
  }
  const got = await readValue(handle);
  return got === value ? `filled [${id}]` : `filled [${id}] (field now shows ${JSON.stringify(got.slice(0, 80))})`;
}

async function visibleOptions(frame: Frame): Promise<ElementHandle<Element>[]> {
  const all = await frame.$$(
    '[role=option],[role=listbox] li,[role=menuitemradio],[role=menuitem],[class*="option" i]:not(option):not(select)',
  );
  const keep: ElementHandle<Element>[] = [];
  for (const h of all) {
    const ok = await h
      .evaluate((el) => {
        const r = el.getBoundingClientRect();
        const t = ((el as HTMLElement).innerText || "").trim();
        return r.width > 1 && r.height > 1 && t.length > 0 && t.length < 120 && !el.querySelector('[role=option]');
      })
      .catch(() => false);
    if (ok) keep.push(h);
  }
  return keep;
}

async function doSelect(page: Page, id: number, value: string): Promise<string> {
  const { handle, frame } = await resolve(id);
  const i = await info(handle);
  if (i.tag === "select") {
    const readOptions = () =>
      handle.evaluate((el) => Array.from((el as HTMLSelectElement).options).map((o) => ({ label: o.text.trim(), value: o.value })));
    let options = await readOptions();
    let idx = bestOptionIndex(options, value);
    // Options often load after a field this one depends on changes (time slots after a date): wait.
    for (let waited = 0; idx < 0 && waited < 6000; waited += 300) {
      await new Promise((r) => setTimeout(r, 300));
      options = await readOptions();
      idx = bestOptionIndex(options, value);
    }
    if (idx < 0) {
      throw new Error(
        `[${id}] has no option like ${JSON.stringify(value)}. Options: ${options
          .slice(0, 30)
          .map((o) => o.label)
          .join(" | ")}`,
      );
    }
    await (handle as ElementHandle<HTMLSelectElement>).select(options[idx].value);
    return `selected ${JSON.stringify(options[idx].label)} in [${id}] (native)`;
  }

  // Custom dropdown/combobox: open it, type to filter when it's a text input, pick the best option.
  const opensList = i.role === "combobox" || i.role === "listbox" || i.hasPopup || (i.tag === "input" && (i.hasList || i.autocomplete));
  if (!opensList) throw wrongKind(id, "select from", i, "use click for a button, or the id of the dropdown");
  const typable = i.tag === "input" || i.tag === "textarea" || i.editable;
  await realClick(page, handle, id);
  if (typable) await clearAndType(page, handle, value);
  let texts: string[] = [];
  let opts: ElementHandle<Element>[] = [];
  for (let waited = 0; waited <= 2500; waited += 100) {
    if (waited) await new Promise((r) => setTimeout(r, 100));
    opts = await visibleOptions(frame);
    texts = await Promise.all(opts.map((o) => o.evaluate((el) => ((el as HTMLElement).innerText || "").replace(/\s+/g, " ").trim())));
    if (bestOptionIndex(texts.map((t) => ({ label: t })), value) >= 0) break;
  }
  const idx = bestOptionIndex(texts.map((t) => ({ label: t })), value);
  if (idx < 0) {
    const shown = texts.slice(0, 15).join(" | ");
    throw new Error(
      shown
        ? `[${id}] opened but no option matches ${JSON.stringify(value)}. Visible options: ${shown}`
        : `[${id}] ${typable ? `typed ${JSON.stringify(value)} but` : ""} no dropdown options appeared.`,
    );
  }
  await opts[idx].evaluate((el) => el.scrollIntoView({ block: "center" }));
  await withNavigation(page, () => opts[idx].click());
  return `selected ${JSON.stringify(texts[idx])} in [${id}]`;
}

async function checkedState(handle: ElementHandle<Element>): Promise<boolean> {
  return handle.evaluate((el) => (el as HTMLInputElement).checked === true || el.getAttribute("aria-checked") === "true");
}

async function doCheck(page: Page, id: number, want: boolean): Promise<string> {
  const { handle } = await resolve(id);
  const i = await info(handle);
  if (!i.checkable) throw wrongKind(id, want ? "check" : "uncheck", i, "use click to press a button");
  if ((await checkedState(handle)) === want) return `[${id}] already ${want ? "checked" : "unchecked"}`;
  await realClick(page, handle, id);
  const now = await checkedState(handle);
  if (now !== want) {
    await handle.evaluate((el) => (el as HTMLElement).click());
  }
  return `${(await checkedState(handle)) === want ? "" : "tried to "}${want ? "checked" : "unchecked"} [${id}]`;
}

async function doUpload(id: number, path: string): Promise<string> {
  const file = resolveUploadPath(path);
  const { handle } = await resolve(id);
  let input: ElementHandle<Element> | null = (await handle.evaluate((el) => el.matches('input[type="file"]'))) ? handle : null;
  if (!input) {
    const found = await handle.evaluateHandle((el) => {
      const inside = el.querySelector('input[type="file"]');
      if (inside) return inside;
      const forId = el.closest("label")?.htmlFor || el.getAttribute("for");
      if (forId) {
        const t = document.getElementById(forId);
        if (t && t.matches('input[type="file"]')) return t;
      }
      let p: Element | null = el.parentElement;
      for (let i = 0; p && i < 4; i++, p = p.parentElement) {
        const f = p.querySelector('input[type="file"]');
        if (f) return f;
      }
      return null;
    });
    input = found.asElement() as ElementHandle<Element> | null;
  }
  if (!input) throw new Error(`[${id}] is not a file input and none was found next to it.`);
  await (input as ElementHandle<HTMLInputElement>).uploadFile(file);
  const names = await input.evaluate((el) => Array.from((el as HTMLInputElement).files ?? []).map((f) => f.name).join(", "));
  if (!names) throw new Error(`Upload to [${id}] did not register a file.`);
  return `uploaded ${names} to [${id}]`;
}

const STALE = /no longer on the page|from before the page changed|from a page that is gone/;

// If an element went stale, disappeared or was briefly covered (e.g. a loading overlay), re-read the
// page once; if exactly one element with the same kind and label is there, retry on it. If the page
// didn't change, the original error stands and the model handles it as usual.
async function runWithRetry(page: Page, a: Action): Promise<string> {
  if (a.label !== undefined && a.id === undefined) {
    const id = await idForLabel(a);
    const r = await runWithRetry(page, { ...a, id, label: undefined });
    return `${r} (${JSON.stringify(a.label)})`;
  }
  try {
    return await runOne(page, a);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const retryable = err instanceof RetryableError || STALE.test(msg);
    const key = a.id !== undefined ? itemKey(a.id) : undefined;
    if (!retryable || !key) throw err;
    await settle(page);
    await readState();
    const again = findSameItem(key);
    if (again === undefined) throw err;
    const result = await runOne(page, { ...a, id: again });
    return `${result} (retried: [${a.id}] had changed, same element is now [${again}])`;
  }
}

async function runOne(page: Page, a: Action): Promise<string> {
  switch (a.do) {
    case "open":
      await openUrl(needValue(a));
      throw new StopBatch(`opened ${a.value}`);
    case "back":
      await withNavigation(page, () => page.goBack({ waitUntil: "domcontentloaded", timeout: 30_000 }));
      throw new StopBatch("went back");
    case "fill":
      return doFill(page, needId(a), a.value ?? "");
    case "select":
      return doSelect(page, needId(a), needValue(a));
    case "check":
    case "uncheck":
      return doCheck(page, needId(a), a.do === "check");
    case "upload":
      return doUpload(needId(a), needValue(a));
    case "click": {
      const id = needId(a);
      const { handle } = await resolve(id);
      const url = page.url();
      await realClick(page, handle, id);
      return page.url() !== url ? `clicked [${id}] -> page changed` : `clicked [${id}]`;
    }
    case "press": {
      if (a.id !== undefined) await (await resolve(a.id)).handle.focus();
      const key = a.value || "Enter";
      await withNavigation(page, () => pressCombo(page, key));
      return `pressed ${key}`;
    }
    case "scroll": {
      if (a.id !== undefined && !a.value) {
        await (await resolve(a.id)).handle.evaluate((el) => el.scrollIntoView({ block: "center" }));
        return `scrolled to [${a.id}]`;
      }
      // With an id and a direction, scroll the list/panel that element sits in (infinite lists,
      // dropdown menus, chat panes) instead of the whole page.
      // "bottom"/"top" jump to the end, which is what makes infinite lists load their next page.
      const how = (a.value ?? "down").toLowerCase();
      const r = a.id !== undefined ? await resolve(a.id) : null;
      const target = r ? r.handle : null;
      const where = await (r ? r.frame : page.mainFrame()).evaluate(
        (el, mode) => {
          let box: Element | null = null;
          for (let p: Element | null = el; p && p !== document.documentElement; p = p.parentElement) {
            const s = getComputedStyle(p);
            if (/(auto|scroll)/.test(s.overflowY) && p.scrollHeight > p.clientHeight + 2) {
              box = p;
              break;
            }
          }
          const sc = box ?? document.scrollingElement ?? document.documentElement;
          const h = box ? box.clientHeight : window.innerHeight;
          if (mode === "bottom") sc.scrollTop = sc.scrollHeight;
          else if (mode === "top") sc.scrollTop = 0;
          else sc.scrollBy(0, (mode === "up" ? -0.8 : 0.8) * h);
          const w = window as unknown as { __ibScroll?: Element };
          w.__ibScroll = sc;
          return { where: box ? "its scrollable container" : "the page", height: sc.scrollHeight };
        },
        target,
        how,
      );
      await new Promise((r) => setTimeout(r, 600)); // lazy lists load more when scrolled
      // Say whether more content loaded and whether the end was reached, so the model doesn't
      // keep scrolling blind (or ask look, which only sees the viewport).
      const after = await (r ? r.frame : page.mainFrame()).evaluate(() => {
        const sc = (window as unknown as { __ibScroll?: Element }).__ibScroll;
        if (!sc) return null;
        return { height: sc.scrollHeight, atEnd: sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 4, atTop: sc.scrollTop <= 0 };
      });
      const grew = after && after.height > where.height ? "; more content loaded" : "";
      const end = after?.atEnd ? "; reached the end" : after?.atTop && how === "up" ? "; at the top" : "";
      return `scrolled ${where.where} ${how}${grew}${end}`;
    }
    case "wait_for": {
      const text = needValue(a);
      await page.waitForFunction((t) => !!document.body && document.body.innerText.toLowerCase().includes(t), { timeout: 15_000, polling: 200 }, text.toLowerCase());
      return `saw ${JSON.stringify(text)}`;
    }
    // Fallbacks for things the state list missed: click by visible text, or at coordinates from look.
    case "click_text": {
      const text = needValue(a);
      const search = async () => {
        const handle = await page.evaluateHandle(`${FIND_TEXT_SRC}(${JSON.stringify(text)})`);
        const got = (await handle.evaluate((r) => (r ? { total: (r as { total: number }).total, text: (r as { text: string }).text } : null))) as {
          total: number;
          text: string;
        } | null;
        return { found: handle, info: got };
      };
      let { found, info } = await search();
      // Not on the page yet: it may be further down an infinite list or a lazy-loaded page. Scroll
      // every scrollable area to its end (that's what triggers loading) and look again.
      let scrolled = 0;
      while (!info && scrolled < 6) {
        const moved = await page.evaluate(() => {
          let any = false;
          const boxes = [document.scrollingElement ?? document.documentElement, ...Array.from(document.querySelectorAll("*")).filter((e) => {
            const s = getComputedStyle(e);
            return /(auto|scroll)/.test(s.overflowY) && e.scrollHeight > e.clientHeight + 2;
          })];
          for (const b of boxes) {
            if (b.scrollTop + b.clientHeight < b.scrollHeight - 4) {
              b.scrollTop = b.scrollHeight;
              any = true;
            }
          }
          return any;
        });
        if (!moved) break;
        scrolled++;
        await new Promise((res) => setTimeout(res, 700));
        ({ found, info } = await search());
      }
      if (!info) throw new Error(`no visible element with the text ${JSON.stringify(text)}${scrolled ? ` (scrolled to the end of every list ${scrolled} times)` : ""}`);
      const el = (await found.evaluateHandle((r) => (r as { el: Element }).el)).asElement() as ElementHandle<Element>;
      const url = page.url();
      await realClick(page, el, 0);
      const note = info.total > 1 ? ` (${info.total} elements matched; clicked the one in an open popup or the most specific)` : "";
      return `clicked text ${JSON.stringify(info.text)}${note}${page.url() !== url ? " -> page changed" : ""}`;
    }
    case "click_at": {
      const [x, y] = needValue(a)
        .split(/[ ,]+/)
        .map((n) => Number(n));
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`click_at needs "x,y" in page pixels, got ${JSON.stringify(a.value)}`);
      const hit = await page.evaluate(
        (px, py) => {
          const el = document.elementFromPoint(px, py) as HTMLElement | null;
          return el ? `${el.tagName.toLowerCase()} ${JSON.stringify((el.innerText || el.getAttribute("aria-label") || "").trim().slice(0, 40))}` : "nothing";
        },
        x,
        y,
      );
      await withNavigation(page, () => page.mouse.click(x, y));
      return `clicked at ${x},${y} (${hit})`;
    }
    case "wait": {
      const ms = Math.min(Math.max(Number(a.value) || 1000, 0), 10_000);
      await new Promise((r) => setTimeout(r, ms));
      return `waited ${ms}ms`;
    }
  }
}

// Re-reads the page after a click and compares it with the state the batch was planned against. If
// a dialog opened or closed, or an element a later action targets vanished or became something
// else, the remaining actions would hit the wrong thing (e.g. fields behind a new dialog).
async function planInvalidated(before: ReturnType<typeof snapshot>, rest: Action[]): Promise<string> {
  // Label-targeted (and id-less) actions are resolved on the live page, so they can't be misdirected.
  if (rest.every((r) => r.id === undefined)) return "";
  await readState();
  const now = snapshot();
  if (now.dialogs !== before.dialogs) return now.dialogs ? "a dialog opened" : "the dialog closed";
  for (const r of rest) {
    if (r.id === undefined) continue;
    const was = before.items.get(r.id);
    if (!was) continue; // not in the state the model saw; that action will report its own error
    const is = now.items.get(r.id);
    if (!is) return `[${r.id}] "${was.label}" is no longer on the page`;
    if (was.kind !== is.kind || was.label !== is.label) return `[${r.id}] is now a different element`;
  }
  return "";
}

const DEPENDENT = (a: Action) => a.do === "click" || a.do === "press";

export async function act(rawActions: Record<string, unknown>[]): Promise<string> {
  let page = await getPage();
  const lines: string[] = [];
  const startUrl = page.url();
  const actions: Action[] = [];
  for (const raw of rawActions) {
    try {
      actions.push(normalizeAction(raw));
    } catch (err) {
      return `ERR ${err instanceof Error ? err.message : String(err)} (nothing was done)`;
    }
  }
  const before = snapshot();
  for (let n = 0; n < actions.length; n++) {
    const a = actions[n];
    try {
      const result = await runWithRetry(page, a);
      lines.push("ok  " + result);
      // Only clicks/keys (and custom dropdowns, which are clicks) can re-render or navigate; fills,
      // native selects, checks and uploads apply synchronously, so waiting after them is pure cost.
      const customSelect = a.do === "select" && !result.includes("native");
      if ((DEPENDENT(a) || customSelect) && n < actions.length - 1) {
        page = await settle(page);
        const changed = await planInvalidated(before, actions.slice(n + 1));
        if (changed) {
          lines.push(`--  ${changed} after ${describe(a)}; skipped the remaining ${actions.length - n - 1} -- re-plan with the ids below`);
          break;
        }
      }
      if (page.url() !== startUrl && n < actions.length - 1 && actions.slice(n + 1).some((x) => x.id !== undefined)) {
        lines.push(`--  page changed after action ${n + 1}; skipped the remaining ${actions.length - n - 1} (re-plan from the new state)`);
        break;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof StopBatch) {
        lines.push((msg.startsWith("opened") || msg.startsWith("went") ? "ok  " : "ERR ") + msg);
        if (n < actions.length - 1) lines.push(`--  skipped the remaining ${actions.length - n - 1}`);
        break;
      }
      lines.push(`ERR ${describe(a)}: ${msg}`);
      if (DEPENDENT(a)) {
        if (n < actions.length - 1) lines.push(`--  skipped the remaining ${actions.length - n - 1} (they depended on that click)`);
        break;
      }
    }
  }
  page = await settle(page);
  await saveScreenshot(page);
  return lines.join("\n");
}
