---
name: wx-quality-assurance
description: 用于保障微信小程序 + CloudBase 项目质量，覆盖测试策略与用例编写、云函数单元测试、开发者工具调试、数据库验证、性能优化与安全测试清单。
metadata:
  title: 微信小程序质量保障
  author: fengyu
  version: 1.0.0
---

> 测试前请先了解 `.42cog/real.md`（7 条不可违反的业务规则）。

## 何时使用此技能

在进行 **微信小程序质量保障** 时使用，包括：

- 制定测试策略与编写测试用例
- 云函数单元测试
- 微信开发者工具调试
- 数据库操作验证
- 性能优化
- 安全测试

**不适用于：**
- UI 设计（请使用 `wx-ui-design`）
- 编码实现（请使用 `wx-coding`）
- 数据库设计（请使用 `wx-database-design`）

---

# 测试策略

## 小程序测试金字塔（项目约定）

```text
        ┌───────────┐
        │  手动测试   │  10% — 真机预览、流程走查
        │  (Manual)  │
        ├───────────┤
        │  集成测试   │  30% — 云函数 + 数据库联调
        │(Integration)│
        ├───────────┤
        │  单元测试   │  60% — 云函数逻辑、工具函数
        │  (Unit)    │
        └───────────┘
```

## 测试重点分配

| 测试类型 | 覆盖目标 | 工具 |
|---|---|---|
| 单元测试 | 云函数业务逻辑、工具函数、数据转换 | Jest / Vitest |
| 集成测试 | 云函数 + NoSQL/MySQL 联调、API 契约 | Jest + 测试环境 |
| 手动测试 | 真机预览、流程走查、UI 适配 | 微信开发者工具 |

## 测试文件组织

```text
cloudfunctions/
└── createOrder/
    ├── index.js
    ├── package.json
    └── __tests__/
        ├── index.test.js      # 单元测试
        └── index.integration.js  # 集成测试
miniprogram/
└── utils/
    ├── formatter.ts
    └── __tests__/
        └── formatter.test.ts
```

---

# 云函数单元测试

## Mock wx-server-sdk

```javascript
// __tests__/mocks/wx-server-sdk.js
const mockDb = {
  collection: jest.fn().mockReturnThis(),
  doc: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  get: jest.fn(),
  add: jest.fn(),
  update: jest.fn(),
  remove: jest.fn(),
  orderBy: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  skip: jest.fn().mockReturnThis(),
  command: {
    eq: jest.fn(v => ({ $eq: v })),
    neq: jest.fn(v => ({ $neq: v })),
    gt: jest.fn(v => ({ $gt: v })),
    inc: jest.fn(v => ({ $inc: v })),
    set: jest.fn(v => ({ $set: v })),
  },
  serverDate: jest.fn(() => new Date()),
  runTransaction: jest.fn(async (fn) => await fn(mockDb)),
}

const mockCloud = {
  init: jest.fn(),
  database: jest.fn(() => mockDb),
  getWXContext: jest.fn(() => ({
    OPENID: 'test-openid-001',
    APPID: 'wx1234567890',
    UNIONID: undefined,
  })),
  DYNAMIC_CURRENT_ENV: 'test-env',
}

module.exports = mockCloud
module.exports._mockDb = mockDb
```

## 云函数测试模板

```javascript
// cloudfunctions/createOrder/__tests__/index.test.js
jest.mock('wx-server-sdk', () => require('./mocks/wx-server-sdk'))

const cloud = require('wx-server-sdk')
const { _mockDb: mockDb } = cloud
const { main } = require('../index')

describe('createOrder', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    cloud.getWXContext.mockReturnValue({
      OPENID: 'test-openid-001',
      APPID: 'wx1234567890',
    })
  })

  test('成功创建订单', async () => {
    mockDb.add.mockResolvedValue({ _id: 'order-001' })

    const result = await main({
      storeId: 'store-001',
      items: [{ serviceId: 's1', quantity: 1, price: 100 }]
    })

    expect(result.code).toBe(0)
    expect(result.data.orderId).toBe('order-001')
    expect(mockDb.collection).toHaveBeenCalledWith('orders')
    expect(mockDb.add).toHaveBeenCalledTimes(1)
  })

  test('参数缺失返回错误', async () => {
    const result = await main({ storeId: '' })

    expect(result.code).toBe(-1)
    expect(result.message).toContain('参数')
  })

  test('仅店长可开单', async () => {
    // 模拟非店长用户
    mockDb.get.mockResolvedValue({
      data: [{ UDF_S_1161: '美容师' }]
    })

    const result = await main({
      storeId: 'store-001',
      items: [{ serviceId: 's1', quantity: 1 }]
    })

    expect(result.code).toBe(-1)
    expect(result.message).toContain('权限')
  })
})
```

## 工具函数测试

```typescript
// miniprogram/utils/__tests__/formatter.test.ts
import { maskPhone, formatPrice, formatOrderNo } from '../formatter'

describe('maskPhone', () => {
  test('脱敏标准手机号', () => {
    expect(maskPhone('13812345678')).toBe('138****5678')
  })

  test('空值返回空', () => {
    expect(maskPhone('')).toBe('')
    expect(maskPhone(undefined)).toBe('')
  })
})

describe('formatPrice', () => {
  test('分转元', () => {
    expect(formatPrice(10000)).toBe('100.00')
    expect(formatPrice(99)).toBe('0.99')
  })
})

describe('formatOrderNo', () => {
  test('生成正确格式', () => {
    const no = formatOrderNo(1)
    expect(no).toMatch(/^FY-XSD\d{6}\d+$/)
  })
})
```

---

# 微信开发者工具调试

## Console 面板

- 查看 `console.log` 输出和运行时错误
- 云函数日志需在「云开发控制台 → 云函数 → 日志」中查看
- 使用结构化日志：`console.log(JSON.stringify({ action, params, timestamp }))`

## Network 面板

- 监控所有网络请求（云函数调用、文件上传）
- 检查请求参数和响应数据
- 关注请求耗时，识别慢接口

## Storage 面板

- 查看和编辑本地存储（`wx.setStorageSync` / `wx.getStorageSync`）
- 清理缓存数据进行测试

## 真机调试

- 使用「预览」生成二维码进行真机测试
- 开启「真机调试」查看真机上的 Console 和 Network
- 测试不同机型的 rpx 适配效果

## 性能面板

- **Audits**：检测启动性能、运行时性能
- **Memory**：监控内存使用，识别内存泄漏
- **setData 分析**：检查 setData 频率和数据量

---

# 数据库测试

## 安全规则测试

1. 使用 `readSecurityRule` MCP 工具检查当前规则
2. 验证不同角色的访问权限：
   - 普通用户只能读写自己的数据
   - 管理员可以读写所有数据
   - 未认证用户无法写入

## _openid 隔离测试

```javascript
// 验证用户数据隔离
test('用户只能查询自己的订单', async () => {
  cloud.getWXContext.mockReturnValue({ OPENID: 'user-A' })

  const result = await main({ action: 'getMyOrders' })

  // 验证查询条件包含 _openid
  expect(mockDb.where).toHaveBeenCalledWith(
    expect.objectContaining({ _openid: 'user-A' })
  )
})
```

## MySQL 验证

- 使用 `executeReadOnlySQL` 验证表结构
- 使用 `executeReadOnlySQL` 验证数据一致性
- 检查 `_openid` 列是否存在

---

# 性能优化

## 启动优化

| 优化项 | 方法 |
|---|---|
| 代码包体积 | 分包加载（subpackages），主包 < 2MB |
| 按需加载 | **`"lazyCodeLoading": "requiredComponents"`**（app.json 中配置，官方强烈推荐） |
| 首屏数据 | 使用预拉取（prefetch），减少等待 |
| 图片资源 | 使用 CDN，Icons8（< 5KB），避免 Base64 |
| 初始化 | `wx.cloud.init()` 在 `onLaunch` 中仅调用一次 |
| 滚动优化 | `"enablePassiveEvent": true`（app.json 中配置） |

## setData 优化

```typescript
// 错误：频繁调用
items.forEach(item => {
  this.setData({ [`list[${i}]`]: item })  // 多次调用
})

// 正确：合并为一次
const updateData: Record<string, any> = {}
items.forEach((item, i) => {
  updateData[`list[${i}]`] = item
})
this.setData(updateData)  // 一次调用

// 正确：路径更新代替全量替换
this.setData({ 'list[0].status': '已支付' })  // 而非替换整个 list
```

## 图片优化

- 使用 `<image>` 的 `lazy-load` 属性
- 设置合理的 `mode`（`aspectFill` / `widthFix` / `scaleToFill`）
- 列表中避免加载原图，使用缩略图
- **优先使用 webp 格式**（体积更小，微信 `<image>` 组件原生支持）
- 根据实际显示尺寸请求对应大小的图片（如通过 CDN 缩放参数）

---

# 安全测试清单

基于 `real.md` 中 7 条不可违反的业务规则，逐条验证：

## 1. 服务端权限校验

- [ ] 开单接口在云函数中校验店长身份（`UDF_S_1161='门店经理'` AND `UDF_S_1624='否'`）
- [ ] 确认收款接口同样校验店长身份
- [ ] 非店长用户调用返回明确的权限错误

## 2. 数据写入一致性

- [ ] 枚举值原样匹配（`疗程卡`/`单品`、`是`/`否`）
- [ ] 编号格式正确（`FY-XSD{YYMMDD}{序号}`）
- [ ] RID 查库取 MAX+1
- [ ] 系统字段必填（FILLUSERID/FILLDATE/LOCKSTATE/REPORTSTATUS）
- [ ] 收款合计 = 各收款方式之和

## 3. 幂等性验证

- [ ] 下单接口：重复提交不会创建重复订单
- [ ] 支付确认：重复确认不会重复入账
- [ ] 疗程卡核销：重复完成不会重复扣次

## 4. 手机号脱敏

- [ ] 美容师查询接口返回脱敏手机号（`138****5678`）
- [ ] 店长查询接口返回完整手机号
- [ ] 脱敏在云函数中执行，不依赖前端

## 5. 日历统计准确性

- [ ] 日历仅展示 `已支付` 状态订单
- [ ] 按支付完成时间（非下单时间）入账
- [ ] 状态变更后日历即时更新（watch 推送）

## 6. 服务单状态流转

- [ ] 状态只能单向流转：待服务 → 服务中 → 已完成
- [ ] 疗程卡扣次仅在「服务中→已完成」时执行
- [ ] 剩余次数不得 < 0
- [ ] 单品支付即完成，不走核销

## 7. 门店绑定审批

- [ ] 同一顾客同时仅一条待审批申请
- [ ] 审批动作写入操作日志
- [ ] 仅店长可执行审批

---

## 通用安全检查

| 检查项 | 验证方法 |
|---|---|
| 认证 | 云函数中 `getWXContext()` 获取 OPENID，不依赖前端传值 |
| 授权 | 所有写操作在云函数中校验权限 |
| 数据验证 | 云函数中校验输入参数类型和范围 |
| 跨集合 | 跨集合操作通过云函数，不依赖前端拼接 |
| 密钥保护 | 数据库连接串、API Key 使用环境变量 |
| 安全规则 | 每个集合/表配置了适当的安全规则 |

## 隐私 API 授权测试

自 2023 年起，微信要求部分涉及用户隐私的 API 需先通过隐私授权才能调用。如项目使用以下 API，需测试隐私授权流程：

| API | 隐私权限 | 测试要点 |
|---|---|---|
| `wx.getLocation` | 地理位置 | 需配置 `requiredPrivateInfos` 并调用 `wx.requirePrivacyAuthorize` |
| `wx.chooseAddress` | 通讯地址 | 同上 |
| `wx.chooseLocation` | 选择位置 | 同上 |
| `wx.getWeRunData` | 微信运动步数 | 同上 |

**测试清单：**
- [ ] `app.json` 中是否配置了 `"usePrivacyCheck": true`（如使用隐私 API）
- [ ] 隐私弹窗是否在 API 调用前展示
- [ ] 用户拒绝授权后是否有友好提示和降级处理
- [ ] 隐私政策文档是否已在小程序管理后台上传
