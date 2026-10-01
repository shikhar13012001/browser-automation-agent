// Deterministic robustness test: drives every widget in bench/fixture/zoo.html through the same tool
// layer the model uses (state text -> ids -> act), then checks what the page actually recorded in
// window.ZOO. No LLM involved, so a failure is always a tool bug, never model variance.
// Needs the fixture server (node bench/fixture/server.mjs) and debug Chrome on 9222.
const { act } = await import("../packages/browser-mcp/src/actions.js");
const { openUrl, readState, getPage, takeNotes } = await import("../packages/browser-mcp/src/browser.js");

const URL = "http://localhost:4545/zoo";
let state = "";

async function refresh(): Promise<string> {
  state = await readState();
  return state;
}

// Finds an element id in the latest state by label (and optionally kind), like a model would.
function id(label: string, kind?: string): number {
  for (const line of state.split("\n")) {
    const m = line.match(/^\s*\[(\d+)\] (\S+) "(.*?)"/);
    if (!m) continue;
    const k = m[2].split(":")[0];
    if (m[3].toLowerCase().includes(label.toLowerCase()) && (!kind || k === kind)) return Number(m[1]);
  }
  throw new Error(`"${label}"${kind ? ` (${kind})` : ""} is not in the state`);
}

async function run(actions: Record<string, unknown>[]): Promise<string> {
  const out = await act(actions);
  await refresh();
  if (/^ERR /m.test(out)) throw new Error(out.split("\n").filter((l) => l.startsWith("ERR")).join("; "));
  return out;
}

async function zoo(): Promise<Record<string, unknown>> {
  const page = await getPage();
  return (await page.evaluate("JSON.parse(JSON.stringify(window.ZOO))")) as Record<string, unknown>;
}

const next = new Date();
next.setDate(1);
next.setMonth(next.getMonth() + 1);
const wantDate = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-15`;

type Case = { name: string; steps: () => Promise<unknown>; check: (z: Record<string, unknown>) => boolean };
const cases: Case[] = [
  { name: "Radix select (pointerdown, portaled)", steps: () => run([{ do: "select", id: id("Preferred language"), value: "Python3" }]), check: (z) => z.lang === "Python3" },
  {
    name: "React-Select (plain div options)",
    steps: async () => {
      await run([{ do: "select", id: id("Country of residence"), value: "Canada" }]);
      // The pick shows in a sibling div, not the input; the state must still say so.
      if (!/combobox "Country of residence" = "Canada"/.test(state)) throw new Error("state does not show the chosen country");
    },
    check: (z) => z.country === "Canada",
  },
  {
    name: "click_text finds lazy-loaded items",
    steps: () => run([{ do: "click_text", value: "Project 55" }]),
    check: (z) => z.project === 55,
  },
  { name: "MUI select (backdrop + portal)", steps: () => run([{ do: "select", id: id("Seniority level"), value: "Senior" }]), check: (z) => z.level === "Senior" },
  {
    name: "Date picker (read-only + calendar)",
    // fill on a read-only date field drives the calendar itself.
    steps: () => run([{ do: "fill", id: id("Start date"), value: wantDate }]),
    check: (z) => z.date === wantDate,
  },
  { name: "Shadow DOM web component", steps: () => run([{ do: "fill", id: id("Newsletter email"), value: "a@b.co" }, { do: "click", id: id("Subscribe") }]), check: (z) => z.newsletter === "a@b.co" },
  { name: "Same-origin iframe", steps: () => run([{ do: "fill", id: id("Coupon code"), value: "SAVE10" }, { do: "click", id: id("Apply coupon") }]), check: (z) => z.coupon === "SAVE10" },
  { name: "Cross-origin iframe", steps: () => run([{ do: "fill", id: id("Name on card"), value: "Test User" }, { do: "click", id: id("Save card holder") }]), check: (z) => z.cardHolder === "Test User" },
  { name: "contenteditable message box", steps: () => run([{ do: "fill", id: id("Write a message"), value: "Hello there" }]), check: (z) => z.message === "Hello there" },
  { name: "Toggle switch", steps: () => run([{ do: "check", id: id("Email notifications") }]), check: (z) => z.notifications === true },
  {
    name: "Tabs (field in hidden panel)",
    // One batch: the field only exists after the tab click, so it is targeted by label.
    steps: () => run([{ do: "click", id: id("Billing", "tab") }, { do: "fill", label: "Billing email", value: "bill@acme.co" }]),
    check: (z) => z.billingEmail === "bill@acme.co",
  },
  {
    name: "Accordion",
    steps: () => run([{ do: "click", id: id("Shipping address") }, { do: "fill", label: "Postal code", value: "560001" }]),
    check: (z) => z.zip === "560001",
  },
  {
    name: "CSS :hover-only menu",
    steps: () => run([{ do: "click", id: id("Account") }, { do: "click", label: "Settings" }]),
    check: (z) => z.menu === "Settings",
  },
  {
    name: "Infinite list in its own scroller",
    steps: async () => {
      for (let i = 0; i < 6 && !/"Project 42"/.test(state); i++) await run([{ do: "scroll", id: id("Project 1", "button"), value: "bottom" }]);
      await run([{ do: "click", id: id("Project 42", "button") }]);
    },
    check: (z) => z.project === 42,
  },
  {
    name: "Slow content (wait_for)",
    steps: async () => {
      await run([{ do: "click", id: id("Generate report") }, { do: "wait_for", value: "Download report" }]);
      await run([{ do: "click", id: id("Download report") }]);
    },
    check: (z) => z.downloaded === true,
  },
  {
    name: "Toast is reported",
    steps: async () => {
      await run([{ do: "click", id: id("Save draft") }]);
      if (!/MESSAGES: .*Draft saved/.test(state)) throw new Error("toast text not in the state");
    },
    check: (z) => z.drafted === true,
  },
  {
    name: "window.confirm is handled + noted",
    steps: async () => {
      await run([{ do: "click", id: id("Archive project") }]);
      const notes = takeNotes().join(" ");
      if (!/confirm|dialog/i.test(notes)) throw new Error(`no note about the confirm dialog (notes: ${notes || "none"})`);
    },
    check: (z) => z.archived === true,
  },
  { name: "Custom checkbox gates a button", steps: () => run([{ do: "check", id: id("Terms of Service") }, { do: "click", id: id("Continue to payment") }]), check: (z) => z.accepted === true },
  { name: "Button under a fixed bottom bar", steps: () => run([{ do: "click", id: id("Publish changes") }]), check: (z) => z.published === true && !z.chat },
  {
    name: "keyup-filtered autocomplete",
    steps: async () => {
      await run([{ do: "fill", id: id("Primary skill"), value: "Ty" }]);
      await run([{ do: "click_text", value: "TypeScript" }]);
    },
    check: (z) => z.skill === "TypeScript",
  },
  { name: "Input mask", steps: () => run([{ do: "fill", id: id("Mobile number"), value: "5551234567" }]), check: (z) => z.phone === "5551234567" },
  { name: "Range slider", steps: () => run([{ do: "fill", id: id("Monthly budget"), value: "70" }]), check: (z) => z.budget === 70 },
  { name: "Segmented toggle buttons", steps: () => run([{ do: "click", id: id("Hybrid") }]), check: (z) => z.workMode === "Hybrid" },
  { name: "Native select with optgroups", steps: () => run([{ do: "select", id: id("Timezone"), value: "India Standard Time" }]), check: (z) => String(z.tz).includes("India Standard Time") },
  { name: "Input replaced on every keystroke", steps: () => run([{ do: "fill", id: id("Company name"), value: "Acme Robotics" }]), check: (z) => z.company === "Acme Robotics" },
  { name: "Search on Enter only", steps: () => run([{ do: "fill", id: id("Search members"), value: "ana" }, { do: "press", id: id("Search members"), value: "Enter" }]), check: (z) => z.search === "ana" },
  { name: "Icon-only button (svg title)", steps: () => run([{ do: "click", id: id("Edit display name") }]), check: (z) => z.edit === true },
  { name: "Radio cards (div role=radio)", steps: () => run([{ do: "check", id: id("Team", "radio") }]), check: (z) => String(z.plan).startsWith("Team") },
];

await openUrl(URL);
await refresh();
const results: { name: string; ok: boolean; why?: string; ms: number }[] = [];
for (const c of cases) {
  const t = Date.now();
  let why: string | undefined;
  try {
    await refresh();
    await c.steps();
  } catch (e) {
    why = e instanceof Error ? e.message : String(e);
  }
  const z = await zoo();
  const ok = c.check(z);
  if (!ok && !why) why = "page did not record the expected result";
  results.push({ name: c.name, ok, why: ok ? undefined : why, ms: Date.now() - t });
  // Leave no popup open for the next case.
  await act([{ do: "press", value: "Escape" }]).catch(() => {});
}

const pass = results.filter((r) => r.ok).length;
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(40)} ${String(r.ms).padStart(5)}ms${r.why ? `  -- ${r.why.slice(0, 220)}` : ""}`);
console.log(`\n${pass}/${results.length} widgets handled`);
process.exit(pass === results.length ? 0 : 1);
