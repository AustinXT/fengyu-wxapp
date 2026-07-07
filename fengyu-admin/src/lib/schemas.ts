import { z } from 'zod'


export const loginSchema = z.object({
  phone: z.string()
    .min(1, '请输入手机号')
    .regex(/^1\d{10}$/, '请输入正确的手机号'),
  password: z.string()
    .min(1, '请输入密码'),
})
export type LoginInput = z.infer<typeof loginSchema>


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


const dateStringSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD')


const dateTimeStringSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, '时间格式应为 YYYY-MM-DDTHH:mm')


export const employeeSchema = z.object({
  employeeId: z.string().min(1, '员工编号不能为空'),
  name: z.string().min(1, '姓名不能为空'),
  phone: z.string()
    .regex(/^1\d{10}$/, '请输入正确的手机号')
    .optional()
    .or(z.literal('')),
  gender: z.enum(['男', '女']).optional().nullable(),
  
  idCard: z.string()
    .min(1, '请输入身份证号')
    .regex(/^\d{17}[\dXx]$/, '身份证号格式不正确'),
  storeId: z.string().min(1, '请选择门店'),
  orgNodeId: z.string().optional().nullable(),
  positionName: z.string().optional().nullable(),
  birthday: z.string().optional().nullable(),
  skills: z.array(z.string()).optional().nullable(),
  
  socialInsurance: z.boolean().optional(),
  
  hiredAt: dateStringSchema.optional().nullable().or(z.literal('')),
  
  leaveStart: dateTimeStringSchema.optional().nullable().or(z.literal('')),
  
  leaveEnd: dateTimeStringSchema.optional().nullable().or(z.literal('')),
  
  resignedAt: dateStringSchema.optional().nullable().or(z.literal('')),
  
  resignationReason: z.string().optional().nullable(),
})
export type EmployeeInput = z.infer<typeof employeeSchema>


export const storeSchema = z.object({
  storeName: z.string().min(1, '请输入门店名称'),
  marketId: z.string().min(1, '请选择所属市场'),
  openingDate: dateStringSchema.optional().nullable().or(z.literal('')),
  
  closedAt: dateStringSchema.optional().nullable().or(z.literal('')),
  bedCount: z.number().int().min(0).optional().nullable(),
  phone: z.string().optional().nullable(),
  businessHours: z.string().optional().nullable(),
})
export type StoreInput = z.infer<typeof storeSchema>



export const paymentMethodSchema = z.enum(['微信', '支付宝', '线下', '无'])
export type PaymentMethodInput = z.infer<typeof paymentMethodSchema>


export const createOrderSchema = z.object({
  storeId: z.string().min(1, '请选择门店'),
  marketName: z.string().min(1, '市场名称不能为空'),
  clientUserId: z.string().nullable(),
  clientPhone: z.string().regex(/^1\d{10}$/, '请输入正确的手机号'),
  customerName: z.string().min(1, '顾客姓名不能为空'),
  paymentMethod: paymentMethodSchema,
  
  saleOrderType: z.enum(['销售单', '内部单', '转换单']),
  openedBy: z.string().min(1, '开单人不能为空'),
  preferredEmployeeId: z.string().optional(),
  
  receivedAmount: z.number().min(0, '本次收款金额不能为负').optional(),
  
  couponId: z.string().optional().nullable(),
  
  isActivity: z.boolean().optional(),
  items: z.array(z.object({
    skuId: z.string().min(1, 'SKU ID 不能为空'),
    productName: z.string(),
    productType: z.enum(['疗程卡', '家居产品']),
    sessionCount: z.number().int().min(1).nullable(),
    unitPrice: z.string(),
    unitRealPrice: z.string(),
    quantity: z.number().int().min(1, '数量至少为 1'),
    salesCategory: z.enum(['自销自耗', '他销自耗', '他销他耗', '生态合作']).nullable().optional(),
  })).min(1, '请至少选择一件商品'),
})
export type CreateOrderInput = z.infer<typeof createOrderSchema>


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


export const assignRoleSchema = z.object({
  employeeId: z.string().min(1, '请选择员工'),
  role: z.enum(['admin', 'manager', 'finance', 'hr', 'product', 'customer_mgr']),
  scopeId: z.string().min(1, '请选择组织范围'),
})
export type AssignRoleInput = z.infer<typeof assignRoleSchema>





export const recordPaymentInputSchema = z.object({
  saleOrderId: z.string().min(1, '订单号不能为空'),
  repayAmount: z.number().multipleOf(0.01, '金额精度最多 2 位小数').min(0, '回款金额不能为负'),
  paymentMethod: z.enum(['线下', '储值卡']),
  externalTxnId: z.string().optional(),
  prepaidCardAmount: z.number().multipleOf(0.01, '金额精度最多 2 位小数').min(0, '储值卡抵扣金额不能为负').default(0),
  note: z.string().optional(),
  
  idempotencyKey: z.string().optional(),
}).refine((v) => v.repayAmount + v.prepaidCardAmount > 0, {
  message: '回款金额与储值卡抵扣不能都为 0',
  path: ['repayAmount'],
}).refine(
  (v) => v.paymentMethod !== '线下' || (!!v.externalTxnId && v.externalTxnId.trim().length > 0) || v.repayAmount === 0,
  { message: '线下回款必须填写外部交易号（银行回执号/流水号）', path: ['externalTxnId'] },
)
export type RecordPaymentInput = z.infer<typeof recordPaymentInputSchema>


export const rechargeTierSchema = z.object({
  faceValue: z.number().positive('面额必须 > 0'),
  payAmount: z.number().min(0, '实付金额不能为负'),
}).refine((t) => t.payAmount <= t.faceValue + 1e-6, {
  message: '实付金额不能高于面额',
  path: ['payAmount'],
})

export const rechargeCardConfigSchema = z.object({
  tiers: z.array(rechargeTierSchema).min(1, '至少配置一个充值档位'),
  minAmount: z.number().positive('最低充值金额必须 > 0'),
  maxAmount: z.number().positive('单次上限必须 > 0'),
}).refine((c) => c.maxAmount >= c.minAmount, {
  message: '单次上限不能低于最低充值金额',
  path: ['maxAmount'],
}).refine((c) => new Set(c.tiers.map((t) => t.faceValue)).size === c.tiers.length, {
  message: '充值档位面额不能重复',
  path: ['tiers'],
})
export type RechargeCardConfigInput = z.infer<typeof rechargeCardConfigSchema>
