import type { Attempt, OnEvent, RunResult, UsageDetail } from "./agent.js";
import { agentPrompt, maxSteps, reasoningEffort } from "./config.js";
import { browserTool } from "./tool-client.js";

// The direct engine: the daemon runs the model loop itself against the OpenAI Responses API and
// calls the browser tool directly. Compared with going through OpenCode it removes ~1.5s of
// overhead per step and a multi-second server start, reports each step as it happens (OpenCode
// only exposes a turn after it finishes), and can be aborted or run several at once.
// The conversation lives server-side: each request sends only the new tool results and chains to
// the previous response by id, which is also what a follow-up task continues from.

const API = "https://api.openai.com/v1/responses";
const STEP_TIMEOUT_MS = Number(process.env.INTENT_AGENT_STEP_TIMEOUT_MS ?? 120_000);
const MAX_RUN_MS = Number(process.env.INTENT_AGENT_MAX_RUN_MS ?? 25 * 60_000);

// USD per 1M tokens: [fresh input, cached input, output]. INTENT_AGENT_PRICES adds or overrides
// entries as JSON, e.g. {"my-model":[0.2,0.02,0.8]}. Unknown models are reported with cost 0.
const PRICES: Record<string, [number, number, number]> = {
  "gpt-6-luna": [0.1, 0.01, 0.5],
  "gpt-4o-mini": [0.15, 0.075, 0.6],
  "gpt-4.1-mini": [0.4, 0.1, 1.6],
  "gpt-4.1-nano": [0.1, 0.025, 0.4],
  "gpt-5-mini": [0.25, 0.025, 2],
  ...(JSON.parse(process.env.INTENT_AGENT_PRICES ?? "{}") as Record<string, [number, number, number]>),
};
const warnedPrice = new Set<string>();

type FunctionCall = { type: "function_call"; call_id: string; name: string; arguments: string };
type OutputItem = FunctionCall | { type: "message"; content?: { type: string; text?: string }[] } | { type: string };
type ApiResponse = {
  id: string;
  output: OutputItem[];
  usage?: { input_tokens: number; output_tokens: number; input_tokens_details?: { cached_tokens?: number }; output_tokens_details?: { reasoning_tokens?: number } };
  error?: { message?: string } | null;
};

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function callModel(body: Record<string, unknown>): Promise<ApiResponse> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set");
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(API, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
      });
    } catch (err) {
      // Network blips and step timeouts: a model request has no side effects, so retrying is safe.
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      throw new Error(`${body.model}: request failed (${err instanceof Error ? err.message : String(err)})`);
    }
    if (res.ok) return (await res.json()) as ApiResponse;
    const text = await res.text();
    let message = text.slice(0, 300);
    try {
      message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message;
    } catch {
      // not JSON; keep the raw text
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 3 && !/quota|billing/i.test(message)) {
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
      continue;
    }
    throw new ApiError(`${body.model}: ${message}`, res.status);
  }
}

function describeCall(name: string, args: Record<string, unknown>): string {
  if (name === "open") return `Opening ${args.url}`;
  if (name === "state") return "Reading the page";
  if (name === "look") return `Looking at the screen: ${String(args.question ?? "").slice(0, 120)}`;
  if (name === "act" && Array.isArray(args.actions)) {
    const parts = (args.actions as Record<string, unknown>[]).map((a) => {
      const target = a.label ? ` "${a.label}"` : a.id !== undefined ? ` [${a.id}]` : "";
      const value = a.value !== undefined && a.do !== "fill" ? ` ${String(a.value).slice(0, 30)}` : "";
      return `${a.do}${target}${value}`;
    });
    const shown = parts.slice(0, 8).join(", ");
    return `${parts.length} action${parts.length === 1 ? "" : "s"}: ${shown}${parts.length > 8 ? `, +${parts.length - 8} more` : ""}`;
  }
  return `Ran ${name}`;
}

const IMAGE = /\.(png|jpe?g|gif|webp)(\?|$)/i;

export async function runDirect(
  model: string,
  promptText: string,
  attempt: Attempt,
  onEvent: OnEvent,
  attachments: string[],
  worker: string,
): Promise<RunResult & { toolErrors: string }> {
  const [providerID, modelID] = model.split("/", 2);
  const tool = browserTool(worker);
  const specs = await tool.tools();
  const effort = reasoningEffort(providerID, modelID);
  // The model has no clock: without this, "tomorrow" and "next month" are computed from whenever its
  // training data ends (it booked July for "next month" in October). Day granularity keeps the
  // instructions identical all day, so they stay cached.
  const now = new Date();
  const today = `${now.toLocaleDateString("en-US", { weekday: "long" })}, ${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const base: Record<string, unknown> = {
    model: modelID,
    instructions: `${agentPrompt()}\n\nToday is ${today} (time zone ${zone}).`,
    tools: specs.map((s) => ({ type: "function", name: s.name, description: s.description, parameters: s.parameters, strict: false })),
    parallel_tool_calls: false,
    store: true,
    ...(effort ? { reasoning: { effort } } : {}),
  };

  const d: UsageDetail = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, steps: 0, toolCalls: 0 };
  const files = attachments.map((url) => (IMAGE.test(url) ? { type: "input_image", image_url: url } : { type: "input_file", file_url: url }));
  // Calls from an interrupted attempt that never got an answer must be answered before the
  // conversation can continue.
  let input: Record<string, unknown>[] = [
    ...(attempt.pending ?? []).map((call_id) => ({ type: "function_call_output", call_id, output: "Interrupted: the result of this call is unknown. Call state to see the page." })),
    { role: "user", content: [{ type: "input_text", text: promptText }, ...files] },
  ];
  let previous = attempt.sessionId?.startsWith("resp_") ? attempt.sessionId : undefined;
  const started = Date.now();
  const limit = maxSteps();
  let output = "";

  for (let step = 0; ; step++) {
    const overTime = Date.now() - started > MAX_RUN_MS;
    const lastStep = step >= limit || overTime;
    if (lastStep) {
      input.push({
        role: "user",
        content: [{ type: "input_text", text: `Stop here: the ${overTime ? "time" : "step"} limit for one run was reached. Do not call any more tools. Report exactly what is done and what is not, and end with a NEEDS_ATTENTION: line saying what remains.` }],
      });
    }
    let res: ApiResponse;
    try {
      res = await callModel({ ...base, input, ...(previous ? { previous_response_id: previous } : {}), ...(lastStep ? { tool_choice: "none" } : {}) });
    } catch (err) {
      // A stored conversation can be unusable for this request (expired, or produced by a model whose
      // reasoning items this one can't read). Start a new one with the same prompt instead of failing.
      if (step === 0 && previous && err instanceof ApiError && err.status === 400) {
        previous = undefined;
        input = input.filter((i) => i.type !== "function_call_output");
        res = await callModel({ ...base, input });
      } else {
        throw err;
      }
    }
    if (res.error?.message) throw new Error(`${model}: ${res.error.message}`);
    previous = res.id;
    attempt.sessionId = res.id;
    attempt.pending = undefined;

    const u = res.usage;
    if (u) {
      const cached = u.input_tokens_details?.cached_tokens ?? 0;
      d.input += u.input_tokens - cached;
      d.cacheRead += cached;
      const reasoning = u.output_tokens_details?.reasoning_tokens ?? 0;
      d.output += u.output_tokens - reasoning;
      d.reasoning += reasoning;
    }
    d.steps++;

    const calls = res.output.filter((o): o is FunctionCall => o.type === "function_call");
    const said = res.output
      .flatMap((o) => (o.type === "message" && "content" in o ? (o.content ?? []) : []))
      .filter((c) => c.type === "output_text")
      .map((c) => c.text ?? "")
      .join("\n")
      .trim();
    if (said) onEvent("plan", said);
    if (!calls.length || lastStep) {
      output = said;
      break;
    }

    // Until the next request delivers their results, these calls are unanswered in the stored
    // conversation; if the run is interrupted here, the resume has to answer them first.
    input = [];
    attempt.pending = calls.map((c) => c.call_id);
    for (const call of calls) {
      let args: Record<string, unknown> = {};
      let result: string;
      try {
        args = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
        onEvent("action", describeCall(call.name, args));
        result = await tool.call(call.name, args);
      } catch (err) {
        result = `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
      d.toolCalls++;
      if (result.startsWith("Error:")) onEvent("error", `${call.name}: ${result.slice(7, 300)}`);
      input.push({ type: "function_call_output", call_id: call.call_id, output: result });
    }
  }
  attempt.pending = undefined;

  if (!output && d.input + d.cacheRead + d.output === 0) throw new Error(`${model} returned an empty response`);
  const price = PRICES[modelID];
  if (!price && !warnedPrice.has(modelID)) {
    warnedPrice.add(modelID);
    console.warn(`[direct] no price known for ${modelID}; its cost is reported as 0 (set INTENT_AGENT_PRICES)`);
  }
  const cost = price ? (d.input * price[0] + d.cacheRead * price[1] + (d.output + d.reasoning) * price[2]) / 1e6 : 0;
  return {
    output,
    sessionId: attempt.sessionId ?? previous ?? "",
    model,
    usage: { inputTokens: d.input + d.cacheRead, outputTokens: d.output + d.reasoning, cost, detail: d },
    toolErrors: "",
  };
}
