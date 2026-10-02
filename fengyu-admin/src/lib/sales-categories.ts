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
 *      fengyu-admin/src/lib/data-center/daily-overview.ts         日常数据一览表的展示顺序常量（有意与本数组顺序不同，集合相等守护）
 *
 * ⚠️ 本文件**禁 import 任何 app 内模块**（当前零 import）。`data-center/columns.ts` 在模块初始化期
 *    就解引用 `SALES_CATEGORY_COLUMN_KEYS`，一旦形成环，TDZ 下会在模块加载期抛
 *    「Cannot read properties of undefined」，直接打死 export-worker 进程。
 */

/**
 * `Object.freeze` 而非仅 `as const`：`as const` 只有**编译期**只读。admin 是长驻 Node 进程，
 * 且 zod 的 `z.enum(SALES_CATEGORIES)` 会把本数组**按引用**存进 `createOrderSchema` 的 `_def.values`，
 * 使它经 schema 图对外可达 —— 任一未来消费者一次 `.sort()` 就会同时污染下拉顺序、
 * z.enum 白名单和后续所有请求。与同目录 `api-error.ts:31` 对同构单源的处理保持一致。
 */
export const SALES_CATEGORIES = Object.freeze(['自销自耗', '他销自耗', '他销他耗', '生态合作'] as const)

export type SalesCategory = (typeof SALES_CATEGORIES)[number]

/**
 * 数据中心「按技师人效」明细表的分类列 key。
 *
 * 用 `Record<SalesCategory, string>` 而非并行数组 —— 枚举加值时 **tsc 直接报缺键**，
 * 比 snapshot 测试更早失败。`lib/data-center/columns.ts` 的 4 个分类列由本表生成。
 *
 * 用 `satisfies` 而非类型标注：两者都强制键完备，但 `satisfies` 额外保留**值的字面量类型**
 * （`'saleZxzh'` 而非宽化成 `string`），使 `columns.ts` 生成的列 key 仍是精确联合而非 `string`。
 *
 * ⚠️ 该表口径是 `spia.allocated_amount`（**营业额份额**），与 staff 绩效页同名 4 格的
 *    `commission_amount`（**提成**）差一个费率量级，两者不应相等，勿顺手统一。
 *
 * freeze 的必要性不止于防篡改：`columns.ts` 在模块初始化期就把值 snapshot 进了
 * `salesCategoryMetricColumns`，事后改本表**根本不生效** —— 「改了没反应」比直接报错更难查，
 * freeze 让这类误用在 strict mode 下当场抛错。同 `api-error.ts:45` 对 CODE_MAP 的处理。
 */
export const SALES_CATEGORY_COLUMN_KEYS = Object.freeze({
  自销自耗: 'saleZxzh',
  他销自耗: 'saleTxzh',
  他销他耗: 'saleTxth',
  生态合作: 'saleEco',
}) satisfies Readonly<Record<SalesCategory, string>>

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
