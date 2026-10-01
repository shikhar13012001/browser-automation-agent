// Persona QA demo: runs one QA-mode task per persona in bench/qa/personas.csv against the buggy
// practice site (/qa/...), the same way a dashboard batch upload would (same template rendering,
// same QA prompt, same JSON extraction). It scores which planted bugs (bench/qa/bugs.json) each
// persona reported and prints the merged batch report.
//   npx tsx bench/qa-run.ts [model] [--only "Persona name,Other"]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import dotenv from "dotenv";

dotenv.config({ path: "apps/daemon/.env", quiet: true });
const { runTask, resetClient } = await import("../apps/daemon/src/agent.js");
const { buildPrompt, extractJson } = await import("../apps/daemon/src/markers.js");
const { parseCsv, planBatch } = await import("../apps/web/src/lib/batch.js");
const { buildBatchReport, findingsOf } = await import("../apps/web/src/lib/qa-report.js");

const BASE = process.env.BENCH_URL ?? "http://localhost:4545";
const model = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "openai/gpt-6-luna";
const onlyArg = process.argv.indexOf("--only");
const only = onlyArg > 0 ? process.argv[onlyArg + 1].split(",") : undefined;

const RESUME = resolve("bench/qa/resume-sample.pdf");
if (!existsSync(RESUME)) {
  // A minimal one-page PDF, enough for the form's upload step.
  const pdf = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n";
  writeFileSync(RESUME, pdf);
}

const TEMPLATE = `You are a first-time applicant testing this company's careers site. Persona: {{persona}}.
Apply to the job at ${BASE}/qa/jobs/sde1 as {{first_name}} {{last_name}}, email {{email}}, phone {{phone_code}} {{phone}}, city {{city}}, {{experience}} of experience, currently a Software Engineer at Acme Corp, graduated from IIT Delhi in 2019. Upload the resume at ${RESUME}. Continue as a guest.
How you behave: {{behaviour}}
This is a test site, so do submit the application, then read the confirmation page. Report every bug or UX problem you actually ran into.`;

type Bug = { id: string; title: string; personas: string[]; match: string };
const bugs = JSON.parse(readFileSync("bench/qa/bugs.json", "utf8")) as Bug[];
const rows = parseCsv(readFileSync("bench/qa/personas.csv", "utf8")).filter((r) => !only || only.includes(r.persona));
const plan = planBatch(TEMPLATE, rows, "persona", new Set());

const runs: { id: string; label: string; status: string; cost?: number; findings: ReturnType<typeof findingsOf>; seconds: number; submitted: boolean; error?: string }[] = [];
for (const [i, t] of plan.tasks.entries()) {
  const persona = rows[i].persona;
  const before = ((await (await fetch(`${BASE}/api/submissions`)).json()) as unknown[]).length;
  const t0 = Date.now();
  let status = "completed";
  let output = "";
  let cost = 0;
  let error: string | undefined;
  try {
    const r = await runTask(buildPrompt(t.prompt, { mode: "qa" }), undefined, () => {}, [], { models: [model], includeContext: false });
    output = r.output;
    cost = r.usage.cost;
    if (/NEEDS_ATTENTION:/.test(output)) status = "needs_attention";
  } catch (e) {
    status = "failed";
    error = e instanceof Error ? e.message : String(e);
  }
  const after = ((await (await fetch(`${BASE}/api/submissions`)).json()) as unknown[]).length;
  const findings = findingsOf(extractJson(output));
  const run = { id: String(i + 1), label: persona, status, cost, findings, seconds: Math.round((Date.now() - t0) / 1000), submitted: after > before, error };
  runs.push(run);
  console.log(`${persona.padEnd(20)} ${status.padEnd(16)} ${String(run.seconds).padStart(4)}s  $${cost.toFixed(4)}  submitted=${run.submitted}  findings=${findings.length}${error ? `  error=${error.slice(0, 100)}` : ""}`);
}

// Detection: for each planted bug, which of the personas expected to hit it reported it.
const text = (f: (typeof runs)[number]["findings"][number]) => [f.title, f.actual, f.expected, ...(f.steps ?? [])].join(" ").toLowerCase();
const matched = new Set<string>();
console.log("\nPlanted bug detection:");
let expectedPairs = 0;
let detectedPairs = 0;
for (const b of bugs) {
  const re = new RegExp(b.match, "i");
  const targets = runs.filter((r) => b.personas.includes("*") ? r.submitted : b.personas.includes(r.label));
  const hitBy = targets.filter((r) => r.findings.some((f, k) => re.test(text(f)) && matched.add(`${r.id}:${k}`)));
  // Also count findings from other personas that happen to describe this bug.
  for (const r of runs) r.findings.forEach((f, k) => re.test(text(f)) && matched.add(`${r.id}:${k}`));
  expectedPairs += targets.length;
  detectedPairs += hitBy.length;
  console.log(`  ${b.id} ${hitBy.length ? "FOUND  " : "missed "} ${b.title}  (${hitBy.length}/${targets.length}: ${hitBy.map((r) => r.label).join(", ") || "-"})`);
}
const all = runs.flatMap((r) => r.findings.map((f, k) => ({ r, f, k })));
const other = all.filter(({ r, k }) => !matched.has(`${r.id}:${k}`));
const found = bugs.filter((b) => {
  const re = new RegExp(b.match, "i");
  return runs.some((r) => r.findings.some((f) => re.test(text(f))));
}).length;
console.log(`\n${found}/${bugs.length} planted bugs found by at least one persona; ${detectedPairs}/${expectedPairs} expected persona-bug hits.`);
console.log(`${other.length} of ${all.length} findings match no planted bug (review these: real quirks or false positives):`);
for (const { r, f } of other) console.log(`  - [${r.label}] ${f.severity ?? "?"}: ${f.title}`);

const report = buildBatchReport(runs);
console.log(`\nMerged report: ${report.issues.length} distinct issues from ${report.findings} findings over ${report.runs} runs, $${report.cost.toFixed(4)} total`);
for (const is of report.issues) console.log(`  ${is.severity.padEnd(10)} x${is.hits}  ${is.title}`);

mkdirSync("bench/results", { recursive: true });
const out = `bench/results/qa-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
writeFileSync(out, JSON.stringify({ model, runs, report }, null, 2));
console.log(`\nsaved ${out}`);
resetClient();
process.exit(0);
