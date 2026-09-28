import { NextRequest, NextResponse } from "next/server";
import { put } from "@vercel/blob";

export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || !(file instanceof File)) {
    return NextResponse.json({ error: "file is required (multipart/form-data)" }, { status: 400 });
  }

  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const storedName = `${crypto.randomUUID()}-${safeName}`;

  const blob = await put(storedName, file, { access: "public" });

  return NextResponse.json({ url: blob.url, mime: file.type || "application/octet-stream", filename: file.name }, { status: 201 });
}
