import { getSql, ensureSchema } from "./db";

export type TaskStatus = "queued" | "running" | "completed" | "failed" | "needs_attention";

export type StoredTask = {
  id: string;
  prompt: string;
  status: TaskStatus;
  output?: string;
  createdAt: string;
  deviceId?: string;
  sessionId?: string;
  continuesTaskId?: string;
  attachments?: string[];
  attentionScreenshotUrl?: string;
};

export type Device = {
  id: string;
  lastSeenAt: string;
};

export type RunEventKind = "status" | "plan" | "action" | "verification" | "finding" | "attention" | "error" | "result";

export type RunEvent = {
  id: string;
  taskId: string;
  ts: string;
  kind: RunEventKind;
  message: string;
};

type Row = Record<string, unknown>;

function rowToTask(row: Row): StoredTask {
  return {
    id: row.id as string,
    prompt: row.prompt as string,
    status: row.status as TaskStatus,
    output: (row.output as string | null) ?? undefined,
    createdAt: new Date(row.created_at as string).toISOString(),
    deviceId: (row.device_id as string | null) ?? undefined,
    sessionId: (row.session_id as string | null) ?? undefined,
    continuesTaskId: (row.continues_task_id as string | null) ?? undefined,
    attachments: (row.attachments as string[] | null) ?? undefined,
    attentionScreenshotUrl: (row.attention_screenshot_url as string | null) ?? undefined,
  };
}

function rowToDevice(row: Row): Device {
  return { id: row.id as string, lastSeenAt: new Date(row.last_seen_at as string).toISOString() };
}

function rowToEvent(row: Row): RunEvent {
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    ts: new Date(row.ts as string).toISOString(),
    kind: row.kind as RunEventKind,
    message: row.message as string,
  };
}

export async function createTask(prompt: string, continuesTaskId?: string, attachments?: string[]): Promise<StoredTask> {
  await ensureSchema();
  const sql = getSql();

  let parentSessionId: string | undefined;
  if (continuesTaskId) {
    const parent = await getTask(continuesTaskId);
    parentSessionId = parent?.sessionId;
  }

  const rows = (await sql`
    INSERT INTO tasks (id, prompt, status, session_id, continues_task_id, attachments)
    VALUES (gen_random_uuid(), ${prompt}, 'queued', ${parentSessionId ?? null}, ${continuesTaskId ?? null}, ${attachments ?? null})
    RETURNING *
  `) as Row[];
  return rowToTask(rows[0]);
}

export async function getTask(id: string): Promise<StoredTask | undefined> {
  await ensureSchema();
  const sql = getSql();
  const rows = (await sql`SELECT * FROM tasks WHERE id = ${id}`) as Row[];
  return rows[0] ? rowToTask(rows[0]) : undefined;
}

export async function listTasks(): Promise<StoredTask[]> {
  await ensureSchema();
  const sql = getSql();
  const rows = (await sql`SELECT * FROM tasks ORDER BY created_at DESC`) as Row[];
  return rows.map(rowToTask);
}

export async function updateTask(id: string, patch: Partial<StoredTask>): Promise<StoredTask | undefined> {
  await ensureSchema();
  const sql = getSql();
  const existing = await getTask(id);
  if (!existing) return undefined;

  const merged = { ...existing, ...patch };
  const rows = (await sql`
    UPDATE tasks SET
      status = ${merged.status},
      output = ${merged.output ?? null},
      session_id = ${merged.sessionId ?? null},
      attention_screenshot_url = ${merged.attentionScreenshotUrl ?? null}
    WHERE id = ${id}
    RETURNING *
  `) as Row[];
  return rowToTask(rows[0]);
}

export async function claimNextTask(deviceId: string): Promise<StoredTask | undefined> {
  await ensureSchema();
  const sql = getSql();
  // Atomic claim: the subquery's FOR UPDATE SKIP LOCKED runs inside the same single
  // statement's implicit transaction, so two concurrent claims can't grab the same row.
  const rows = (await sql`
    UPDATE tasks SET status = 'running', device_id = ${deviceId}
    WHERE id = (
      SELECT id FROM tasks WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `) as Row[];
  return rows[0] ? rowToTask(rows[0]) : undefined;
}

export async function touchDevice(id: string): Promise<Device> {
  await ensureSchema();
  const sql = getSql();
  const rows = (await sql`
    INSERT INTO devices (id, last_seen_at) VALUES (${id}, now())
    ON CONFLICT (id) DO UPDATE SET last_seen_at = now()
    RETURNING *
  `) as Row[];
  return rowToDevice(rows[0]);
}

export async function listDevices(): Promise<Device[]> {
  await ensureSchema();
  const sql = getSql();
  const rows = (await sql`SELECT * FROM devices`) as Row[];
  return rows.map(rowToDevice);
}

export async function addEvent(taskId: string, kind: RunEventKind, message: string): Promise<RunEvent> {
  await ensureSchema();
  const sql = getSql();
  const rows = (await sql`
    INSERT INTO run_events (task_id, kind, message)
    VALUES (${taskId}, ${kind}, ${message})
    RETURNING *
  `) as Row[];
  return rowToEvent(rows[0]);
}

export async function listEvents(taskId: string, sinceId?: string): Promise<RunEvent[]> {
  await ensureSchema();
  const sql = getSql();
  const rows = (sinceId
    ? await sql`
        SELECT * FROM run_events
        WHERE task_id = ${taskId}
          AND seq > COALESCE((SELECT seq FROM run_events WHERE id = ${sinceId} AND task_id = ${taskId}), 0)
        ORDER BY seq ASC
      `
    : await sql`SELECT * FROM run_events WHERE task_id = ${taskId} ORDER BY seq ASC`) as Row[];
  return rows.map(rowToEvent);
}
