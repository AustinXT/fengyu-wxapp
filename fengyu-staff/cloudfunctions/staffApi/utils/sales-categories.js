// utils/sales-categories.js — 销售归属分类单源（staffApi 内部）
//
// 与 db/schema/enums.ts::salesCategoryEnum 同源，数组顺序即前端展示顺序。
//
// ⚠️ 本项目禁跨端共享目录（用户已 veto cloudfunctions-shared），本文件**仅供 staffApi 内部**复用；
//    clientApi / payNotify / fengyu-admin 的同名列表各自保留独立副本，改这里须同步核对：
//      db/schema/enums.ts:105                            salesCategoryEnum（权威单源）
//      fengyu-admin/src/lib/types.ts                     type SalesCategory
//      fengyu-admin/src/lib/schemas.ts                   z.enum
//      fengyu-admin/src/lib/data-center/columns.ts       员工效率表 4 列（口径是 allocated_amount，非提成）
//      fengyu-client/cloudfunctions/payNotify/index.js
//
// 小程序前端**不再持有副本** —— staff.performanceDetail 通过 categories 字段下发（issue #123），
// 避免枚举改名时前端出现「幽灵格子 + 真实分类并存」的静默漂移。

// freeze：云函数容器跨请求复用模块作用域，且本数组被 mgmt-dashboard 以别名共享引用，
// 任一 route 原地 push/sort 都会污染另一个 route 的后续请求
const SALES_CATEGORIES = Object.freeze(['自销自耗', '他销自耗', '他销他耗', '生态合作'])

/** sales_category 为 NULL 时的归类名 —— 前后端必须字面量一致，勿改 */
const UNCATEGORIZED = '未分类'

module.exports = { SALES_CATEGORIES, UNCATEGORIZED }
