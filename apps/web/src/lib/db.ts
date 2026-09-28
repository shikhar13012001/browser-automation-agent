import { neon } from "@neondatabase/serverless";

// Lazy init: calling neon() at module load time would throw during `next build`
// if DATABASE_URL isn't set yet (e.g. before Marketplace provisioning finishes).
let _sql: ReturnType<typeof neon> | undefined;

export function getSql() {
  if (!_sql) {
    _sql = neon(process.env.DATABASE_URL!);
  }
  return _sql;
}

let schemaReady: Promise<void> | undefined;

export function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    const sql = getSql();
    schemaReady = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS tasks (
          id UUID PRIMARY KEY,
          prompt TEXT NOT NULL,
          status TEXT NOT NULL,
          output TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          device_id TEXT,
          session_id TEXT,
          continues_task_id UUID,
          attachments TEXT[],
          attention_screenshot_url TEXT
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS devices (
          id TEXT PRIMARY KEY,
          last_seen_at TIMESTAMPTZ NOT NULL
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS run_events (
          seq BIGSERIAL PRIMARY KEY,
          id UUID NOT NULL DEFAULT gen_random_uuid(),
          task_id UUID NOT NULL,
          ts TIMESTAMPTZ NOT NULL DEFAULT now(),
          kind TEXT NOT NULL,
          message TEXT NOT NULL
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS run_events_task_id_idx ON run_events(task_id)`;
      await sql`CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks(status)`;
    })();
  }
  return schemaReady;
}
