/**
 * 销售归属分类单源（fengyu-admin 内部）
 *
 * 与 `db/schema/enums.ts::salesCategoryEnum` 同源，数组顺序即各处列表/下拉/报表列的展示顺序。
 *
 * ⚠️ 本项目禁**跨端**共享目录（用户已 veto cloudfunctions-shared），本文件**仅供 fengyu-admin 内部**复用；
 *    staffApi / payNotify 各自保留独立副本，一致性靠
 *    `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/sales-categories-enum-snapshot.test.js` 守护。
 *    改这里须同步核对：
 *      db/schema/enums.ts:105                                    salesCategoryEnum（权威单源）
 *      fengyu-staff/cloudfunctions/staffApi/utils/sales-categories.js
 *      fengyu-client/cloudfunctions/payNotify/index.js            orderRates / serviceRates 骨架
 *      fengyu-admin/src/actions/data-center/efficiency.ts         员工人效 4 列 FILTER SQL（见下方说明）
 */

export const SALES_CATEGORIES = ['自销自耗', '他销自耗', '他销他耗', '生态合作'] as const

export type SalesCategory = (typeof SALES_CATEGORIES)[number]

/**
 * 数据中心「按技师人效」明细表的分类列 key。
 *
 * 用 `Record<SalesCategory, string>` 而非并行数组 —— 枚举加值时 **tsc 直接报缺键**，
 * 比 snapshot 测试更早失败。`lib/data-center/columns.ts` 的 4 个分类列由本表生成。
 *
 * ⚠️ 该表口径是 `spia.allocated_amount`（**营业额份额**），与 staff 绩效页同名 4 格的
 *    `commission_amount`（**提成**）差一个费率量级，两者不应相等，勿顺手统一。
 */
export const SALES_CATEGORY_COLUMN_KEYS: Record<SalesCategory, string> = {
  自销自耗: 'saleZxzh',
  他销自耗: 'saleTxzh',
  他销他耗: 'saleTxth',
  生态合作: 'saleEco',
}

/**
 * 生成以四分类为键、值全 0 的**可变**费率骨架。
 *
 * 必须每次新建（调用方会原地写入 `skeleton[r.sales_category] = rate`），
 * 因此不能像 `SALES_CATEGORIES` 那样导出共享的冻结常量。
 */
export function createSalesCategoryRates(): Record<string, number> {
  const rates: Record<string, number> = {}
  for (const category of SALES_CATEGORIES) rates[category] = 0
  return rates
}
