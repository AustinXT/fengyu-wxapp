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
})
export type EmployeeInput = z.infer<typeof employeeSchema>

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
  saleOrderType: z.enum(['销售单', '内部单', '回款单', '转换单', '退款单']),
  openedBy: z.string().min(1, '开单人不能为空'),
  preferredEmployeeId: z.string().optional(),
  items: z.array(z.object({
    skuId: z.string().min(1, 'SKU ID 不能为空'),
    productName: z.string(),
    skuSpecName: z.string(),
    productType: z.enum(['疗程卡', '单品', '院装产品']),
    sessionCount: z.number().int().min(1).nullable(),
    unitPrice: z.string(),
    unitRealPrice: z.string(),
    quantity: z.number().int().min(1, '数量至少为 1'),
    salesCategory: z.enum(['自采自销', '他销自耗', '他销他耗', '生态合作']).nullable().optional(),
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
