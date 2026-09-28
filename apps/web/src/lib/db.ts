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
      // run_events predates its seq column in older databases; add it (existing rows get values) so
      // event pagination works without a manual migration.
      await sql`ALTER TABLE run_events ADD COLUMN IF NOT EXISTS seq BIGSERIAL`;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS run_events_seq_idx ON run_events(seq)`;
      await sql`ALTER TABLE run_events ADD COLUMN IF NOT EXISTS id UUID NOT NULL DEFAULT gen_random_uuid()`;
      await sql`ALTER TABLE run_events ALTER COLUMN id SET DEFAULT gen_random_uuid()`;
      await sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS model TEXT`;
      await sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS input_tokens INTEGER`;
      await sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS output_tokens INTEGER`;
      await sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS cost DOUBLE PRECISION`;
      await sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS result_json JSONB`;
      await sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS output_schema TEXT`;
      await sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS mode TEXT`;
      await sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS require_approval BOOLEAN`;
      await sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS batch_id UUID`;
      await sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS dedupe_key TEXT`;
      await sql`
        CREATE TABLE IF NOT EXISTS templates (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT NOT NULL UNIQUE,
          prompt TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS batches (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT NOT NULL,
          prompt_template TEXT NOT NULL,
          key_column TEXT,
          total INTEGER NOT NULL,
          skipped INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS tasks_batch_id_idx ON tasks(batch_id)`;
      await sql`CREATE INDEX IF NOT EXISTS tasks_dedupe_key_idx ON tasks(dedupe_key)`;
      await sql`CREATE INDEX IF NOT EXISTS run_events_task_id_idx ON run_events(task_id)`;
      await sql`CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks(status)`;
    })();
  }
  return schemaReady;
}
