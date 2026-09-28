"use client";

import { Badge } from "@/components/ui/badge";
import { STATUS_VARIANT } from "@/components/run-view";
import type { StoredTask } from "@/lib/store";

export function TaskHistory({
  tasks,
  selectedId,
  onSelect,
}: {
  tasks: StoredTask[];
  selectedId: string | undefined;
  onSelect: (task: StoredTask) => void;
}) {
  if (tasks.length === 0) return null;

  return (
    <div className="space-y-1">
      <h2 className="text-sm font-medium text-muted-foreground">Recent tasks</h2>
      <div className="divide-y divide-border rounded-lg border border-border">
        {tasks.map((t) => (
          <button
            key={t.id}
            onClick={() => onSelect(t)}
            className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-accent ${
              t.id === selectedId ? "bg-accent" : ""
            }`}
          >
            <span className="truncate">{t.prompt}</span>
            <Badge variant={STATUS_VARIANT[t.status]} className="shrink-0 text-xs">
              {t.status}
            </Badge>
          </button>
        ))}
      </div>
    </div>
  );
}
