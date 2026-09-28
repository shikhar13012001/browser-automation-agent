"use client";

import { useId, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type UploadedAttachment = { url: string; filename: string };

export function PromptBox({
  onSubmit,
  disabled,
}: {
  onSubmit: (prompt: string, attachments: string[]) => void;
  disabled?: boolean;
}) {
  const [prompt, setPrompt] = useState("Test ScheduRx as a doctor.");
  const [attachments, setAttachments] = useState<UploadedAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputId = useId();

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

  function submit() {
    if (!prompt.trim()) return;
    onSubmit(
      prompt,
      attachments.map((a) => a.url),
    );
    setAttachments([]);
  }

  return (
    <div className="space-y-3">
      <Textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={4}
        placeholder="What should I do?"
        className="resize-none text-base"
      />

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
