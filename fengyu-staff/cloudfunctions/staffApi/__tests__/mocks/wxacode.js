/**
 * wxacode mock — 小程序码生成工具模拟
 */
module.exports = {
  generateWxacode: vi.fn(async () => Buffer.from('fake-qrcode-png')),
  uploadToCloudStorage: vi.fn(async () => 'cloud://mock-file-id/wxacode.png'),
  // 纯函数，保留真实语义（按正式函数身份 self=release）
  effectiveEnvVersion: vi.fn((v) => (['develop', 'trial', 'release'].includes(v) ? v : 'release')),
  versionPathSuffix: vi.fn((v) => (v === 'release' ? '' : `-${v}`)),
  getSelfEnvVersion: vi.fn(() => 'release'),
}
