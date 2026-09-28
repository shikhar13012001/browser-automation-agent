export type Row = Record<string, string>;

// RFC 4180-style CSV: quoted fields, escaped quotes, commas and newlines inside quotes.
export function parseCsv(text: string): Row[] {
  const rows: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  const src = text.replace(/^﻿/, "");

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      record.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      record.push(field);
      field = "";
      rows.push(record);
      record = [];
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    rows.push(record);
  }

  return tableToRows(rows);
}

export function tableToRows(table: unknown[][]): Row[] {
  const nonEmpty = table.filter((r) => r.some((c) => String(c ?? "").trim() !== ""));
  if (nonEmpty.length < 2) return [];
  const headers = nonEmpty[0].map((h) => String(h ?? "").trim());
  return nonEmpty.slice(1).map((r) => {
    const row: Row = {};
    headers.forEach((h, idx) => {
      if (h) row[h] = String(r[idx] ?? "").trim();
    });
    return row;
  });
}

export function findMissingColumns(template: string, rows: Row[]): string[] {
  const needed = new Set([...template.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((m) => m[1]));
  const available = new Set(rows.flatMap((r) => Object.keys(r)));
  return [...needed].filter((n) => !available.has(n));
}

export function renderTemplate(template: string, row: Row): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, name: string) => row[name] ?? "");
}

export function normalizeKey(value: string | undefined): string | undefined {
  const v = (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return v === "" ? undefined : v;
}

export type PlannedTask = { prompt: string; dedupeKey?: string };

// Turns rows into tasks. A row is skipped when its key repeats earlier in the file or when the key is
// already in `existingKeys` (tasks created by earlier batches). Rows with an empty template value for
// a used column are skipped as invalid rather than sent to the agent half-filled.
export function planBatch(
  template: string,
  rows: Row[],
  keyColumn: string | undefined,
  existingKeys: Set<string>,
): { tasks: PlannedTask[]; duplicates: number; invalid: number } {
  const seen = new Set<string>();
  const tasks: PlannedTask[] = [];
  let duplicates = 0;
  let invalid = 0;
  const used = [...template.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((m) => m[1]);

  for (const row of rows) {
    if (used.some((name) => (row[name] ?? "") === "")) {
      invalid++;
      continue;
    }
    const key = keyColumn ? normalizeKey(row[keyColumn]) : undefined;
    if (key && (seen.has(key) || existingKeys.has(key))) {
      duplicates++;
      continue;
    }
    if (key) seen.add(key);
    tasks.push({ prompt: renderTemplate(template, row), dedupeKey: key });
  }
  return { tasks, duplicates, invalid };
}
