import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock @cloudbase/node-sdk
const mockUploadFile = vi.fn()
const mockGetTempFileURL = vi.fn()
vi.mock('@cloudbase/node-sdk', () => ({
  default: {
    init: vi.fn().mockReturnValue({
      uploadFile: (...args: unknown[]) => mockUploadFile(...args),
      getTempFileURL: (...args: unknown[]) => mockGetTempFileURL(...args),
    }),
  },
}))

import { uploadFile, CDN_BASE } from './cloudbase'

describe('cloudbase', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('CDN_BASE 是 tcb.qcloud.la 地址', () => {
    expect(CDN_BASE).toContain('tcb.qcloud.la')
  })

  it('uploadFile 返回临时 URL', async () => {
    mockUploadFile.mockResolvedValue({ fileID: 'cloud://test/file.jpg' })
    mockGetTempFileURL.mockResolvedValue({
      fileList: [{ tempFileURL: 'https://cdn.example.com/file.jpg' }],
    })

    const result = await uploadFile(Buffer.from('test'), 'test/file.jpg')
    expect(result).toBe('https://cdn.example.com/file.jpg')
    expect(mockUploadFile).toHaveBeenCalledWith({
      cloudPath: 'test/file.jpg',
      fileContent: expect.any(Buffer),
    })
  })

  it('uploadFile 无 tempFileURL 时回退 CDN 拼接', async () => {
    mockUploadFile.mockResolvedValue({ fileID: 'cloud://test/img.png' })
    mockGetTempFileURL.mockResolvedValue({ fileList: [{}] })

    const result = await uploadFile(Buffer.from('data'), 'admin/img.png')
    expect(result).toBe(`${CDN_BASE}/admin/img.png`)
  })

  it('uploadFile 无 fileID 抛出错误', async () => {
    mockUploadFile.mockResolvedValue({})

    await expect(uploadFile(Buffer.from('data'), 'fail/file.jpg'))
      .rejects.toThrow('上传失败')
  })
})
