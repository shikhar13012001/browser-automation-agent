export type TaskMode = "standard" | "qa";

export type TaskOptions = {
  mode?: TaskMode;
  outputSchema?: string;
  requireApproval?: boolean;
};

export function extractAttention(output: string): string | undefined {
  const match = output.match(/NEEDS_ATTENTION:\s*(.+)/s);
  return match?.[1]?.trim();
}

export function extractApproval(output: string): string | undefined {
  const match = output.match(/NEEDS_APPROVAL:\s*(.+)/s);
  return match?.[1]?.trim();
}

// Last fenced ```json block wins, so a model that shows a draft and then a final answer is read correctly.
export function extractJson(output: string): unknown | undefined {
  const tryParse = (text: string): unknown | undefined => {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  };

  const blocks = [...output.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (let i = blocks.length - 1; i >= 0; i--) {
    const parsed = tryParse(blocks[i][1].trim());
    if (parsed !== undefined) return parsed;
  }

  // Models sometimes skip the fence: accept the whole reply, then the outermost {...} span.
  const whole = tryParse(output.trim());
  if (whole !== undefined) return whole;
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  return start !== -1 && end > start ? tryParse(output.slice(start, end + 1)) : undefined;
}

const QA_INSTRUCTIONS = `You are acting as an exploratory QA tester and first-time user of the product described in the task. Actually use it: follow the journey the task describes, try realistic inputs, and notice anything confusing, slow, broken, misleading, or inaccessible. Only report what you directly observed; do not speculate about causes you cannot see. Every finding needs the page URL and the exact steps to reproduce it.

Finish with one fenced json block of this exact shape (an empty findings array is a valid result):
\`\`\`json
{"summary": "one or two sentences", "findings": [{"severity": "critical|major|minor|suggestion", "category": "bug|ux|accessibility|content|performance", "title": "short title", "url": "page url", "steps": ["step 1", "step 2"], "expected": "what you expected", "actual": "what happened"}]}
\`\`\``;

const APPROVAL_INSTRUCTIONS = `APPROVAL GATE: do all preparation work, but do NOT perform the final irreversible action (submitting, sending, paying, deleting, confirming). When you are one step away from it, call take_screenshot once, then stop and end your response with a final line starting exactly with \`NEEDS_APPROVAL:\` followed by a concise description of exactly what you are about to do and what state the page is in. Do not click the final button.`;

export function buildPrompt(prompt: string, options: TaskOptions = {}): string {
  const parts: string[] = [];
  if (options.mode === "qa") parts.push(QA_INSTRUCTIONS);
  if (options.outputSchema?.trim()) {
    parts.push(
      `OUTPUT FORMAT: end your response with one fenced json block containing only a value that matches this JSON schema (or shape description):\n${options.outputSchema.trim()}`,
    );
  }
  if (options.requireApproval) parts.push(APPROVAL_INSTRUCTIONS);
  if (parts.length === 0) return prompt;
  return `${prompt}\n\n---\n${parts.join("\n\n")}`;
}

export function parseModelChain(value: string | undefined, fallback = "github-copilot/claude-sonnet-5"): string[] {
  const chain = (value ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter((m) => m.includes("/"));
  return chain.length > 0 ? chain : [fallback];
}

const RECOVERABLE = /not connected|econnrefused|econnreset|socket hang up|transport closed|mcp.*(closed|disconnected)/i;

// True when the failure means the browser tool connection is dead and the embedded OpenCode server should be recreated.
export function isRecoverableToolFailure(text: string): boolean {
  return RECOVERABLE.test(text);
}
