// Benchmark: runs the same realistic job-application journey (cookie dialog -> Apply opens a new
// tab -> guest sign-in -> 3-step form with a custom combobox, hidden file input, styled checkboxes
// and validation -> submit) through the real agent code path, and scores each run against what the
// fixture server actually received. Records time, steps, tool calls, fresh/cached tokens and cost.
//
//   npx tsx bench/run.ts                       # default matrix
//   npx tsx bench/run.ts --only luna-low,4o-mini --runs 2
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import dotenv from "dotenv";

dotenv.config({ path: "apps/daemon/.env", quiet: true });
const { runTask, setConfigOverride, warmUp } = await import("../apps/daemon/src/agent.js");

const BASE = process.env.BENCH_URL ?? "http://localhost:4545";
const RUN_TIMEOUT_MS = 8 * 60_000;

type Config = { name: string; tool: "intent-browser" | "chrome-devtools"; model: string; effort?: string };

const baseline = JSON.parse(readFileSync("bench/baseline-config.json", "utf8"));
const intentBrowserMcp = { type: "local", command: ["node", "--import", "tsx", "packages/browser-mcp/src/index.ts"] };

function overrideFor(c: Config): Record<string, unknown> {
  const [, modelID] = c.model.split("/", 2);
  const provider = c.effort ? { openai: { models: { [modelID]: { options: { reasoningEffort: c.effort } } } } } : {};
  if (c.tool === "chrome-devtools") {
    return {
      provider,
      mcp: {
        "chrome-devtools": { ...baseline.mcp["chrome-devtools"], enabled: true },
        "intent-browser": { ...intentBrowserMcp, enabled: false },
      },
      agent: { browser: { prompt: baseline.agent.browser.prompt, tools: baseline.agent.browser.tools } },
    };
  }
  return { provider, mcp: { "intent-browser": { ...intentBrowserMcp, enabled: true } } };
}

const MATRIX: Config[] = [
  { name: "devtools+4o-mini", tool: "chrome-devtools", model: "openai/gpt-4o-mini" },
  { name: "devtools+luna-low", tool: "chrome-devtools", model: "openai/gpt-6-luna", effort: "low" },
  { name: "luna-low", tool: "intent-browser", model: "openai/gpt-6-luna", effort: "low" },
  { name: "luna-none", tool: "intent-browser", model: "openai/gpt-6-luna", effort: "none" },
  { name: "luna-medium", tool: "intent-browser", model: "openai/gpt-6-luna", effort: "medium" },
  { name: "4o-mini", tool: "intent-browser", model: "openai/gpt-4o-mini" },
  { name: "4.1-mini", tool: "intent-browser", model: "openai/gpt-4.1-mini" },
  { name: "4.1-nano", tool: "intent-browser", model: "openai/gpt-4.1-nano" },
  { name: "5.4-nano", tool: "intent-browser", model: "openai/gpt-5.4-nano", effort: "low" },
  { name: "5.4-mini", tool: "intent-browser", model: "openai/gpt-5.4-mini", effort: "low" },
  { name: "5-mini", tool: "intent-browser", model: "openai/gpt-5-mini", effort: "low" },
];

const PROMPT = `Apply to this job: ${BASE}/jobs/sde1 -- open it and complete the whole application using my profile and resume from the context. This is a practice site, so do submit the application at the end. Report the reference number shown on the confirmation page.`;

// What a correct application contains, derived from context/career.md and context/resumes.md.
const CHECKS: [string, (d: Record<string, unknown>) => boolean][] = [
  ["firstName", (d) => d.firstName === "Shikhar"],
  ["lastName", (d) => d.lastName === "Gupta"],
  ["email", (d) => String(d.email).toLowerCase() === "ishgupta2015@gmail.com"],
  ["phoneCode", (d) => d.phoneCode === "+91 India"],
  ["phone", (d) => String(d.phone).replace(/\D/g, "").endsWith("9555607181")],
  ["city", (d) => d.city === "Bengaluru"],
  ["linkedin", (d) => /shikhar-gupta-71ab59201/i.test(String(d.linkedin ?? ""))],
  ["resume", (d) => /CoreSWE/i.test(String(d.resume))],
  ["employer", (d) => /american express|amex/i.test(String(d.employer))],
  ["title", (d) => /software|sde|engineer/i.test(String(d.title))],
  ["experience", (d) => d.experience === "1-2 years"],
  ["university", (d) => /iiit.*gwalior|gwalior/i.test(String(d.university))],
  ["gradYear", (d) => String(d.gradYear) === "2025"],
  ["skills", (d) => { const s = (d.skills as string[]) ?? []; return s.filter((x) => ["Python", "Kotlin", "Java", "TypeScript"].includes(x)).length >= 2 && !s.some((x) => ["PHP", "Ruby"].includes(x)); }],
  ["basedInIndia", (d) => d.basedInIndia === "Yes"],
  ["whyJoin", (d) => String(d.whyJoin ?? "").trim().length >= 50],
  ["gender", (d) => !d.gender || d.gender === "Prefer not to say"],
  ["consent", (d) => d.consent === true],
];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const only = arg("only")?.split(",");
const runs = Number(arg("runs") ?? 1);
// --engine opencode|direct for the intent-browser configs (default: direct for OpenAI models). The
// chrome-devtools baseline only exists inside OpenCode.
const engineArg = arg("engine") as "opencode" | "direct" | undefined;
const configs = only ? MATRIX.filter((c) => only.includes(c.name)) : MATRIX;
mkdirSync("bench/results", { recursive: true });
const outFile = `bench/results/run-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
const results: Record<string, unknown>[] = [];

for (const c of configs) {
  for (let r = 1; r <= runs; r++) {
    setConfigOverride(overrideFor(c));
    const engine = c.tool === "chrome-devtools" ? "opencode" : engineArg;
    if (engine === "opencode") {
      const mcp = (await warmUp()) as Record<string, { status: string }>;
      const live = Object.entries(mcp ?? {}).filter(([, v]) => v?.status === "connected").map(([k]) => k);
      if (!live.includes(c.tool)) {
        console.log(`!! ${c.name}: expected ${c.tool} to be connected, got ${JSON.stringify(mcp)}`);
      }
    }
    await fetch(`${BASE}/api/reset`);

    const t0 = Date.now();
    let output = "";
    let error = "";
    let usage: { cost: number; detail?: Record<string, number> } = { cost: 0 };
    let usedModel = "";
    try {
      const res = await Promise.race([
        runTask(PROMPT, undefined, () => {}, [], { models: [c.model], engine }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("benchmark timeout")), RUN_TIMEOUT_MS)),
      ]);
      output = res.output;
      usage = res.usage;
      usedModel = res.model;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const seconds = (Date.now() - t0) / 1000;
    const last = await (await fetch(`${BASE}/api/last`)).json();
    const data = (last?.data ?? {}) as Record<string, unknown>;
    const failed = last ? CHECKS.filter(([, ok]) => !ok(data)).map(([k]) => k) : CHECKS.map(([k]) => k);
    const submitted = !!last;
    const correct = CHECKS.length - failed.length;
    const reportedRef = !!last?.ref && output.includes(last.ref);
    const row = {
      config: c.name,
      engine: engine ?? "direct",
      tool: c.tool,
      model: c.model,
      effort: c.effort ?? "",
      run: r,
      submitted,
      fieldsCorrect: `${correct}/${CHECKS.length}`,
      success: submitted && failed.length === 0,
      reportedRef,
      wrongFields: failed,
      seconds: Math.round(seconds),
      steps: usage.detail?.steps ?? 0,
      toolCalls: usage.detail?.toolCalls ?? 0,
      freshInput: usage.detail?.input ?? 0,
      cachedInput: usage.detail?.cacheRead ?? 0,
      output: (usage.detail?.output ?? 0) + (usage.detail?.reasoning ?? 0),
      reasoning: usage.detail?.reasoning ?? 0,
      costUsd: Number(usage.cost.toFixed(5)),
      usedModel,
      error,
      answer: output.slice(0, 300),
    };
    results.push(row);
    writeFileSync(outFile, JSON.stringify(results, null, 2));
    console.log(
      `${c.name.padEnd(18)} run ${r}: ${row.success ? "PASS" : submitted ? "PARTIAL" : "FAIL"} ${row.fieldsCorrect} ` +
        `${row.seconds}s steps=${row.steps} tools=${row.toolCalls} in=${row.freshInput}+${row.cachedInput}c out=${row.output} $${row.costUsd}` +
        (failed.length && submitted ? ` wrong=${failed.join(",")}` : "") +
        (error ? ` error=${error.slice(0, 120)}` : ""),
    );
  }
}
console.log(`\nsaved ${outFile}`);
process.exit(0);
