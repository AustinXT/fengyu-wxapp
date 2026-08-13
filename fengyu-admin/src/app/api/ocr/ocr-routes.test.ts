import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getSession, hasPermission, recognizeBusinessLicense, recognizeIdCard } = vi.hoisted(() => ({
  getSession: vi.fn(),
  hasPermission: vi.fn(),
  recognizeBusinessLicense: vi.fn(),
  recognizeIdCard: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({ getSession }))
vi.mock('@/lib/permissions', () => ({ hasPermission }))
vi.mock('@/lib/ocr/client', () => ({ recognizeBusinessLicense, recognizeIdCard }))

import { POST as businessLicensePost } from './business-license/route'
import { POST as idCardPost } from './id-card/route'

function request(path: string, file: File, side?: 'face' | 'back'): NextRequest {
  const body = new FormData()
  body.set('file', file)
  if (side) body.set('side', side)
  return new NextRequest(`http://localhost${path}`, { method: 'POST', body })
}

describe('OCR Route Handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getSession.mockResolvedValue({ userId: 'admin' })
    hasPermission.mockReturnValue(true)
  })

  it('无 merchant:update 权限时拒绝识别', async () => {
    hasPermission.mockReturnValue(false)
    const response = await businessLicensePost(request('/api/ocr/business-license', new File(['x'], 'license.png', { type: 'image/png' })))
    expect(response.status).toBe(403)
    expect(recognizeBusinessLicense).not.toHaveBeenCalled()
  })

  it('营业执照只接受 JPG/PNG 且成功返回预填数据', async () => {
    recognizeBusinessLicense.mockResolvedValue({ merRegName: '测试主体' })
    const response = await businessLicensePost(request('/api/ocr/business-license', new File(['png'], 'license.png', { type: 'image/png' })))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ ok: true, data: { merRegName: '测试主体' } })
  })

  it('身份证拒绝 PDF 并把反面 side 传给识别器', async () => {
    const invalid = await idCardPost(request('/api/ocr/id-card', new File(['pdf'], 'id.pdf', { type: 'application/pdf' }), 'back'))
    expect(invalid.status).toBe(400)

    recognizeIdCard.mockResolvedValue({ side: 'back', larIdcardLongTerm: 'true' })
    const valid = await idCardPost(request('/api/ocr/id-card', new File(['jpg'], 'id.jpg', { type: 'image/jpeg' }), 'back'))
    expect(valid.status).toBe(200)
    expect(recognizeIdCard).toHaveBeenCalledWith(expect.any(File), 'back')
  })
})
