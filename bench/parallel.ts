// Throughput benchmark: N copies of the complex zoo task at the same time, each on its own worker
// (its own tab and tool process in the same Chrome), each scored from what its own tab recorded.
//   npx tsx bench/parallel.ts 3 [model]
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import dotenv from "dotenv";
import puppeteer from "puppeteer-core";

dotenv.config({ path: "apps/daemon/.env", quiet: true });
const { runTask, resetClient } = await import("../apps/daemon/src/agent.js");
const { PROMPT, EXPECT, failures } = await import("./zoo-task.js");

const n = Number(process.argv[2] ?? 3);
const model = process.argv[3] ?? "openai/gpt-6-luna";
const workers = Array.from({ length: n }, (_, i) => (i === 0 ? "" : `w${i + 1}`));

const t0 = Date.now();
const runs = await Promise.all(
  workers.map(async (worker) => {
    const t = Date.now();
    try {
      const r = await runTask(PROMPT, undefined, () => {}, [], { models: [model], includeContext: false, worker });
      return { worker, seconds: Math.round((Date.now() - t) / 1000), cost: r.usage.cost, calls: r.usage.detail?.toolCalls ?? 0, error: "" };
    } catch (e) {
      return { worker, seconds: Math.round((Date.now() - t) / 1000), cost: 0, calls: 0, error: e instanceof Error ? e.message : String(e) };
    }
  }),
);
const wall = Math.round((Date.now() - t0) / 1000);

// Each worker's tab id is in its own home-tab file; read what that tab recorded.
const browser = await puppeteer.connect({ browserURL: process.env.INTENT_BROWSER_CDP_URL ?? "http://127.0.0.1:9222", defaultViewport: null });
const pages = await browser.pages();
let perfect = 0;
for (const r of runs) {
  const file = join(tmpdir(), "intent-browser", r.worker ? `home-tab-${r.worker}.txt` : "home-tab.txt");
  const id = readFileSync(file, "utf8").trim();
  const page = pages.find((p) => (p.target() as unknown as { _targetId?: string })._targetId === id);
  const z = page ? ((await page.evaluate("window.ZOO ? JSON.parse(JSON.stringify(window.ZOO)) : {}")) as Record<string, unknown>) : {};
  const failed = failures(z);
  if (!failed.length && !r.error) perfect++;
  console.log(
    `${(r.worker || "w1").padEnd(3)} ${String(r.seconds).padStart(4)}s  $${r.cost.toFixed(4)}  ${String(r.calls).padStart(2)} calls  ${EXPECT.length - failed.length}/${EXPECT.length}` +
      (failed.length ? `  failed: ${failed.join(", ")}` : "") +
      (r.error ? `  error: ${r.error.slice(0, 120)}` : ""),
  );
}
const serial = runs.reduce((s, r) => s + r.seconds, 0);
console.log(`\n${n} tasks at once: ${wall}s wall clock (${serial}s of task time) -> ${(serial / wall).toFixed(1)}x throughput, ${perfect}/${n} perfect`);
await browser.disconnect();
resetClient();
process.exit(0);
