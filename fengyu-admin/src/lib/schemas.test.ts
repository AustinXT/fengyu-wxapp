import { describe, it, expect } from 'vitest'
import {
  loginSchema,
  changePasswordSchema,
  employeeSchema,
  createOrderSchema,
  commissionRateSchema,
  assignRoleSchema,
} from './schemas'

// ─── 登录表单 ───
describe('loginSchema', () => {
  it('合法数据通过', () => {
    expect(loginSchema.safeParse({ phone: '13800138000', password: 'admin123' }).success).toBe(true)
  })

  it('空手机号拒绝', () => {
    const r = loginSchema.safeParse({ phone: '', password: 'admin123' })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues[0].message).toBe('请输入手机号')
  })

  it('非法手机号格式拒绝', () => {
    expect(loginSchema.safeParse({ phone: '2380013800', password: 'x' }).success).toBe(false)
    expect(loginSchema.safeParse({ phone: '1234', password: 'x' }).success).toBe(false)
    expect(loginSchema.safeParse({ phone: '138001380001', password: 'x' }).success).toBe(false)
  })

  it('空密码拒绝', () => {
    const r = loginSchema.safeParse({ phone: '13800138000', password: '' })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues[0].message).toBe('请输入密码')
  })
})

// ─── 修改密码 ───
describe('changePasswordSchema', () => {
  it('合法密码通过', () => {
    expect(changePasswordSchema.safeParse({ newPassword: 'abc12345', confirmPassword: 'abc12345' }).success).toBe(true)
  })

  it('密码少于 8 位拒绝', () => {
    const r = changePasswordSchema.safeParse({ newPassword: 'abc1', confirmPassword: 'abc1' })
    expect(r.success).toBe(false)
  })

  it('纯数字密码拒绝（缺字母）', () => {
    expect(changePasswordSchema.safeParse({ newPassword: '12345678', confirmPassword: '12345678' }).success).toBe(false)
  })

  it('纯字母密码拒绝（缺数字）', () => {
    expect(changePasswordSchema.safeParse({ newPassword: 'abcdefgh', confirmPassword: 'abcdefgh' }).success).toBe(false)
  })

  it('两次密码不一致拒绝', () => {
    const r = changePasswordSchema.safeParse({ newPassword: 'abc12345', confirmPassword: 'abc12346' })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues[0].message).toBe('两次密码不一致')
  })
})

// ─── 员工表单 ───
describe('employeeSchema', () => {
  const valid = {
    employeeId: 'FY-260313-0001',
    name: '张三',
    storeId: 'store-nc01',
  }

  it('最小合法数据通过', () => {
    expect(employeeSchema.safeParse(valid).success).toBe(true)
  })

  it('员工编号为空拒绝', () => {
    expect(employeeSchema.safeParse({ ...valid, employeeId: '' }).success).toBe(false)
  })

  it('姓名为空拒绝', () => {
    expect(employeeSchema.safeParse({ ...valid, name: '' }).success).toBe(false)
  })

  it('门店为空拒绝', () => {
    expect(employeeSchema.safeParse({ ...valid, storeId: '' }).success).toBe(false)
  })

  it('合法手机号通过', () => {
    expect(employeeSchema.safeParse({ ...valid, phone: '13800138000' }).success).toBe(true)
  })

  it('非法手机号拒绝', () => {
    expect(employeeSchema.safeParse({ ...valid, phone: '1234' }).success).toBe(false)
  })

  it('空手机号允许（可选）', () => {
    expect(employeeSchema.safeParse({ ...valid, phone: '' }).success).toBe(true)
  })

  it('合法身份证号通过', () => {
    expect(employeeSchema.safeParse({ ...valid, idCard: '360102199001011234' }).success).toBe(true)
    expect(employeeSchema.safeParse({ ...valid, idCard: '36010219900101123X' }).success).toBe(true)
  })

  it('非法身份证号拒绝', () => {
    expect(employeeSchema.safeParse({ ...valid, idCard: '1234' }).success).toBe(false)
  })

  it('带技能数组通过', () => {
    expect(employeeSchema.safeParse({ ...valid, skills: ['美容师', '养生师'] }).success).toBe(true)
  })
})

// ─── 订单创建 ───
describe('createOrderSchema', () => {
  const validItem = {
    skuId: 'sku-001',
    productName: '蜜语生玑',
    skuSpecName: '10次卡',
    productType: '疗程卡' as const,
    sessionCount: 10,
    unitPrice: '1999.00',
    unitRealPrice: '1800.00',
    quantity: 1,
    salesCategory: '自采自销' as const,
  }

  const validOrder = {
    storeId: 'store-nc01',
    marketName: '南昌市场',
    clientUserId: null,
    clientPhone: '13800138000',
    customerName: '李女士',
    paymentMethod: 'offline' as const,
    saleOrderType: '普通' as const,
    openedBy: 'FY-260101-0001',
    items: [validItem],
  }

  it('合法订单通过', () => {
    expect(createOrderSchema.safeParse(validOrder).success).toBe(true)
  })

  it('空商品列表拒绝', () => {
    expect(createOrderSchema.safeParse({ ...validOrder, items: [] }).success).toBe(false)
  })

  it('门店为空拒绝', () => {
    expect(createOrderSchema.safeParse({ ...validOrder, storeId: '' }).success).toBe(false)
  })

  it('顾客手机号格式拒绝', () => {
    expect(createOrderSchema.safeParse({ ...validOrder, clientPhone: '1234' }).success).toBe(false)
  })

  it('商品数量为 0 拒绝', () => {
    const badItem = { ...validItem, quantity: 0 }
    expect(createOrderSchema.safeParse({ ...validOrder, items: [badItem] }).success).toBe(false)
  })

  it('商品数量为负数拒绝', () => {
    const badItem = { ...validItem, quantity: -1 }
    expect(createOrderSchema.safeParse({ ...validOrder, items: [badItem] }).success).toBe(false)
  })

  it('多件商品通过', () => {
    const items = [
      validItem,
      { ...validItem, skuId: 'sku-002', productType: '单品' as const, sessionCount: null, quantity: 2 },
    ]
    expect(createOrderSchema.safeParse({ ...validOrder, items }).success).toBe(true)
  })

  it('支持全部订单类型', () => {
    const types = ['普通', '体验', '内部', '福利活动', '回款', '转换', '退款'] as const
    types.forEach(t => {
      expect(createOrderSchema.safeParse({ ...validOrder, saleOrderType: t }).success).toBe(true)
    })
  })

  it('非法订单类型拒绝', () => {
    expect(createOrderSchema.safeParse({ ...validOrder, saleOrderType: '未知' }).success).toBe(false)
  })
})

// ─── 提成矩阵 ───
describe('commissionRateSchema', () => {
  const valid = {
    orgId: 'org-market-nc',
    orderType: '销售单',
    roleType: '美容师',
    salesCategory: '自采自销',
    amountTierMin: '0',
    amountTierMax: '5000',
    commissionRate: '0.08',
  }

  it('合法配置通过', () => {
    expect(commissionRateSchema.safeParse(valid).success).toBe(true)
  })

  it('提成比例 0 通过（无提成）', () => {
    expect(commissionRateSchema.safeParse({ ...valid, commissionRate: '0' }).success).toBe(true)
  })

  it('提成比例 1 通过（100%）', () => {
    expect(commissionRateSchema.safeParse({ ...valid, commissionRate: '1' }).success).toBe(true)
  })

  it('提成比例超过 1 拒绝', () => {
    expect(commissionRateSchema.safeParse({ ...valid, commissionRate: '1.5' }).success).toBe(false)
  })

  it('提成比例为负数拒绝', () => {
    expect(commissionRateSchema.safeParse({ ...valid, commissionRate: '-0.1' }).success).toBe(false)
  })

  it('最小金额为负数拒绝', () => {
    expect(commissionRateSchema.safeParse({ ...valid, amountTierMin: '-100' }).success).toBe(false)
  })

  it('最大金额为空允许（无上限）', () => {
    expect(commissionRateSchema.safeParse({ ...valid, amountTierMax: '' }).success).toBe(true)
  })

  it('市场为空拒绝', () => {
    expect(commissionRateSchema.safeParse({ ...valid, orgId: '' }).success).toBe(false)
  })
})

// ─── 权限分配 ───
describe('assignRoleSchema', () => {
  it('合法分配通过', () => {
    expect(assignRoleSchema.safeParse({
      employeeId: 'FY-260101-0001',
      role: 'manager',
      scopeId: 'org-store-nc01',
    }).success).toBe(true)
  })

  it('员工为空拒绝', () => {
    expect(assignRoleSchema.safeParse({
      employeeId: '',
      role: 'manager',
      scopeId: 'org-store-nc01',
    }).success).toBe(false)
  })

  it('非法角色拒绝', () => {
    expect(assignRoleSchema.safeParse({
      employeeId: 'FY-260101-0001',
      role: 'staff', // staff 不在 enum 中
      scopeId: 'org-store-nc01',
    }).success).toBe(false)
  })

  it('组织范围为空拒绝', () => {
    expect(assignRoleSchema.safeParse({
      employeeId: 'FY-260101-0001',
      role: 'admin',
      scopeId: '',
    }).success).toBe(false)
  })

  it('支持全部可分配角色', () => {
    const roles = ['admin', 'manager', 'finance', 'hr', 'product', 'customer_mgr'] as const
    roles.forEach(role => {
      expect(assignRoleSchema.safeParse({
        employeeId: 'FY-260101-0001',
        role,
        scopeId: 'org-hq',
      }).success).toBe(true)
    })
  })
})
