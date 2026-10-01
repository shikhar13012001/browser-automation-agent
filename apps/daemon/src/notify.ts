import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import nodemailer from "nodemailer";

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT ?? 587);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL ?? SMTP_USER;

let transporter: ReturnType<typeof nodemailer.createTransport> | undefined;

function getTransporter() {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return undefined;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
  }
  return transporter;
}

// chrome-devtools-mcp writes each screenshot to its own %TEMP%\chrome-devtools-mcp-<id>\screenshot.png.
// There's no API to ask "what did the last task screenshot" directly, so we find the most
// recently modified one across all such directories. Stale directories accumulate across a long
// daemon uptime (one per chrome-devtools-mcp process spawn), so `notBeforeMs` -- the timestamp the
// current task started -- is required: without it this can silently return a screenshot from a
// completely unrelated, much earlier task.
export async function findLatestScreenshot(notBeforeMs: number): Promise<string | undefined> {
  const root = tmpdir();
  // intent-browser (the default browser tool) saves the viewport after every action to one fixed file.
  const own = join(root, "intent-browser", "latest.jpg");
  try {
    if ((await stat(own)).mtimeMs >= notBeforeMs) return own;
  } catch {
    // not using intent-browser, fall back to chrome-devtools-mcp's per-process files
  }
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return undefined;
  }

  let latest: { path: string; mtimeMs: number } | undefined;
  for (const entry of entries) {
    if (!entry.startsWith("chrome-devtools-mcp-")) continue;
    const screenshotPath = join(root, entry, "screenshot.png");
    try {
      const info = await stat(screenshotPath);
      if (info.mtimeMs < notBeforeMs) continue;
      if (!latest || info.mtimeMs > latest.mtimeMs) {
        latest = { path: screenshotPath, mtimeMs: info.mtimeMs };
      }
    } catch {
      // no screenshot in this dir, skip
    }
  }
  return latest?.path;
}

export async function sendAttentionEmail(params: {
  taskId: string;
  prompt: string;
  description: string;
  dashboardUrl?: string;
  taskStartedAt: number;
  // "Needs attention" (blocked, waiting for you) or "Failed" (gave up); shown in the subject.
  kind?: string;
}): Promise<void> {
  const t = getTransporter();
  if (!t) {
    console.log(
      `[notify] SMTP not configured (set SMTP_HOST/SMTP_USER/SMTP_PASS) -- skipping email for task ${params.taskId}: ${params.description}`,
    );
    return;
  }
  if (!NOTIFY_EMAIL) {
    console.log(`[notify] no NOTIFY_EMAIL/SMTP_USER destination configured -- skipping email`);
    return;
  }

  const screenshotPath = await findLatestScreenshot(params.taskStartedAt);
  const lines = [
    `Task: ${params.prompt}`,
    "",
    params.description,
    "",
    params.dashboardUrl ? `View: ${params.dashboardUrl}` : undefined,
  ].filter(Boolean);

  try {
    await t.sendMail({
      from: SMTP_USER,
      to: NOTIFY_EMAIL,
      subject: `[Agent] ${params.kind ?? "Needs attention"}: ${params.prompt.slice(0, 60)}`,
      text: lines.join("\n"),
      attachments: screenshotPath ? [{ filename: screenshotPath.endsWith(".jpg") ? "screenshot.jpg" : "screenshot.png", path: screenshotPath }] : [],
    });
    console.log(`[notify] sent attention email for task ${params.taskId}`);
  } catch (err) {
    console.error(`[notify] failed to send attention email for task ${params.taskId}`, err);
  }
}
