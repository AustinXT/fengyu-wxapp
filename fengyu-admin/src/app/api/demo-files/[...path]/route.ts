import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { readDemoFile, verifyDemoFileUrl } from '@/lib/demo-storage'

export const dynamic = 'force-dynamic'

export async function GET(request: Request, context: { params: Promise<{ path: string[] }> }) {
  if (process.env.DEMO_MODE !== '1') return new NextResponse(null, { status: 404 })
  const key = (await context.params).path.join('/')
  try {
    const signed = verifyDemoFileUrl(key, new URL(request.url))
    if (!signed && (key.startsWith('admin/exports/') || !(await getSession()))) {
      return NextResponse.json({ error: '文件访问未授权' }, { status: 403 })
    }
    const data = await readDemoFile(key)
    const extension = key.split('.').pop()?.toLowerCase()
    const type = ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } as Record<string, string>)[extension || ''] || 'application/octet-stream'
    return new NextResponse(new Uint8Array(data), { headers: {
      'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store',
      ...(type === 'application/octet-stream' ? { 'Content-Disposition': 'attachment' } : {}),
    } })
  } catch {
    return NextResponse.json({ error: '文件不存在或路径无效' }, { status: 404 })
  }
}
