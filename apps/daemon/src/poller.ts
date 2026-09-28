import { readFile } from "node:fs/promises";
import { runTask, type RunEventKind, type Usage } from "./agent.js";
import { buildPrompt, extractApproval, extractAttention, extractJson, type TaskMode } from "./markers.js";
import { findLatestScreenshot, sendAttentionEmail } from "./notify.js";

const CLOUD_API_URL = process.env.CLOUD_API_URL ?? "http://localhost:3000";
const DEVICE_ID = process.env.DEVICE_ID ?? "laptop-1";
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 3000);
const DASHBOARD_SECRET = process.env.DASHBOARD_SECRET;

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return { ...extra, ...(DASHBOARD_SECRET ? { Authorization: `Bearer ${DASHBOARD_SECRET}` } : {}) };
}

type CloudTask = {
  id: string;
  prompt: string;
  sessionId?: string;
  attachments?: string[];
  mode?: TaskMode;
  outputSchema?: string;
  requireApproval?: boolean;
};
type TaskStatus = "completed" | "failed" | "needs_attention" | "awaiting_approval";

type ReportExtras = {
  attentionScreenshotUrl?: string;
  model?: string;
  usage?: Usage;
  resultJson?: unknown;
};

async function reportResult(
  id: string,
  status: TaskStatus,
  output: string,
  sessionId?: string,
  extras: ReportExtras = {},
  attempts = 3,
): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(`${CLOUD_API_URL}/api/tasks/${id}`, {
        method: "PATCH",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ status, output, sessionId, ...extras }),
      });
      if (!res.ok) throw new Error(`report failed with status ${res.status}`);
      return;
    } catch (err) {
      if (attempt === attempts) throw err;
      // A connection that's been idle for the whole task duration can be dead in the
      // client's keep-alive pool; retrying opens a fresh one instead of reusing it.
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
}

// Events are posted one at a time, in order: concurrent posts can land out of order and scramble the trail.
let eventQueue: Promise<void> = Promise.resolve();

function postEvent(taskId: string, kind: RunEventKind, message: string): void {
  eventQueue = eventQueue.then(() =>
    fetch(`${CLOUD_API_URL}/api/tasks/${taskId}/events`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ kind, message }),
    })
      .then((res) => {
        if (!res.ok) console.error(`[poller] event post for ${taskId} rejected with status ${res.status}`);
      })
      .catch((err) => console.error(`[poller] failed to post event for ${taskId}`, err)),
  );
}

// The model is instructed to end its response with a line starting "NEEDS_ATTENTION:" when it's
// genuinely stuck (see opencode.jsonc's browser agent prompt). Detection is done in markers.ts, not
// left to the model to "remember to call a tool" -- deterministic and daemon-owned.

async function uploadScreenshot(taskId: string, taskStartedAt: number): Promise<string | undefined> {
  const path = await findLatestScreenshot(taskStartedAt);
  if (!path) return undefined;
  try {
    const bytes = await readFile(path);
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: "image/png" }), `attention-${taskId}.png`);
    const res = await fetch(`${CLOUD_API_URL}/api/uploads`, { method: "POST", headers: authHeaders(), body: form });
    if (!res.ok) return undefined;
    const data: { url: string } = await res.json();
    return data.url;
  } catch (err) {
    console.error(`[poller] failed to upload attention screenshot for ${taskId}`, err);
    return undefined;
  }
}

async function pollOnce(): Promise<void> {
  const res = await fetch(`${CLOUD_API_URL}/api/tasks/next?device=${DEVICE_ID}`, { headers: authHeaders() });
  if (res.status === 204) return;
  if (!res.ok) {
    console.error(`poll failed: ${res.status}`);
    return;
  }

  const task = (await res.json()) as CloudTask;
  console.log(
    `[poller] running task ${task.id}${task.sessionId ? ` (continuing session ${task.sessionId})` : ""}: ${task.prompt}`,
  );

  const taskStartedAt = Date.now();
  let output: string;
  let sessionId: string | undefined;
  let model: string;
  let usage: Usage;
  try {
    const result = await runTask(
      buildPrompt(task.prompt, {
        mode: task.mode,
        outputSchema: task.outputSchema,
        requireApproval: task.requireApproval,
      }),
      task.sessionId,
      (kind, message) => postEvent(task.id, kind, message),
      task.attachments ?? [],
    );
    output = result.output;
    sessionId = result.sessionId;
    model = result.model;
    usage = result.usage;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[poller] task ${task.id} failed: ${message}`);
    await reportResult(task.id, "failed", message, task.sessionId).catch((reportErr) =>
      console.error(`[poller] also failed to report failure for ${task.id}`, reportErr),
    );
    return;
  }

  const attentionDescription = extractAttention(output);
  const approvalDescription = attentionDescription ? undefined : extractApproval(output);
  const wantsJson = task.mode === "qa" || Boolean(task.outputSchema?.trim());
  const resultJson = wantsJson ? extractJson(output) : undefined;
  const base: ReportExtras = { model, usage, ...(resultJson !== undefined ? { resultJson } : {}) };

  try {
    if (approvalDescription) {
      const screenshotUrl = await uploadScreenshot(task.id, taskStartedAt);
      await reportResult(task.id, "awaiting_approval", output, sessionId, { ...base, attentionScreenshotUrl: screenshotUrl });
      console.log(`[poller] task ${task.id} awaiting approval: ${approvalDescription}`);
    } else if (attentionDescription) {
      const screenshotUrl = await uploadScreenshot(task.id, taskStartedAt);
      await reportResult(task.id, "needs_attention", output, sessionId, { ...base, attentionScreenshotUrl: screenshotUrl });
      console.log(`[poller] task ${task.id} needs attention: ${attentionDescription}`);
      await sendAttentionEmail({
        taskId: task.id,
        prompt: task.prompt,
        description: attentionDescription,
        dashboardUrl: `${CLOUD_API_URL}/`,
        taskStartedAt,
      });
    } else {
      await reportResult(task.id, "completed", output, sessionId, base);
      console.log(`[poller] task ${task.id} completed`);
    }
  } catch (err) {
    // The task genuinely finished (one way or another) -- don't overwrite that with a false
    // "failed" status. Leave it as "running"; the real result is recoverable from the opencode session.
    console.error(`[poller] task ${task.id} finished but could not report the result`, err);
  }
}

// A device runs one task at a time, so any task still marked running for this device at startup was
// interrupted by a crash or restart. Fail it instead of leaving it running forever.
async function failOrphanedTasks(): Promise<void> {
  try {
    const res = await fetch(`${CLOUD_API_URL}/api/tasks`, { headers: authHeaders() });
    if (!res.ok) return;
    const tasks = (await res.json()) as { id: string; status: string; deviceId?: string; sessionId?: string }[];
    for (const t of tasks.filter((x) => x.status === "running" && x.deviceId === DEVICE_ID)) {
      await reportResult(t.id, "failed", "Interrupted: the daemon restarted while this task was running. Re-run or continue it.", t.sessionId);
      console.log(`[poller] marked orphaned task ${t.id} as failed`);
    }
  } catch (err) {
    console.error("[poller] could not check for orphaned tasks", err);
  }
}

export function startPolling(): void {
  console.log(`[poller] polling ${CLOUD_API_URL} as device "${DEVICE_ID}" every ${POLL_INTERVAL_MS}ms`);
  void failOrphanedTasks();
  // Self-scheduling, not setInterval: a task can run far longer than POLL_INTERVAL_MS, and
  // setInterval would fire a new overlapping pollOnce() every tick regardless, hammering the
  // cloud API with concurrent requests for the entire duration of every long-running task.
  const tick = () => {
    pollOnce()
      .catch((err) => console.error("[poller] error", err))
      .finally(() => setTimeout(tick, POLL_INTERVAL_MS));
  };
  tick();
}
