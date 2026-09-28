import { NextRequest, NextResponse } from "next/server";
import { createTask, listTasks, type TaskMode } from "@/lib/store";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body.prompt !== "string" || body.prompt.length === 0) {
    return NextResponse.json({ error: "prompt is required" }, { status: 400 });
  }
  if (body.mode !== undefined && body.mode !== "standard" && body.mode !== "qa") {
    return NextResponse.json({ error: "mode must be 'standard' or 'qa'" }, { status: 400 });
  }
  const task = await createTask(body.prompt, {
    continuesTaskId: typeof body.continueFrom === "string" ? body.continueFrom : undefined,
    attachments: Array.isArray(body.attachments) ? body.attachments.filter((a: unknown) => typeof a === "string") : undefined,
    mode: body.mode as TaskMode | undefined,
    outputSchema: typeof body.outputSchema === "string" && body.outputSchema.trim() ? body.outputSchema : undefined,
    requireApproval: typeof body.requireApproval === "boolean" ? body.requireApproval : undefined,
  });
  return NextResponse.json(task, { status: 201 });
}

export async function GET() {
  return NextResponse.json(await listTasks());
}
