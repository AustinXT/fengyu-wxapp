import { readFile } from "fs/promises";
import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { getSession } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { lakalaOnboardingAttachments } from "@db/lakala-onboarding";

type Params = { params: Promise<{ id: string; attachmentId: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  const session = await getSession();
  if (!session || !hasPermission(session, "merchant:list")) {
    return NextResponse.json({ ok: false, error: "无权查看入网资料" }, { status: 403 });
  }
  const { id, attachmentId } = await params;
  const [attachment] = await db
    .select()
    .from(lakalaOnboardingAttachments)
    .where(and(eq(lakalaOnboardingAttachments.applicationId, id), eq(lakalaOnboardingAttachments.id, attachmentId)))
    .limit(1);
  if (!attachment) return NextResponse.json({ ok: false, error: "附件不存在" }, { status: 404 });
  const buffer = await readFile(attachment.localPath);
  return new NextResponse(buffer, {
    headers: {
      "Content-Type": attachment.mimeType || "application/octet-stream",
      "Cache-Control": "private, max-age=60",
      "Content-Disposition": `inline; filename="${encodeURIComponent(attachment.fileName)}"`,
    },
  });
}
