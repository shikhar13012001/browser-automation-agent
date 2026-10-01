import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBatchReport, findingsOf } from "./qa-report.js";

test("findings from different runs describing the same bug are merged", () => {
  const report = buildBatchReport([
    { id: "1", label: "Dev", status: "completed", cost: 0.01, findings: [{ severity: "major", title: "City field is cleared after going Back" }] },
    { id: "2", label: "Neha", status: "completed", cost: 0.02, findings: [{ severity: "critical", title: "Going back clears the City field" }, { severity: "minor", title: "Privacy policy link returns 404" }] },
    { id: "3", label: "Ravi", status: "failed", findings: [] },
  ]);
  assert.equal(report.runs, 3);
  assert.equal(report.findings, 3);
  assert.equal(report.issues.length, 2);
  assert.equal(report.issues[0].hits, 2);
  assert.equal(report.issues[0].severity, "critical", "keeps the worst severity");
  assert.deepEqual(report.byStatus, { completed: 2, failed: 1 });
  assert.equal(Number(report.cost.toFixed(2)), 0.03);
});

test("unrelated findings stay separate", () => {
  const report = buildBatchReport([
    { id: "1", label: "A", status: "completed", findings: [{ title: "Plus-addressed email rejected" }, { title: "Next button unresponsive for 6+ years" }] },
  ]);
  assert.equal(report.issues.length, 2);
});

test("findingsOf tolerates missing or malformed result JSON", () => {
  assert.deepEqual(findingsOf(undefined), []);
  assert.deepEqual(findingsOf({ findings: "nope" }), []);
  assert.equal(findingsOf({ findings: [{ title: "x" }, null] }).length, 1);
});
