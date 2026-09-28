"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import type { RunEvent, StoredTask, TaskStatus } from "@/lib/store";

export const STATUS_VARIANT: Record<TaskStatus, "default" | "secondary" | "destructive" | "outline"> = {
  queued: "outline",
  running: "default",
  completed: "secondary",
  failed: "destructive",
  needs_attention: "destructive",
  awaiting_approval: "default",
};

const STATUS_LABEL: Record<TaskStatus, string> = {
  queued: "queued",
  running: "running",
  completed: "completed",
  failed: "failed",
  needs_attention: "needs attention",
  awaiting_approval: "awaiting approval",
};

const KIND_COLOR: Record<RunEvent["kind"], string> = {
  status: "text-muted-foreground",
  plan: "text-foreground",
  action: "text-blue-400",
  verification: "text-purple-400",
  finding: "text-yellow-400",
  attention: "text-orange-400",
  error: "text-destructive",
  result: "text-green-400",
};

const SEVERITY_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  critical: "destructive",
  major: "destructive",
  minor: "secondary",
  suggestion: "outline",
};

type Finding = {
  severity?: string;
  category?: string;
  title?: string;
  url?: string;
  steps?: string[];
  expected?: string;
  actual?: string;
};

type FindingsReport = { summary?: string; findings: Finding[] };

function asFindingsReport(value: unknown): FindingsReport | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as { summary?: unknown; findings?: unknown };
  if (!Array.isArray(v.findings)) return undefined;
  return { summary: typeof v.summary === "string" ? v.summary : undefined, findings: v.findings as Finding[] };
}

// Once the JSON result is parsed and shown as structured data, drop the raw JSON from the prose.
function proseWithoutJson(output: string): string {
  const withoutFences = output.replace(/```(?:json)?[sS]*?```/gi, "").trim();
  return withoutFences.startsWith("{") ? "" : withoutFences;
}

function formatUsage(task: StoredTask): string | undefined {
  if (!task.model) return undefined;
  const tokens = (task.inputTokens ?? 0) + (task.outputTokens ?? 0);
  const cost = task.cost !== undefined ? ` · $${task.cost.toFixed(4)}` : "";
  return `${task.model} · ${tokens.toLocaleString()} tokens${cost}`;
}

function FindingsView({ report }: { report: FindingsReport }) {
  const counts = report.findings.reduce<Record<string, number>>((acc, f) => {
    const key = f.severity ?? "unrated";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium">
          {report.findings.length} finding{report.findings.length === 1 ? "" : "s"}
        </p>
        {Object.entries(counts).map(([sev, n]) => (
          <Badge key={sev} variant={SEVERITY_VARIANT[sev] ?? "outline"}>
            {n} {sev}
          </Badge>
        ))}
      </div>
      {report.summary && <p className="text-sm text-muted-foreground">{report.summary}</p>}
      {report.findings.map((f, i) => (
        <div key={i} className="space-y-1.5 rounded-md border border-border p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={SEVERITY_VARIANT[f.severity ?? ""] ?? "outline"}>{f.severity ?? "unrated"}</Badge>
            {f.category && <span className="text-xs uppercase text-muted-foreground">{f.category}</span>}
            <span className="font-medium">{f.title ?? "Untitled finding"}</span>
          </div>
          {f.url && <p className="truncate text-xs text-muted-foreground">{f.url}</p>}
          {f.steps && f.steps.length > 0 && (
            <ol className="list-decimal space-y-0.5 pl-5 text-foreground/90">
              {f.steps.map((s, j) => (
                <li key={j}>{s}</li>
              ))}
            </ol>
          )}
          {f.expected && (
            <p>
              <span className="text-muted-foreground">Expected: </span>
              {f.expected}
            </p>
          )}
          {f.actual && (
            <p>
              <span className="text-muted-foreground">Actual: </span>
              {f.actual}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

export function RunView({
  task,
  events,
  onContinue,
}: {
  task: StoredTask;
  events: RunEvent[];
  onContinue: (prompt: string, opts?: { requireApproval?: boolean }) => void;
}) {
  const [continuePrompt, setContinuePrompt] = useState("Continue from where you left off.");
  const isFinished = ["completed", "failed", "needs_attention", "awaiting_approval"].includes(task.status);
  const usage = formatUsage(task);
  const report = asFindingsReport(task.resultJson);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{task.prompt}</p>
          {task.sessionId && <p className="truncate text-xs text-muted-foreground">session {task.sessionId}</p>}
          {usage && <p className="truncate text-xs text-muted-foreground">{usage}</p>}
        </div>
        <Badge variant={STATUS_VARIANT[task.status]}>{STATUS_LABEL[task.status]}</Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        {task.attachments && task.attachments.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {task.attachments.map((url) => (
              <Badge key={url} variant="outline" className="text-xs">
                {url.split("/").pop()}
              </Badge>
            ))}
          </div>
        )}

        {events.length > 0 && (
          <ScrollArea className="h-48 rounded-md border border-border p-3">
            <div className="space-y-2">
              {events.map((e) => (
                <div key={e.id} className="text-sm">
                  <span className={`mr-2 text-xs uppercase ${KIND_COLOR[e.kind]}`}>{e.kind}</span>
                  <span className="whitespace-pre-wrap text-foreground/90">{e.message}</span>
                </div>
              ))}
            </div>
          </ScrollArea>
        )}

        {(task.status === "needs_attention" || task.status === "awaiting_approval") && task.attentionScreenshotUrl && (
          <div className="space-y-2">
            <p className="text-sm font-medium text-orange-400">
              {task.status === "awaiting_approval" ? "Waiting for your approval" : "Needs your attention"}
            </p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={task.attentionScreenshotUrl}
              alt="Screenshot of the page at the point the agent stopped"
              className="max-w-full rounded-md border border-border"
            />
          </div>
        )}

        {report ? (
          <FindingsView report={report} />
        ) : (
          task.resultJson !== undefined && (
            <pre className="overflow-x-auto rounded-md border border-border bg-muted/30 p-3 text-xs">
              {JSON.stringify(task.resultJson, null, 2)}
            </pre>
          )
        )}

        {(() => {
          const text = task.resultJson !== undefined && task.output ? proseWithoutJson(task.output) : task.output;
          return text ? <p className="whitespace-pre-wrap text-sm">{text}</p> : null;
        })()}

        {task.status === "awaiting_approval" && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => onContinue("Approved. Go ahead and complete the final step now.", { requireApproval: false })}>
              Approve and continue
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => onContinue("Do not submit. Cancel and leave the page as it is.", { requireApproval: false })}
            >
              Reject
            </Button>
          </div>
        )}

        {task.status === "needs_attention" && (
          <Button
            size="sm"
            onClick={() => onContinue("I have resolved the blocker in the browser. Continue from where you stopped.")}
          >
            I fixed it, resume
          </Button>
        )}

        {isFinished && (
          <>
            <Separator />
            <div className="space-y-2">
              <Textarea
                value={continuePrompt}
                onChange={(e) => setContinuePrompt(e.target.value)}
                rows={2}
                className="resize-none text-sm"
              />
              <Button size="sm" variant="outline" onClick={() => onContinue(continuePrompt)}>
                Continue this task
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
