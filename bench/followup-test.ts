// Direct engine: a follow-up task must continue the earlier conversation (same as the dashboard's
// "continue" on a finished task), and a session it can't continue must not break the run.
import dotenv from "dotenv";
dotenv.config({ path: "apps/daemon/.env", quiet: true });
const { runTask, resetClient } = await import("../apps/daemon/src/agent.js");
const opts = { models: ["openai/gpt-6-luna"], includeContext: false };
const first = await runTask("Open http://localhost:4545/zoo and tell me only the label of the first dropdown on the page.", undefined, (k, m) => console.log(`  [${k}] ${m.slice(0, 90)}`), [], opts);
console.log("first:", first.output.replace(/\s+/g, " ").slice(0, 120), "| session", first.sessionId.slice(0, 12));
const second = await runTask("Without opening anything again: what URL did I ask you to open, and what was the label you told me? Answer in one line.", first.sessionId, () => {}, [], opts);
console.log("follow-up:", second.output.replace(/\s+/g, " ").slice(0, 200), `| tool calls ${second.usage.detail?.toolCalls}`);
const stale = await runTask("Reply with the single word OK.", "resp_doesnotexist000000000000000000000000000000000000", () => {}, [], opts);
console.log("unusable session:", stale.output.replace(/\s+/g, " ").slice(0, 60));
resetClient();
process.exit(0);
