/**
 * system_configs 安全注入/还原（针对 cron e2e）。
 *
 * 用法：
 *   const restore = backupAndSetConfig('birthday_benefits', { 星钻: {...} })
 *   try { ... 跑测试 ... } finally { restore() }
 *
 * 设计要点：
 *   - 备份原 value JSON 到内存（每个 key 一份）
 *   - 注入测试 value（JSON.stringify 写入）
 *   - 还原：若原 key 不存在 → DELETE；存在 → UPDATE 回原 value
 *   - 同 key 多次 backup 用最早的快照（避免嵌套还原后丢失原值）
 */

import { psql } from './cron-runner'

const SNAPSHOTS = new Map<string, string | null>() // null 表示原 key 不存在

/**
 * 备份并设置 system_configs[key] = JSON.stringify(value)。
 * 返回 restore 函数。
 */
export function backupAndSetConfig(key: string, value: unknown): () => void {
  // 首次备份才记快照
  if (!SNAPSHOTS.has(key)) {
    const existing = psql(`SELECT value::text FROM system_configs WHERE key = '${key}'`)
    SNAPSHOTS.set(key, existing.length > 0 ? existing : null)
  }
  const json = JSON.stringify(value).replace(/'/g, "''")
  psql(`
    INSERT INTO system_configs (key, value, updated_at)
    VALUES ('${key}', '${json}'::jsonb, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `)
  return () => restoreConfig(key)
}

/**
 * 强制删除 system_configs[key]，用于测试"配置缺失"分支。
 * 备份原 value，返回 restore 函数。
 */
export function backupAndDeleteConfig(key: string): () => void {
  if (!SNAPSHOTS.has(key)) {
    const existing = psql(`SELECT value::text FROM system_configs WHERE key = '${key}'`)
    SNAPSHOTS.set(key, existing.length > 0 ? existing : null)
  }
  psql(`DELETE FROM system_configs WHERE key = '${key}'`)
  return () => restoreConfig(key)
}

function restoreConfig(key: string): void {
  if (!SNAPSHOTS.has(key)) return
  const original = SNAPSHOTS.get(key)
  if (original === null) {
    psql(`DELETE FROM system_configs WHERE key = '${key}'`)
  } else {
    const escaped = (original ?? '').replace(/'/g, "''")
    psql(`
      INSERT INTO system_configs (key, value, updated_at)
      VALUES ('${key}', '${escaped}'::jsonb, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `)
  }
  SNAPSHOTS.delete(key)
}

/** 全部还原（spec.afterAll 兜底）。 */
export function restoreAllConfigs(): void {
  for (const key of [...SNAPSHOTS.keys()]) {
    restoreConfig(key)
  }
}
