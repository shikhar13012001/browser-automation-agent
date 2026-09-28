import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPrompt,
  extractApproval,
  extractAttention,
  extractJson,
  isRecoverableToolFailure,
  parseModelChain,
} from "./markers.js";

test("extractAttention / extractApproval read their own marker only", () => {
  assert.equal(extractAttention("done\nNEEDS_ATTENTION: captcha on login"), "captcha on login");
  assert.equal(extractAttention("all good"), undefined);
  assert.equal(extractApproval("ready\nNEEDS_APPROVAL: about to click Submit"), "about to click Submit");
  assert.equal(extractApproval("NEEDS_ATTENTION: stuck"), undefined);
});

test("extractJson takes the last fenced json block and ignores invalid JSON", () => {
  const text = 'draft\n```json\n{"a":1}\n```\nfinal\n```json\n{"a":2}\n```';
  assert.deepEqual(extractJson(text), { a: 2 });
  assert.equal(extractJson("```json\n{not json}\n```"), undefined);
  assert.equal(extractJson("no block"), undefined);
});

test("extractJson accepts unfenced JSON, prose around JSON, and bare fences", () => {
  assert.deepEqual(extractJson('{"summary":"ok","findings":[]}'), { summary: "ok", findings: [] });
  assert.deepEqual(extractJson('Here you go:\n{"a": {"b": 2}}\nThanks'), { a: { b: 2 } });
  assert.deepEqual(extractJson("```\n{\"x\":1}\n```"), { x: 1 });
  assert.equal(extractJson("just words, no json"), undefined);
});

test("buildPrompt is a no-op without options and adds only the requested sections", () => {
  assert.equal(buildPrompt("do it"), "do it");
  const qa = buildPrompt("test the app", { mode: "qa" });
  assert.match(qa, /exploratory QA tester/);
  assert.match(qa, /"findings"/);
  assert.doesNotMatch(qa, /APPROVAL GATE/);
  const approval = buildPrompt("apply", { requireApproval: true });
  assert.match(approval, /NEEDS_APPROVAL:/);
  const schema = buildPrompt("extract", { outputSchema: '{"title": "string"}' });
  assert.match(schema, /"title": "string"/);
});

test("parseModelChain splits, trims, drops invalid entries, and falls back", () => {
  assert.deepEqual(parseModelChain("a/b, c/d ,junk"), ["a/b", "c/d"]);
  assert.deepEqual(parseModelChain(undefined), ["github-copilot/claude-sonnet-5"]);
  assert.deepEqual(parseModelChain(""), ["github-copilot/claude-sonnet-5"]);
});

test("isRecoverableToolFailure matches dead-connection errors only", () => {
  assert.equal(isRecoverableToolFailure('Error: "Not connected"'), true);
  assert.equal(isRecoverableToolFailure("connect ECONNREFUSED 127.0.0.1:9222"), true);
  assert.equal(isRecoverableToolFailure("element not found"), false);
});
