import { afterEach, it, expect, vi } from 'vitest'
import { demoFileUrl, verifyDemoFileUrl, readDemoFile } from './demo-storage'

afterEach(() => vi.unstubAllEnvs())
it('文件签名绑定路径与有效期，拒绝篡改', () => {
  vi.stubEnv('JWT_SECRET','test-secret')
  const key='admin/exports/1/报表.xlsx'
  const url=new URL(demoFileUrl(key,true))
  expect(verifyDemoFileUrl(key,url)).toBe(true)
  expect(verifyDemoFileUrl('admin/exports/2/报表.xlsx',url)).toBe(false)
  url.searchParams.set('expires','1')
  expect(verifyDemoFileUrl(key,url)).toBe(false)
})
it('拒绝目录逃逸', async () => {
  expect(() => demoFileUrl('../admin.env')).toThrow()
  await expect(readDemoFile('uploads/../../admin.env')).rejects.toThrow()
})
