import forge from 'node-forge'


export function encryptPassword(plain: string): string {
  const pubB64 = process.env.NEXT_PUBLIC_RSA_PUBLIC_KEY
  if (!pubB64) {
    throw new Error('密码加密未配置（缺少 NEXT_PUBLIC_RSA_PUBLIC_KEY）')
  }

  const pem = atob(pubB64)
  const publicKey = forge.pki.publicKeyFromPem(pem)
  
  const encrypted = publicKey.encrypt(forge.util.encodeUtf8(plain), 'RSA-OAEP', {
    md: forge.md.sha256.create(),
    mgf1: { md: forge.md.sha256.create() },
  })
  return forge.util.encode64(encrypted)
}
