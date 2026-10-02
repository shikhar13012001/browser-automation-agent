// Deterministic end-to-end check of the browser-mcp tool mechanics against the fixture, with no LLM:
// read state, find ids by label, act. If this can't finish the application, no model will.
import { act } from "../packages/browser-mcp/src/actions.js";
import { openUrl, readState, takeNotes } from "../packages/browser-mcp/src/browser.js";

const BASE = process.env.BENCH_URL ?? "http://localhost:4545";
const RESUME = "resumes/Shikhar_Gupta_Resume_CoreSWE.pdf";

function idOf(state: string, re: RegExp): number {
  const line = state.split("\n").find((l) => re.test(l));
  const m = line?.match(/\[(\d+)\]/);
  if (!m) throw new Error(`no element matching ${re} in state:\n${state}`);
  return Number(m[1]);
}

async function step(label: string, actions: Parameters<typeof act>[0]): Promise<string> {
  const t = Date.now();
  const report = await act(actions);
  const state = await readState();
  console.log(`\n=== ${label} (${Date.now() - t}ms) ===\n${report}\n${takeNotes().join("\n")}\n--- state (${state.length} chars) ---\n${state}`);
  return state;
}

const t0 = Date.now();
await fetch(`${BASE}/api/reset`);
await openUrl(`${BASE}/jobs/sde1`);
let s = await readState();
console.log(`=== job page (${s.length} chars) ===\n${s}`);

s = await step("accept cookies", [{ do: "click", id: idOf(s, /button "Accept all cookies"/) }]);
s = await step("apply", [{ do: "click", id: idOf(s, /link "Apply now"/) }]);
s = await step("continue as guest", [{ do: "click", id: idOf(s, /link "Continue as guest"/) }]);
s = await step("step 1", [
  { do: "fill", id: idOf(s, /"First name/), value: "Shikhar" },
  { do: "fill", id: idOf(s, /"Last name/), value: "Gupta" },
  { do: "fill", id: idOf(s, /"Email address/), value: "ishgupta2015@gmail.com" },
  { do: "select", id: idOf(s, /"Country code/), value: "+91 India" },
  { do: "fill", id: idOf(s, /"Phone number/), value: "9555607181" },
  // fill, not select: the common model mistake on this field, which must still pick the suggestion.
  { do: "fill", id: idOf(s, /combobox "City/), value: "Bengaluru" },
  { do: "fill", id: idOf(s, /"LinkedIn profile URL"/), value: "https://linkedin.com/in/shikhar-gupta-71ab59201" },
  { do: "click", id: idOf(s, /button "Next"/) },
]);
s = await step("step 2", [
  { do: "upload", id: idOf(s, /file /), value: RESUME },
  { do: "fill", id: idOf(s, /"Current employer/), value: "American Express" },
  { do: "fill", id: idOf(s, /"Current job title/), value: "Software Engineer" },
  { do: "select", id: idOf(s, /"Years of experience/), value: "1-2 years" },
  { do: "fill", id: idOf(s, /"University/), value: "IIIT Gwalior" },
  { do: "fill", id: idOf(s, /"Graduation year/), value: "2025" },
  { do: "check", id: idOf(s, /checkbox "Python"/) },
  { do: "check", id: idOf(s, /checkbox "Kotlin"/) },
  { do: "check", id: idOf(s, /checkbox "TypeScript"/) },
  { do: "click", id: idOf(s, /button "Next"/) },
]);
s = await step("step 3", [
  { do: "check", id: idOf(s, /radio "Yes"/) },
  { do: "fill", id: idOf(s, /"Why do you want to work at Northwind/), value: "I want to build reliable, large-scale backend and distributed systems, and Northwind's platform work matches my experience at American Express." },
  { do: "select", id: idOf(s, /"Gender/), value: "Prefer not to say" },
  { do: "check", id: idOf(s, /checkbox "I confirm/) },
  { do: "click", id: idOf(s, /button "Submit application"/) },
]);
const last = await (await fetch(`${BASE}/api/last`)).json();
console.log(`\n=== server received (total ${Date.now() - t0}ms) ===\n${JSON.stringify(last, null, 1)}`);
process.exit(0);
