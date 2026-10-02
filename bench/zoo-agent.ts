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

const { PROMPT, EXPECT } = await import("./zoo-task.js");
const model = process.argv[2] ?? "openai/gpt-6-luna";
const t = Date.now();
let summary = "";
try {
  const r = await runTask(PROMPT, undefined, () => {}, [], { models: [model], includeContext: false, engine: process.env.ZOO_ENGINE as "direct" | "opencode" | undefined, worker: process.env.ZOO_WORKER });
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
