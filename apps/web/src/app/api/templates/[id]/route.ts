import { NextRequest, NextResponse } from "next/server";
import { deleteTemplate } from "@/lib/store";

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "invalid id" }, { status: 400 });
  const deleted = await deleteTemplate(id);
  return deleted ? new NextResponse(null, { status: 204 }) : NextResponse.json({ error: "not found" }, { status: 404 });
}
