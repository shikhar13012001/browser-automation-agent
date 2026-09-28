import { NextRequest, NextResponse } from "next/server";
import { readSheet } from "read-excel-file/node";
import { findMissingColumns, parseCsv, planBatch, tableToRows, type Row } from "@/lib/batch";
import { createBatch, createTask, listBatches, listDedupeKeys, type TaskMode } from "@/lib/store";

const MAX_ROWS = 500;

async function rowsFromFile(file: File): Promise<Row[]> {
  const name = file.name.toLowerCase();
  const bytes = Buffer.from(await file.arrayBuffer());
  if (name.endsWith(".xlsx")) {
    const table = (await readSheet(bytes)) as unknown[][];
    return tableToRows(table);
  }
  if (name.endsWith(".csv") || file.type === "text/csv") {
    return parseCsv(bytes.toString("utf-8"));
  }
  throw new Error("Upload a .csv or .xlsx file");
}

export async function GET() {
  return NextResponse.json(await listBatches());
}

export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  const promptTemplate = String(form?.get("promptTemplate") ?? "");
  const keyColumn = String(form?.get("keyColumn") ?? "").trim() || undefined;
  const name = String(form?.get("name") ?? "").trim();
  const modeValue = String(form?.get("mode") ?? "");
  const mode: TaskMode | undefined = modeValue === "qa" ? "qa" : undefined;
  const requireApproval = form?.get("requireApproval") === "true" ? true : undefined;

  if (!(file instanceof File) || !promptTemplate.trim()) {
    return NextResponse.json({ error: "file and promptTemplate are required" }, { status: 400 });
  }

  let rows: Row[];
  try {
    rows = await rowsFromFile(file);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not read file" }, { status: 400 });
  }
  if (rows.length === 0) return NextResponse.json({ error: "The file has no data rows" }, { status: 400 });
  if (rows.length > MAX_ROWS) return NextResponse.json({ error: `Too many rows (max ${MAX_ROWS})` }, { status: 400 });

  const missing = findMissingColumns(promptTemplate, rows);
  if (missing.length > 0) {
    return NextResponse.json({ error: `Template uses columns not in the file: ${missing.join(", ")}`, columns: Object.keys(rows[0]) }, { status: 400 });
  }
  if (keyColumn && !(keyColumn in rows[0])) {
    return NextResponse.json({ error: `Key column "${keyColumn}" is not in the file`, columns: Object.keys(rows[0]) }, { status: 400 });
  }

  const plan = planBatch(promptTemplate, rows, keyColumn, keyColumn ? await listDedupeKeys() : new Set());
  if (plan.tasks.length === 0) {
    return NextResponse.json({ error: "Nothing to run", duplicates: plan.duplicates, invalid: plan.invalid }, { status: 400 });
  }

  const batchId = await createBatch({
    name: name || file.name,
    promptTemplate,
    keyColumn,
    total: plan.tasks.length,
    skipped: plan.duplicates + plan.invalid,
  });
  for (const t of plan.tasks) {
    await createTask(t.prompt, { batchId, dedupeKey: t.dedupeKey, mode, requireApproval });
  }
  return NextResponse.json({ batchId, created: plan.tasks.length, duplicates: plan.duplicates, invalid: plan.invalid }, { status: 201 });
}
