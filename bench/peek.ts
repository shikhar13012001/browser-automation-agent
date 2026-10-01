// Print the current page state of the agent's tab (for checking what a run actually left behind).
const { readState } = await import("../packages/browser-mcp/src/browser.js");
console.log(await readState({ text: process.argv.includes("--text") }));
process.exit(0);
