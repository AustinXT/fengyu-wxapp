import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { recognizeIdCard } from "@/lib/ocr/client";
import { isUploadFileLike } from "@/lib/upload-file";

export async function POST(request: Request) {
  const session = await getSession();
  if (!session || !hasPermission(session, "merchant:update")) {
    return NextResponse.json({ ok: false, error: "无权识别入网资料" }, { status: 403 });
  }
  try {
    const form = await request.formData();
    const file = form.get("file");
    const side = form.get("side") === "back" ? "back" : "face";
    if (!isUploadFileLike(file)) throw new Error("请选择身份证图片");
    const fileType = (file as { type?: string }).type ?? "";
    if (fileType !== "image/jpeg" && fileType !== "image/png") {
      throw new Error("身份证仅支持 JPG/PNG 图片");
    }
    return NextResponse.json({ ok: true, data: await recognizeIdCard(file, side) });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "OCR 识别失败" }, { status: 400 });
  }
}
