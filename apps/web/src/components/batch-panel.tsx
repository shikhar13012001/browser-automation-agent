"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { Batch } from "@/lib/store";

type BatchResult = { created: number; duplicates: number; invalid: number };

export function BatchPanel() {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [promptTemplate, setPromptTemplate] = useState(
    "Find the careers page for {{company}} and list any open roles that match my profile.",
  );
  const [keyColumn, setKeyColumn] = useState("");
  const [requireApproval, setRequireApproval] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BatchResult | null>(null);
  const [batches, setBatches] = useState<Batch[]>([]);
  const fileInputId = useId();

  const loadBatches = useCallback(() => {
    fetch("/api/batches")
      .then((r) => (r.ok ? r.json() : []))
      .then(setBatches)
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadBatches();
    const t = setInterval(loadBatches, 5000);
    return () => clearInterval(t);
  }, [loadBatches]);

  async function run() {
    if (!file) return;
    setBusy(true);
    setError(null);
    setResult(null);
    const form = new FormData();
    form.append("file", file);
    form.append("promptTemplate", promptTemplate);
    form.append("keyColumn", keyColumn);
    form.append("requireApproval", String(requireApproval));
    try {
      const res = await fetch("/api/batches", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) {
        const cols = Array.isArray(data.columns) ? ` Columns in file: ${data.columns.join(", ")}.` : "";
        setError(`${data.error ?? "Batch failed"}${cols}`);
        return;
      }
      setResult(data);
      setFile(null);
      loadBatches();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Batch failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <button
        type="button"
        className="text-sm font-medium text-muted-foreground hover:text-foreground"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "Hide batch runs" : "Batch runs from a spreadsheet"}
      </button>

      {open && (
        <div className="space-y-3 rounded-lg border border-border p-4">
          <p className="text-sm text-muted-foreground">
            Upload a .csv or .xlsx with a header row. One task is queued per row, and{" "}
            <code className="rounded bg-muted px-1">{"{{column}}"}</code> in the instruction is filled from that row.
            Tasks run one after another.
          </p>
          <Textarea
            value={promptTemplate}
            onChange={(e) => setPromptTemplate(e.target.value)}
            rows={3}
            className="resize-none text-sm"
          />
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <label className="flex items-center gap-2">
              <span className="text-muted-foreground">Skip repeats by column</span>
              <input
                value={keyColumn}
                onChange={(e) => setKeyColumn(e.target.value)}
                placeholder="e.g. company"
                className="h-8 w-36 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring dark:bg-input/30"
              />
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={requireApproval} onChange={(e) => setRequireApproval(e.target.checked)} />
              <span>Ask before any final submit</span>
            </label>
          </div>
          <div className="flex items-center justify-between gap-2">
            <label
              htmlFor={fileInputId}
              className={cn(buttonVariants({ variant: "outline", size: "sm" }), "cursor-pointer", busy && "pointer-events-none opacity-50")}
            >
              {file ? file.name : "Choose .csv or .xlsx"}
            </label>
            <input
              id={fileInputId}
              type="file"
              accept=".csv,.xlsx"
              className="hidden"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            <Button type="button" onClick={run} disabled={!file || busy || !promptTemplate.trim()}>
              {busy ? "Queuing..." : "Queue batch"}
            </Button>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          {result && (
            <p className="text-sm">
              Queued {result.created} task{result.created === 1 ? "" : "s"}
              {result.duplicates > 0 && `, skipped ${result.duplicates} repeat${result.duplicates === 1 ? "" : "s"}`}
              {result.invalid > 0 && `, skipped ${result.invalid} row${result.invalid === 1 ? "" : "s"} with empty values`}.
            </p>
          )}
        </div>
      )}

      {batches.length > 0 && (
        <div className="divide-y divide-border rounded-lg border border-border">
          {batches.slice(0, 5).map((b) => {
            const done = (b.counts.completed ?? 0) + (b.counts.failed ?? 0) + (b.counts.needs_attention ?? 0) + (b.counts.awaiting_approval ?? 0);
            return (
              <div key={b.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                <span className="min-w-0 truncate">{b.name}</span>
                <span className="flex flex-wrap items-center gap-1.5">
                  <Badge variant="outline">
                    {done}/{b.total} done
                  </Badge>
                  {(b.counts.awaiting_approval ?? 0) > 0 && <Badge>{b.counts.awaiting_approval} awaiting approval</Badge>}
                  {(b.counts.needs_attention ?? 0) > 0 && <Badge variant="destructive">{b.counts.needs_attention} need attention</Badge>}
                  {(b.counts.failed ?? 0) > 0 && <Badge variant="destructive">{b.counts.failed} failed</Badge>}
                  {b.skipped > 0 && <Badge variant="secondary">{b.skipped} skipped</Badge>}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
