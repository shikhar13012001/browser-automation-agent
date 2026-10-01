import { act } from "../packages/browser-mcp/src/actions.js";
import { openUrl, readState, takeNotes } from "../packages/browser-mcp/src/browser.js";
const [url, clickLabel] = process.argv.slice(2);
let t = Date.now();
await openUrl(url);
let s = await readState();
console.log(`open ${Date.now() - t}ms, state ${s.length} chars\n${s}\n${takeNotes().join("\n")}`);
if (clickLabel) {
  const id = Number(s.split("\n").find((l) => l.includes(`"${clickLabel}"`))?.match(/\[(\d+)\]/)?.[1]);
  t = Date.now();
  const r = await act([{ do: "click", id }]);
  s = await readState();
  console.log(`\nclick "${clickLabel}" [${id}] ${Date.now() - t}ms\n${r}\n${takeNotes().join("\n")}\nstate ${s.length} chars\n${s}`);
}
process.exit(0);
