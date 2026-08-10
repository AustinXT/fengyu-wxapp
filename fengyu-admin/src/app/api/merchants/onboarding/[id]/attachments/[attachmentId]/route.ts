import { and, eq, ne } from 'drizzle-orm'
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/db'
import { lakalaOnboardingApplications, lakalaOnboardingAttachments } from '@db/lakala-onboarding'
import { stores } from '@db/org'
import { getSession } from '@/lib/auth'
import { hasPermission, scopeCondition } from '@/lib/permissions'
import { readPrivateOnboardingFile } from '@/lib/upload-file'
import { getOnboardingAttachmentForDownload } from '@/actions/lakala-onboarding'

type Params = { params: Promise<{ id: string; attachmentId: string }> }

function safeFilename(filename: string): string {
  return filename.replace(/[\r\n"\\]/g, '_').slice(0, 180) || 'attachment'
}

export async function GET(_request: NextRequest, { params }: Params) {
  const session = await getSession()
  if (!session || !hasPermission(session, 'merchant:list')) {
    return NextResponse.json({ ok: false, error: '无权查看入网资料' }, { status: 403 })
  }

  const { id, attachmentId } = await params
  const [attachment] = await db
    .select({
      id: lakalaOnboardingAttachments.id,
    })
    .from(lakalaOnboardingAttachments)
    .innerJoin(
      lakalaOnboardingApplications,
      eq(lakalaOnboardingAttachments.applicationId, lakalaOnboardingApplications.id),
    )
    .innerJoin(stores, eq(lakalaOnboardingApplications.storeId, stores.storeId))
    .where(and(
      eq(lakalaOnboardingAttachments.id, attachmentId),
      eq(lakalaOnboardingApplications.id, id),
      ne(lakalaOnboardingAttachments.status, 'DELETED'),
      scopeCondition(session, stores.storeId),
    ))
    .limit(1)

  // 返回同一 404，避免用申请或附件 ID 枚举其它门店的私有资料。
  if (!attachment) {
    return NextResponse.json({ ok: false, error: '附件不存在' }, { status: 404 })
  }

  try {
    // 再走核心 action 的集中 scope 查询，避免日后 schema/状态规则变更导致下载路由漂移。
    const downloadable = await getOnboardingAttachmentForDownload(id, attachmentId)
    if (!downloadable) return NextResponse.json({ ok: false, error: '附件不存在' }, { status: 404 })
    const body = await readPrivateOnboardingFile(downloadable.storageKey)
    return new NextResponse(new Uint8Array(body), {
      headers: {
        'Content-Type': downloadable.contentType || 'application/octet-stream',
        'Content-Disposition': `inline; filename="${encodeURIComponent(safeFilename(downloadable.originalFilename))}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch {
    // 私有文件读取错误不能将存储绝对路径或文件名带入日志。
    console.error('Unable to read onboarding attachment')
    return NextResponse.json({ ok: false, error: '附件文件不存在或暂不可读取' }, { status: 404 })
  }
}
