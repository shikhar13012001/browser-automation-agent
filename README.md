# intent-agent

Checkpoint-driven build of a browser automation agent: OpenCode + Chrome DevTools MCP, controlled remotely.

## Checkpoint 1 — OpenCode controls a real Chrome

Prerequisite: Chrome must be running with remote debugging enabled so `chrome-devtools-mcp --autoConnect`
can attach to it (rather than launching its own throwaway browser).

Test:

```sh
opencode run --agent build "Use my currently running Chrome. Open Google. Search for \"OpenAI API documentation\". Open the appropriate result. Scroll through the page. Tell me the page title and current URL. Do not launch a new browser. Verify each action before continuing."
```

Do not move to Checkpoint 2 until this works reliably.

## Checkpoint 2 — a program controls OpenCode

Small daemon using `@opencode-ai/sdk` that accepts `POST /tasks { prompt }` and drives an OpenCode session
programmatically instead of the terminal.

## Checkpoint 3 — phone → cloud → laptop → Chrome

Minimal Vercel API (`/api/tasks`, `/api/devices`) polled by the local daemon.

## Checkpoint 4 — local model swap

Swap the cloud/hosted model for a local Ollama vision model once 1–3 are proven, without changing the runtime.
