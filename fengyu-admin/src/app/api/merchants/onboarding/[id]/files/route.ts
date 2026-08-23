import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { isUploadFileLike } from "@/lib/upload-file";
import { uploadOnboardingAttachment } from "@/actions/lakala-onboarding";
import { MAX_ONBOARDING_ATTACHMENT_BYTES } from "@/lib/lakala-onboarding-constants";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  const session = await getSession();
  if (!session || !hasPermission(session, "merchant:update")) {
    return NextResponse.json({ ok: false, error: "无权上传入网资料" }, { status: 403 });
  }
  const { id } = await params;
  const form = await request.formData();
  const file = form.get("file");
  const attType = String(form.get("attType") || "");
  const displayName = String(form.get("displayName") || "");
  if (!isUploadFileLike(file) || !attType || !displayName) {
    return NextResponse.json({ ok: false, error: "缺少上传文件或附件类型" }, { status: 400 });
  }
  if (typeof file.size === "number" && file.size > MAX_ONBOARDING_ATTACHMENT_BYTES) {
    return NextResponse.json(
      { ok: false, error: `${displayName}：文件过大（${(file.size / 1024 / 1024).toFixed(1)}MB），请压缩到 5MB 内后重新上传` },
      { status: 400 },
    );
  }
  try {
    const result = await uploadOnboardingAttachment(id, file, attType, displayName);
    return NextResponse.json({ ok: true, data: result });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "上传失败" },
      { status: 400 },
    );
  }
}
