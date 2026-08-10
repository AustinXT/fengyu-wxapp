import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { uploadOnboardingAttachment } from '@/actions/lakala-onboarding'
import { ALLOWED_ONBOARDING_CONTENT_TYPES, ATTACHMENT_REQUIREMENTS, MAX_ONBOARDING_ATTACHMENT_BYTES } from '@/lib/lakala-onboarding-constants'

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png'])

const ATTACHMENTS = new Map<string, { displayName: string; imageOnly: boolean }>(
  ATTACHMENT_REQUIREMENTS.map((item) => [
    item.attachmentType,
    { displayName: item.displayName, imageOnly: item.attachmentType !== 'BUSINESS_LICENCE' && item.attachmentType !== 'OPENING_PERMIT' },
  ]),
)

type Params = { params: Promise<{ id: string }> }

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  if (!message || message.length > 200 || /(?:SQL|postgres|database|column|constraint|stack)/i.test(message)) return '上传失败，请稍后重试'
  return message.replace(/^[A-Z_]+:\s*/, '')
}

export async function POST(request: NextRequest, { params }: Params) {
  const session = await getSession()
  if (!session || !hasPermission(session, 'merchant:update')) {
    return NextResponse.json({ ok: false, error: '无权上传入网资料' }, { status: 403 })
  }

  try {
    const { id } = await params
    const formData = await request.formData()
    const file = formData.get('file')
    const attachmentType = String(formData.get('attachmentType') ?? formData.get('attType') ?? '')
    const expectedUpdatedAt = String(formData.get('expectedUpdatedAt') ?? '') || undefined
    const definition = ATTACHMENTS.get(attachmentType)
    if (!id || !definition || !(file instanceof File)) {
      return NextResponse.json({ ok: false, error: '上传参数不完整或附件类型不支持' }, { status: 400 })
    }
    if (file.size <= 0 || file.size > MAX_ONBOARDING_ATTACHMENT_BYTES) {
      return NextResponse.json({ ok: false, error: `${definition.displayName} 文件大小需在 5 MB 以内` }, { status: 400 })
    }
    const allowedTypes = definition.imageOnly ? IMAGE_TYPES : ALLOWED_ONBOARDING_CONTENT_TYPES
    if (!allowedTypes.has(file.type)) {
      return NextResponse.json({
        ok: false,
        error: definition.imageOnly
          ? `${definition.displayName}仅支持 JPG 或 PNG 图片`
          : `${definition.displayName}仅支持 JPG、PNG 图片或 PDF`,
      }, { status: 400 })
    }

    // action 内会按申请所属门店再次执行 scope 校验；route 层校验防止无权限请求进入文件处理。
    const result = await uploadOnboardingAttachment(id, file, attachmentType, definition.displayName, expectedUpdatedAt)
    if (!result.success) {
      return NextResponse.json({
        ok: false,
        error: result.message || '资料上传失败',
        ...(result.updatedAt ? { data: { updatedAt: result.updatedAt } } : {}),
      }, { status: 400 })
    }
    return NextResponse.json({ ok: true, data: result })
  } catch (error) {
    return NextResponse.json({ ok: false, error: safeErrorMessage(error) }, { status: 400 })
  }
}
