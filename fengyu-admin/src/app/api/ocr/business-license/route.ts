import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { recognizeBusinessLicense } from "@/lib/ocr/client";
import { isUploadFileLike } from "@/lib/upload-file";

export async function POST(request: Request) {
  const session = await getSession();
  if (!session || !hasPermission(session, "merchant:update")) {
    return NextResponse.json({ ok: false, error: "无权识别入网资料" }, { status: 403 });
  }
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!isUploadFileLike(file)) throw new Error("请选择营业执照图片");
    return NextResponse.json({ ok: true, data: await recognizeBusinessLicense(file) });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "OCR 识别失败" }, { status: 400 });
  }
}
