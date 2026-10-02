import { getPage, screenshotBase64 } from "./browser.js";

// OpenCode drops image tool results in this environment (its image normaliser needs a Photon WASM
// module that fails to load, so every image is "omitted"). Vision therefore happens here: the tool
// sends its own screenshot to a vision model and returns text -- which always survives.
const VISION_MODEL = process.env.INTENT_BROWSER_VISION_MODEL ?? "gpt-6-luna";

export type Point = { label: string; x: number; y: number };

export async function look(question: string): Promise<{ answer: string; points: Point[] }> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("Vision is unavailable: OPENAI_API_KEY is not set for the browser tool.");
  const page = await getPage();
  const { w, h, dpr } = await page.evaluate(() => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio || 1 }));
  const shot = await screenshotBase64();
  const scale = Math.min(1, 1280 / (Math.max(w, h, 1) * dpr));
  const imgW = Math.round(w * dpr * scale);
  const imgH = Math.round(h * dpr * scale);

  const instructions =
    `You are looking at a screenshot of a web page (${imgW}x${imgH} pixels). Answer the question concisely and only from what is visible. ` +
    `If the question asks where something is, include its centre point. Reply with JSON only: ` +
    `{"answer": "...", "points": [{"label": "...", "x": <pixel x>, "y": <pixel y>}]} (points may be empty).`;

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: VISION_MODEL,
      reasoning: { effort: "low" },
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: `${instructions}\n\nQuestion: ${question}` },
            { type: "input_image", image_url: `data:${shot.mime};base64,${shot.data}` },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Vision request failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { output?: { type: string; content?: { type: string; text?: string }[] }[] };
  const text =
    body.output?.flatMap((o) => (o.type === "message" ? (o.content ?? []).filter((c) => c.type === "output_text").map((c) => c.text ?? "") : [])).join("") ?? "";

  let parsed: { answer?: string; points?: Point[] } = {};
  try {
    parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  } catch {
    parsed = { answer: text };
  }
  // Model coordinates are screenshot pixels; clicks use CSS pixels of the viewport.
  const toCss = 1 / (dpr * scale);
  const points = (parsed.points ?? [])
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
    .map((p) => ({ label: String(p.label ?? ""), x: Math.round(p.x * toCss), y: Math.round(p.y * toCss) }));
  // An empty answer told the model nothing and it went on guessing; say so instead.
  const answer = String(parsed.answer ?? "").trim() || text.trim() || "(the vision model returned no answer -- ask a narrower question, or use state)";
  return { answer, points };
}
