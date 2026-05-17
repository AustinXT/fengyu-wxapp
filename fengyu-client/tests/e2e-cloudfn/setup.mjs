/**
 * client L2 setup
 *
 * 复用根 tests/e2e-cloudfn/setup.mjs 的环境变量、PG 池、命名空间常量（NS=TE2L2_）。
 * 额外暴露 client 测试专属常量。
 */
export * from '../../../tests/e2e-cloudfn/setup.mjs'
import { NS } from '../../../tests/e2e-cloudfn/setup.mjs'

// ─── client 专属命名空间常量 ─────────────────────────────
// 商品/SKU 用同一 NS 前缀，方便统一清理
export const TEST_MALL_CATEGORY_ID = `${NS}_MALL_CAT`
export const TEST_PRODUCT_CATEGORY_ID = `${NS}_PROD_CAT`
export const TEST_PRODUCT_ID = `${NS}_PROD`           // 普通商品
export const TEST_SKU_NORMAL_ID = `${NS}_SKU_N`        // 普通单品 SKU
export const TEST_SKU_COURSE_ID = `${NS}_SKU_C`        // 疗程卡 SKU（sessionCount > 1）
export const TEST_SKU_EXPERIENCE_ID = `${NS}_SKU_E`    // 体验卡 SKU（is_experience=true）
export const TEST_SKU_RECHARGE_ID = `${NS}_SKU_R`      // 充值卡 SKU（is_recharge_card=true）

// 储值卡（一户一账户）
export const TEST_PREPAID_CARD_ID = `${NS}_CARD`

// 优惠券
export const TEST_COUPON_TEMPLATE_ID = `${NS}_CTPL`
export const TEST_COUPON_ID = `${NS}_CPN`

// 第二顾客（用于跨用户访问测试）
export const TEST_CLIENT2_USER_ID = `${NS}_CLI2`
export const TEST_CLIENT2_OPENID = `${NS}_CLI2_OPENID`
export const TEST_CLIENT2_PHONE = '19999099003'
