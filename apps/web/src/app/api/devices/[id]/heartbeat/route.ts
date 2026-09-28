import { NextResponse } from "next/server";
import { touchDevice } from "@/lib/store";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const device = await touchDevice(id);
  return NextResponse.json(device);
}
