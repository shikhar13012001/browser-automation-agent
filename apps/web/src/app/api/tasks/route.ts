import { NextRequest, NextResponse } from "next/server";
import { createTask, listTasks } from "@/lib/store";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body.prompt !== "string" || body.prompt.length === 0) {
    return NextResponse.json({ error: "prompt is required" }, { status: 400 });
  }
  const continuesTaskId = typeof body.continueFrom === "string" ? body.continueFrom : undefined;
  const attachments = Array.isArray(body.attachments) ? body.attachments.filter((a: unknown) => typeof a === "string") : undefined;
  const task = await createTask(body.prompt, continuesTaskId, attachments);
  return NextResponse.json(task, { status: 201 });
}

export async function GET() {
  return NextResponse.json(await listTasks());
}
