import { createServer } from "node:http";
import type { Task, TaskResult } from "./task.js";
import { runTask } from "./agent.js";
import { startPolling } from "./poller.js";

const PORT = Number(process.env.PORT ?? 3333);

const server = createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/tasks") {
    res.writeHead(404).end();
    return;
  }

  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", async () => {
    let task: Task;
    try {
      task = JSON.parse(body);
    } catch {
      res.writeHead(400).end("invalid JSON");
      return;
    }

    if (typeof task.prompt !== "string" || task.prompt.length === 0) {
      res.writeHead(400).end("prompt is required");
      return;
    }

    try {
      const { output } = await runTask(task.prompt);
      const result: TaskResult = { output };
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500).end(err instanceof Error ? err.message : "unknown error");
    }
  });
});

server.listen(PORT, () => {
  console.log(`daemon listening on http://localhost:${PORT}`);
});

startPolling();
