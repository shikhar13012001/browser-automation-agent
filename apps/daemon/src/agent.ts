import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createOpencode, type OpencodeClient } from "@opencode-ai/sdk";
import type { Part, TextPartInput, FilePartInput } from "@opencode-ai/sdk";

const PROJECT_DIR = process.env.INTENT_AGENT_PROJECT_DIR ?? process.cwd();
const MODEL = process.env.INTENT_AGENT_MODEL ?? "github-copilot/claude-sonnet-5";
const CONTEXT_DIR = process.env.INTENT_AGENT_CONTEXT_DIR ?? join(PROJECT_DIR, "context");

let cachedContext: string | undefined;

async function loadContext(): Promise<string> {
  if (cachedContext !== undefined) return cachedContext;
  try {
    const entries = await readdir(CONTEXT_DIR);
    const files = entries.filter((f) => f.toLowerCase() !== "readme.md" && f.endsWith(".md")).sort();
    const sections = await Promise.all(
      files.map(async (f) => `## ${f}\n\n${await readFile(join(CONTEXT_DIR, f), "utf-8")}`),
    );
    cachedContext = sections.join("\n\n");
  } catch {
    cachedContext = "";
  }
  return cachedContext;
}

let client: OpencodeClient | undefined;

async function getClient(): Promise<OpencodeClient> {
  if (!client) {
    const opencode = await createOpencode();
    client = opencode.client;
  }
  return client;
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

export type RunResult = {
  output: string;
  sessionId: string;
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

export async function runTask(
  prompt: string,
  existingSessionId?: string,
  onEvent: OnEvent = () => {},
  attachments: string[] = [],
): Promise<RunResult> {
  const c = await getClient();

  const [providerID, modelID] = MODEL.split("/", 2);

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

  try {
    const result = await c.session.prompt({
      path: { id: sessionId },
      query: { directory: PROJECT_DIR },
      body: {
        agent: "browser",
        model: { providerID, modelID },
        parts: [textPart, ...fileParts],
      },
    });

    if (!result.data) {
      throw new Error("opencode returned no result for the prompt");
    }

    emitBreakdown(result.data.parts, onEvent);

    return { output: textFromParts(result.data.parts), sessionId };
  } finally {
    done = true;
    await heartbeat;
  }
}
