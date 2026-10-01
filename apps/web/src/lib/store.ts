import { getSql, ensureSchema } from "./db";

export type TaskStatus = "queued" | "running" | "completed" | "failed" | "needs_attention" | "awaiting_approval";
export type TaskMode = "standard" | "qa";

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
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
  resultJson?: unknown;
  outputSchema?: string;
  mode?: TaskMode;
  requireApproval?: boolean;
  batchId?: string;
  dedupeKey?: string;
};

export type NewTaskOptions = {
  continuesTaskId?: string;
  attachments?: string[];
  mode?: TaskMode;
  outputSchema?: string;
  requireApproval?: boolean;
  batchId?: string;
  dedupeKey?: string;
};

export type Template = { id: string; name: string; prompt: string; createdAt: string };

export type Batch = {
  id: string;
  name: string;
  promptTemplate: string;
  keyColumn?: string;
  total: number;
  skipped: number;
  createdAt: string;
  counts: Partial<Record<TaskStatus, number>>;
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
    model: (row.model as string | null) ?? undefined,
    inputTokens: (row.input_tokens as number | null) ?? undefined,
    outputTokens: (row.output_tokens as number | null) ?? undefined,
    cost: (row.cost as number | null) ?? undefined,
    resultJson: (row.result_json as unknown) ?? undefined,
    outputSchema: (row.output_schema as string | null) ?? undefined,
    mode: (row.mode as TaskMode | null) ?? undefined,
    requireApproval: (row.require_approval as boolean | null) ?? undefined,
    batchId: (row.batch_id as string | null) ?? undefined,
    dedupeKey: (row.dedupe_key as string | null) ?? undefined,
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

export async function createTask(prompt: string, options: NewTaskOptions = {}): Promise<StoredTask> {
  await ensureSchema();
  const sql = getSql();
  const { continuesTaskId, attachments, mode, outputSchema, requireApproval, batchId, dedupeKey } = options;

  let parentSessionId: string | undefined;
  if (continuesTaskId) {
    const parent = await getTask(continuesTaskId);
    parentSessionId = parent?.sessionId;
  }

  const rows = (await sql`
    INSERT INTO tasks (id, prompt, status, session_id, continues_task_id, attachments, mode, output_schema, require_approval, batch_id, dedupe_key)
    VALUES (
      gen_random_uuid(), ${prompt}, 'queued', ${parentSessionId ?? null}, ${continuesTaskId ?? null}, ${attachments ?? null},
      ${mode ?? null}, ${outputSchema ?? null}, ${requireApproval ?? null}, ${batchId ?? null}, ${dedupeKey ?? null}
    )
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
      attention_screenshot_url = ${merged.attentionScreenshotUrl ?? null},
      model = ${merged.model ?? null},
      input_tokens = ${merged.inputTokens ?? null},
      output_tokens = ${merged.outputTokens ?? null},
      cost = ${merged.cost ?? null},
      result_json = ${merged.resultJson === undefined ? null : JSON.stringify(merged.resultJson)}::jsonb
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

function rowToTemplate(row: Row): Template {
  return {
    id: row.id as string,
    name: row.name as string,
    prompt: row.prompt as string,
    createdAt: new Date(row.created_at as string).toISOString(),
  };
}

export async function listTemplates(): Promise<Template[]> {
  await ensureSchema();
  const sql = getSql();
  const rows = (await sql`SELECT * FROM templates ORDER BY name ASC`) as Row[];
  return rows.map(rowToTemplate);
}

export async function saveTemplate(name: string, prompt: string): Promise<Template> {
  await ensureSchema();
  const sql = getSql();
  const rows = (await sql`
    INSERT INTO templates (name, prompt) VALUES (${name}, ${prompt})
    ON CONFLICT (name) DO UPDATE SET prompt = EXCLUDED.prompt
    RETURNING *
  `) as Row[];
  return rowToTemplate(rows[0]);
}

export async function deleteTemplate(id: string): Promise<boolean> {
  await ensureSchema();
  const sql = getSql();
  const rows = (await sql`DELETE FROM templates WHERE id = ${id} RETURNING id`) as Row[];
  return rows.length > 0;
}

// Keys of tasks that were queued or ran for a key before, so re-uploading the same list does not
// redo companies. Failed tasks are excluded on purpose: a failed row may be retried.
export async function listDedupeKeys(): Promise<Set<string>> {
  await ensureSchema();
  const sql = getSql();
  const rows = (await sql`SELECT DISTINCT dedupe_key FROM tasks WHERE dedupe_key IS NOT NULL AND status <> 'failed'`) as Row[];
  return new Set(rows.map((r) => r.dedupe_key as string));
}

export async function createBatch(input: {
  name: string;
  promptTemplate: string;
  keyColumn?: string;
  total: number;
  skipped: number;
}): Promise<string> {
  await ensureSchema();
  const sql = getSql();
  const rows = (await sql`
    INSERT INTO batches (name, prompt_template, key_column, total, skipped)
    VALUES (${input.name}, ${input.promptTemplate}, ${input.keyColumn ?? null}, ${input.total}, ${input.skipped})
    RETURNING id
  `) as Row[];
  return rows[0].id as string;
}

export async function listBatchTasks(batchId: string): Promise<StoredTask[]> {
  await ensureSchema();
  const sql = getSql();
  const rows = (await sql`SELECT * FROM tasks WHERE batch_id = ${batchId} ORDER BY created_at ASC`) as Row[];
  return rows.map(rowToTask);
}

export async function listBatches(): Promise<Batch[]> {
  await ensureSchema();
  const sql = getSql();
  const batches = (await sql`SELECT * FROM batches ORDER BY created_at DESC LIMIT 20`) as Row[];
  const counts = (await sql`
    SELECT batch_id, status, COUNT(*)::int AS n FROM tasks WHERE batch_id IS NOT NULL GROUP BY batch_id, status
  `) as Row[];
  return batches.map((b) => {
    const perStatus: Partial<Record<TaskStatus, number>> = {};
    for (const c of counts) {
      if (c.batch_id === b.id) perStatus[c.status as TaskStatus] = c.n as number;
    }
    return {
      id: b.id as string,
      name: b.name as string,
      promptTemplate: b.prompt_template as string,
      keyColumn: (b.key_column as string | null) ?? undefined,
      total: b.total as number,
      skipped: b.skipped as number,
      createdAt: new Date(b.created_at as string).toISOString(),
      counts: perStatus,
    };
  });
}
