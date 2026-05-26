/**
 * Playwright globalTeardown（e2e-pages）。清理 globalSetup 产出的详情夹具 + 临时文件。
 */
import fs from 'node:fs'
import path from 'node:path'
import { cleanupDetailFixtures } from './fixtures/seed-detail-fixtures'

function loadDatabaseUrlFromEnvLocal(): void {
  if (process.env.DATABASE_URL || process.env.PG_CONNECTION_STRING) return
  const envPath = path.resolve(process.cwd(), '.env.local')
  try {
    const txt = fs.readFileSync(envPath, 'utf8')
    for (const raw of txt.split('\n')) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const m = line.match(/^DATABASE_URL\s*=\s*(.*)$/)
      if (m) {
        process.env.DATABASE_URL = m[1].trim().replace(/^["']|["']$/g, '')
        break
      }
    }
  } catch {
    /* ignore */
  }
}

export default async function globalTeardown() {
  loadDatabaseUrlFromEnvLocal()
  try {
    await cleanupDetailFixtures()
    console.log('[e2e globalTeardown] 详情夹具已清理')
  } catch (e) {
    console.warn('[e2e globalTeardown] 清理失败（忽略）:', (e as Error).message)
  }
}
