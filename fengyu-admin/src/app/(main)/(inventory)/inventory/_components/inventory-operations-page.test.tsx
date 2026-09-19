import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 办理台（inventory-operations-page.tsx）的表单一致性守护（#135）。
 *
 * 这个文件 2720 行、20 个表单，且每个表单都依赖一大堆 server action 与联动状态，
 * 渲染测试的 mock 成本远高于收益。这里改用**源码守护**：断言的是本次改动的
 * 几条不变量，任一被改回去都会立刻转红。
 *
 * 判据全部来自各表单 submit() 里的校验分支，不是按字段名猜的 —— 三个 helper
 * 就是判据字典：
 *   optionalText()        → 可选
 *   positiveNumber()      → 空串返回 null（Number('') === 0 不满足 > 0）→ 真必填
 *   nonnegativeNumber()   → 空串返回 0 → 清空等价于填 0，**不是**必填
 */
describe('办理台表单一致性（#135）', () => {
  const source = readFileSync(resolve(__dirname, 'inventory-operations-page.tsx'), 'utf8')

  function block(from: string, to: string): string {
    const start = source.indexOf(from)
    const end = source.indexOf(to)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    return source.slice(start, end)
  }

  it('FormField 的 required 同时给出视觉 * 与读屏可读的「（必填）」', () => {
    // 只有 * 的话读屏用户听不出必填；只有 sr-only 的话视觉上看不出来。
    // 两者都要，且 * 必须 aria-hidden，否则读屏会念出「星号」。
    const formField = block('function FormField(', 'function RemarkField(')
    expect(formField).toMatch(/required = false/)
    expect(formField).toMatch(/aria-hidden="true">\*</)
    expect(formField).toMatch(/className="sr-only">（必填）</)
  })

  it('FormField 不往控件上加 HTML required 属性', () => {
    // 职责分工：值域（min/max/step）交给浏览器，必填与组合逻辑交给 submit()。
    // `required` 拦的是「空值」，而本页大量字段是条件必填（二选一 / filter-then-validate /
    // 驳回才必填），加上去会把合法的留空一律拦下，且弹的是浏览器通用文案而非业务文案。
    // 注意这跟保留 min/max 不矛盾 —— 后者拦的是「填了但越界」，submit() 的 JS 校验管不到。
    const formField = block('function FormField(', 'function RemarkField(')
    expect(formField).not.toMatch(/\brequired=\{required\}\s*\/?>/)
    expect(formField).not.toMatch(/aria-required/)
  })

  it('DocPicker 把 required 透传给 FormField', () => {
    // 漏传的话 9 个单据选择器全都不显示必填标记，而它们无一例外都是必填的。
    const docPicker = block('function DocPicker(', 'function SkuPicker(')
    expect(docPicker).toMatch(/required = false/)
    expect(docPicker).toMatch(/<FormField label=\{label\} required=\{required\}>/)
  })

  it('数值输入是 type=number 且带 min/step/max，不留 inputMode="decimal"', () => {
    // ⚠️ HTML 的 min 属性对 type=text **完全无效**。issue 原文说「补 min="0"」，
    // 但照字面只加 min 而不改 type，能让 UX 扫描器转绿却零实际效果 —— 假修复。
    expect(source).not.toMatch(/inputMode="decimal"/)

    const numberInputs = source.match(/type="number"[^/>]*/g) ?? []
    // 21 个数值输入分布在 18 行（有的一行多个）
    expect(numberInputs.length).toBe(21)
    for (const attrs of numberInputs) {
      expect(attrs).toMatch(/min="0(\.01)?"/)
      expect(attrs).toMatch(/step="0\.01"/)
      // numeric(12,2) 的上界：再大 PG 会抛 22003 numeric field overflow
      expect(attrs).toMatch(/max="9999999999\.99"/)
    }
  })

  it('min 按 positiveNumber / nonnegativeNumber 分档，不是一刀切 0', () => {
    // 走 positiveNumber 的字段填 0 会被 JS 拒绝，但 toast 说的是「请完整填写…」——
    // 字段明明填了却被告知没填完，用户会去找哪个框空着。给 min="0.01" 让浏览器
    // 直接说「值必须大于或等于 0.01」。
    // 「至少填一条」语义的（采购数量 / 实收数量）保持 min="0"：那里填 0 会被
    // .filter(x !== null) 剔除，等于「这行不选」，是合法操作，不能拦。
    const strict = source.match(/min="0\.01"/g) ?? []
    const loose = source.match(/min="0"/g) ?? []
    expect(strict.length).toBe(9)
    expect(loose.length).toBe(12)

    // 抽样两个方向，防止整体计数对了但分配错了
    const store = block('function StoreRequestForm(', 'function ItemCompanyReplenishmentForm(')
    expect(store).toMatch(/min="0\.01"/)          // 数量走 positiveNumber
    const purchase = block('function PurchaseOrderForm(', 'function SupplyChainPurchaseOrderForm(')
    expect(purchase).toMatch(/<FormField label="采购数量"><Input type="number" min="0"/)
  })

  it('「请完整填写」语义的字段标必填', () => {
    // 门店报货：submit() 里 `!storeId || !marketId` 与
    // `!item.skuId || item.quantity === null`（quantity 走 positiveNumber）。
    const form = block('function StoreRequestForm(', 'function ItemCompanyReplenishmentForm(')
    for (const label of ['报货门店', '所属市场', '商品', '数量']) {
      expect(form).toMatch(new RegExp(`<FormField label="${label}" required`))
    }
    // 这三个走 optionalText，不该标
    for (const label of ['报货日期', '明细备注']) {
      expect(form).toMatch(new RegExp(`<FormField label="${label}">`))
    }
  })

  it('「请填写至少一条」语义的字段**不**标必填', () => {
    // 采购订单的「采购数量」：submit() 先 .filter(quantity !== null) 再判
    // 「请填写至少一条采购数量」—— 逐行标 * 是误导（单行留空是允许的）。
    const purchase = block('function PurchaseOrderForm(', 'function SupplyChainPurchaseOrderForm(')
    expect(purchase).toMatch(/<FormField label="采购数量">/)
    expect(purchase).not.toMatch(/<FormField label="采购数量" required/)

    // 供应链采购入库的「实收数量」同理
    const receipt = block('function SupplyChainPurchaseReceiptForm(', 'function SupplyChainPurchaseCancelForm(')
    expect(receipt).toMatch(/<FormField label="实收数量">/)
    expect(receipt).not.toMatch(/<FormField label="实收数量" required/)
  })

  it('nonnegativeNumber 字段不标必填（空串等于 0，不是漏填）', () => {
    // 品项公司发货的「正常发货」「赠送数量」都走 nonnegativeNumber，且 submit()
    // 先 filter 掉两者之和为 0 的行 —— 单独清空任一个都是合法的。
    const shipment = block('function CompanyShipmentForm(', 'interface ReceiptProgressLine')
    expect(shipment).toMatch(/<FormField label="正常发货">/)
    expect(shipment).not.toMatch(/<FormField label="正常发货" required/)
    expect(shipment).toMatch(/<FormField label="赠送数量">/)
    expect(shipment).not.toMatch(/<FormField label="赠送数量" required/)
  })

  it('filter-then-validate 的批次字段不标必填（条件必填）', () => {
    // 品项公司发货 / 分院配货的 submit() 都是**先 filter 再校验**：
    //   .filter((line) => (line.quantity ?? 0) + (line.giftQuantity ?? 0) > 0)
    //   .some((line) => !Number.isInteger(line.lotId) || ...)
    // 数量为 0 的行根本不检查 lotId —— 部分发货时"这次不发"的行留空批次完全合法。
    // 标上 * 会逼用户去给不发货的行挑批次，而该 SKU 在该库位可能压根没有批次可挑。
    // 这与「采购数量不该逐行标」是同一类判据，只是发生在批次上。
    for (const [from, to, label] of [
      ['function CompanyShipmentForm(', 'interface ReceiptProgressLine', '发货批次'],
      ['function StoreAllocationForm(', 'function ReturnForm(', '市场批次'],
    ] as const) {
      const form = block(from, to)
      expect(form).toMatch(new RegExp(`<FormField label="${label}">`))
      expect(form).not.toMatch(new RegExp(`<FormField label="${label}" required`))
    }

    // 反向：市场员工购的「市场批次」**没有** filter（`items.some(...)` 直接校验每一行），
    // 是无条件必填，必须仍标着 —— 否则这条测试就退化成"把所有批次都去掉标记"也能过。
    const staffPurchase = block('function MarketStaffPurchaseForm(', 'function SelfPurchaseForm(')
    expect(staffPurchase).toMatch(/<FormField label="市场批次" required/)
  })

  it('必填标记覆盖到全部 19 个表单，不只是 UX 扫描点到的那 5 个', () => {
    // 只改被扫描到的 5 个表单，会让同一个 FormField 组件在页面内自相矛盾：
    // 用户看到有些字段带 *、有些不带，会以为不带的都是可选。
    const marked = source.match(/<(?:FormField|DocPicker) label=(?:"[^"]*"|\{[^}]*\}) required/g) ?? []
    expect(marked.length).toBe(58)
  })
})

/**
 * 业务工作区双 Tab 的结构守护（#190）。
 *
 * 同样走源码守护（理由见文件顶部：2800 行组件 + 20 个表单，渲染 mock 成本远高于收益）。
 * 这里钉的四条都是「改错了页面照常渲染、但行为静默跑偏」的点。
 */
describe('业务工作区双 Tab（#190）', () => {
  const source = readFileSync(resolve(__dirname, 'inventory-operations-page.tsx'), 'utf8')

  it('工作区默认停在填报表单，不是单据', () => {
    // 办理台的主用途是办业务。默认落到单据 Tab 会让每个人每次都多点一下。
    expect(source).toMatch(/<Tabs defaultValue="form">/)
    expect(source).toMatch(/<TabsTrigger value="form">填报表单<\/TabsTrigger>/)
    expect(source).toMatch(/<TabsTrigger value="docs">单据<\/TabsTrigger>/)
  })

  it('表单面板带 keepMounted，切去看单据不会清空填了一半的表单', () => {
    // 去掉 keepMounted 后页面完全正常，只是每次切 Tab 回来数据没了 ——
    // 这种回归没人会在 code review 里看出来。
    expect(source).toMatch(/<TabsContent value="form" keepMounted/)
  })

  it('单据面板按 operation 加 key，换业务时重置分页与已加载数据', () => {
    // 不加 key 的话，OperationDocsTab 在切换业务时不重建：page 还停在上一个业务的第 N 页，
    // 新业务的单据只有 1 页 → 打开就是空白，且 Pagination 会自纠回第 1 页再请求一次。
    expect(source).toMatch(/<OperationDocsTab key=\{operation\}/)
  })

  it('单据 Tab 只能走 listInventoryOperationDocs，不自己拼单据类型', () => {
    // 单据类型 / 状态 / 层级的收窄规则在服务端按 operationId 查映射表解析。
    // 客户端一旦自己拼 docType，映射表就有了第二份真相，改一处忘一处。
    expect(source).toContain('listInventoryOperationDocs')
    expect(source).not.toMatch(/listInventoryCoreDocs/)
    expect(source).not.toMatch(/docTypes:\s*\[/)
  })
})
