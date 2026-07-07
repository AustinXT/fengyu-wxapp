import 'server-only'
import { constants, privateDecrypt } from 'crypto'


export function decryptPassword(ciphertextB64: string): string {
  const keyB64 = process.env.RSA_PRIVATE_KEY
  if (!keyB64) {
    
    throw new Error('INVALID_STATE: 密码加密未配置（缺少 RSA_PRIVATE_KEY）')
  }

  const privateKey = Buffer.from(keyB64, 'base64').toString('utf8')
  const decrypted = privateDecrypt(
    { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(ciphertextB64, 'base64'),
  )
  return decrypted.toString('utf8')
}
