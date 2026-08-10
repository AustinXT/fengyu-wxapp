import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  readPrivateOnboardingFile,
  savePrivateOnboardingFile,
  type UploadFileLike,
} from './upload-file'

const originalPrivateUploadDir = process.env.PRIVATE_UPLOAD_DIR
let uploadRoot = ''

function uploadFile(content: Buffer, name: string, type: string): UploadFileLike {
  return {
    name,
    type,
    size: content.length,
    async arrayBuffer() {
      return content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer
    },
  }
}

beforeEach(async () => {
  uploadRoot = await mkdtemp(path.join(tmpdir(), 'fengyu-onboarding-upload-'))
  process.env.PRIVATE_UPLOAD_DIR = uploadRoot
})

afterEach(async () => {
  await rm(uploadRoot, { recursive: true, force: true })
  if (originalPrivateUploadDir === undefined) delete process.env.PRIVATE_UPLOAD_DIR
  else process.env.PRIVATE_UPLOAD_DIR = originalPrivateUploadDir
})

describe('私有入网附件存储', () => {
  it('根据文件魔数保存图片，并只能通过 opaque storage key 读取', async () => {
    const contents = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])

    const saved = await savePrivateOnboardingFile(
      'onb_safe_1',
      uploadFile(contents, '../../营业执照.png', 'image/png'),
    )

    expect(saved.storageKey).toMatch(/^lakala-onboarding\/onb_safe_1\/[a-f0-9]{32}\.png$/)
    expect(saved.originalFilename).toBe('营业执照.png')
    expect(saved.contentType).toBe('image/png')
    await expect(readPrivateOnboardingFile(saved.storageKey)).resolves.toEqual(contents)
  })

  it('拒绝 MIME 与真实文件内容不一致的伪装上传', async () => {
    const pdf = Buffer.from('%PDF-1.7\nprivate')

    await expect(savePrivateOnboardingFile(
      'onb_safe_2',
      uploadFile(pdf, 'photo.jpg', 'image/jpeg'),
    )).rejects.toThrow('文件类型与实际内容不匹配')
  })

  it('拒绝应用编号和 storage key 的路径逃逸', async () => {
    const image = Buffer.from([0xff, 0xd8, 0xff, 0x00])

    await expect(savePrivateOnboardingFile(
      '../outside',
      uploadFile(image, 'photo.jpg', 'image/jpeg'),
    )).rejects.toThrow('申请编号格式不合法')
    await expect(readPrivateOnboardingFile('../outside.pdf')).rejects.toThrow('私有附件存储键格式不合法')
  })
})
