import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bestOptionIndex, formatItem, formatState, type FrameData } from "./format.js";
import { normalizeAction, parseDate, resolveUploadPath } from "./actions.js";
import { EXTRACT_SRC } from "./extract-src.js";
import { FIND_TEXT_SRC } from "./find-text-src.js";
import { DATEPICKER_SRC } from "./datepicker-src.js";

test("the in-page extraction script is valid JavaScript", () => {
  // A literal newline slipped into a string once and broke extraction on every page.
  assert.doesNotThrow(() => new Function(`return ${EXTRACT_SRC};`));
  const invisible = [0xa0, 0x2028, 0x2029].filter((c) => EXTRACT_SRC.includes(String.fromCharCode(c)));
  assert.deepEqual(invisible, [], "invisible characters in the page script");
});

test("the other in-page scripts are valid JavaScript", () => {
  for (const src of [FIND_TEXT_SRC, DATEPICKER_SRC]) assert.doesNotThrow(() => new Function(`return ${src};`));
});

test("parseDate accepts ISO and month-name dates, never ambiguous slash dates", () => {
  assert.deepEqual(parseDate("2026-11-15"), { y: 2026, m: 10, d: 15 });
  assert.deepEqual(parseDate("15 November 2026"), { y: 2026, m: 10, d: 15 });
  assert.deepEqual(parseDate("Nov 15, 2026"), { y: 2026, m: 10, d: 15 });
  assert.equal(parseDate("03/04/2026"), undefined);
  assert.equal(parseDate("Software Engineer"), undefined);
  assert.equal(parseDate("5551234567"), undefined);
});

test("normalizeAction ignores the zero/empty defaults small models fill into every field", () => {
  // The exact shape gpt-4o-mini sent on ScheduRx, which made every action try to open "".
  const a = normalizeAction({ do: "click", id: 8, value: "", open: "", wait_ms: 20000, fill: 0, back: false });
  assert.deepEqual(a, { do: "click", id: 8, value: "" });
  assert.equal(normalizeAction({ do: "click", id: 0 }).id, undefined);
  assert.equal(normalizeAction({ do: "Wait-For", value: "Saved" }).do, "wait_for");
  for (const v of ["select", "scroll", "press", "uncheck"]) assert.equal(normalizeAction({ do: v }).do, v);
  assert.equal(normalizeAction({ do: "fill", id: "12", value: "x" }).id, 12);
  assert.throws(() => normalizeAction({ do: "teleport" }), /unknown action/);
  // label targets an element only when no id is given, and never on verbs without a target.
  assert.deepEqual(normalizeAction({ do: "fill", label: " Billing email ", value: "x" }), { do: "fill", id: undefined, value: "x", label: "Billing email" });
  assert.equal(normalizeAction({ do: "fill", id: 4, label: "Billing email" }).label, undefined);
  assert.equal(normalizeAction({ do: "wait", label: "x", value: "100" }).label, undefined);
  assert.equal(normalizeAction({ do: "click", label: "" }).label, undefined);
});

test("state shows toasts, read-only pickers and hover menus", () => {
  const frame: FrameData = {
    items: [
      { id: 1, kind: "textbox", label: "Start date", value: "", readonly: true },
      { id: 2, kind: "button", label: "Account ▾", hoverMenu: true },
    ],
    headings: [],
    errors: [],
    messages: ["Draft saved at 10:02"],
    dialogs: [],
    chromeHidden: 0,
    gen: "g",
    title: "T",
    url: "http://x/",
  };
  const s = formatState([frame], { tabIndex: 0, tabCount: 1 });
  assert.match(s, /MESSAGES: "Draft saved at 10:02"/);
  assert.match(s, /\[1\] textbox "Start date" = "" \(read-only: click it to open its picker\)/);
  assert.match(s, /\[2\] button "Account ▾" \(menu: click to open\)/);
});

const opts = (...labels: string[]) => labels.map((label) => ({ label }));

test("bestOptionIndex prefers exact, then prefix, then substring, then word overlap", () => {
  const o = opts("Select…", "Less than 1 year", "1-2 years", "3-5 years");
  assert.equal(bestOptionIndex(o, "1-2 years"), 2);
  assert.equal(bestOptionIndex(o, "1-2"), 2);
  assert.equal(bestOptionIndex(opts("+1 United States", "+91 India"), "India"), 1);
  assert.equal(bestOptionIndex(opts("+1 United States", "+91 India"), "+91"), 1);
  assert.equal(bestOptionIndex(opts("Bengaluru", "Bangalore Rural"), "bengaluru"), 0);
  assert.equal(bestOptionIndex(opts("Female", "Male", "Prefer not to say"), "prefer not"), 2);
  assert.equal(bestOptionIndex(opts("Yes", "No"), "Maybe"), -1);
  assert.equal(bestOptionIndex([{ label: "India", value: "IN" }], "in"), 0);
});

test("bestOptionIndex matches times across 12h/24h formats and never matches 2:00 to 12:00", () => {
  const slots = opts("09:00", "12:00", "13:45", "14:00", "14:15");
  assert.equal(bestOptionIndex(slots, "2:00 PM"), 3);
  assert.equal(bestOptionIndex(slots, "2 pm"), 3);
  assert.equal(bestOptionIndex(slots, "14:00"), 3);
  assert.equal(bestOptionIndex(opts("1:30 PM", "2:00 PM", "12:00 PM"), "14:00"), 1);
  assert.equal(bestOptionIndex(opts("12:00 AM", "12:00 PM"), "12 pm"), 1);
  assert.equal(bestOptionIndex(opts("Less than 1 year", "3-5 years"), "3-5 years"), 1);
});

test("formatItem marks visually-required fields and does not repeat the asterisk", () => {
  const s = formatItem({ id: 3, kind: "textbox", label: "First name *", value: "" }, "http://x/");
  assert.equal(s, '[3] textbox "First name" * = ""');
  assert.match(formatItem({ id: 4, kind: "checkbox", label: "Python", checked: true }, "http://x/"), /\[x\]$/);
  assert.match(formatItem({ id: 5, kind: "radio", label: "No", checked: false }, "http://x/"), /\( \)$/);
  assert.match(
    formatItem({ id: 6, kind: "textbox", label: "Email", value: "x", invalid: true, hint: "Email is required" }, "http://x/"),
    /INVALID: Email is required/,
  );
});

function frame(items: FrameData["items"], extra: Partial<FrameData> = {}): FrameData {
  return { items, headings: [], errors: [], dialogs: [], chromeHidden: 0, gen: "g", title: "T", url: "http://x/", ...extra };
}

test("formatState shows only the dialog's elements while a blocking dialog is open", () => {
  const out = formatState(
    [
      frame(
        [
          { id: 1, kind: "textbox", label: "Patient name", value: "", inDialog: true },
          { id: 2, kind: "button", label: "Save booking", inDialog: true },
          { id: 6, kind: "button", label: "New booking" },
          { id: 7, kind: "button", label: "Block time" },
        ],
        { dialogs: ["New appointment"] },
      ),
    ],
    { tabIndex: 0, tabCount: 1 },
  );
  assert.match(out, /DIALOG "New appointment" is open/);
  assert.match(out, /\[1\] textbox "Patient name"/);
  assert.match(out, /\[2\] button "Save booking"/);
  assert.doesNotMatch(out, /New booking|Block time/);
  assert.match(out, /2 elements behind the dialog are hidden/);
});

test("formatState does not repeat a legend as a separate group line", () => {
  const out = formatState(
    [
      frame([
        { id: 2, kind: "radio", label: "Yes", group: "Based in India? *", section: "Based in India? *" },
        { id: 3, kind: "radio", label: "No", group: "Based in India? *", section: "Based in India? *" },
      ]),
    ],
    { tabIndex: 0, tabCount: 1 },
  );
  assert.equal(out.split("\n").filter((l) => l.startsWith("?")).length, 0);
  assert.match(out, /## Based in India\? \*/);
});

test("formatState shows headings and text on pages with little to click", () => {
  const out = formatState([frame([], { headings: ["Application received"], summary: "Your reference number is NW-1." })], {
    tabIndex: 0,
    tabCount: 1,
  });
  assert.match(out, /HEADINGS: "Application received"/);
  assert.match(out, /reference number is NW-1/);
});

test("resolveUploadPath only allows files inside the allowed folders", () => {
  const dir = mkdtempSync(join(tmpdir(), "ib-allowed-"));
  const other = mkdtempSync(join(tmpdir(), "ib-other-"));
  writeFileSync(join(dir, "cv.pdf"), "x");
  writeFileSync(join(other, "secret.txt"), "x");
  assert.equal(resolveUploadPath("cv.pdf", [dir], dir).endsWith("cv.pdf"), true);
  assert.throws(() => resolveUploadPath(join(other, "secret.txt"), [dir], dir), /outside allowed folders/);
  assert.throws(() => resolveUploadPath(join(dir, "..", other.split(/[\\/]/).pop()!, "secret.txt"), [dir], dir), /outside allowed/);
  assert.throws(() => resolveUploadPath("missing.pdf", [dir], dir), /File not found/);
});
