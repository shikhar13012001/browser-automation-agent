import { NextRequest, NextResponse } from "next/server";
import { claimNextTask, touchDevice } from "@/lib/store";

export async function GET(req: NextRequest) {
  const deviceId = req.nextUrl.searchParams.get("device");
  if (!deviceId) {
    return NextResponse.json({ error: "device query param is required" }, { status: 400 });
  }
  await touchDevice(deviceId);

  const task = await claimNextTask(deviceId);
  if (!task) {
    return new NextResponse(null, { status: 204 });
  }
  return NextResponse.json(task);
}
