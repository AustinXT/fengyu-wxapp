import { z } from 'zod'

// ─── 登录表单 ───
export const loginSchema = z.object({
  phone: z.string()
    .min(1, '请输入手机号')
    .regex(/^1\d{10}$/, '请输入正确的手机号'),
  password: z.string()
    .min(1, '请输入密码'),
})
export type LoginInput = z.infer<typeof loginSchema>

// ─── 修改密码 ───
export const changePasswordSchema = z.object({
  newPassword: z.string()
    .min(8, '密码至少 8 位')
    .regex(/[a-zA-Z]/, '密码需包含字母')
    .regex(/[0-9]/, '密码需包含数字'),
  confirmPassword: z.string(),
}).refine(d => d.newPassword === d.confirmPassword, {
  message: '两次密码不一致',
  path: ['confirmPassword'],
})
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>

// 日期字符串校验：YYYY-MM-DD（admin 表单 `<Input type="date">` 格式）
const dateStringSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD')

// ─── 员工表单 ───
export const employeeSchema = z.object({
  employeeId: z.string().min(1, '员工编号不能为空'),
  name: z.string().min(1, '姓名不能为空'),
  phone: z.string()
    .regex(/^1\d{10}$/, '请输入正确的手机号')
    .optional()
    .or(z.literal('')),
  gender: z.enum(['男', '女']).optional().nullable(),
  idCard: z.string()
    .regex(/^\d{17}[\dXx]$/, '身份证号格式不正确')
    .optional()
    .or(z.literal('')),
  storeId: z.string().min(1, '请选择门店'),
  orgNodeId: z.string().optional().nullable(),
  positionName: z.string().optional().nullable(),
  birthday: z.string().optional().nullable(),
  skills: z.array(z.string()).optional().nullable(),
  /** 入职日期；mgmt-dashboard 员工数历史化所需（ticket 2026-04-25 T3） */
  hiredAt: dateStringSchema.optional().nullable().or(z.literal('')),
  /** 离职日期；NULL 表示在职。与 isResigned 双写一致 */
  resignedAt: dateStringSchema.optional().nullable().or(z.literal('')),
})
export type EmployeeInput = z.infer<typeof employeeSchema>

// ─── 门店表单（ticket 2026-04-25 T4：闭店日期历史化） ───
export const storeSchema = z.object({
  storeName: z.string().min(1, '请输入门店名称'),
  marketId: z.string().min(1, '请选择所属市场'),
  openingDate: dateStringSchema.optional().nullable().or(z.literal('')),
  /** 闭店日期；NULL 表示在营。与 isClosed 双写一致 */
  closedAt: dateStringSchema.optional().nullable().or(z.literal('')),
  bedCount: z.number().int().min(0).optional().nullable(),
  phone: z.string().optional().nullable(),
  businessHours: z.string().optional().nullable(),
})
export type StoreInput = z.infer<typeof storeSchema>

// ─── 支付方式枚举（与 db/schema/enums.ts:23 对齐） ───
// `'无'` 语义：全额储值卡抵扣，实付 = 0，不走任何支付通道
export const paymentMethodSchema = z.enum(['微信', '支付宝', '线下', '无'])
export type PaymentMethodInput = z.infer<typeof paymentMethodSchema>

// ─── 订单创建 ───
export const createOrderSchema = z.object({
  storeId: z.string().min(1, '请选择门店'),
  marketName: z.string().min(1, '市场名称不能为空'),
  clientUserId: z.string().nullable(),
  clientPhone: z.string().regex(/^1\d{10}$/, '请输入正确的手机号'),
  customerName: z.string().min(1, '顾客姓名不能为空'),
  paymentMethod: paymentMethodSchema,
  // 2026-04-26 sale-order-domain-refactor：仅允许用户创建 3 种类型；'回款单'/'退款单' 已迁至 sale_order_payments
  saleOrderType: z.enum(['销售单', '内部单', '转换单']),
  openedBy: z.string().min(1, '开单人不能为空'),
  preferredEmployeeId: z.string().optional(),
  /**
   * 本次收款金额（部分支付基础 ticket PR-3）
   * - 未传 / undefined → 视为全额收款（= payable_amount）
   * - 0 → 纯挂账（status='待支付'，不写 payments 行）
   * - 0 < v < payable_amount → 部分支付（status='部分支付'）
   * - = payable_amount → 全额（status='已支付' 或 '待确认收款'）
   * 上界校验由 action 层在计算出 payable_amount 后做（schema 只保障非负数）。
   */
  receivedAmount: z.number().min(0, '本次收款金额不能为负').optional(),
  // J3 (B9 ticket follow-up): 一张订单仅支持 1 张优惠券，schema 层用 z.string() 拒绝 array
  couponId: z.string().optional().nullable(),
  items: z.array(z.object({
    skuId: z.string().min(1, 'SKU ID 不能为空'),
    productName: z.string(),
    skuSpecName: z.string(),
    productType: z.enum(['疗程卡', '单品', '家居产品']),
    sessionCount: z.number().int().min(1).nullable(),
    unitPrice: z.string(),
    unitRealPrice: z.string(),
    quantity: z.number().int().min(1, '数量至少为 1'),
    salesCategory: z.enum(['自销自耗', '他销自耗', '他销他耗', '生态合作']).nullable().optional(),
  })).min(1, '请至少选择一件商品'),
})
export type CreateOrderInput = z.infer<typeof createOrderSchema>

// ─── 提成矩阵 ───
export const commissionRateSchema = z.object({
  orgId: z.string().min(1, '请选择市场'),
  orderType: z.string().min(1, '请选择订单类型'),
  roleType: z.string().min(1, '请选择角色类型'),
  salesCategory: z.string().min(1, '请选择销售分类'),
  amountTierMin: z.string().refine(v => !isNaN(Number(v)) && Number(v) >= 0, '最小金额不能为负'),
  amountTierMax: z.string()
    .refine(v => v === '' || (!isNaN(Number(v)) && Number(v) > 0), '最大金额需为正数')
    .optional()
    .or(z.literal('')),
  commissionRate: z.string().refine(v => {
    const n = Number(v)
    return !isNaN(n) && n >= 0 && n <= 1
  }, '提成比例需在 0-1 之间'),
})
export type CommissionRateInput = z.infer<typeof commissionRateSchema>

// ─── 顾客档案 ───
export const customerSchema = z.object({
  name: z.string().optional().nullable(),
  gender: z.string().optional().nullable(),
  boundStoreId: z.string().optional().nullable(),
  boundEmployeeId: z.string().optional().nullable(),
  memberLevel: z.string().optional().nullable(),
  customerSource: z.string().optional().nullable(),
  birthday: z.string().optional().nullable(),
  occupation: z.string().optional().nullable(),
  isMarried: z.boolean().optional().nullable(),
  wechatName: z.string().optional().nullable(),
  skinType: z.string().optional().nullable(),
  improvementFocus: z.string().optional().nullable(),
  skinIssue: z.string().optional().nullable(),
  wellnessPreference: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
})
export type CustomerInput = z.infer<typeof customerSchema>

// ─── 权限分配 ───
export const assignRoleSchema = z.object({
  employeeId: z.string().min(1, '请选择员工'),
  role: z.enum(['admin', 'manager', 'finance', 'hr', 'product', 'customer_mgr']),
  scopeId: z.string().min(1, '请选择组织范围'),
})
export type AssignRoleInput = z.infer<typeof assignRoleSchema>

// ─── 录入回款（ticket 2026-04-24 多次回款 PR-B） ───
// admin 端 paymentMethod 仅支持线下 / 储值卡（后台不收线上钱）；
// 线下要求 externalTxnId（银行回执号），储值卡场景 externalTxnId 为空。
// 允许 repayAmount=0 + prepaidCardAmount>0（纯储值卡抵扣回款），但两者之和必须 > 0。
export const recordPaymentInputSchema = z.object({
  saleOrderId: z.string().min(1, '订单号不能为空'),
  repayAmount: z.number().multipleOf(0.01, '金额精度最多 2 位小数').min(0, '回款金额不能为负'),
  paymentMethod: z.enum(['线下', '储值卡']),
  externalTxnId: z.string().optional(),
  prepaidCardAmount: z.number().multipleOf(0.01, '金额精度最多 2 位小数').min(0, '储值卡抵扣金额不能为负').default(0),
  note: z.string().optional(),
}).refine((v) => v.repayAmount + v.prepaidCardAmount > 0, {
  message: '回款金额与储值卡抵扣不能都为 0',
  path: ['repayAmount'],
}).refine(
  (v) => v.paymentMethod !== '线下' || (!!v.externalTxnId && v.externalTxnId.trim().length > 0) || v.repayAmount === 0,
  { message: '线下回款必须填写外部交易号（银行回执号/流水号）', path: ['externalTxnId'] },
)
export type RecordPaymentInput = z.infer<typeof recordPaymentInputSchema>
