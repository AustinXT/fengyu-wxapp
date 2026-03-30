'use server'

import { db } from '@/db'
import { sql } from 'drizzle-orm'
import { getSession } from '@/lib/auth'
import { requirePermission } from '@/lib/permissions'
import { logOperation } from '@/lib/operation-log'

interface SystemSettings {
  newMemberThreshold: string
  orderTimeout: string
  bannerImages: string[]
  fengyuguanImage: string
}

const DEFAULT_SETTINGS: SystemSettings = {
  newMemberThreshold: '1980',
  orderTimeout: '10',
  bannerImages: [],
  fengyuguanImage: '',
}

export async function getSettings(): Promise<SystemSettings> {
  const session = await getSession()
  requirePermission(session, 'system:config')

  try {
    const rows = await db.execute<{ key: string; value: string }>(sql`
      SELECT key, value FROM system_configs
      WHERE key IN ('new_member_threshold', 'order_timeout', 'banner_images', 'fengyuguan_image')
    `)

    const settings = { ...DEFAULT_SETTINGS }
    for (const row of rows as any[]) {
      if (row.key === 'new_member_threshold') settings.newMemberThreshold = row.value
      if (row.key === 'order_timeout') settings.orderTimeout = row.value
      if (row.key === 'banner_images') {
        try { settings.bannerImages = JSON.parse(row.value) } catch { /* keep default */ }
      }
      if (row.key === 'fengyuguan_image') settings.fengyuguanImage = row.value
    }
    return settings
  } catch {
    return DEFAULT_SETTINGS
  }
}

export async function saveSettings(settings: SystemSettings): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'system:config')

  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS system_configs (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `)

    const entries = [
      { key: 'new_member_threshold', value: settings.newMemberThreshold },
      { key: 'order_timeout', value: settings.orderTimeout },
      { key: 'banner_images', value: JSON.stringify(settings.bannerImages) },
      { key: 'fengyuguan_image', value: settings.fengyuguanImage },
    ]

    for (const entry of entries) {
      await db.execute(sql`
        INSERT INTO system_configs (key, value, updated_at)
        VALUES (${entry.key}, ${entry.value}, NOW())
        ON CONFLICT (key) DO UPDATE SET value = ${entry.value}, updated_at = NOW()
      `)
    }

    await logOperation(session, 'system.saveConfig', 'system_config', 'all', settings as unknown as Record<string, unknown>)

    const { revalidatePath } = await import('next/cache')
    revalidatePath('/settings')
    return { success: true, message: '配置保存成功' }
  } catch (err) {
    console.error('Save settings error:', err)
    return { success: false, message: '保存失败，请稍后重试' }
  }
}
