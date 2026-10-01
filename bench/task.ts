// Run one natural-language task through the same code path the daemon uses and print what happened.
// Usage: npx tsx bench/task.ts "prompt" [model]
import dotenv from "dotenv";
dotenv.config({ path: "apps/daemon/.env", quiet: true });
const { runTask, resetClient } = await import("../apps/daemon/src/agent.js");

const prompt = process.argv[2];
const model = process.argv[3];
if (!prompt) throw new Error('usage: npx tsx bench/task.ts "prompt" [model]');

const t = Date.now();
try {
  const r = await runTask(prompt, undefined, (kind, msg) => console.log(`[${kind}] ${msg}`), [], model ? { models: [model] } : {});
  console.log(`\n--- output (${r.model}, ${Math.round((Date.now() - t) / 1000)}s) ---\n${r.output}`);
  console.log("\nusage:", JSON.stringify(r.usage));
} catch (e) {
  console.log(`\n--- failed after ${Math.round((Date.now() - t) / 1000)}s: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  resetClient();
  process.exit(0);
}
