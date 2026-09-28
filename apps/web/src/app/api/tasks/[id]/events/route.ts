import { NextRequest, NextResponse } from "next/server";
import { addEvent, listEvents } from "@/lib/store";
import type { RunEventKind } from "@/lib/store";

const VALID_KINDS: RunEventKind[] = ["status", "plan", "action", "verification", "finding", "attention", "error", "result"];

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body || typeof body.message !== "string" || !VALID_KINDS.includes(body.kind)) {
    return NextResponse.json({ error: "kind and message are required" }, { status: 400 });
  }
  const event = await addEvent(id, body.kind, body.message);
  return NextResponse.json(event, { status: 201 });
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const since = req.nextUrl.searchParams.get("since") ?? undefined;
  return NextResponse.json(await listEvents(id, since));
}
