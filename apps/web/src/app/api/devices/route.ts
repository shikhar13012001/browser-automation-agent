import { NextResponse } from "next/server";
import { listDevices } from "@/lib/store";

export async function GET() {
  return NextResponse.json(await listDevices());
}
