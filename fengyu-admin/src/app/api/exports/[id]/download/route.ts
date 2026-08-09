import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { adminExportJobs } from '@db/export-job'
import { getSession } from '@/lib/auth'
import { getTempFileUrl } from '@/lib/cloudbase'

export const dynamic = 'force-dynamic'

/**
 * 下载地址不直接存入任务表，也不把 CloudBase 文件 ID 暴露给客户端。
 * 每次请求都重新检查提交人，并只返回一个短期签名 URL。
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await getSession()
  if (!session) {
    return NextResponse.json({ error: '未登录' }, { status: 401 })
  }

  const rawId = (await context.params).id
  const id = Number(rawId)
  if (!Number.isSafeInteger(id) || id <= 0) {
    return NextResponse.json({ error: '任务编号无效' }, { status: 400 })
  }

  const [job] = await db
    .select({
      id: adminExportJobs.id,
      status: adminExportJobs.status,
      fileCloudPath: adminExportJobs.fileCloudPath,
      fileName: adminExportJobs.fileName,
      expiresAt: adminExportJobs.expiresAt,
    })
    .from(adminExportJobs)
    .where(and(
      eq(adminExportJobs.id, id),
      eq(adminExportJobs.requestedByEmployeeId, session.employeeId),
    ))
    .limit(1)

  if (!job) return NextResponse.json({ error: '导出任务不存在' }, { status: 404 })
  if (job.status !== 'ready' || !job.fileCloudPath) {
    return NextResponse.json({ error: '导出文件尚未准备好' }, { status: 409 })
  }
  if (job.expiresAt && job.expiresAt.getTime() <= Date.now()) {
    await db
      .update(adminExportJobs)
      .set({ status: 'expired', fileCloudPath: null, updatedAt: new Date() })
      .where(eq(adminExportJobs.id, id))
    return NextResponse.json({ error: '导出文件已过期，请重新导出' }, { status: 410 })
  }

  try {
    const url = await getTempFileUrl(job.fileCloudPath)
    const response = NextResponse.redirect(url)
    if (job.fileName) {
      response.headers.set(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(job.fileName)}`,
      )
    }
    return response
  } catch {
    return NextResponse.json({ error: '导出文件暂时不可用，请稍后重试' }, { status: 503 })
  }
}
