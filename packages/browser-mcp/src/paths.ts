import { tmpdir } from "node:os";
import { join } from "node:path";

// Several agents can drive the same Chrome at once, each in its own tab. INTENT_BROWSER_WORKER names
// the worker, and every file this server keeps (its tab id, screenshot, activity) carries that name
// so workers never read each other's.
export const WORKER = (process.env.INTENT_BROWSER_WORKER ?? "").replace(/[^a-z0-9_-]/gi, "");
export const DIR = join(tmpdir(), "intent-browser");

// "latest.jpg" -> "<tmp>/intent-browser/latest.jpg", or ".../latest-w2.jpg" for worker w2.
export function workerFile(name: string): string {
  if (!WORKER) return join(DIR, name);
  const dot = name.lastIndexOf(".");
  return join(DIR, dot > 0 ? `${name.slice(0, dot)}-${WORKER}${name.slice(dot)}` : `${name}-${WORKER}`);
}
