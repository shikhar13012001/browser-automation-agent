import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { act, VERBS } from "./actions.js";
import { closeTab, getPage, listTabs, openUrl, readState, saveScreenshot, switchTab, takeNotes } from "./browser.js";
import { look } from "./vision.js";
import { diffState } from "./format.js";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { workerFile } from "./paths.js";
import { dirname } from "node:path";

// One browser, one agent: tool calls are serialised so parallel calls from the model can't
// interleave clicks and reads on the same tab.
let queue: Promise<unknown> = Promise.resolve();
let lastBatch = "";
let repeats = 0;
// Per-call durations (INTENT_BROWSER_TIMINGS=1) so benchmarks can split a run into browser time and
// model time.
const TIMINGS = process.env.INTENT_BROWSER_TIMINGS === "1" ? workerFile("timings.jsonl") : "";

function serial<T>(work: () => Promise<T>): Promise<T> {
  const fn = async () => {
    const t0 = Date.now();
    let out = "";
    try {
      const r = await work();
      out = (r as { content?: { text?: string }[] })?.content?.[0]?.text ?? "";
      return r;
    } finally {
      if (TIMINGS) {
        const line = { at: t0, ms: Date.now() - t0, call: lastSummary, result: out.split("\n").slice(0, 12).join(" | ").slice(0, 600) };
        void appendFile(TIMINGS, JSON.stringify(line) + "\n").catch(() => {});
      }
    }
  };
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

// The daemon can't see inside a running model turn, so every tool call leaves a timestamp and a
// one-line summary here. The daemon uses it to tell a slow-but-working run from a stuck one, and to
// show what the agent is doing right now.
const ACTIVITY_FILE = workerFile("activity.json");
let lastSummary = "";
function recordActivity(tool: string, summary: string): void {
  lastSummary = `${tool}: ${summary}`;
  void mkdir(dirname(ACTIVITY_FILE), { recursive: true })
    .then(() => writeFile(ACTIVITY_FILE, JSON.stringify({ at: Date.now(), tool, summary: summary.slice(0, 200) })))
    .catch(() => {});
}

function summarize(actions: Record<string, unknown>[]): string {
  return actions.map((a) => `${a.do}${a.id !== undefined ? ` [${a.id}]` : ""}${a.value !== undefined && a.do !== "fill" ? ` ${String(a.value).slice(0, 30)}` : ""}`).join(", ");
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

// The last full state the model was shown. With INTENT_BROWSER_DIFF=1, an act on the same page
// returns only the difference. It is off by default: measured on the zoo task it saved no time
// (cached input is nearly free) and cost accuracy -- 4 of 6 runs perfect with diffs against 6 of 6
// without, because the full state after each act is what the model checks its work against. It is
// kept for pages too large to resend.
let seen: string | undefined;
const DIFF = process.env.INTENT_BROWSER_DIFF === "1";

async function withState(prefix: string, opts: { all?: boolean; text?: boolean; diff?: boolean } = {}) {
  const state = await readState(opts);
  const notes = takeNotes();
  const shown = opts.diff && DIFF ? diffState(seen, state) : state;
  // Variants with extra content (all links, page text) aren't a baseline for later diffs.
  seen = opts.all || opts.text ? undefined : state;
  return text([prefix, ...notes.map((n) => `note: ${n}`), shown].filter(Boolean).join("\n\n"));
}

function fail(err: unknown) {
  return { isError: true, ...text(`Error: ${err instanceof Error ? err.message : String(err)}`) };
}

const server = new McpServer({ name: "intent-browser", version: "1.0.0" });

server.registerTool(
  "open",
  {
    description: "Go to a URL in the agent's tab (reused across tasks) and return the page state.",
    inputSchema: { url: z.string().describe("Absolute URL") },
  },
  ({ url }) =>
    serial(async () => {
      recordActivity("open", `Opening ${url}`);
      try {
        await openUrl(url);
        await saveScreenshot(await getPage());
        return await withState("");
      } catch (e) {
        return fail(e);
      }
    }),
);

server.registerTool(
  "state",
  {
    description:
      "Current page as a compact list of interactive elements: [id] kind \"label\" = value, * = required, [x]/( ) = checked, INVALID = failed validation. text=true adds the page's readable text (only when you need content, e.g. a job description). all=true also lists header/nav/footer links.",
    inputSchema: {
      text: z.boolean().optional(),
      all: z.boolean().optional(),
    },
  },
  ({ text: withText, all }) =>
    serial(async () => {
      recordActivity("state", "Reading the page");
      try {
        return await withState("", { text: withText, all });
      } catch (e) {
        return fail(e);
      }
    }),
);

const actionSchema = z.object({
  do: z.enum(VERBS),
  id: z.number().int().optional().describe("element id from the latest state"),
  label: z
    .string()
    .optional()
    .describe("instead of id: the element's label, for elements that only appear after an earlier action in this batch (a tab's fields, the next form page)"),
  value: z
    .string()
    .optional()
    .describe("fill: text | select: option wording | upload: file path | press: key | open: URL | wait_for: text | scroll: down/up | wait: ms"),
});

server.registerTool(
  "act",
  {
    description:
      "Run actions in order, then return the new page state. Batch a whole page in ONE call: every fill/select/check/upload, then the Next/Continue/Save click last. Each action: {do, id?, label?, value?}. For an element that only appears after an earlier click in the same batch (fields in a tab or accordion you open, the fields of the next form page), use label instead of id, e.g. [{do:'click', id:10}, {do:'fill', label:'Billing email', value:'x'}]; clicks by label need the exact label. do = click | click_text (value = visible text, when an element is missing from the state) | click_at (value = 'x,y' from look) | fill | select (native or custom dropdown; picks the closest option) | check | uncheck | upload (value = file path) | press (value = key, id optional) | scroll | wait_for (value = text) | wait (value = ms) | open (value = URL) | back. Use ids from the latest state. After a failed click, or once the page changes, the remaining id-based actions are skipped (label-based ones still run).",
    inputSchema: { actions: z.array(actionSchema).min(1).max(60) },
  },
  ({ actions }) =>
    serial(async () => {
      recordActivity("act", `${actions.length} action${actions.length === 1 ? "" : "s"}: ${summarize(actions as Record<string, unknown>[])}`);
      try {
        // A confused model can resend the same failing batch forever; the third identical one is
        // refused so it has to change approach (or stop with NEEDS_ATTENTION) instead of looping.
        const key = JSON.stringify(actions);
        repeats = key === lastBatch ? repeats + 1 : 1;
        lastBatch = key;
        if (repeats >= 3) {
          return fail(
            "You have sent this exact batch 3 times and it did not work. Do not send it again: read the latest state, use only ids listed there, change your approach, or stop with NEEDS_ATTENTION explaining what is blocking you.",
          );
        }
        const report = await act(actions as Record<string, unknown>[]);
        return await withState(report, { diff: true });
      } catch (e) {
        return fail(e);
      }
    }),
);

server.registerTool(
  "tabs",
  {
    description: "List open tabs; optionally switch to or close one (1-based).",
    inputSchema: { switch: z.number().int().optional(), close: z.number().int().optional() },
  },
  ({ switch: sw, close }) =>
    serial(async () => {
      try {
        if (close !== undefined) await closeTab(close - 1);
        if (sw !== undefined) {
          await switchTab(sw - 1);
          return await withState(`switched to tab ${sw}`);
        }
        const { pages, index } = await listTabs();
        return text(pages.map((p, i) => `${i === index ? "*" : " "} ${i + 1}. ${p.url()}`).join("\n"));
      } catch (e) {
        return fail(e);
      }
    }),
);

server.registerTool(
  "look",
  {
    description:
      "Look at the screen and answer a question about it, when the state can't tell you (a control missing from the list, a canvas or image, a calendar grid, what's visually selected). Ask a specific question; for 'where is X' it returns x,y points you can use with {do:'click_at', value:'x,y'}.",
    inputSchema: { question: z.string().describe("What you need to know, e.g. 'Where is the language dropdown and what does it show?'") },
  },
  ({ question }) =>
    serial(async () => {
      recordActivity("look", `Looking at the screen: ${question}`);
      try {
        const r = await look(question);
        const pts = r.points.map((p) => `${p.label || "point"} at ${p.x},${p.y}`).join("; ");
        return text(`${r.answer}${pts ? `\nPOINTS: ${pts}` : ""}`);
      } catch (e) {
        return fail(e);
      }
    }),
);

await server.connect(new StdioServerTransport());
// When the OpenCode server that spawned us dies, stdin closes. Exit instead of lingering: on Windows
// an orphan keeps inherited handles (it held OpenCode's port 4096, so the next server failed to start).
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));
