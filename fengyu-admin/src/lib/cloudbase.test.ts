import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock @cloudbase/node-sdk
const mockUploadFile = vi.fn()
const mockGetTempFileURL = vi.fn()
const mockDeleteFile = vi.fn()
const mockCallFunction = vi.fn()
const mockInit = vi.fn().mockReturnValue({
  uploadFile: (...args: unknown[]) => mockUploadFile(...args),
  getTempFileURL: (...args: unknown[]) => mockGetTempFileURL(...args),
  deleteFile: (...args: unknown[]) => mockDeleteFile(...args),
  callFunction: (...args: unknown[]) => mockCallFunction(...args),
})
vi.mock('@cloudbase/node-sdk', () => ({
  default: {
    init: (...args: unknown[]) => mockInit(...args),
  },
}))

import { uploadFile, getTempFileUrl, deleteByCloudPaths, callStaffFunction, CDN_BASE } from './cloudbase'

describe('cloudbase', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.CLOUDBASE_ENV_ID = 'test-env'
    process.env.STAFF_ENV_ID = 'staff-test-env'
    process.env.STAFF_TENCENTCLOUD_SECRETID = 'staff-secret-id'
    process.env.STAFF_TENCENTCLOUD_SECRETKEY = 'staff-secret-key'
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

  it('getTempFileUrl 使用当前 CloudBase 环境获取临时下载地址', async () => {
    mockGetTempFileURL.mockResolvedValue({
      fileList: [{ tempFileURL: 'https://download.example.com/export.xlsx' }],
    })

    await expect(getTempFileUrl('admin/exports/1/content.xlsx'))
      .resolves.toBe('https://download.example.com/export.xlsx')
    expect(mockGetTempFileURL).toHaveBeenCalledWith({
      fileList: [`cloud://test-env.${new URL(CDN_BASE).hostname.split('.')[0]}/admin/exports/1/content.xlsx`],
    })
  })

  it('deleteByCloudPaths 使用完整 fileID，并保留已有 fileID', async () => {
    mockDeleteFile.mockResolvedValue({ fileList: [] })

    await deleteByCloudPaths([
      'admin/exports/1/content.xlsx',
      'cloud://legacy.bucket/admin/exports/2/content.xlsx',
    ])

    expect(mockDeleteFile).toHaveBeenCalledWith({
      fileList: [
        `cloud://test-env.${new URL(CDN_BASE).hostname.split('.')[0]}/admin/exports/1/content.xlsx`,
        'cloud://legacy.bucket/admin/exports/2/content.xlsx',
      ],
    })
  })

  it('getTempFileUrl 在 CloudBase 未返回临时地址时失败', async () => {
    mockGetTempFileURL.mockResolvedValue({ fileList: [{}] })

    await expect(getTempFileUrl('admin/exports/1/content.xlsx'))
      .rejects.toThrow('导出文件不存在或已过期')
  })

  it('staffApi 使用独立腾讯云账号凭据', async () => {
    mockCallFunction.mockResolvedValue({ result: { code: 0 } })

    await callStaffFunction('staffApi', { action: 'system.health', payload: {} })

    expect(mockInit).toHaveBeenCalledWith({
      env: 'staff-test-env',
      secretId: 'staff-secret-id',
      secretKey: 'staff-secret-key',
    })
    expect(mockCallFunction).toHaveBeenCalledWith({
      name: 'staffApi',
      data: { action: 'system.health', payload: {} },
    })
  })
})
