import 'server-only'

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  ALLOWED_ONBOARDING_CONTENT_TYPES,
  ALLOWED_ONBOARDING_FILE_EXTENSIONS,
  MAX_ONBOARDING_ATTACHMENT_BYTES,
} from './lakala-onboarding-constants'

export interface UploadFileLike {
  name: string
  type: string
  size: number
  arrayBuffer: () => Promise<ArrayBuffer>
}

export interface SavedPrivateOnboardingFile {
  storageKey: string
  originalFilename: string
  fileExt: string
  fileSizeBytes: number
  contentType: string
  contentSha256: string
}

const STORAGE_KEY_PATTERN = /^lakala-onboarding\/[A-Za-z0-9_-]{1,80}\/[a-f0-9]{32}\.(jpg|jpeg|png|pdf)$/
const APPLICATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/

export function isUploadFileLike(value: unknown): value is UploadFileLike {
  if (!value || typeof value !== 'object') return false
  const file = value as Partial<UploadFileLike>
  return (
    typeof file.name === 'string' &&
    typeof file.type === 'string' &&
    typeof file.size === 'number' &&
    Number.isFinite(file.size) &&
    typeof file.arrayBuffer === 'function'
  )
}

function privateUploadRoot(): string {
  const configured = process.env.PRIVATE_UPLOAD_DIR?.trim()
  if (!configured) {
    throw new Error('INVALID_STATE: PRIVATE_UPLOAD_DIR 未配置，入网资料不能写入临时目录')
  }
  if (!path.isAbsolute(configured)) {
    throw new Error('INVALID_STATE: PRIVATE_UPLOAD_DIR 必须是绝对路径')
  }
  const root = path.resolve(configured)
  if (root === path.parse(root).root) {
    throw new Error('INVALID_STATE: PRIVATE_UPLOAD_DIR 不能指向文件系统根目录')
  }
  return root
}

export function getPrivateUploadRoot(): string {
  return privateUploadRoot()
}

async function ensurePrivateUploadRoot(): Promise<string> {
  const root = privateUploadRoot()
  await mkdir(root, { recursive: true, mode: 0o700 })
  return root
}

function safeOriginalFilename(filename: string): string {
  const basename = path.basename(filename || 'upload')
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
    .trim()
  return (basename || 'upload').slice(0, 180)
}

function detectContentType(buffer: Buffer): { contentType: string; fileExt: string } | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { contentType: 'image/jpeg', fileExt: 'jpg' }
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { contentType: 'image/png', fileExt: 'png' }
  }
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString('ascii') === '%PDF-') {
    return { contentType: 'application/pdf', fileExt: 'pdf' }
  }
  return null
}

function validateDeclaredContentType(declared: string, detected: string): void {
  const normalized = declared.trim().toLowerCase()
  if (!normalized || normalized === 'application/octet-stream') return
  if (!ALLOWED_ONBOARDING_CONTENT_TYPES.has(normalized) || normalized !== detected) {
    throw new Error('INVALID_PARAMS: 文件类型与实际内容不匹配，仅支持 JPG、PNG、PDF')
  }
}

function buildStorageKey(applicationId: string, extension: string): string {
  if (!APPLICATION_ID_PATTERN.test(applicationId)) {
    throw new Error('INVALID_PARAMS: 申请编号格式不合法')
  }
  if (!ALLOWED_ONBOARDING_FILE_EXTENSIONS.has(extension)) {
    throw new Error('INVALID_PARAMS: 不支持的文件扩展名')
  }
  return `lakala-onboarding/${applicationId}/${randomUUID().replace(/-/g, '')}.${extension}`
}

function resolvePrivateStoragePath(root: string, storageKey: string): string {
  if (!STORAGE_KEY_PATTERN.test(storageKey)) {
    throw new Error('INVALID_PARAMS: 私有附件存储键格式不合法')
  }
  const resolved = path.resolve(root, storageKey)
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error('INVALID_PARAMS: 非法的私有附件路径')
  }
  return resolved
}

/**
 * 写入非公开附件。数据库仅可持久化本函数返回的 storageKey 和元数据，绝不保存服务器绝对路径。
 */
export async function savePrivateOnboardingFile(
  applicationId: string,
  file: UploadFileLike,
): Promise<SavedPrivateOnboardingFile> {
  if (!isUploadFileLike(file)) throw new Error('INVALID_PARAMS: 上传文件格式不合法')
  if (file.size <= 0) throw new Error('INVALID_PARAMS: 上传文件不能为空')
  if (file.size > MAX_ONBOARDING_ATTACHMENT_BYTES) {
    throw new Error('INVALID_PARAMS: 上传文件不能超过 5MB')
  }

  const raw = await file.arrayBuffer()
  const buffer = Buffer.from(raw)
  if (buffer.length === 0 || buffer.length > MAX_ONBOARDING_ATTACHMENT_BYTES) {
    throw new Error('INVALID_PARAMS: 上传文件不能超过 5MB')
  }
  const detected = detectContentType(buffer)
  if (!detected) throw new Error('INVALID_PARAMS: 文件内容不受支持，仅支持 JPG、PNG、PDF')
  validateDeclaredContentType(file.type, detected.contentType)

  const root = await ensurePrivateUploadRoot()
  const storageKey = buildStorageKey(applicationId, detected.fileExt)
  const destination = resolvePrivateStoragePath(root, storageKey)
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
  await writeFile(destination, buffer, { mode: 0o600, flag: 'wx' })

  return {
    storageKey,
    originalFilename: safeOriginalFilename(file.name),
    fileExt: detected.fileExt,
    fileSizeBytes: buffer.length,
    contentType: detected.contentType,
    contentSha256: createHash('sha256').update(buffer).digest('hex'),
  }
}

/**
 * 仅供已完成鉴权和门店 scope 校验的 Route Handler 读取附件内容。
 */
export async function readPrivateOnboardingFile(storageKey: string): Promise<Buffer> {
  const root = await ensurePrivateUploadRoot()
  return readFile(resolvePrivateStoragePath(root, storageKey))
}

export function bufferToUploadFileLike(buffer: Buffer, name: string, type: string): UploadFileLike {
  return {
    name,
    type,
    size: buffer.length,
    async arrayBuffer() {
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
    },
  }
}

