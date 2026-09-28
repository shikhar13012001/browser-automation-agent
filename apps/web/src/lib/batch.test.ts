import { test } from "node:test";
import assert from "node:assert/strict";
import { findMissingColumns, normalizeKey, parseCsv, planBatch, renderTemplate } from "./batch";

test("parseCsv handles quotes, embedded commas/newlines, CRLF and BOM", () => {
  const csv = '﻿company,notes\r\n"Acme, Inc","line1\nline2"\r\nGlobex,"say ""hi"""\r\n';
  assert.deepEqual(parseCsv(csv), [
    { company: "Acme, Inc", notes: "line1\nline2" },
    { company: "Globex", notes: 'say "hi"' },
  ]);
});

test("parseCsv ignores blank lines and returns [] for header-only input", () => {
  assert.deepEqual(parseCsv("a,b\n\n1,2\n\n"), [{ a: "1", b: "2" }]);
  assert.deepEqual(parseCsv("a,b\n"), []);
});

test("renderTemplate and findMissingColumns use {{column}} placeholders", () => {
  assert.equal(renderTemplate("Find {{ company }} careers in {{city}}", { company: "Acme", city: "Pune" }), "Find Acme careers in Pune");
  assert.deepEqual(findMissingColumns("Go to {{url}} for {{who}}", [{ url: "x" }]), ["who"]);
});

test("planBatch skips duplicates inside the file and against earlier batches, and invalid rows", () => {
  const rows = [
    { company: "Acme", url: "a.com" },
    { company: " acme ", url: "a2.com" },
    { company: "Globex", url: "g.com" },
    { company: "Initech", url: "" },
    { company: "Hooli", url: "h.com" },
  ];
  const plan = planBatch("Apply at {{company}} via {{url}}", rows, "company", new Set(["hooli"]));
  assert.equal(plan.tasks.length, 2);
  assert.deepEqual(plan.tasks.map((t) => t.dedupeKey), ["acme", "globex"]);
  assert.equal(plan.duplicates, 2);
  assert.equal(plan.invalid, 1);
});

test("normalizeKey collapses case and whitespace", () => {
  assert.equal(normalizeKey("  Acme   Corp "), "acme corp");
  assert.equal(normalizeKey("   "), undefined);
});
