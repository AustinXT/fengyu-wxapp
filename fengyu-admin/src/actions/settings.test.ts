import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/db', () => ({
  db: { execute: vi.fn() },
}))

vi.mock('drizzle-orm', () => ({
  sql: Object.assign(vi.fn(() => ({})), { raw: vi.fn() }),
}))

vi.mock('@/lib/auth', () => ({
  getSession: vi.fn(),
}))

vi.mock('@/lib/permissions', () => ({
  requirePermission: vi.fn(),
}))

vi.mock('@/lib/operation-log', () => ({
  logOperation: vi.fn(),
  logUpdate: vi.fn(),
  logTransition: vi.fn(),
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

vi.mock('@/lib/cloudbase', () => ({
  uploadFile: vi.fn(),
  reuploadToFixedPath: vi.fn(),
  deleteByCloudPaths: vi.fn(),
  callClientFunction: vi.fn().mockResolvedValue({ code: 0, message: 'success' }),
}))

vi.mock('@/lib/member-threshold', () => ({
  invalidateMemberThreshold: vi.fn(),
}))

import {
  getSettings,
  saveSettings,
  listActiveCouponTemplates,
  getMemberBenefits,
  saveMemberBenefits,
  getShareGiftConfig,
  saveShareGiftConfig,
} from './settings'
import {
  normalizeShareGiftConfig,
  DEFAULT_SHARE_GIFT_CONFIG,
} from '@/lib/share-gift-config'
import { db } from '@/db'
import { getSession } from '@/lib/auth'
import { logUpdate } from '@/lib/operation-log'
import { callClientFunction } from '@/lib/cloudbase'
import { invalidateMemberThreshold } from '@/lib/member-threshold'

const mockSession = {
  employeeId: 'ADMIN-001',
  roles: [{ role: 'admin' }],
  permissions: { actions: ['system:config'], scopeStoreIds: [] },
}

const EMPTY_BENEFIT = {
  points: 0,
  couponTemplateIds: [],
  messageTitle: '',
  messageBody: '',
}

const EMPTY_BENEFITS_MAP = {
  初钻: EMPTY_BENEFIT,
  星钻: EMPTY_BENEFIT,
  粉钻: EMPTY_BENEFIT,
  金钻: EMPTY_BENEFIT,
  黑钻: EMPTY_BENEFIT,
}

// ── getSettings ───────────────────────────────────────────────────────────────

describe('getSettings — 系统配置读取（不含权益）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('DB 有记录 → 覆盖默认值', async () => {
    ;(db.execute as any).mockResolvedValue([
      { key: 'new_member_threshold', value: '3000' },
      { key: 'order_timeout', value: '15' },
    ])

    const result = await getSettings()

    expect(result.newMemberThreshold).toBe('3000')
    expect(result.orderTimeout).toBe('15')
  })

  it('DB 无记录 → 返回默认值', async () => {
    ;(db.execute as any).mockResolvedValue([])

    const result = await getSettings()

    expect(result.newMemberThreshold).toBe('1980')
    expect(result.orderTimeout).toBe('10')
    expect(result.bannerImages).toEqual([])
    expect(result.fengyuguanImage).toBe('')
  })

  it('返回对象不再包含 memberLevelBenefits 字段', async () => {
    ;(db.execute as any).mockResolvedValue([])
    const result = await getSettings()
    expect(result).not.toHaveProperty('memberLevelBenefits')
  })

  it('DB 异常 → 返回默认值（静默降级）', async () => {
    ;(db.execute as any).mockRejectedValue(new Error('table not found'))

    const result = await getSettings()

    expect(result.newMemberThreshold).toBe('1980')
    expect(result.orderTimeout).toBe('10')
  })
})

// ── saveSettings ──────────────────────────────────────────────────────────────

describe('saveSettings — 系统配置保存（不含权益）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('正常保存 → 执行 CREATE TABLE + 4 次 UPSERT + banner_count 查询/保存 + 日志', async () => {
    ;(db.execute as any).mockResolvedValue([])

    const result = await saveSettings({
      newMemberThreshold: '2000',
      orderTimeout: '20',
      bannerImages: [],
      fengyuguanImage: '',
    })

    expect(result.success).toBe(true)
    expect(result.message).toContain('保存成功')
    // getSettings SELECT + CREATE TABLE + 4 UPSERT + SELECT banner_count + UPSERT banner_count = 8
    expect(db.execute).toHaveBeenCalledTimes(8)
    expect(logUpdate).toHaveBeenCalledWith(
      mockSession, 'system.saveConfig', 'system_config', 'all',
      expect.anything(), expect.objectContaining({ newMemberThreshold: '2000' }),
    )
  })

  it('DB 异常 → 返回失败消息', async () => {
    ;(db.execute as any).mockRejectedValue(new Error('disk full'))

    const result = await saveSettings({
      newMemberThreshold: '1980',
      orderTimeout: '10',
      bannerImages: [],
      fengyuguanImage: '',
    })

    expect(result.success).toBe(false)
    expect(result.message).toContain('保存失败')
  })

  it('newMemberThreshold 变化 → 广播 invalidate 到 admin 自身 + clientApi', async () => {
    ;(db.execute as any).mockResolvedValue([])

    const result = await saveSettings({
      newMemberThreshold: '2500',
      orderTimeout: '10',
      bannerImages: [],
      fengyuguanImage: '',
    })

    expect(result.success).toBe(true)
    expect(invalidateMemberThreshold).toHaveBeenCalledTimes(1)
    expect(callClientFunction).toHaveBeenCalledWith('clientApi', {
      action: 'config.invalidateConfig',
    })
  })

  it('newMemberThreshold 未变化 → 不广播', async () => {
    ;(db.execute as any).mockResolvedValue([])

    const result = await saveSettings({
      newMemberThreshold: '1980',
      orderTimeout: '10',
      bannerImages: [],
      fengyuguanImage: '',
    })

    expect(result.success).toBe(true)
    expect(invalidateMemberThreshold).not.toHaveBeenCalled()
    expect(callClientFunction).not.toHaveBeenCalled()
  })

  it('广播失败 → 不影响 saveSettings 成功返回（Promise.allSettled 容错）', async () => {
    ;(db.execute as any).mockResolvedValue([])
    ;(callClientFunction as any).mockRejectedValueOnce(new Error('cloudbase timeout'))

    const result = await saveSettings({
      newMemberThreshold: '3000',
      orderTimeout: '10',
      bannerImages: [],
      fengyuguanImage: '',
    })

    expect(result.success).toBe(true)
    expect(invalidateMemberThreshold).toHaveBeenCalledTimes(1)
  })
})

// ── listActiveCouponTemplates ─────────────────────────────────────────────────

describe('listActiveCouponTemplates — 优惠券模板列表', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('返回有效模板列表（驼峰映射）', async () => {
    ;(db.execute as any).mockResolvedValue([
      { template_id: 'tpl-1', name: '满减券' },
      { template_id: 'tpl-2', name: '折扣券' },
    ])

    const result = await listActiveCouponTemplates()

    expect(result).toEqual([
      { templateId: 'tpl-1', name: '满减券' },
      { templateId: 'tpl-2', name: '折扣券' },
    ])
  })
})

// ── getMemberBenefits ─────────────────────────────────────────────────────────

describe('getMemberBenefits — 三组会员权益读取', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('DB 无记录 → 三场景均返回空权益结构', async () => {
    ;(db.execute as any).mockResolvedValue([])

    const result = await getMemberBenefits()

    expect(result.upgrade).toEqual(EMPTY_BENEFITS_MAP)
    expect(result.birthday).toEqual(EMPTY_BENEFITS_MAP)
    expect(result.thanksgiving).toEqual(EMPTY_BENEFITS_MAP)
  })

  it('三 key 齐全 → 三场景各自解析', async () => {
    ;(db.execute as any).mockResolvedValue([
      {
        key: 'member_level_benefits',
        value: JSON.stringify({
          星钻: { points: 500, couponTemplateIds: ['tpl-1'], messageTitle: '🎉', messageBody: 'hi' },
        }),
      },
      {
        key: 'birthday_benefits',
        value: JSON.stringify({
          金钻: { points: 300, couponTemplateIds: ['tpl-b'], messageTitle: '🎂', messageBody: 'birthday' },
        }),
      },
      {
        key: 'thanksgiving_benefits',
        value: JSON.stringify({
          黑钻: { points: 1000, couponTemplateIds: ['tpl-t'], messageTitle: '💝', messageBody: 'thanks' },
        }),
      },
    ])

    const result = await getMemberBenefits()

    expect(result.upgrade.星钻.points).toBe(500)
    expect(result.upgrade.星钻.messageTitle).toBe('🎉')
    expect(result.birthday.金钻.points).toBe(300)
    expect(result.birthday.金钻.messageTitle).toBe('🎂')
    expect(result.thanksgiving.黑钻.points).toBe(1000)
    expect(result.thanksgiving.黑钻.couponTemplateIds).toEqual(['tpl-t'])
    // 未配置等级用默认值
    expect(result.upgrade.初钻).toEqual(EMPTY_BENEFIT)
    expect(result.birthday.初钻).toEqual(EMPTY_BENEFIT)
  })

  it('某个 key 的 JSON 损坏 → 仅该场景降级为默认，其他场景正常', async () => {
    ;(db.execute as any).mockResolvedValue([
      { key: 'member_level_benefits', value: '{not valid' },
      {
        key: 'birthday_benefits',
        value: JSON.stringify({ 粉钻: { points: 100, couponTemplateIds: [], messageTitle: '', messageBody: '' } }),
      },
    ])

    const result = await getMemberBenefits()

    expect(result.upgrade).toEqual(EMPTY_BENEFITS_MAP)
    expect(result.birthday.粉钻.points).toBe(100)
    expect(result.thanksgiving).toEqual(EMPTY_BENEFITS_MAP)
  })

  it('DB 异常 → 三场景均返回默认（静默降级）', async () => {
    ;(db.execute as any).mockRejectedValue(new Error('conn lost'))

    const result = await getMemberBenefits()

    expect(result.upgrade).toEqual(EMPTY_BENEFITS_MAP)
    expect(result.birthday).toEqual(EMPTY_BENEFITS_MAP)
    expect(result.thanksgiving).toEqual(EMPTY_BENEFITS_MAP)
  })
})

// ── saveMemberBenefits ────────────────────────────────────────────────────────

describe('saveMemberBenefits — 三组会员权益保存', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('正常保存 → getOld SELECT + CREATE TABLE + 3 UPSERT + 日志', async () => {
    ;(db.execute as any).mockResolvedValue([])

    const result = await saveMemberBenefits({
      upgrade: EMPTY_BENEFITS_MAP,
      birthday: EMPTY_BENEFITS_MAP,
      thanksgiving: EMPTY_BENEFITS_MAP,
    })

    expect(result.success).toBe(true)
    expect(result.message).toContain('保存成功')
    // getMemberBenefits SELECT + CREATE TABLE + 3 UPSERT = 5
    expect(db.execute).toHaveBeenCalledTimes(5)
    expect(logUpdate).toHaveBeenCalledWith(
      mockSession, 'system.saveMemberBenefits', 'system_config', 'member_benefits',
      expect.anything(), expect.anything(),
    )
  })

  it('三场景各自规范化 → points 负值/小数裁剪、couponIds 去重、文案 trim', async () => {
    ;(db.execute as any).mockResolvedValue([])

    const result = await saveMemberBenefits({
      upgrade: {
        ...EMPTY_BENEFITS_MAP,
        初钻: { points: -5, couponTemplateIds: ['', 'tpl-1', 'tpl-1'], messageTitle: '  a  ', messageBody: '' },
      },
      birthday: {
        ...EMPTY_BENEFITS_MAP,
        星钻: { points: 10.9, couponTemplateIds: [], messageTitle: '', messageBody: '' },
      },
      thanksgiving: EMPTY_BENEFITS_MAP,
    })

    expect(result.success).toBe(true)
    // logUpdate args[5] 是 normalized bundle
    const normalized = (logUpdate as any).mock.calls[0][5] as any
    expect(normalized.upgrade.初钻.points).toBe(0)
    expect(normalized.upgrade.初钻.couponTemplateIds).toEqual(['tpl-1'])
    expect(normalized.upgrade.初钻.messageTitle).toBe('a')
    expect(normalized.birthday.星钻.points).toBe(10)
  })

  it('DB 异常 → 返回失败消息', async () => {
    ;(db.execute as any).mockRejectedValue(new Error('disk full'))

    const result = await saveMemberBenefits({
      upgrade: EMPTY_BENEFITS_MAP,
      birthday: EMPTY_BENEFITS_MAP,
      thanksgiving: EMPTY_BENEFITS_MAP,
    })

    expect(result.success).toBe(false)
    expect(result.message).toContain('保存失败')
  })
})

// ── normalizeShareGiftConfig ──────────────────────────────────────────────────

describe('normalizeShareGiftConfig — 分享礼配置规范化', () => {
  it('空输入 → 返回默认配置', () => {
    expect(normalizeShareGiftConfig(null)).toEqual(DEFAULT_SHARE_GIFT_CONFIG)
    expect(normalizeShareGiftConfig(undefined)).toEqual(DEFAULT_SHARE_GIFT_CONFIG)
    expect(normalizeShareGiftConfig('not-object')).toEqual(DEFAULT_SHARE_GIFT_CONFIG)
  })

  it('percent 超下限 → clamp 到 0.01', () => {
    const r = normalizeShareGiftConfig({ percent: -1 })
    expect(r.percent).toBe(0.01)
  })

  it('percent 超上限 → clamp 到 0.5', () => {
    const r = normalizeShareGiftConfig({ percent: 10 })
    expect(r.percent).toBe(0.5)
  })

  it('percent 非数字 → 使用默认值 0.15', () => {
    const r = normalizeShareGiftConfig({ percent: 'abc' })
    expect(r.percent).toBe(0.15)
  })

  it('min > max → 自动交换', () => {
    const r = normalizeShareGiftConfig({ minFaceValue: 500, maxFaceValue: 1 })
    expect(r.minFaceValue).toBe(1)
    expect(r.maxFaceValue).toBe(500)
  })

  it('负数面值 → 取 0', () => {
    const r = normalizeShareGiftConfig({ minFaceValue: -5, maxFaceValue: 100 })
    expect(r.minFaceValue).toBe(0)
  })

  it('validityDays 超范围 → clamp 到 [1, 3650]', () => {
    expect(normalizeShareGiftConfig({ validityDays: 0 }).validityDays).toBe(1)
    expect(normalizeShareGiftConfig({ validityDays: 99999 }).validityDays).toBe(3650)
    expect(normalizeShareGiftConfig({ validityDays: 7.8 }).validityDays).toBe(7)
  })

  it('字符串字段 trim', () => {
    const r = normalizeShareGiftConfig({
      couponTemplateId: '  tpl-1  ',
      messageInviterTitle: '  标题  ',
      messageInviterBody: ' 正文 ',
      messageInviteeTitle: ' invitee ',
      messageInviteeBody: ' body ',
    })
    expect(r.couponTemplateId).toBe('tpl-1')
    expect(r.messageInviterTitle).toBe('标题')
    expect(r.messageInviterBody).toBe('正文')
    expect(r.messageInviteeTitle).toBe('invitee')
    expect(r.messageInviteeBody).toBe('body')
  })

  it('enabled / inviterMustHavePaidOrder 转 boolean', () => {
    const r = normalizeShareGiftConfig({ enabled: 1, inviterMustHavePaidOrder: '' })
    expect(r.enabled).toBe(true)
    expect(r.inviterMustHavePaidOrder).toBe(false)
  })
})

// ── getShareGiftConfig ────────────────────────────────────────────────────────

describe('getShareGiftConfig — 分享礼配置读取', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('DB 无记录 → 返回默认配置', async () => {
    ;(db.execute as any).mockResolvedValue([])
    const result = await getShareGiftConfig()
    expect(result).toEqual(DEFAULT_SHARE_GIFT_CONFIG)
  })

  it('JSON 损坏 → 返回默认配置', async () => {
    ;(db.execute as any).mockResolvedValue([{ value: '{bad json' }])
    const result = await getShareGiftConfig()
    expect(result).toEqual(DEFAULT_SHARE_GIFT_CONFIG)
  })

  it('DB 异常 → 返回默认配置', async () => {
    ;(db.execute as any).mockRejectedValue(new Error('table missing'))
    const result = await getShareGiftConfig()
    expect(result).toEqual(DEFAULT_SHARE_GIFT_CONFIG)
  })

  it('合法 JSON → 返回规范化后的配置', async () => {
    ;(db.execute as any).mockResolvedValue([
      {
        value: JSON.stringify({
          enabled: true,
          percent: 0.2,
          minFaceValue: 5,
          maxFaceValue: 200,
          couponTemplateId: 'tpl-share',
          validityDays: 60,
          inviterMustHavePaidOrder: true,
          messageInviterTitle: 'I',
          messageInviterBody: 'Ib',
          messageInviteeTitle: 'E',
          messageInviteeBody: 'Eb',
        }),
      },
    ])
    const result = await getShareGiftConfig()
    expect(result.enabled).toBe(true)
    expect(result.percent).toBe(0.2)
    expect(result.couponTemplateId).toBe('tpl-share')
    expect(result.validityDays).toBe(60)
  })
})

// ── saveShareGiftConfig ───────────────────────────────────────────────────────

describe('saveShareGiftConfig — 分享礼配置保存', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('正常保存 → CREATE TABLE + SELECT + UPSERT + 日志', async () => {
    ;(db.execute as any).mockResolvedValue([])
    const result = await saveShareGiftConfig({
      ...DEFAULT_SHARE_GIFT_CONFIG,
      enabled: true,
      couponTemplateId: 'tpl-1',
    })
    expect(result.success).toBe(true)
    expect(result.message).toContain('分享礼配置已保存')
    expect(logUpdate).toHaveBeenCalledWith(
      mockSession,
      'system.saveShareGiftConfig',
      'system_config',
      'share_gift',
      expect.any(Object),
      expect.any(Object),
    )
  })

  it('DB 异常 → 返回失败消息', async () => {
    ;(db.execute as any).mockRejectedValue(new Error('pg down'))
    const result = await saveShareGiftConfig(DEFAULT_SHARE_GIFT_CONFIG)
    expect(result.success).toBe(false)
    expect(result.message).toContain('保存失败')
  })
})
