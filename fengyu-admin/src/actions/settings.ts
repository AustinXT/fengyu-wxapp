'use server'

import { db } from '@/db'
import { sql } from 'drizzle-orm'
import { getSession } from '@/lib/auth'
import { requirePermission } from '@/lib/permissions'
import { logUpdate } from '@/lib/operation-log'
import { uploadFile, reuploadToFixedPath, deleteByCloudPaths, callClientFunction } from '@/lib/cloudbase'
import { invalidateMemberThreshold } from '@/lib/member-threshold'

/**
 * 单个等级的权益配置
 */
export interface MemberLevelBenefit {
  /** 升级时奖励积分（整数，0 表示不发） */
  points: number
  /** 升级时发放的优惠券模板 ID 数组（templateId 来自 coupon_templates） */
  couponTemplateIds: string[]
  /** 升级消息标题（空字符串表示不发消息） */
  messageTitle: string
  /** 升级消息正文 */
  messageBody: string
}

/** 五个钻石等级的权益配置映射 */
export type MemberLevelBenefitsMap = Record<
  '初钻' | '星钻' | '粉钻' | '金钻' | '黑钻',
  MemberLevelBenefit
>

interface SystemSettings {
  newMemberThreshold: string
  orderTimeout: string
  bannerImages: string[]
  fengyuguanImage: string
  memberLevelBenefits: MemberLevelBenefitsMap
}

const DEFAULT_BENEFIT: MemberLevelBenefit = {
  points: 0,
  couponTemplateIds: [],
  messageTitle: '',
  messageBody: '',
}

const DEFAULT_MEMBER_LEVEL_BENEFITS: MemberLevelBenefitsMap = {
  初钻: { ...DEFAULT_BENEFIT },
  星钻: { ...DEFAULT_BENEFIT },
  粉钻: { ...DEFAULT_BENEFIT },
  金钻: { ...DEFAULT_BENEFIT },
  黑钻: { ...DEFAULT_BENEFIT },
}

const DEFAULT_SETTINGS: SystemSettings = {
  newMemberThreshold: '1980',
  orderTimeout: '10',
  bannerImages: [],
  fengyuguanImage: '',
  memberLevelBenefits: DEFAULT_MEMBER_LEVEL_BENEFITS,
}

/**
 * 规范化用户提交的权益配置：
 * - 缺失等级用 DEFAULT_BENEFIT 补齐
 * - points 转 number 并裁剪为非负整数
 * - couponTemplateIds 去重 + 过滤空值
 * - 文案 trim
 */
function normalizeBenefits(input: unknown): MemberLevelBenefitsMap {
  const result: MemberLevelBenefitsMap = { ...DEFAULT_MEMBER_LEVEL_BENEFITS }
  if (!input || typeof input !== 'object') return result

  for (const level of ['初钻', '星钻', '粉钻', '金钻', '黑钻'] as const) {
    const raw = (input as Record<string, unknown>)[level]
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const points = Math.max(0, Math.floor(Number(r.points) || 0))
    const couponTemplateIds = Array.isArray(r.couponTemplateIds)
      ? [...new Set(r.couponTemplateIds.map((id) => String(id).trim()).filter(Boolean))]
      : []
    result[level] = {
      points,
      couponTemplateIds,
      messageTitle: typeof r.messageTitle === 'string' ? r.messageTitle.trim() : '',
      messageBody: typeof r.messageBody === 'string' ? r.messageBody.trim() : '',
    }
  }
  return result
}

export async function getSettings(): Promise<SystemSettings> {
  const session = await getSession()
  requirePermission(session, 'system:config')

  try {
    const rows = await db.execute<{ key: string; value: string }>(sql`
      SELECT key, value FROM system_configs
      WHERE key IN ('new_member_threshold', 'order_timeout', 'banner_images', 'fengyuguan_image', 'member_level_benefits')
    `)

    const settings: SystemSettings = {
      ...DEFAULT_SETTINGS,
      memberLevelBenefits: { ...DEFAULT_MEMBER_LEVEL_BENEFITS },
    }
    for (const row of rows as any[]) {
      if (row.key === 'new_member_threshold') settings.newMemberThreshold = row.value
      if (row.key === 'order_timeout') settings.orderTimeout = row.value
      if (row.key === 'banner_images') {
        try { settings.bannerImages = JSON.parse(row.value) } catch { /* keep default */ }
      }
      if (row.key === 'fengyuguan_image') settings.fengyuguanImage = row.value
      if (row.key === 'member_level_benefits') {
        try { settings.memberLevelBenefits = normalizeBenefits(JSON.parse(row.value)) } catch { /* keep default */ }
      }
    }
    return settings
  } catch {
    return { ...DEFAULT_SETTINGS, memberLevelBenefits: { ...DEFAULT_MEMBER_LEVEL_BENEFITS } }
  }
}

export async function saveSettings(settings: SystemSettings): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'system:config')

  try {
    const oldSettings = await getSettings()

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS system_configs (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `)

    const normalizedBenefits = normalizeBenefits(settings.memberLevelBenefits)

    const entries = [
      { key: 'new_member_threshold', value: settings.newMemberThreshold },
      { key: 'order_timeout', value: settings.orderTimeout },
      { key: 'banner_images', value: JSON.stringify(settings.bannerImages) },
      { key: 'fengyuguan_image', value: settings.fengyuguanImage },
      { key: 'member_level_benefits', value: JSON.stringify(normalizedBenefits) },
    ]

    for (const entry of entries) {
      await db.execute(sql`
        INSERT INTO system_configs (key, value, updated_at)
        VALUES (${entry.key}, ${entry.value}, NOW())
        ON CONFLICT (key) DO UPDATE SET value = ${entry.value}, updated_at = NOW()
      `)
    }

    // 将轮播图重新上传到固定 CDN 路径 (banner1.jpg, banner2.jpg, ...)
    const bannerUrls = settings.bannerImages || []
    const newCount = bannerUrls.length
    await Promise.all(
      bannerUrls.map((url, i) =>
        reuploadToFixedPath(url, `fengyu-client/banner/banner${i + 1}.jpg`)
      )
    )

    // 读取旧的 banner_count，删除多余的旧固定路径图片
    const oldCountRows = await db.execute<{ value: string }>(sql`
      SELECT value FROM system_configs WHERE key = 'banner_count'
    `)
    const oldCount = parseInt((oldCountRows as any[])[0]?.value || '0', 10) || 0
    if (oldCount > newCount) {
      const pathsToDelete = Array.from(
        { length: oldCount - newCount },
        (_, i) => `fengyu-client/banner/banner${newCount + i + 1}.jpg`
      )
      await deleteByCloudPaths(pathsToDelete)
    }

    // 上传 config.json 到 CDN（client 端读取此文件获取轮播图数量和版本号）
    const configJson = Buffer.from(JSON.stringify({ count: newCount, v: Date.now() }))
    await uploadFile(configJson, 'fengyu-client/banner/config.json')

    // 保存 banner_count
    await db.execute(sql`
      INSERT INTO system_configs (key, value, updated_at)
      VALUES ('banner_count', ${String(newCount)}, NOW())
      ON CONFLICT (key) DO UPDATE SET value = ${String(newCount)}, updated_at = NOW()
    `)

    await logUpdate(
      session,
      'system.saveConfig',
      'system_config',
      'all',
      oldSettings as unknown as Record<string, unknown>,
      { ...settings, memberLevelBenefits: normalizedBenefits } as unknown as Record<string, unknown>,
    )

    // 会员门槛变化时，主动失效 admin 自身 + clientApi 内存缓存
    // staffApi / cronTask 在另一个 envId，依赖 utils/config 的被动 updated_at 戳核对（30 秒内生效）
    if (oldSettings.newMemberThreshold !== settings.newMemberThreshold) {
      invalidateMemberThreshold()
      await Promise.allSettled([
        callClientFunction('clientApi', { action: 'config.invalidateConfig' }),
      ]).then((results) => {
        for (const r of results) {
          if (r.status === 'rejected') {
            console.warn('Broadcast invalidateConfig failed:', r.reason)
          }
        }
      })
    }

    const { revalidatePath } = await import('next/cache')
    revalidatePath('/settings')
    return { success: true, message: '配置保存成功' }
  } catch (err) {
    console.error('Save settings error:', err)
    return { success: false, message: '保存失败，请稍后重试' }
  }
}

/**
 * 加载所有有效的优惠券模板（用于权益配置中的多选下拉）
 */
export async function listActiveCouponTemplates(): Promise<Array<{ templateId: string; name: string }>> {
  const session = await getSession()
  requirePermission(session, 'system:config')

  const rows = await db.execute<{ template_id: string; name: string }>(sql`
    SELECT template_id, name FROM coupon_templates
    WHERE is_active = true
    ORDER BY created_at DESC
    LIMIT 200
  `)
  return (rows as any[]).map((r) => ({ templateId: r.template_id, name: r.name }))
}
