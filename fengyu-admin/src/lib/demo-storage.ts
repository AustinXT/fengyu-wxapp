import { createHmac, timingSafeEqual } from 'node:crypto'
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import type { ReadStream } from 'node:fs'

function filePath(key: string): string {
  const root = resolve(process.env.DEMO_UPLOAD_DIR || '/var/lib/lxcoding/uploads')
  if (!key || key.includes('\\') || key.includes('\0') || key.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('INVALID_PARAMS: 文件路径无效')
  }
  const target = resolve(root, key)
  if (!target.startsWith(root + sep)) throw new Error('INVALID_PARAMS: 文件路径无效')
  return target
}

function signature(key: string, expires: string): string {
  if (!process.env.JWT_SECRET) throw new Error('INVALID_STATE: 演示文件签名密钥缺失')
  return createHmac('sha256', process.env.JWT_SECRET).update(`${key}\n${expires}`).digest('hex')
}

export function demoFileUrl(key: string, signed = false): string {
  filePath(key)
  const url = new URL(`/api/demo-files/${key.split('/').map(encodeURIComponent).join('/')}`, process.env.DEMO_PUBLIC_ORIGIN || 'http://101.34.242.103:8094')
  if (signed) {
    const expires = String(Date.now() + 5 * 60_000)
    url.searchParams.set('expires', expires)
    url.searchParams.set('signature', signature(key, expires))
  }
  return url.toString()
}

export function verifyDemoFileUrl(key: string, url: URL): boolean {
  const expires = url.searchParams.get('expires') || ''
  const provided = url.searchParams.get('signature') || ''
  if (!/^\d+$/.test(expires) || Number(expires) < Date.now() || !/^[a-f0-9]{64}$/.test(provided)) return false
  return timingSafeEqual(Buffer.from(signature(key, expires)), Buffer.from(provided))
}

export async function writeDemoFile(content: Buffer | ReadStream, key: string): Promise<string> {
  const target = filePath(key)
  await mkdir(dirname(target), { recursive: true })
  if (Buffer.isBuffer(content)) await writeFile(target, content)
  else {
    const chunks: Buffer[] = []
    for await (const chunk of content) chunks.push(Buffer.from(chunk))
    await writeFile(target, Buffer.concat(chunks))
  }
  return demoFileUrl(key)
}

export async function readDemoFile(key: string): Promise<Buffer> {
  return readFile(filePath(key))
}

export async function deleteDemoFile(key: string): Promise<void> {
  await rm(filePath(key), { force: true })
}
