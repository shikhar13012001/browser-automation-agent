import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createOpencode, type OpencodeClient } from "@opencode-ai/sdk";
import type { Part, TextPartInput, FilePartInput } from "@opencode-ai/sdk";
import { isRecoverableToolFailure, parseModelChain } from "./markers.js";

// process.cwd() is NOT a reliable default here: `npm run start -w apps/daemon` (and similar
// workspace-script invocations) sets it to apps/daemon, not the repo root, silently breaking
// CONTEXT_DIR below unless INTENT_AGENT_PROJECT_DIR is set explicitly by whoever launches this.
// Resolve from this file's own location instead (apps/daemon/src/agent.ts -> repo root) so the
// default is correct regardless of how or from where the process was started.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PROJECT_DIR = process.env.INTENT_AGENT_PROJECT_DIR ?? REPO_ROOT;
const MODEL_CHAIN = parseModelChain(process.env.INTENT_AGENT_MODEL);
const MODEL_TIMEOUT_MS = Number(process.env.INTENT_AGENT_MODEL_TIMEOUT_MS ?? 240_000);
const CONTEXT_DIR = process.env.INTENT_AGENT_CONTEXT_DIR ?? join(PROJECT_DIR, "context");

let cachedContext: string | undefined;

async function loadContext(): Promise<string> {
  if (cachedContext !== undefined) return cachedContext;
  try {
    const entries = await readdir(CONTEXT_DIR);
    const files = entries.filter((f) => f.toLowerCase() !== "readme.md" && f.endsWith(".md")).sort();
    if (files.length === 0) {
      console.warn(`[agent] no context files found in ${CONTEXT_DIR} -- new sessions will start with no personal context`);
    }
    const sections = await Promise.all(
      files.map(async (f) => `## ${f}\n\n${await readFile(join(CONTEXT_DIR, f), "utf-8")}`),
    );
    cachedContext = sections.join("\n\n");
  } catch (err) {
    console.error(`[agent] could not read context from ${CONTEXT_DIR} -- new sessions will start with no personal context`, err);
    cachedContext = "";
  }
  return cachedContext;
}

let client: OpencodeClient | undefined;
let server: { close(): void } | undefined;

async function getClient(): Promise<OpencodeClient> {
  if (!client) {
    const opencode = await createOpencode();
    client = opencode.client;
    server = opencode.server;
  }
  return client;
}

// Recreates the embedded OpenCode server, which also respawns its MCP subprocesses (e.g. the
// Chrome DevTools connection). Without this a dead browser-tool connection fails every later
// task with "Not connected" until the whole daemon is restarted by hand.
export function resetClient(): void {
  try {
    server?.close();
  } catch (err) {
    console.error("[agent] failed to close opencode server", err);
  }
  client = undefined;
  server = undefined;
}

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  svg: "image/svg+xml",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
};

function mimeFromUrl(url: string): string {
  const ext = url.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

function textFromParts(parts: Part[]): string {
  return parts
    .filter((part): part is Part & { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

export type Usage = { inputTokens: number; outputTokens: number; cost: number };

export type RunResult = {
  output: string;
  sessionId: string;
  model: string;
  usage: Usage;
};

export type RunEventKind = "status" | "plan" | "action" | "verification" | "finding" | "attention" | "error" | "result";
export type OnEvent = (kind: RunEventKind, message: string) => void;

// True per-step live streaming turned out not to work reliably in this OpenCode version
// (both the SSE event stream and polling session.messages() only surface a message's parts
// once the message is fully committed, not while it's still being generated -- confirmed by
// direct testing). Instead: emit a lightweight heartbeat while the prompt is in flight so the
// UI shows real movement, then emit the full ordered breakdown (every tool call and reasoning
// step, not just the final answer) once the result comes back.
function emitBreakdown(parts: Part[], onEvent: OnEvent): void {
  for (const part of parts) {
    if (part.type === "tool") {
      if (part.state.status === "completed") {
        onEvent("action", part.state.title || `Ran ${part.tool}`);
      } else if (part.state.status === "error") {
        onEvent("error", `${part.tool} failed: ${part.state.error}`);
      }
    } else if ((part.type === "reasoning" || part.type === "text") && part.text.trim()) {
      onEvent("plan", part.text.trim());
    }
  }
}

// MCP servers report a dead connection either as a tool error or as a normal, short tool result
// ("Not connected"). Long outputs are skipped so page content that happens to contain those words
// (snapshots, extracted text) can never trigger a restart.
const MAX_ERROR_OUTPUT_CHARS = 300;

function toolFailureText(parts: Part[]): string {
  return parts
    .flatMap((part) => {
      if (part.type !== "tool") return [];
      if (part.state.status === "error") return [part.state.error];
      if (part.state.status === "completed" && part.state.output.length <= MAX_ERROR_OUTPUT_CHARS) return [part.state.output];
      return [];
    })
    .join("\n");
}

async function collectTurn(
  c: OpencodeClient,
  sessionId: string,
  startedAt: number,
): Promise<{ parts: Part[]; usage: Usage } | undefined> {
  try {
    const res = await c.session.messages({ path: { id: sessionId }, query: { directory: PROJECT_DIR } });
    if (!res.data) return undefined;
    // Same machine, but allow a little clock slack between this process and the OpenCode server.
    const turn = res.data.filter((m) => m.info.role === "assistant" && m.info.time.created >= startedAt - 2000);
    if (turn.length === 0) return undefined;
    const usage: Usage = { inputTokens: 0, outputTokens: 0, cost: 0 };
    for (const m of turn) {
      if (m.info.role !== "assistant") continue;
      usage.inputTokens += m.info.tokens.input + m.info.tokens.cache.read + m.info.tokens.cache.write;
      usage.outputTokens += m.info.tokens.output + m.info.tokens.reasoning;
      usage.cost += m.info.cost;
    }
    return { parts: turn.flatMap((m) => m.parts), usage };
  } catch (err) {
    console.error("[agent] could not read the turn back from the session", err);
    return undefined;
  }
}

// Tries each model in INTENT_AGENT_MODEL (comma-separated) in order. A model attempt counts as failed
// when the call throws or OpenCode reports a provider error (quota, auth, network). A dead browser-tool
// connection instead recreates the OpenCode server once and retries the same model.
export async function runTask(
  prompt: string,
  existingSessionId?: string,
  onEvent: OnEvent = () => {},
  attachments: string[] = [],
): Promise<RunResult> {
  let sessionId = existingSessionId;
  let recovered = false;
  let lastError: unknown;

  for (let i = 0; i < MODEL_CHAIN.length; i++) {
    const model = MODEL_CHAIN[i];
    for (;;) {
      try {
        const result = await runOnce(model, prompt, sessionId, onEvent, attachments);
        sessionId = result.sessionId;
        if (!recovered && isRecoverableToolFailure(result.toolErrors)) {
          recovered = true;
          onEvent("status", "Browser tool connection was lost. Restarting the agent server and retrying...");
          resetClient();
          continue;
        }
        return result;
      } catch (err) {
        lastError = err;
        const message = err instanceof Error ? err.message : String(err);
        if (!recovered && isRecoverableToolFailure(message)) {
          recovered = true;
          onEvent("status", "Agent connection was lost. Restarting the agent server and retrying...");
          resetClient();
          continue;
        }
        if (i + 1 < MODEL_CHAIN.length) {
          onEvent("status", `Model ${model} failed (${message}). Falling back to ${MODEL_CHAIN[i + 1]}.`);
        }
        break;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function runOnce(
  model: string,
  prompt: string,
  existingSessionId: string | undefined,
  onEvent: OnEvent,
  attachments: string[],
): Promise<RunResult & { toolErrors: string }> {
  const c = await getClient();

  const [providerID, modelID] = model.split("/", 2);

  const isNewSession = !existingSessionId;
  let sessionId = existingSessionId;
  if (!sessionId) {
    const session = await c.session.create({ query: { directory: PROJECT_DIR } });
    if (!session.data) {
      throw new Error("Failed to create opencode session");
    }
    sessionId = session.data.id;
  }

  const context = isNewSession ? await loadContext() : "";
  const promptText = context
    ? `<context about the user, read before acting -- use this instead of guessing or asking>\n${context}\n</context>\n\n${prompt}`
    : prompt;

  let done = false;
  const heartbeat = (async () => {
    let elapsedSec = 0;
    while (!done) {
      await new Promise((resolve) => setTimeout(resolve, 15_000));
      if (done) break;
      elapsedSec += 15;
      onEvent("status", `Still working (${elapsedSec}s elapsed)...`);
    }
  })();

  const fileParts: FilePartInput[] = attachments.map((url) => ({
    type: "file",
    url,
    mime: mimeFromUrl(url),
    filename: url.split("/").pop(),
  }));
  const textPart: TextPartInput = { type: "text", text: promptText };

  const turnStartedAt = Date.now();
  try {
    // A rate-limited or exhausted provider can hang indefinitely instead of erroring -- observed
    // directly (Copilot sat on "Still working" heartbeats past 270s with zero tool activity, never
    // throwing, so the model-fallback chain below never triggered). This bounds a single attempt so
    // a stuck call fails fast and the chain moves to the next model. The timed-out call isn't
    // cancelled server-side (the SDK exposes no abort), it's just no longer waited on here.
    const result = await Promise.race([
      c.session.prompt({
        path: { id: sessionId },
        query: { directory: PROJECT_DIR },
        body: {
          agent: "browser",
          model: { providerID, modelID },
          parts: [textPart, ...fileParts],
        },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`${providerID}/${modelID} timed out after ${MODEL_TIMEOUT_MS / 1000}s`)), MODEL_TIMEOUT_MS),
      ),
    ]);

    if (!result.data) {
      throw new Error("opencode returned no result for the prompt");
    }

    const info = result.data.info;
    if (info.error) {
      const detail = "data" in info.error && info.error.data && "message" in info.error.data ? String(info.error.data.message) : info.error.name;
      throw new Error(`${providerID}/${modelID}: ${detail}`);
    }

    // The prompt result only carries the final message's parts. Tool calls and per-step token
    // usage live on the earlier assistant messages of this turn, so read the whole turn back.
    const turn = await collectTurn(c, sessionId, turnStartedAt);
    const turnParts = turn?.parts ?? result.data.parts;
    emitBreakdown(turnParts, onEvent);

    return {
      output: textFromParts(result.data.parts),
      sessionId,
      model,
      usage: turn?.usage ?? {
        inputTokens: info.tokens.input + info.tokens.cache.read + info.tokens.cache.write,
        outputTokens: info.tokens.output + info.tokens.reasoning,
        cost: info.cost,
      },
      toolErrors: toolFailureText(turnParts),
    };
  } finally {
    done = true;
    await heartbeat;
  }
}
