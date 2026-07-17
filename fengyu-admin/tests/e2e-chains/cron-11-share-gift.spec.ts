/**
 * cron-11：share-gift（分享礼）端到端
 *
 * 测试方式：直接 import fengyu-client/cloudfunctions/clientApi/share-gift.js 的 grantShareGift，
 *           传 pg PoolClient + order 参数。3 副本一致性由 cross-end-sql-snapshot.test.js 守护，
 *           不需要分别测 client / staff / payNotify 三份。
 *
 * 验证矩阵：
 *   11.1  数值 clamp 中间档：paidAmount=200 × 15% = 30
 *   11.2  上界 clamp：paidAmount=10000 × 15% = 1500 → clamp 到 max=500
 *   11.3  下界 clamp：paidAmount=20 × 15% = 3 → clamp 到 min=10
 *   11.4  paidAmount=0 → granted=false, reason='no_paid_amount'
 *   11.5  配置缺失 → no_config
 *   11.6  配置 disabled → disabled
 *   11.7  配置 bad json → bad_config（PG jsonb 列约束，本仓库实际无法插入坏 JSON，标 skip）
 *   11.8  不是首单 → not_first_order
 *   11.9  no_inviter → no_inviter
 *   11.10 双幂等：同 saleOrderId 触发 2 次 → 第二次 0 新增 user_coupons
 *   11.11 有效期 days 模式：template.validity_mode='days', days=90 → expire ~+90d
 *   11.12 有效期 fixed 模式：template.valid_to=固定日期 → expire=该固定日
 *   11.13 退款不撤销（已知问题 audit-19 P0-19-04，test.fixme 等修复）
 */

import { test, expect } from '@playwright/test'
// @ts-expect-error: pg 类型在测试环境未声明（仅 e2e-chains 用，无需 admin runtime 类型）
import { Client } from 'pg'
import {
  backupAndSetConfig,
  backupAndDeleteConfig,
  restoreAllConfigs,
} from './_helpers/cron-config'
import { upsertClient, insertSaleOrder, cleanupCronE2E, PREFIX } from './_helpers/cron-fixtures'
import { psql } from './_helpers/cron-runner'

// 动态 require share-gift（commonjs 模块）
// eslint-disable-next-line @typescript-eslint/no-require-imports
const shareGift: {
  grantShareGift: (
    client: Client,
    order: { saleOrderId: string; clientUserId: string; paidAmount: number; source?: string },
  ) => Promise<{ granted: boolean; reason?: string; value?: number; inviter?: string }>
} = require('../../../fengyu-client/cloudfunctions/clientApi/share-gift.js')

const PG_URL = 'postgresql://fengyu:fengyu123@47.113.202.7:5433/fengyu_wxapp'

function ensureTestStore(): string {
  const storeId = psql(`SELECT store_id FROM stores LIMIT 1`)
  if (!storeId) throw new Error('需要至少 1 个 stores')
  return storeId
}
const STORE_ID = ensureTestStore()

/** 在事务内调用 grantShareGift，自动 BEGIN/COMMIT */
async function callShareGift(
  saleOrderId: string,
  clientUserId: string,
  paidAmount: number,
): Promise<ReturnType<typeof shareGift.grantShareGift>> {
  const c = new Client({ connectionString: PG_URL })
  await c.connect()
  try {
    await c.query('BEGIN')
    const result = await shareGift.grantShareGift(c as never, {
      saleOrderId,
      clientUserId,
      paidAmount,
      source: 'cron-11-e2e',
    })
    await c.query('COMMIT')
    return result
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    await c.end()
  }
}

function countShareCoupons(saleOrderId: string): number {
  const out = psql(
    `SELECT COUNT(*) FROM user_coupons WHERE coupon_id IN ('sg-inviter-${saleOrderId}', 'sg-invitee-${saleOrderId}')`,
  )
  return Number(out) || 0
}

function getShareCouponValue(saleOrderId: string, role: 'inviter' | 'invitee'): number | null {
  const out = psql(
    `SELECT face_value_override::text FROM user_coupons WHERE coupon_id = 'sg-${role}-${saleOrderId}'`,
  )
  if (!out) return null
  return Number(out)
}

function getShareCouponExpireYmd(saleOrderId: string, role: 'inviter' | 'invitee'): string | null {
  const out = psql(
    `SELECT TO_CHAR(expire_at, 'YYYY-MM-DD') FROM user_coupons WHERE coupon_id = 'sg-${role}-${saleOrderId}'`,
  )
  return out || null
}

test.describe.serial('cron-11 share-gift（分享礼）', () => {
  test.beforeAll(() => {
    cleanupCronE2E()
  })

  test.afterAll(() => {
    restoreAllConfigs()
    cleanupCronE2E()
  })

  test('11.1 数值 clamp 中间：paidAmount=200×0.15=30，face=30，邀请/被邀各 1 张券', async () => {
    backupAndSetConfig('share_gift_config', {
      enabled: true,
      couponTemplateId: 'FY-FIX-CT-DISCOUNT',
      percent: 0.15,
      minFaceValue: 10,
      maxFaceValue: 100,
      messageInviterTitle: '【凤御美业】您邀请的好友首单送您 {couponValue} 元券',
      messageInviteeTitle: '【凤御美业】新客首单礼 {couponValue} 元券',
    })
    const inviterUid = upsertClient('SG_111_INV', { customerType: '会员客' })
    const inviteeUid = upsertClient('SG_111_INVE', {
      customerType: '会员客',
      inviterUserId: inviterUid,
    })
    const soid = insertSaleOrder('SG_111', {
      storeId: STORE_ID,
      clientUserId: inviteeUid,
      received: 200,
      paidAt: '2026-11-20 10:00:00',
    })
    const r = await callShareGift(soid, inviteeUid, 200)
    expect(r.granted).toBe(true)
    expect(r.value).toBe(30)
    expect(r.inviter).toBe(inviterUid)
    expect(countShareCoupons(soid)).toBe(2)
    expect(getShareCouponValue(soid, 'inviter')).toBe(30)
    expect(getShareCouponValue(soid, 'invitee')).toBe(30)
  })

  test('11.2 上界 clamp：paidAmount=10000 → raw=1500 → clamp 到 max=500', async () => {
    backupAndSetConfig('share_gift_config', {
      enabled: true,
      couponTemplateId: 'FY-FIX-CT-DISCOUNT',
      percent: 0.15,
      minFaceValue: 1,
      maxFaceValue: 500,
      messageInviterTitle: 'X',
      messageInviteeTitle: 'X',
    })
    const inviter = upsertClient('SG_112_INV', { customerType: '会员客' })
    const invitee = upsertClient('SG_112_INVE', {
      customerType: '会员客',
      inviterUserId: inviter,
    })
    const soid = insertSaleOrder('SG_112', {
      storeId: STORE_ID,
      clientUserId: invitee,
      received: 10000,
      paidAt: '2026-11-20 10:00:00',
    })
    const r = await callShareGift(soid, invitee, 10000)
    expect(r.granted).toBe(true)
    expect(r.value).toBe(500)
  })

  test('11.3 下界 clamp：paidAmount=20 → raw=3 → clamp 到 min=10', async () => {
    backupAndSetConfig('share_gift_config', {
      enabled: true,
      couponTemplateId: 'FY-FIX-CT-DISCOUNT',
      percent: 0.15,
      minFaceValue: 10,
      maxFaceValue: 500,
      messageInviterTitle: 'X',
      messageInviteeTitle: 'X',
    })
    const inviter = upsertClient('SG_113_INV', { customerType: '会员客' })
    const invitee = upsertClient('SG_113_INVE', {
      customerType: '会员客',
      inviterUserId: inviter,
    })
    const soid = insertSaleOrder('SG_113', {
      storeId: STORE_ID,
      clientUserId: invitee,
      received: 20,
      paidAt: '2026-11-20 10:00:00',
    })
    const r = await callShareGift(soid, invitee, 20)
    expect(r.granted).toBe(true)
    expect(r.value).toBe(10)
  })

  test('11.4 paidAmount=0 → no_paid_amount，不入主流程', async () => {
    const inviter = upsertClient('SG_114_INV', { customerType: '会员客' })
    const invitee = upsertClient('SG_114_INVE', {
      customerType: '会员客',
      inviterUserId: inviter,
    })
    const soid = insertSaleOrder('SG_114', {
      storeId: STORE_ID,
      clientUserId: invitee,
      received: 0,
      paidAt: '2026-11-20 10:00:00',
    })
    const r = await callShareGift(soid, invitee, 0)
    expect(r.granted).toBe(false)
    expect(r.reason).toBe('no_paid_amount')
    expect(countShareCoupons(soid)).toBe(0)
  })

  test('11.5 配置缺失（system_configs 无 share_gift_config 行）→ no_config', async () => {
    backupAndDeleteConfig('share_gift_config')
    const inviter = upsertClient('SG_115_INV', { customerType: '会员客' })
    const invitee = upsertClient('SG_115_INVE', {
      customerType: '会员客',
      inviterUserId: inviter,
    })
    const soid = insertSaleOrder('SG_115', {
      storeId: STORE_ID,
      clientUserId: invitee,
      received: 200,
      paidAt: '2026-11-20 10:00:00',
    })
    const r = await callShareGift(soid, invitee, 200)
    expect(r.granted).toBe(false)
    expect(r.reason).toBe('no_config')

    // 恢复 share_gift_config 给后续测试
    backupAndSetConfig('share_gift_config', {
      enabled: true,
      couponTemplateId: 'FY-FIX-CT-DISCOUNT',
      percent: 0.15,
      minFaceValue: 1,
      maxFaceValue: 500,
      messageInviterTitle: 'X',
      messageInviteeTitle: 'X',
    })
  })

  test('11.6 配置 disabled（enabled=false）→ reason=disabled', async () => {
    backupAndSetConfig('share_gift_config', {
      enabled: false,
      couponTemplateId: 'FY-FIX-CT-DISCOUNT',
      percent: 0.15,
    })
    const inviter = upsertClient('SG_116_INV', { customerType: '会员客' })
    const invitee = upsertClient('SG_116_INVE', {
      customerType: '会员客',
      inviterUserId: inviter,
    })
    const soid = insertSaleOrder('SG_116', {
      storeId: STORE_ID,
      clientUserId: invitee,
      received: 200,
      paidAt: '2026-11-20 10:00:00',
    })
    const r = await callShareGift(soid, invitee, 200)
    expect(r.granted).toBe(false)
    expect(r.reason).toBe('disabled')

    // 恢复正常 config
    backupAndSetConfig('share_gift_config', {
      enabled: true,
      couponTemplateId: 'FY-FIX-CT-DISCOUNT',
      percent: 0.15,
      minFaceValue: 1,
      maxFaceValue: 500,
      messageInviterTitle: 'X',
      messageInviteeTitle: 'X',
    })
  })

  test('11.7 不是首单：邀请人之前已有 1 笔已支付订单 → not_first_order', async () => {
    const inviter = upsertClient('SG_117_INV', { customerType: '会员客' })
    const invitee = upsertClient('SG_117_INVE', {
      customerType: '会员客',
      inviterUserId: inviter,
    })
    // 先构造一笔已支付订单
    insertSaleOrder('SG_117_PREV', {
      storeId: STORE_ID,
      clientUserId: invitee,
      received: 50,
      paidAt: '2026-11-01 10:00:00',
    })
    // 再构造本次订单
    const soid = insertSaleOrder('SG_117_NEW', {
      storeId: STORE_ID,
      clientUserId: invitee,
      received: 200,
      paidAt: '2026-11-20 10:00:00',
    })
    const r = await callShareGift(soid, invitee, 200)
    expect(r.granted).toBe(false)
    expect(r.reason).toBe('not_first_order')
  })

  test('11.8 no_inviter：顾客无 inviter_user_id → no_inviter', async () => {
    const invitee = upsertClient('SG_118_INVE', {
      customerType: '会员客',
      inviterUserId: null,
    })
    const soid = insertSaleOrder('SG_118', {
      storeId: STORE_ID,
      clientUserId: invitee,
      received: 200,
      paidAt: '2026-11-20 10:00:00',
    })
    const r = await callShareGift(soid, invitee, 200)
    expect(r.granted).toBe(false)
    expect(r.reason).toBe('no_inviter')
  })

  test('11.9 双幂等：同 saleOrderId 触发 2 次 → 第二次 0 新增（coupon_id 唯一）', async () => {
    const inviter = upsertClient('SG_119_INV', { customerType: '会员客' })
    const invitee = upsertClient('SG_119_INVE', {
      customerType: '会员客',
      inviterUserId: inviter,
    })
    const soid = insertSaleOrder('SG_119', {
      storeId: STORE_ID,
      clientUserId: invitee,
      received: 200,
      paidAt: '2026-11-20 10:00:00',
    })
    const r1 = await callShareGift(soid, invitee, 200)
    expect(r1.granted).toBe(true)
    expect(countShareCoupons(soid)).toBe(2)

    const r2 = await callShareGift(soid, invitee, 200)
    expect(r2.granted).toBe(true) // 业务上仍返回 granted=true，但 INSERT 触发 ON CONFLICT DO NOTHING
    expect(countShareCoupons(soid)).toBe(2) // 不会变成 4
  })

  test('11.10 有效期 days 模式：FY-FIX-CT-DISCOUNT days=90 → expire 距今约 90d', async () => {
    const inviter = upsertClient('SG_1110_INV', { customerType: '会员客' })
    const invitee = upsertClient('SG_1110_INVE', {
      customerType: '会员客',
      inviterUserId: inviter,
    })
    const soid = insertSaleOrder('SG_1110', {
      storeId: STORE_ID,
      clientUserId: invitee,
      received: 200,
      paidAt: '2026-11-20 10:00:00',
    })
    const before = Date.now()
    await callShareGift(soid, invitee, 200)
    const after = Date.now()

    const expireYmd = getShareCouponExpireYmd(soid, 'invitee')
    expect(expireYmd).toBeTruthy()
    const expireMs = new Date(expireYmd + 'T00:00:00Z').getTime()
    const expectedMin = before + 89 * 86400000
    const expectedMax = after + 91 * 86400000
    expect(expireMs).toBeGreaterThanOrEqual(expectedMin)
    expect(expireMs).toBeLessThanOrEqual(expectedMax)
  })

  test('11.11 有效期 fixed 模式：模板 valid_to=固定日期 → 券 expire=该固定日', async () => {
    // FY-FIX-CT-EXPIRED 是 fixed + valid_to=2026-01-01
    backupAndSetConfig('share_gift_config', {
      enabled: true,
      couponTemplateId: 'FY-FIX-CT-EXPIRED',
      percent: 0.15,
      minFaceValue: 1,
      maxFaceValue: 500,
      messageInviterTitle: 'X',
      messageInviteeTitle: 'X',
    })
    const inviter = upsertClient('SG_1111_INV', { customerType: '会员客' })
    const invitee = upsertClient('SG_1111_INVE', {
      customerType: '会员客',
      inviterUserId: inviter,
    })
    const soid = insertSaleOrder('SG_1111', {
      storeId: STORE_ID,
      clientUserId: invitee,
      received: 200,
      paidAt: '2026-11-20 10:00:00',
    })
    const r = await callShareGift(soid, invitee, 200)
    expect(r.granted).toBe(true)
    const expireYmd = getShareCouponExpireYmd(soid, 'invitee')
    // FY-FIX-CT-EXPIRED valid_to = 2026-01-01 00:00:00
    expect(expireYmd).toBe('2026-01-01')
  })

  // 11.12 退款不撤销（已知 bug audit-19 P0-19-04）—— 不在本次范围内，等专项修复 ticket
  // 此处仅占位提醒
  test.fixme('11.12 退款不撤销（audit-19 P0-19-04 already known）', () => {
    // 触发 share-gift → 退款 sale_order → 期望 sg-* 券撤销，但当前实现不撤销
    // 待修复后启用此测试
  })

  test('cleanup 后置 sanity', () => {
    cleanupCronE2E()
    expect(
      Number(
        psql(
          `SELECT COUNT(*) FROM client_wechat_users WHERE user_id LIKE '${PREFIX.CLIENT}SG_%'`,
        ),
      ),
    ).toBe(0)
  })
})
