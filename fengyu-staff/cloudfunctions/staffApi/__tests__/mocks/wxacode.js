/**
 * wxacode mock — 小程序码生成工具模拟
 */
module.exports = {
  generateWxacode: jest.fn(async () => Buffer.from('fake-qrcode-png')),
  uploadToCloudStorage: jest.fn(async () => 'cloud://mock-file-id/wxacode.png'),
}
