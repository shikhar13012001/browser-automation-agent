// Does OpenCode keep the screenshot the browser tool returns, or drop it as "omitted"?
import dotenv from "dotenv";
dotenv.config({ path: "apps/daemon/.env", quiet: true });
const { runTask, warmUp, resetClient } = await import("../apps/daemon/src/agent.js");

await warmUp();
const res = await runTask(
  "Call the intent-browser screenshot tool exactly once. Then reply with exactly one line: IMAGE_SEEN if you received an image, or IMAGE_MISSING if the tool result said an image was omitted. Then, if you saw it, name one word visible on screen.",
  undefined,
  () => {},
  [],
  { models: ["openai/gpt-6-luna"], includeContext: false },
);
console.log(res.output, "| cost", res.usage.cost.toFixed(5));
resetClient();
process.exit(0);
