// End-to-end robustness benchmark: one natural-language task that touches ~20 awkward widgets on
// bench/fixture/zoo.html, run by a real model through the daemon's code path, scored by what the page
// recorded (window.ZOO). Usage: npx tsx bench/zoo-agent.ts [model]
import dotenv from "dotenv";
dotenv.config({ path: "apps/daemon/.env", quiet: true });
const { runTask, resetClient, setConfigOverride } = await import("../apps/daemon/src/agent.js");
// ZOO_EFFORT=none|low|medium overrides the model's reasoning effort for this run.
if (process.env.ZOO_EFFORT) {
  const [, modelID] = (process.argv[2] ?? "openai/gpt-6-luna").split("/", 2);
  setConfigOverride({ provider: { openai: { models: { [modelID]: { options: { reasoningEffort: process.env.ZOO_EFFORT } } } } } });
}
const { getPage } = await import("../packages/browser-mcp/src/browser.js");

const model = process.argv[2] ?? "openai/gpt-6-luna";
const next = new Date();
next.setDate(1);
next.setMonth(next.getMonth() + 1);
const wantDate = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-15`;

const PROMPT = `Go to http://localhost:4545/zoo and complete the account setup:
- preferred language Python3, country of residence Canada, seniority Senior
- start date: the 15th of next month
- subscribe the newsletter with test@example.com
- apply coupon SAVE10, and save the card holder name Test User
- write the message "Hello there"
- turn on email notifications
- billing email bill@acme.co (Billing tab), postal code 560001 (Shipping address)
- open Account > Settings
- open Project 42 in the projects list
- generate the report and download it
- mobile number 5551234567, monthly budget 70, work mode Hybrid, timezone India, company name Acme Robotics
- primary skill TypeScript
- search members for "ana"
- choose the Team plan, agree to the terms and continue to payment
Do not archive anything and do not open the chat. Report what you did.`;

const EXPECT: [string, (z: Record<string, unknown>) => boolean][] = [
  ["language", (z) => z.lang === "Python3"],
  ["country", (z) => z.country === "Canada"],
  ["seniority", (z) => z.level === "Senior"],
  ["date", (z) => z.date === wantDate],
  ["newsletter", (z) => z.newsletter === "test@example.com"],
  ["coupon (iframe)", (z) => z.coupon === "SAVE10"],
  ["card holder (x-origin iframe)", (z) => z.cardHolder === "Test User"],
  ["message", (z) => z.message === "Hello there"],
  ["notifications", (z) => z.notifications === true],
  ["billing email", (z) => z.billingEmail === "bill@acme.co"],
  ["postal code", (z) => z.zip === "560001"],
  ["hover menu", (z) => z.menu === "Settings"],
  ["project 42", (z) => z.project === 42],
  ["download", (z) => z.downloaded === true],
  ["phone", (z) => z.phone === "5551234567"],
  ["budget", (z) => z.budget === 70],
  ["work mode", (z) => z.workMode === "Hybrid"],
  ["timezone", (z) => String(z.tz).includes("India")],
  ["company", (z) => z.company === "Acme Robotics"],
  ["skill", (z) => z.skill === "TypeScript"],
  ["search", (z) => z.search === "ana"],
  ["plan", (z) => String(z.plan).startsWith("Team")],
  ["terms + continue", (z) => z.accepted === true],
  ["did NOT archive", (z) => !z.archived],
  ["did NOT open chat", (z) => !z.chat],
];

const t = Date.now();
let summary = "";
try {
  const r = await runTask(PROMPT, undefined, () => {}, [], { models: [model], includeContext: false });
  const d = r.usage.detail;
  summary = `${model}: ${Math.round((Date.now() - t) / 1000)}s, ${r.usage.inputTokens} in / ${r.usage.outputTokens} out tokens, $${r.usage.cost.toFixed(4)}, ${d?.toolCalls ?? "?"} tool calls`;
} catch (e) {
  summary = `${model}: FAILED after ${Math.round((Date.now() - t) / 1000)}s: ${e instanceof Error ? e.message : String(e)}`;
}
const page = await getPage();
const z = (await page.evaluate("window.ZOO ? JSON.parse(JSON.stringify(window.ZOO)) : {}")) as Record<string, unknown>;
let pass = 0;
for (const [name, ok] of EXPECT) {
  const good = ok(z);
  if (good) pass++;
  console.log(`${good ? "PASS" : "FAIL"}  ${name}`);
}
console.log(`\n${summary}\nscore: ${pass}/${EXPECT.length}`);
resetClient();
process.exit(0);
