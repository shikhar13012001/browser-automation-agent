"use client";

import { useEffect, useRef, useState } from "react";
import { DeviceStatus } from "@/components/device-status";
import { BatchPanel } from "@/components/batch-panel";
import { PromptBox, type RunOptions } from "@/components/prompt-box";
import { TaskHistory } from "@/components/task-history";
import { RunView } from "@/components/run-view";
import type { Device, RunEvent, StoredTask } from "@/lib/store";

export default function Home() {
  const [tasks, setTasks] = useState<StoredTask[]>([]);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const lastEventIdRef = useRef<string | undefined>(undefined);

  const selectedTask = tasks.find((t) => t.id === selectedId);
  const isRunning = selectedTask && ["queued", "running"].includes(selectedTask.status);

  // devices + task list, always polling
  useEffect(() => {
    const t = setInterval(() => {
      setNow(Date.now());
      fetch("/api/devices").then((r) => r.json()).then(setDevices).catch(() => {});
      fetch("/api/tasks").then((r) => r.json()).then(setTasks).catch(() => {});
    }, 3000);
    fetch("/api/devices").then((r) => r.json()).then(setDevices).catch(() => {});
    fetch("/api/tasks").then((r) => r.json()).then(setTasks).catch(() => {});
    return () => clearInterval(t);
  }, []);

  // selected task's own status + events, fast-polled only while it's live
  useEffect(() => {
    if (!selectedId) return;
    lastEventIdRef.current = undefined;

    const poll = async () => {
      setEvents((prev) => (lastEventIdRef.current === undefined ? [] : prev));
      const r = await fetch(`/api/tasks/${selectedId}`);
      const updated: StoredTask = await r.json();
      setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));

      const url = lastEventIdRef.current
        ? `/api/tasks/${selectedId}/events?since=${lastEventIdRef.current}`
        : `/api/tasks/${selectedId}/events`;
      const er = await fetch(url);
      const newEvents: RunEvent[] = await er.json();
      if (newEvents.length > 0) {
        lastEventIdRef.current = newEvents[newEvents.length - 1].id;
        setEvents((prev) => [...prev, ...newEvents]);
      }
    };

    poll();
    const interval = setInterval(poll, 1500);
    return () => clearInterval(interval);
  }, [selectedId]);

  async function submit(prompt: string, options: Partial<RunOptions> = {}, continueFrom?: string) {
    const res = await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, ...options, continueFrom }),
    });
    const created: StoredTask = await res.json();
    setTasks((prev) => [created, ...prev]);
    setSelectedId(created.id);
  }

  return (
    <main className="mx-auto max-w-2xl space-y-8 px-4 py-10 sm:py-16">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Intent Agent</h1>
        <DeviceStatus devices={devices} now={now} />
      </div>

      <PromptBox onSubmit={(prompt, options) => submit(prompt, options)} disabled={!!isRunning} />

      <BatchPanel />

      {selectedTask && (
        <RunView task={selectedTask} events={events} onContinue={(p, opts) => submit(p, { attachments: [], ...opts }, selectedTask.id)} />
      )}

      <TaskHistory tasks={tasks} selectedId={selectedId} onSelect={(t) => setSelectedId(t.id)} />
    </main>
  );
}
