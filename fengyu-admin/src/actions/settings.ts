'use server'

import { db } from '@/db'
import { sql } from 'drizzle-orm'
import { withPermission } from '@/lib/with-permission'
import { logUpdate } from '@/lib/operation-log'
import { uploadFile, reuploadToFixedPath, deleteByCloudPaths, callClientFunction } from '@/lib/cloudbase'
import { invalidateMemberThreshold } from '@/lib/member-threshold'
import {
  type ShareGiftConfig,
  DEFAULT_SHARE_GIFT_CONFIG,
  normalizeShareGiftConfig,
} from '@/lib/share-gift-config'
import { rechargeCardConfigSchema, type RechargeCardConfigInput } from '@/lib/schemas'
import { clampCouponQuantity } from '@/lib/coupon-quantity'
import {
  type ConsumeAgreementConfig,
  DEFAULT_CONSUME_AGREEMENT,
  normalizeConsumeAgreement,
} from '@/lib/consume-agreement'

export type { ShareGiftConfig }
export type { RechargeCardConfigInput }
export type { ConsumeAgreementConfig }

/**
 * 单个等级的权益配置
 */
export interface MemberLevelBenefit {
  /** 奖励积分（整数，0 表示不发） */
  points: number
  /** 发放的优惠券模板 ID 数组（templateId 来自 coupon_templates） */
  couponTemplateIds: string[]
  /** 每个模板的发放数量（templateId → 张数，值域 [1, 99]）。缺省=1，兼容无此字段的旧配置 */
  couponQuantities: Record<string, number>
  /** 消息标题（空字符串表示不发消息） */
  messageTitle: string
  /** 消息正文 */
  messageBody: string
}

/** 五个钻石等级的权益配置映射 */
export type MemberLevelBenefitsMap = Record<
  '初钻' | '星钻' | '粉钻' | '金钻' | '黑钻',
  MemberLevelBenefit
>

/** 会员权益的三种场景 */
export type BenefitScenario = 'upgrade' | 'birthday' | 'thanksgiving'

/** 三种场景下的权益配置 */
export interface MemberBenefitsBundle {
  upgrade: MemberLevelBenefitsMap
  birthday: MemberLevelBenefitsMap
  thanksgiving: MemberLevelBenefitsMap
}

interface SystemSettings {
  newMemberThreshold: string
  orderTimeout: string
  bannerImages: string[]
  fengyuguanImage: string
  serviceHotline: string
  /** 积分抵扣上限比例（文本小数，0.03=3%）。值域 [0,1]，保存时 clamp。 */
  pointsDeductionMaxRate: string
}

const DEFAULT_BENEFIT: MemberLevelBenefit = {
  points: 0,
  couponTemplateIds: [],
  couponQuantities: {},
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
  serviceHotline: '',
  pointsDeductionMaxRate: '0.03',
}

const SCENARIO_CONFIG_KEY: Record<BenefitScenario, string> = {
  upgrade: 'member_level_benefits',
  birthday: 'birthday_benefits',
  thanksgiving: 'thanksgiving_benefits',
}

function emptyBenefits(): MemberLevelBenefitsMap {
  return {
    初钻: { ...DEFAULT_BENEFIT },
    星钻: { ...DEFAULT_BENEFIT },
    粉钻: { ...DEFAULT_BENEFIT },
    金钻: { ...DEFAULT_BENEFIT },
    黑钻: { ...DEFAULT_BENEFIT },
  }
}

/**
 * 规范化用户提交的权益配置：
 * - 缺失等级用 DEFAULT_BENEFIT 补齐
 * - points 转 number 并裁剪为非负整数
 * - couponTemplateIds 去重 + 过滤空值
 * - 文案 trim
 */
function normalizeBenefits(input: unknown): MemberLevelBenefitsMap {
  const result = emptyBenefits()
  if (!input || typeof input !== 'object') return result

  for (const level of ['初钻', '星钻', '粉钻', '金钻', '黑钻'] as const) {
    const raw = (input as Record<string, unknown>)[level]
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const points = Math.max(0, Math.floor(Number(r.points) || 0))
    const couponTemplateIds = Array.isArray(r.couponTemplateIds)
      ? [...new Set(r.couponTemplateIds.map((id) => String(id).trim()).filter(Boolean))]
      : []
    // 每个选中模板的发放数量：读 raw.couponQuantities[id] 并 clamp 到 [1,99]，缺省/非法=1。
    // 仅保留 couponTemplateIds 中的 key，丢弃历史残留；兼容无此字段的旧 JSON。
    const rawQty =
      r.couponQuantities && typeof r.couponQuantities === 'object'
        ? (r.couponQuantities as Record<string, unknown>)
        : {}
    const couponQuantities: Record<string, number> = {}
    for (const id of couponTemplateIds) {
      couponQuantities[id] = clampCouponQuantity(rawQty[id])
    }
    result[level] = {
      points,
      couponTemplateIds,
      couponQuantities,
      messageTitle: typeof r.messageTitle === 'string' ? r.messageTitle.trim() : '',
      messageBody: typeof r.messageBody === 'string' ? r.messageBody.trim() : '',
    }
  }
  return result
}

export const getSettings = withPermission(
  'system:config',
  async (): Promise<SystemSettings> => {
  try {
    const rows = await db.execute<{ key: string; value: string }>(sql`
      SELECT key, value FROM system_configs
      WHERE key IN ('new_member_threshold', 'order_timeout', 'banner_images', 'fengyuguan_image', 'service_hotline', 'points_deduction_max_rate')
    `)

    const settings: SystemSettings = { ...DEFAULT_SETTINGS }
    for (const row of rows as any[]) {
      if (row.key === 'new_member_threshold') settings.newMemberThreshold = row.value
      if (row.key === 'order_timeout') settings.orderTimeout = row.value
      if (row.key === 'banner_images') {
        try { settings.bannerImages = JSON.parse(row.value) } catch { /* keep default */ }
      }
      if (row.key === 'fengyuguan_image') settings.fengyuguanImage = row.value
      if (row.key === 'service_hotline') settings.serviceHotline = row.value
      if (row.key === 'points_deduction_max_rate') settings.pointsDeductionMaxRate = row.value
    }
    return settings
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
  },
)

export const saveSettings = withPermission(
  'system:config',
  async (session, settings: SystemSettings): Promise<{ success: boolean; message: string }> => {
  try {
    const oldSettings = await getSettings()

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS system_configs (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `)

    // 积分抵扣比例 clamp 到 [0,1]，非法值降级为默认 0.03（与 lib/system-config 口径一致）
    const deductRateNum = Number(settings.pointsDeductionMaxRate)
    const deductRateValue = Number.isFinite(deductRateNum) && deductRateNum >= 0 && deductRateNum <= 1
      ? String(deductRateNum)
      : '0.03'

    const entries = [
      { key: 'new_member_threshold', value: settings.newMemberThreshold },
      { key: 'order_timeout', value: settings.orderTimeout },
      { key: 'banner_images', value: JSON.stringify(settings.bannerImages) },
      { key: 'fengyuguan_image', value: settings.fengyuguanImage },
      { key: 'service_hotline', value: settings.serviceHotline.trim() },
      { key: 'points_deduction_max_rate', value: deductRateValue },
    ]

    for (const entry of entries) {
      await db.execute(sql`
        INSERT INTO system_configs (key, value, updated_at)
        VALUES (${entry.key}, ${entry.value}, NOW())
        ON CONFLICT (key) DO UPDATE SET value = ${entry.value}, updated_at = NOW()
      `)
    }

    // 凤御馆图 reupload 到固定路径，确保落到当前环境桶（与 banner 一致）。
    // 配合 reuploadToFixedPath 的整 URL 跳过逻辑：源指向别的桶（如 dev）时会重传到本环境桶。
    if (settings.fengyuguanImage) {
      await reuploadToFixedPath(settings.fengyuguanImage, 'images/fengyuguan.jpg')
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
      settings as unknown as Record<string, unknown>,
    )

    // 会员门槛 / 积分抵扣比例变化时，主动失效缓存：
    //   - invalidateMemberThreshold 仅清 admin 自身 member threshold 缓存（deduct rate 在 admin 侧无缓存，直读）
    //   - 广播 invalidateConfig 清 clientApi 整个 utils/config 缓存（含两个配置的缓存）
    // staffApi / payNotify 在另一个 envId，依赖 utils/config 的被动 updated_at 戳核对（30 秒内生效）
    const thresholdChanged = oldSettings.newMemberThreshold !== settings.newMemberThreshold
    const deductRateChanged = oldSettings.pointsDeductionMaxRate !== deductRateValue
    if (thresholdChanged || deductRateChanged) {
      if (thresholdChanged) invalidateMemberThreshold()
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
  },
)

/**
 * 加载所有有效的优惠券模板（用于权益配置中的多选下拉）
 */
export const listActiveCouponTemplates = withPermission(
  'system:config',
  async (): Promise<Array<{ templateId: string; name: string }>> => {
  const rows = await db.execute<{ template_id: string; name: string }>(sql`
    SELECT template_id, name FROM coupon_templates
    WHERE is_active = true
    ORDER BY created_at DESC
  `)
  return (rows as any[]).map((r) => ({ templateId: r.template_id, name: r.name }))
  },
)

/**
 * 读取三种场景（升级/生日/感恩日）的会员权益配置。
 * 任一场景缺失或 JSON 损坏静默降级为默认空值。
 */
export const getMemberBenefits = withPermission(
  'system:config',
  async (): Promise<MemberBenefitsBundle> => {
  const bundle: MemberBenefitsBundle = {
    upgrade: emptyBenefits(),
    birthday: emptyBenefits(),
    thanksgiving: emptyBenefits(),
  }

  try {
    const rows = await db.execute<{ key: string; value: string }>(sql`
      SELECT key, value FROM system_configs
      WHERE key IN ('member_level_benefits', 'birthday_benefits', 'thanksgiving_benefits')
    `)
    for (const row of rows as any[]) {
      const scenario = (Object.keys(SCENARIO_CONFIG_KEY) as BenefitScenario[]).find(
        (s) => SCENARIO_CONFIG_KEY[s] === row.key,
      )
      if (!scenario) continue
      try {
        bundle[scenario] = normalizeBenefits(JSON.parse(row.value))
      } catch {
        // keep default
      }
    }
  } catch {
    // DB 未建表 → 返回空默认
  }

  return bundle
  },
)

// ─── 分享礼运营配置（ticket 2026-04-24 share-gift-reward PR-2） ───

const SHARE_GIFT_CONFIG_KEY = 'share_gift_config'

/**
 * 读取分享礼配置。
 * 行缺失 / JSON 损坏均降级为 DEFAULT_SHARE_GIFT_CONFIG。
 */
export const getShareGiftConfig = withPermission(
  'system:config',
  async (): Promise<ShareGiftConfig> => {
  try {
    const rows = await db.execute<{ value: string }>(sql`
      SELECT value FROM system_configs WHERE key = ${SHARE_GIFT_CONFIG_KEY} LIMIT 1
    `)
    const raw = (rows as any[])[0]?.value
    if (!raw) return { ...DEFAULT_SHARE_GIFT_CONFIG }
    try {
      return normalizeShareGiftConfig(JSON.parse(raw))
    } catch {
      return { ...DEFAULT_SHARE_GIFT_CONFIG }
    }
  } catch {
    return { ...DEFAULT_SHARE_GIFT_CONFIG }
  }
  },
)

/**
 * 保存分享礼配置（UPSERT system_configs）。
 * 规范化 + 审计日志 + revalidatePath('/share-gift')。
 */
export const saveShareGiftConfig = withPermission(
  'system:config',
  async (
    session,
    config: ShareGiftConfig,
  ): Promise<{ success: boolean; message: string }> => {
  try {
    const oldConfig = await getShareGiftConfig()
    const normalized = normalizeShareGiftConfig(config)

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS system_configs (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `)

    const value = JSON.stringify(normalized)
    await db.execute(sql`
      INSERT INTO system_configs (key, value, updated_at)
      VALUES (${SHARE_GIFT_CONFIG_KEY}, ${value}, NOW())
      ON CONFLICT (key) DO UPDATE SET value = ${value}, updated_at = NOW()
    `)

    await logUpdate(
      session,
      'system.saveShareGiftConfig',
      'system_config',
      'share_gift',
      oldConfig as unknown as Record<string, unknown>,
      normalized as unknown as Record<string, unknown>,
    )

    const { revalidatePath } = await import('next/cache')
    revalidatePath('/share-gift')
    return { success: true, message: '分享礼配置已保存' }
  } catch (err) {
    console.error('Save share gift config error:', err)
    return { success: false, message: '保存失败，请稍后重试' }
  }
  },
)

/**
 * 保存三种场景的会员权益配置（一次性写入三份 JSON）。
 * 权益变更不影响 newMemberThreshold 缓存广播逻辑。
 */
export const saveMemberBenefits = withPermission(
  'system:config',
  async (
    session,
    bundle: MemberBenefitsBundle,
  ): Promise<{ success: boolean; message: string }> => {
  try {
    const oldBundle = await getMemberBenefits()

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS system_configs (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `)

    const normalized: MemberBenefitsBundle = {
      upgrade: normalizeBenefits(bundle.upgrade),
      birthday: normalizeBenefits(bundle.birthday),
      thanksgiving: normalizeBenefits(bundle.thanksgiving),
    }

    const entries: Array<{ key: string; value: string }> = [
      { key: SCENARIO_CONFIG_KEY.upgrade, value: JSON.stringify(normalized.upgrade) },
      { key: SCENARIO_CONFIG_KEY.birthday, value: JSON.stringify(normalized.birthday) },
      { key: SCENARIO_CONFIG_KEY.thanksgiving, value: JSON.stringify(normalized.thanksgiving) },
    ]

    for (const entry of entries) {
      await db.execute(sql`
        INSERT INTO system_configs (key, value, updated_at)
        VALUES (${entry.key}, ${entry.value}, NOW())
        ON CONFLICT (key) DO UPDATE SET value = ${entry.value}, updated_at = NOW()
      `)
    }

    await logUpdate(
      session,
      'system.saveMemberBenefits',
      'system_config',
      'member_benefits',
      oldBundle as unknown as Record<string, unknown>,
      normalized as unknown as Record<string, unknown>,
    )

    const { revalidatePath } = await import('next/cache')
    revalidatePath('/member-benefits')
    return { success: true, message: '会员权益保存成功' }
  } catch (err) {
    console.error('Save member benefits error:', err)
    return { success: false, message: '保存失败，请稍后重试' }
  }
  },
)

// ─── 充值卡档位配置（系统配置 → 充值卡配置 Tab；存 system_configs.recharge.*） ───

const DEFAULT_RECHARGE_CARD_CONFIG: RechargeCardConfigInput = {
  tiers: [],
  minAmount: 100,
  maxAmount: 50000,
}

/**
 * 读取充值卡档位配置（faceValue/payAmount 列表 + min/max）。
 * 缺失或 JSON 损坏静默降级为默认空配置（不抛错，保证设置页可渲染）。
 */
export const getRechargeCardConfig = withPermission(
  'system:config',
  async (): Promise<RechargeCardConfigInput> => {
  try {
    const rows = await db.execute<{ key: string; value: string }>(sql`
      SELECT key, value FROM system_configs
      WHERE key IN ('recharge.tiers', 'recharge.minAmount', 'recharge.maxAmount')
    `)
    const cfg: Record<string, string> = {}
    for (const row of rows as any[]) cfg[row.key] = row.value

    const result: RechargeCardConfigInput = { ...DEFAULT_RECHARGE_CARD_CONFIG, tiers: [] }
    if (cfg['recharge.tiers']) {
      try {
        const parsed = JSON.parse(cfg['recharge.tiers'])
        if (Array.isArray(parsed)) {
          result.tiers = parsed
            .filter((t) => t && typeof t.faceValue === 'number' && typeof t.payAmount === 'number')
            .map((t) => ({ faceValue: t.faceValue, payAmount: t.payAmount }))
            .sort((a, b) => a.faceValue - b.faceValue)
        }
      } catch { /* keep empty */ }
    }
    if (cfg['recharge.minAmount']) {
      const n = Number(cfg['recharge.minAmount'])
      if (Number.isFinite(n) && n > 0) result.minAmount = n
    }
    if (cfg['recharge.maxAmount']) {
      const n = Number(cfg['recharge.maxAmount'])
      if (Number.isFinite(n) && n > 0) result.maxAmount = n
    }
    return result
  } catch {
    return { ...DEFAULT_RECHARGE_CARD_CONFIG, tiers: [] }
  }
  },
)

/**
 * 保存充值卡档位配置（Zod 校验 + 规范化 + UPSERT 三个键 + 审计日志）。
 * 三端（admin/staff/client）读同源 system_configs.recharge.* 行保持一致。
 */
export const saveRechargeCardConfig = withPermission(
  'system:config',
  async (
    session,
    config: RechargeCardConfigInput,
  ): Promise<{ success: boolean; message: string }> => {
  try {
    const parsed = rechargeCardConfigSchema.safeParse(config)
    if (!parsed.success) {
      return { success: false, message: parsed.error.issues[0]?.message || '配置校验失败' }
    }

    // 规范化：金额保留 2 位小数 + 按面额升序
    const round2 = (n: number) => Math.round(n * 100) / 100
    const tiers = parsed.data.tiers
      .map((t) => ({ faceValue: round2(t.faceValue), payAmount: round2(t.payAmount) }))
      .sort((a, b) => a.faceValue - b.faceValue)
    const minAmount = round2(parsed.data.minAmount)
    const maxAmount = round2(parsed.data.maxAmount)

    const oldConfig = await getRechargeCardConfig()

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS system_configs (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `)

    const entries: Array<{ key: string; value: string }> = [
      { key: 'recharge.tiers', value: JSON.stringify(tiers) },
      { key: 'recharge.minAmount', value: String(minAmount) },
      { key: 'recharge.maxAmount', value: String(maxAmount) },
    ]
    for (const entry of entries) {
      await db.execute(sql`
        INSERT INTO system_configs (key, value, updated_at)
        VALUES (${entry.key}, ${entry.value}, NOW())
        ON CONFLICT (key) DO UPDATE SET value = ${entry.value}, updated_at = NOW()
      `)
    }

    await logUpdate(
      session,
      'system.saveRechargeConfig',
      'system_config',
      'recharge',
      oldConfig as unknown as Record<string, unknown>,
      { tiers, minAmount, maxAmount } as unknown as Record<string, unknown>,
    )

    const { revalidatePath } = await import('next/cache')
    revalidatePath('/settings')
    return { success: true, message: '充值卡配置保存成功' }
  } catch (err) {
    console.error('Save recharge card config error:', err)
    return { success: false, message: '保存失败，请稍后重试' }
  }
  },
)

// ─── 消费协议配置（系统配置 → 消费协议 Tab；存 system_configs.consume_agreement） ───

const CONSUME_AGREEMENT_KEY = 'consume_agreement'

/**
 * 读取消费协议配置（标题 + 正文）。
 * 行缺失 / JSON 损坏均降级为 DEFAULT_CONSUME_AGREEMENT（含默认文案）。
 */
export const getConsumeAgreement = withPermission(
  'system:config',
  async (): Promise<ConsumeAgreementConfig> => {
  try {
    const rows = await db.execute<{ value: string }>(sql`
      SELECT value FROM system_configs WHERE key = ${CONSUME_AGREEMENT_KEY} LIMIT 1
    `)
    const raw = (rows as any[])[0]?.value
    if (!raw) return { ...DEFAULT_CONSUME_AGREEMENT }
    try {
      return normalizeConsumeAgreement(JSON.parse(raw))
    } catch {
      return { ...DEFAULT_CONSUME_AGREEMENT }
    }
  } catch {
    return { ...DEFAULT_CONSUME_AGREEMENT }
  }
  },
)

/**
 * 保存消费协议配置（规范化 + UPSERT system_configs + 审计日志 + revalidate）。
 * 顾客端 clientApi config.consumeAgreement 读同键，保存后下次拉取即生效（无内存缓存）。
 */
export const saveConsumeAgreement = withPermission(
  'system:config',
  async (
    session,
    config: ConsumeAgreementConfig,
  ): Promise<{ success: boolean; message: string }> => {
  try {
    const oldConfig = await getConsumeAgreement()
    const normalized = normalizeConsumeAgreement(config)

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS system_configs (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `)

    const value = JSON.stringify(normalized)
    await db.execute(sql`
      INSERT INTO system_configs (key, value, updated_at)
      VALUES (${CONSUME_AGREEMENT_KEY}, ${value}, NOW())
      ON CONFLICT (key) DO UPDATE SET value = ${value}, updated_at = NOW()
    `)

    await logUpdate(
      session,
      'system.saveConsumeAgreement',
      'system_config',
      'consume_agreement',
      oldConfig as unknown as Record<string, unknown>,
      normalized as unknown as Record<string, unknown>,
    )

    const { revalidatePath } = await import('next/cache')
    revalidatePath('/settings')
    return { success: true, message: '消费协议已保存' }
  } catch (err) {
    console.error('Save consume agreement error:', err)
    return { success: false, message: '保存失败，请稍后重试' }
  }
  },
)
