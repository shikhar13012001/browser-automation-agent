"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { Template, TaskMode } from "@/lib/store";

export type UploadedAttachment = { url: string; filename: string };

export type RunOptions = {
  attachments: string[];
  mode: TaskMode;
  requireApproval: boolean;
  outputSchema?: string;
};

const selectClass =
  "h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";

export function PromptBox({
  onSubmit,
  disabled,
}: {
  onSubmit: (prompt: string, options: RunOptions) => void;
  disabled?: boolean;
}) {
  const [prompt, setPrompt] = useState("Test ScheduRx as a doctor.");
  const [attachments, setAttachments] = useState<UploadedAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [mode, setMode] = useState<TaskMode>("standard");
  const [requireApproval, setRequireApproval] = useState(false);
  const [outputSchema, setOutputSchema] = useState("");
  const [showSchema, setShowSchema] = useState(false);
  const fileInputId = useId();

  const loadTemplates = useCallback(() => {
    fetch("/api/templates")
      .then((r) => (r.ok ? r.json() : []))
      .then(setTemplates)
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadTemplates();
  }, [loadTemplates]);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.append("file", file);
        const res = await fetch("/api/uploads", { method: "POST", body: form });
        if (!res.ok) {
          setError(`Failed to upload ${file.name} (${res.status})`);
          continue;
        }
        const data: { url: string; filename: string } = await res.json();
        setAttachments((prev) => [...prev, { url: data.url, filename: data.filename }]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  function removeAttachment(url: string) {
    setAttachments((prev) => prev.filter((a) => a.url !== url));
  }

  function pickTemplate(id: string) {
    setTemplateId(id);
    const t = templates.find((x) => x.id === id);
    if (t) setPrompt(t.prompt);
  }

  async function saveTemplate() {
    const name = window.prompt("Template name");
    if (!name?.trim() || !prompt.trim()) return;
    const res = await fetch("/api/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim(), prompt }),
    });
    if (!res.ok) {
      setError("Could not save the template");
      return;
    }
    const saved: Template = await res.json();
    loadTemplates();
    setTemplateId(saved.id);
  }

  async function deleteTemplate() {
    if (!templateId) return;
    await fetch(`/api/templates/${templateId}`, { method: "DELETE" });
    setTemplateId("");
    loadTemplates();
  }

  function submit() {
    if (!prompt.trim()) return;
    onSubmit(prompt, {
      attachments: attachments.map((a) => a.url),
      mode,
      requireApproval,
      outputSchema: outputSchema.trim() || undefined,
    });
    setAttachments([]);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Task template"
          className={cn(selectClass, "min-w-40 flex-1")}
          value={templateId}
          onChange={(e) => pickTemplate(e.target.value)}
        >
          <option value="">Templates{templates.length ? "" : " (none saved)"}</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <Button type="button" size="sm" variant="outline" onClick={saveTemplate} disabled={!prompt.trim()}>
          Save as template
        </Button>
        {templateId && (
          <Button type="button" size="sm" variant="ghost" onClick={deleteTemplate}>
            Delete template
          </Button>
        )}
      </div>

      <Textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={4}
        placeholder="What should I do?"
        className="resize-none text-base"
      />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <label className="flex items-center gap-2">
          <span className="text-muted-foreground">Mode</span>
          <select className={selectClass} value={mode} onChange={(e) => setMode(e.target.value as TaskMode)}>
            <option value="standard">Standard</option>
            <option value="qa">QA: report UX issues and bugs</option>
          </select>
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={requireApproval} onChange={(e) => setRequireApproval(e.target.checked)} />
          <span>Ask before the final submit</span>
        </label>
        <button
          type="button"
          className="text-muted-foreground underline-offset-2 hover:underline"
          onClick={() => setShowSchema((v) => !v)}
        >
          {showSchema ? "Hide" : "Return structured JSON"}
        </button>
      </div>

      {showSchema && (
        <Textarea
          value={outputSchema}
          onChange={(e) => setOutputSchema(e.target.value)}
          rows={3}
          placeholder='Describe the JSON to return, e.g. {"title": "string", "price": "number"}'
          className="resize-none font-mono text-xs"
        />
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {attachments.map((a) => (
            <Badge key={a.url} variant="secondary" className="gap-1.5 pr-1">
              {a.filename}
              <button
                type="button"
                onClick={() => removeAttachment(a.url)}
                className="ml-1 rounded-full px-1 text-muted-foreground hover:text-foreground"
                aria-label={`Remove ${a.filename}`}
              >
                ×
              </button>
            </Badge>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        {/* A label associated with the input is the most reliable cross-browser way to open a
            file picker -- proxying a click via a ref onto a separate Button component (Base UI
            primitive here, not a plain <button>) doesn't reliably trigger it in practice. */}
        <label
          htmlFor={fileInputId}
          className={cn(
            buttonVariants({ variant: "outline", size: "sm" }),
            "cursor-pointer",
            (uploading || disabled) && "pointer-events-none opacity-50",
          )}
        >
          {uploading ? "Uploading..." : "Attach files"}
        </label>
        <input
          id={fileInputId}
          type="file"
          multiple
          className="hidden"
          disabled={uploading || disabled}
          onChange={(e) => handleFiles(e.target.files)}
        />
        <Button type="button" onClick={submit} disabled={disabled || uploading || !prompt.trim()}>
          {disabled ? "Running..." : "Run"}
        </Button>
      </div>
    </div>
  );
}

