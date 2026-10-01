// Deterministic LeetCode check: language popover + Monaco editor, via the tool's own state/act.
import { act } from "../packages/browser-mcp/src/actions.js";
import { openUrl, readState, takeNotes } from "../packages/browser-mcp/src/browser.js";

const idOf = (s: string, re: RegExp) => Number(s.split("\n").find((l) => re.test(l))?.match(/\[(\d+)\]/)?.[1]);
const show = (label: string, s: string, filter = /POPUP|code|Python|C\+\+|Submit|Run/) =>
  console.log(`\n=== ${label} (${s.length} chars) ===\n` + s.split("\n").filter((l, i) => i < 3 || filter.test(l)).slice(0, 30).join("\n"));

await openUrl("https://leetcode.com/problems/two-sum/");
let s = await readState();
show("problem page", s);

// The editor's own language button is the last language-named button before the code editor.
const lines = s.split("\n");
const editorAt = lines.findIndex((l) => /\] code /.test(l));
const lang = Number(
  lines
    .slice(0, editorAt)
    .reverse()
    .find((l) => /button "(C\+\+|Python3|Java|JavaScript)"/.test(l))
    ?.match(/\[(\d+)\]/)?.[1],
);
console.log("\nlanguage button id:", lang, "\n" + (await act([{ do: "click", id: lang }])));
s = await readState();
show("after opening language menu", s);

const py = idOf(s, /button "Python3"/);
console.log("\nPython3 option id:", py, "\n" + (await act([{ do: "click", id: py }])));
s = await readState();
show("after choosing Python3", s);

const code = [
  "class Solution:",
  "    def twoSum(self, nums: List[int], target: int) -> List[int]:",
  "        seen = {}",
  "        for i, n in enumerate(nums):",
  "            if target - n in seen:",
  "                return [seen[target - n], i]",
  "            seen[n] = i",
  "        return []",
].join("\n");
const editor = idOf(s, /\] code /);
console.log("\neditor id:", editor, "\n" + (await act([{ do: "fill", id: editor, value: code }])));
s = await readState();
const line = s.split("\n").find((l) => /\] code /.test(l)) ?? "";
console.log("\n=== editor after fill ===\n" + line.slice(0, 700));
console.log(takeNotes().join("\n"));
process.exit(0);
