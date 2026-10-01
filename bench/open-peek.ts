// Open a URL in the agent's tab and print the state the model would see.
const { openUrl, readState } = await import("../packages/browser-mcp/src/browser.js");
await openUrl(process.argv[2]);
console.log(await readState({ all: process.argv.includes("--all") }));
process.exit(0);
