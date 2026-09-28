"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import type { RunEvent, StoredTask, TaskStatus } from "@/lib/store";

const STATUS_VARIANT: Record<TaskStatus, "default" | "secondary" | "destructive" | "outline"> = {
  queued: "outline",
  running: "default",
  completed: "secondary",
  failed: "destructive",
  needs_attention: "destructive",
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

export function RunView({
  task,
  events,
  onContinue,
}: {
  task: StoredTask;
  events: RunEvent[];
  onContinue: (prompt: string) => void;
}) {
  const [continuePrompt, setContinuePrompt] = useState("Continue from where you left off.");
  const isFinished = ["completed", "failed", "needs_attention"].includes(task.status);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{task.prompt}</p>
          {task.sessionId && (
            <p className="truncate text-xs text-muted-foreground">session {task.sessionId}</p>
          )}
        </div>
        <Badge variant={STATUS_VARIANT[task.status]}>{task.status}</Badge>
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

        {task.status === "needs_attention" && task.attentionScreenshotUrl && (
          <div className="space-y-2">
            <p className="text-sm font-medium text-orange-400">Needs your attention</p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={task.attentionScreenshotUrl}
              alt="Screenshot of the point where the agent got stuck"
              className="max-w-full rounded-md border border-border"
            />
          </div>
        )}

        {task.output && <p className="whitespace-pre-wrap text-sm">{task.output}</p>}

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
