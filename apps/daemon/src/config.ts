import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The agent's prompt, step limit and per-model options live in opencode.jsonc. The direct engine
// reads them from the same file, so both engines behave the same and there is one place to edit.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CONFIG_FILE = process.env.INTENT_AGENT_CONFIG ?? join(process.env.INTENT_AGENT_PROJECT_DIR ?? REPO_ROOT, "opencode.jsonc");

type Json = Record<string, unknown>;

let fileConfig: Json | undefined;
let override: Json | undefined;

function readFile(): Json {
  if (!fileConfig) {
    try {
      // JSONC: only whole-line comments are used in this file.
      fileConfig = JSON.parse(readFileSync(CONFIG_FILE, "utf8").replace(/^\s*\/\/.*$/gm, "")) as Json;
    } catch (err) {
      console.error(`[config] could not read ${CONFIG_FILE}`, err);
      fileConfig = {};
    }
  }
  return fileConfig;
}

function dig(root: Json | undefined, path: string[]): unknown {
  let cur: unknown = root;
  for (const key of path) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Json)[key];
  }
  return cur;
}

// Benchmarks layer extra config over the file (e.g. a different reasoning effort).
export function setConfigLayer(config: Json | undefined): void {
  override = config;
}

export function getConfigLayer(): Json | undefined {
  return override;
}

function get(path: string[]): unknown {
  return dig(override, path) ?? dig(readFile(), path);
}

export function agentPrompt(): string {
  return String(get(["agent", "browser", "prompt"]) ?? "");
}

export function maxSteps(): number {
  return Number(get(["agent", "browser", "maxSteps"]) ?? 60);
}

// e.g. "low" for gpt-6-luna; undefined for models with no reasoning setting.
export function reasoningEffort(providerID: string, modelID: string): string | undefined {
  const v = get(["provider", providerID, "models", modelID, "options", "reasoningEffort"]);
  return typeof v === "string" ? v : undefined;
}
