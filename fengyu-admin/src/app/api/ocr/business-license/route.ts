import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { recognizeBusinessLicense } from '@/lib/ocr/client'
import { OcrConfigurationError, OcrServiceError } from '@/lib/ocr/types'

const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png'])
const MAX_FILE_SIZE = 5 * 1024 * 1024

function errorResponse(error: unknown) {
  if (error instanceof OcrConfigurationError || error instanceof OcrServiceError) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 503 })
  }
  console.error('Business license OCR failed', error)
  return NextResponse.json({ ok: false, error: '营业执照识别失败，请稍后重试' }, { status: 500 })
}

export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session || !hasPermission(session, 'merchant:update')) {
    return NextResponse.json({ ok: false, error: '无权识别入网资料' }, { status: 403 })
  }

  try {
    const file = (await request.formData()).get('file')
    if (!(file instanceof File)) {
      return NextResponse.json({ ok: false, error: '请选择营业执照图片' }, { status: 400 })
    }
    if (!ALLOWED_TYPES.has(file.type)) {
      return NextResponse.json({ ok: false, error: '营业执照仅支持 JPG 或 PNG 图片' }, { status: 400 })
    }
    if (file.size <= 0 || file.size > MAX_FILE_SIZE) {
      return NextResponse.json({ ok: false, error: '营业执照图片大小需在 5 MB 以内' }, { status: 400 })
    }
    return NextResponse.json({ ok: true, data: await recognizeBusinessLicense(file) })
  } catch (error) {
    return errorResponse(error)
  }
}

