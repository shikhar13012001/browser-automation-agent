import { NextRequest, NextResponse } from "next/server";
import { listTemplates, saveTemplate } from "@/lib/store";

export async function GET() {
  return NextResponse.json(await listTemplates());
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const prompt = typeof body?.prompt === "string" ? body.prompt : "";
  if (!name || name.length > 80 || !prompt.trim()) {
    return NextResponse.json({ error: "name (max 80 chars) and prompt are required" }, { status: 400 });
  }
  return NextResponse.json(await saveTemplate(name, prompt), { status: 201 });
}
