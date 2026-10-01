import { readdir, readFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createOpencodeClient, createOpencodeServer, type OpencodeClient } from "@opencode-ai/sdk";
import { Agent } from "undici";
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
// A run is only cut off when it stops making progress: no browser tool call for STALL_MS. A long
// application that keeps working is never killed for being long; MAX_RUN_MS is a last-resort cap.
// (INTENT_AGENT_MODEL_TIMEOUT_MS is the old name for the stall limit, still honoured.)
const STALL_MS = Number(process.env.INTENT_AGENT_STALL_MS ?? process.env.INTENT_AGENT_MODEL_TIMEOUT_MS ?? 180_000);
const MAX_RUN_MS = Number(process.env.INTENT_AGENT_MAX_RUN_MS ?? 25 * 60_000);
// Written by the intent-browser tool on every call (packages/browser-mcp/src/index.ts).
const ACTIVITY_FILE = join(tmpdir(), "intent-browser", "activity.json");
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
let configOverride: Record<string, unknown> | undefined;

// Layers extra OpenCode config over opencode.jsonc (e.g. the benchmark swapping browser tools).
// Takes effect on the next task, since the embedded server is recreated.
export function setConfigOverride(config: Record<string, unknown> | undefined): void {
  configOverride = config;
  resetClient();
}

// session.prompt holds one HTTP request open for the whole turn. Node's fetch gives up waiting for
// response headers after 300s, so every run longer than five minutes failed with "fetch failed"
// (the SDK's own `req.timeout = false` only works under Bun). The OpenCode client gets a connection
// pool without header/body timeouts; stuck runs are the watchdog's job, not the transport's.
const noTimeout = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
const opencodeFetch = (req: Request) => fetch(req, { dispatcher: noTimeout } as RequestInit);

// A free port each time instead of OpenCode's fixed 4096: a leftover server (or one the user runs
// themselves) on 4096 made every start fail with ServeError.
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

async function getClient(): Promise<OpencodeClient> {
  if (!client) {
    const port = await freePort();
    const s = await createOpencodeServer({ port, ...(configOverride ? { config: configOverride } : {}) });
    server = s;
    client = createOpencodeClient({ baseUrl: s.url, fetch: opencodeFetch });
  }
  return client;
}

// Starts the embedded server and its MCP tool servers ahead of the first task, and returns their
// status -- so a benchmark times the task, not start-up, and can confirm which tools are live.
export async function warmUp(): Promise<unknown> {
  const c = await getClient();
  const status = await c.mcp.status({ query: { directory: PROJECT_DIR } });
  return status.data;
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

export type UsageDetail = {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  steps: number;
  toolCalls: number;
};

export type Usage = { inputTokens: number; outputTokens: number; cost: number; detail?: UsageDetail };

export type RunOptions = {
  // Overrides INTENT_AGENT_MODEL for this run.
  models?: string[];
  // Personal context is for acting as the user; QA runs test with persona data instead.
  includeContext?: boolean;
};

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
    const d: UsageDetail = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, steps: 0, toolCalls: 0 };
    let cost = 0;
    for (const m of turn) {
      if (m.info.role !== "assistant") continue;
      d.input += m.info.tokens.input;
      d.cacheRead += m.info.tokens.cache.read;
      d.cacheWrite += m.info.tokens.cache.write;
      d.output += m.info.tokens.output;
      d.reasoning += m.info.tokens.reasoning;
      d.steps += 1;
      d.toolCalls += m.parts.filter((p) => p.type === "tool").length;
      cost += m.info.cost;
    }
    const usage: Usage = {
      inputTokens: d.input + d.cacheRead + d.cacheWrite,
      outputTokens: d.output + d.reasoning,
      cost,
      detail: d,
    };
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
  options: RunOptions = {},
): Promise<RunResult> {
  const attempt: Attempt = { sessionId: existingSessionId };
  let recovered = false;
  let lastError: unknown;
  let interrupted = "";
  const chain = options.models?.length ? options.models : MODEL_CHAIN;
  const includeContext = options.includeContext ?? true;

  for (let i = 0; i < chain.length; i++) {
    const model = chain[i];
    for (;;) {
      // A retry or fallback continues in the same session, so the next model sees what was already
      // done. Starting over from the original prompt could repeat an irreversible step (submit the
      // application a second time) that the interrupted attempt had already taken.
      const text = interrupted && attempt.sessionId ? resumePrompt(interrupted, prompt) : prompt;
      if (interrupted && attempt.sessionId) await waitIdle(attempt.sessionId);
      try {
        const result = await runOnce(model, text, attempt, onEvent, interrupted ? [] : attachments, includeContext);
        if (!recovered && isRecoverableToolFailure(result.toolErrors)) {
          recovered = true;
          interrupted = "the browser tool connection was lost";
          onEvent("status", "Browser tool connection was lost. Restarting the agent server and retrying...");
          resetClient();
          continue;
        }
        return result;
      } catch (caught) {
        // "fetch failed" alone says nothing; the transport's cause (timeout, reset, refused) does.
        const cause = caught instanceof Error && caught.cause ? ` (${String((caught.cause as { code?: string }).code ?? caught.cause)})` : "";
        const err = caught instanceof Error && cause ? new Error(caught.message + cause, { cause: caught.cause }) : caught;
        lastError = err;
        const message = err instanceof Error ? err.message : String(err);
        interrupted = message;
        if (!recovered && isRecoverableToolFailure(message)) {
          recovered = true;
          onEvent("status", "Agent connection was lost. Restarting the agent server and retrying...");
          resetClient();
          continue;
        }
        if (i + 1 < chain.length) {
          onEvent("status", `Model ${model} failed (${message}). Falling back to ${chain[i + 1]}, continuing where it stopped.`);
        }
        break;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

type Attempt = { sessionId?: string };

function resumePrompt(reason: string, original: string): string {
  return (
    `The previous attempt at this task was interrupted (${reason.slice(0, 200)}). Continue the same task from where it stopped: ` +
    "call state first to see where the browser is now, do NOT redo anything irreversible that is already done " +
    "(a submitted form, a sent message, a confirmed booking), and finish the task.\n\n" +
    `The task, for reference:\n${original}`
  );
}

// An aborted session takes a moment to wind down; a prompt sent before it's idle comes back empty.
async function waitIdle(sessionId: string, maxMs = 15_000): Promise<void> {
  const c = await getClient();
  for (let waited = 0; waited < maxMs; waited += 500) {
    const res = await c.session.status({ query: { directory: PROJECT_DIR } }).catch(() => undefined);
    const s = res?.data?.[sessionId];
    if (!s || s.type === "idle") return;
    await new Promise((r) => setTimeout(r, 500));
  }
}

type Activity = { at: number; tool: string; summary: string };

async function lastActivity(): Promise<Activity | undefined> {
  try {
    return JSON.parse(await readFile(ACTIVITY_FILE, "utf8")) as Activity;
  } catch {
    return undefined;
  }
}

async function runOnce(
  model: string,
  prompt: string,
  attempt: Attempt,
  onEvent: OnEvent,
  attachments: string[],
  includeContext: boolean,
): Promise<RunResult & { toolErrors: string }> {
  const c = await getClient();

  const [providerID, modelID] = model.split("/", 2);

  const isNewSession = !attempt.sessionId;
  if (!attempt.sessionId) {
    const session = await c.session.create({ query: { directory: PROJECT_DIR } });
    if (!session.data) {
      throw new Error("Failed to create opencode session");
    }
    attempt.sessionId = session.data.id;
  }
  const sessionId = attempt.sessionId;

  const context = isNewSession && includeContext ? await loadContext() : "";
  const promptText = context
    ? `<context about the user, read before acting -- use this instead of guessing or asking>\n${context}\n</context>\n\n${prompt}`
    : prompt;

  const turnStartedAt = Date.now();
  // Watchdog + heartbeat. A rate-limited or exhausted provider can hang forever without erroring
  // (seen with Copilot: minutes of silence, no tool activity, never throwing), so a run that makes
  // no browser progress for STALL_MS is aborted -- for real, via session.abort, so it can't keep
  // clicking in the background while a fallback model takes over the same browser.
  let done = false;
  let stopWatch: (reason: string) => void = () => {};
  const stalled = new Promise<never>((_, reject) => {
    stopWatch = (reason) => reject(new Error(reason));
  });
  stalled.catch(() => {});
  const watchdog = (async () => {
    let lastBeat = Date.now();
    while (!done) {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      if (done) break;
      const now = Date.now();
      const act = await lastActivity();
      const lastProgress = Math.max(turnStartedAt, act && act.at >= turnStartedAt ? act.at : 0);
      const reason =
        now - lastProgress > STALL_MS
          ? `${model} made no progress for ${Math.round((now - lastProgress) / 1000)}s`
          : now - turnStartedAt > MAX_RUN_MS
            ? `${model} hit the ${Math.round(MAX_RUN_MS / 60_000)}-minute limit for one run`
            : "";
      if (reason) {
        // Reject first: the abort makes session.prompt resolve normally with an empty message, and
        // that must not win the race and look like a successful (empty) answer.
        stopWatch(reason);
        await c.session.abort({ path: { id: sessionId }, query: { directory: PROJECT_DIR } }).catch(() => {});
        break;
      }
      if (now - lastBeat >= 15_000) {
        lastBeat = now;
        const recent = act && act.at >= turnStartedAt ? ` -- last step: ${act.summary} (${Math.round((now - act.at) / 1000)}s ago)` : "";
        onEvent("status", `Still working (${Math.round((now - turnStartedAt) / 1000)}s)${recent}`);
      }
    }
  })();

  const fileParts: FilePartInput[] = attachments.map((url) => ({
    type: "file",
    url,
    mime: mimeFromUrl(url),
    filename: url.split("/").pop(),
  }));
  const textPart: TextPartInput = { type: "text", text: promptText };

  try {
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
      stalled,
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
    // No text and no tokens means the model never actually ran (aborted, or the provider dropped the
    // request). Reporting that as "completed" would hide a task that did nothing.
    const produced = (turn?.usage.inputTokens ?? 0) + info.tokens.input + info.tokens.output;
    if (!textFromParts(result.data.parts).trim() && produced === 0) {
      throw new Error(`${providerID}/${modelID} returned an empty response`);
    }

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
    // Not awaited: it notices `done` on its next tick, and waiting would add up to 5s to every run.
    done = true;
    void watchdog;
  }
}
