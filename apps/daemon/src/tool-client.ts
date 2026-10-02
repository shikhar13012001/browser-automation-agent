import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TOOL_ENTRY = join(REPO_ROOT, "packages", "browser-mcp", "src", "index.ts");
// One act call can legitimately run for minutes (60 actions, waits, slow pages); the MCP SDK's
// default request timeout is 60s.
const CALL_TIMEOUT_MS = 5 * 60_000;

export type ToolSpec = { name: string; description: string; parameters: Record<string, unknown> };

// The intent-browser MCP server as a child process, one per worker. Each worker's server owns its
// own tab (INTENT_BROWSER_WORKER), so several agents can drive the same Chrome at once. Started with
// `node --import tsx` rather than `npx tsx`: 3s instead of 6s, and it stays up between tasks.
export class BrowserTool {
  private client: Client | undefined;
  private starting: Promise<Client> | undefined;
  private specs: ToolSpec[] = [];

  constructor(readonly worker: string) {}

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    this.starting ??= (async () => {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
      if (this.worker) env.INTENT_BROWSER_WORKER = this.worker;
      const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", TOOL_ENTRY], cwd: REPO_ROOT, env, stderr: "ignore" });
      const c = new Client({ name: "intent-agent-daemon", version: "1.0.0" });
      transport.onclose = () => {
        if (this.client === c) this.client = undefined;
      };
      await c.connect(transport);
      const listed = await c.listTools();
      this.specs = listed.tools.map((t) => ({ name: t.name, description: t.description ?? "", parameters: t.inputSchema as Record<string, unknown> }));
      this.client = c;
      return c;
    })().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  async tools(): Promise<ToolSpec[]> {
    await this.connect();
    return this.specs;
  }

  // Returns the tool's text. If the tool process died, the next call starts a new one -- but a call
  // that failed mid-flight is never repeated here: it may already have clicked something, so the
  // model is told to look at the page first.
  async call(name: string, args: Record<string, unknown>): Promise<string> {
    const c = await this.connect().catch(() => this.connect());
    try {
      const r = await c.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS });
      const parts = (r.content ?? []) as { type: string; text?: string }[];
      return parts.map((p) => p.text ?? "").join("\n") || "(no output)";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/not connected|connection closed|timed out/i.test(msg)) {
        this.close();
        return `Error: the browser tool stopped responding (${msg}) and was restarted. It may or may not have done this action -- call state to see where the page is before repeating anything.`;
      }
      return `Error: ${msg}`;
    }
  }

  close(): void {
    const c = this.client;
    this.client = undefined;
    void c?.close().catch(() => {});
  }
}

const tools = new Map<string, BrowserTool>();

export function browserTool(worker = ""): BrowserTool {
  let t = tools.get(worker);
  if (!t) {
    t = new BrowserTool(worker);
    tools.set(worker, t);
  }
  return t;
}

export function closeBrowserTools(): void {
  for (const t of tools.values()) t.close();
  tools.clear();
}
