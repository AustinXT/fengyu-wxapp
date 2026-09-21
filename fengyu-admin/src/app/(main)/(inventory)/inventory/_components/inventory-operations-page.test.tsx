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

  it('主体字段一律走 InventorySubjectSelect，不退回裸 Select（#189）', () => {
    // 组件单测只测组件自身、INV-11 默认 skip —— 把这 17 处换回 `<Select>` 不会让
    // 任何测试变红，而回退的后果（唯一候选还要手点一次 / 联动被吞）在总部、市场
    // 都只有一个的环境里肉眼难辨。这里钉住接线本身。
    expect(source.match(/<InventorySubjectSelect/g) ?? []).toHaveLength(17)

    // 反向：主体类 state 不得再出现在裸 `<Select value={...}>` 上。
    const subjectStates = [
      'supplyChainLocationId', 'marketId', 'storeId', 'sourceMarketId',
      'sourceOrgNodeId', 'targetOrgNodeId', 'locationId',
    ]
    for (const state of subjectStates) {
      expect(source).not.toMatch(new RegExp(`<Select value=\\{${state}\\}`))
    }
  })

  it('值由上游字段派生的主体不参与自动选中（#189）', () => {
    // 「所属市场」由报货门店带出、「回库主体」由退货主体带出。这两处若自己补值：
    //   ① 上游还没选时，只读文本展示的「唯一候选」不是最终会用的主体（门店退货
    //      永远不可能回总部）；
    //   ② 兄弟组件的 effect 在同一次 flush 里读的是本轮渲染前的快照，补出来的值
    //      会反过来盖掉联动刚写进去的那个（后写胜出）。
    const storeRequest = block('function StoreRequestForm(', 'function ItemCompanyReplenishmentForm(')
    expect(storeRequest).toMatch(/label="所属市场"[\s\S]*?autoSelect=\{false\}/)

    const returnForm = block('function ReturnForm(', 'function ReturnApprovalForm(')
    expect(returnForm).toMatch(/label="回库主体"[\s\S]*?autoSelect=\{false\}/)
    // 反向：退货主体本身是上游，必须保持自动选中。按字段区间截取再断言，
    // 避免「区间外某处出现 autoSelect={false}」把这条测试骗过去。
    const returnSourceField = returnForm.slice(
      returnForm.indexOf('label="退货主体"'),
      returnForm.indexOf('label="回库主体"'),
    )
    expect(returnSourceField).not.toMatch(/autoSelect=\{false\}/)
  })

  it('随单回填的主体在选定单据后不自动补值（#189）', () => {
    // 5 个表单会在选定来源单据后把主体回填成单据自己的主体。单据没带主体时（
    // `target_org_node_id` 可空）值会被写成空串 —— 此时组件若自作主张补一个唯一候选，
    // 界面显示"已固定"，服务端却仍按来源单据一致性拒绝，用户看不出问题出在哪。
    expect(source.match(/autoSelect=\{!doc\}/g) ?? []).toHaveLength(5)

    for (const [from, to] of [
      ['function PurchaseOrderForm(', 'function SupplyChainPurchaseOrderForm('],
      ['function SupplyChainPurchaseOrderForm(', 'interface ShipmentDraftLine'],
      ['function CompanyShipmentForm(', 'interface ReceiptProgressLine'],
      ['function SupplyChainPurchaseReceiptForm(', 'function SupplyChainPurchaseCancelForm('],
      ['function StoreAllocationForm(', 'function ReturnForm('],
    ] as const) {
      expect(block(from, to)).toMatch(/autoSelect=\{!doc\}/)
    }
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

  it('工作区默认停在填报表单，且换业务时 key 强制重建（光有 defaultValue 钉不住）', () => {
    // 办理台的主用途是办业务。默认落到单据 Tab 会让每个人每次都多点一下。
    // ⚠️ Tabs 是 uncontrolled：父层在 activeOperation A→B 时原地更新不重挂，
    // 选中态会跟着跑到下一个业务 —— 点开 B 直接落在 B 的单据页。key 是唯一的拦法，
    // 只断言 defaultValue 的话，这个回归照样全绿。
    expect(source).toMatch(/<Tabs key=\{operation\} defaultValue="form">/)
    expect(source).toMatch(/<TabsTrigger value="form">填报表单<\/TabsTrigger>/)
    expect(source).toMatch(/<TabsTrigger value="docs">单据<\/TabsTrigger>/)
  })

  it('表单面板带 keepMounted，切去看单据不会清空填了一半的表单', () => {
    // 去掉 keepMounted 后页面完全正常，只是每次切 Tab 回来数据没了 ——
    // 这种回归没人会在 code review 里看出来。
    expect(source).toMatch(/<TabsContent value="form" keepMounted/)
  })

  it('金额列头只看会话级价格权限，不从当前页数据反推', () => {
    // 反推（`rows.some(r => r.totalAmount != null)`）看着能少一列空「—」，实则更糟：
    // 行级遮蔽后 totalAmount 就是 undefined，混合绑定账号翻到整页都被遮蔽的那一页时
    // 金额列会整列消失、翻回去又出现，表头随页抖动；无权限的行也不再显示「—」。
    const tab = source.slice(source.indexOf('function OperationDocsTab('))
    expect(tab).toMatch(/setPriceVisible\(result\.canViewPrice\)/)
    expect(tab).toMatch(/\.\.\.\(priceVisible\s*\n?\s*\?/)
    expect(tab).not.toMatch(/rows\.some\([^)]*totalAmount/)
  })

  it('请求失败的空表与真的没单据，文案必须不同', () => {
    // 两者都渲染「暂无单据」的话，用户会以为这个业务真的一张单都没有。
    const tab = source.slice(source.indexOf('function OperationDocsTab('))
    expect(tab).toMatch(/setFailed\(true\)/)
    expect(tab).toMatch(/emptyText=\{failed \? '单据加载失败/)
  })

  it('分页器用服务端返回的 pageSize，不用前端常量', () => {
    // engine 会把非白名单页长静默夹成 20。前端按自己那份算总页数的话，
    // 页码条少算页数，最后几页永远翻不到且没有任何提示。
    const tab = source.slice(source.indexOf('function OperationDocsTab('))
    expect(tab).toMatch(/setPageSize\(result\.pageSize\)/)
    expect(tab).toMatch(/<Pagination total=\{total\} page=\{page\} pageSize=\{pageSize\}/)
  })

  it('请求失败不清零 total，否则用户被静默弹回第 1 页并触发第二次请求', () => {
    // Pagination 的越界自纠：total=0 → totalPages=1 → 第 3 页越界 → onPageChange(1)
    // → effect 依赖变 → 再发一次请求。一次瞬时失败被放大成跳页 + 重复请求。
    const catchBlock = source.slice(source.indexOf('.catch((error) => {', source.indexOf('function OperationDocsTab(')))
    expect(catchBlock.slice(0, 400)).toMatch(/setRows\(\[\]\)/)
    expect(catchBlock.slice(0, 400)).not.toMatch(/setTotal\(0\)/)
  })

  it('单据号用新标签打开详情，不做整行 router.push', () => {
    // keepMounted 的全部意义是「去单据 Tab 看一眼回来表单还在」。行内 router.push
    // 会把整个办理台连同填了一半的明细卸载掉，而 returnTo 只恢复 URL、恢复不了 React state。
    const tab = source.slice(source.indexOf('function OperationDocsTab('))
    expect(tab).toMatch(/target="_blank"/)
    expect(tab).toMatch(/rel="noopener noreferrer"/)
    expect(tab).not.toMatch(/onRowClick/)
  })

  it('单据 Tab 只能走 listInventoryOperationDocs，不自己拼单据类型', () => {
    // 单据类型 / 状态 / 层级的收窄规则在服务端按 operationId 查映射表解析。
    // 客户端一旦自己拼 docType，映射表就有了第二份真相，改一处忘一处。
    expect(source).toContain('listInventoryOperationDocs')
    expect(source).not.toMatch(/listInventoryCoreDocs/)
    expect(source).not.toMatch(/docTypes:\s*\[/)
  })
})

/**
 * 通用业务卡片与单据 Tab 的边界（#190 / #191）。
 *
 * 10 张通用卡（内部领用 / 报损 / 盘点 / 调货 / 顾客产品出库…）目前借用了三个真实
 * 转换业务的 id 当 React key，靠 `href` 分支走 <Link> 跳单据中心，永远不会
 * setActiveOperation，所以不会打开单据 Tab。这层保护是**隐式**的 ——
 * 一旦 #191 把某张卡改成内嵌表单而忘了给它自己的 id，
 * 「市场产品报损」的单据 Tab 会直接列出库存转换单：页面完全正常，数据完全不对。
 */
describe('通用业务卡片不参与单据 Tab（#190 / #191 交界）', () => {
  const source = readFileSync(resolve(__dirname, 'inventory-operations-page.tsx'), 'utf8')

  it('GENERIC_OPERATIONS 每一条都带 href（否则会落进按 id 查映射表的单据 Tab）', () => {
    const generic = source.slice(
      source.indexOf('const GENERIC_OPERATIONS'),
      source.indexOf('function today()'),
    )
    const entries = generic.match(/\{ id: '[^']+',[^}]*\}/g) ?? []
    /*
     * ⚠️ 上面的正则要求 `id` 是字面量的第一个键且条目里没有嵌套对象。
     * 键序一变条目就不进 entries —— 没 href 也不会红，正好漏掉这条测试要防的事故。
     * 所以先用「`id:` 的出现次数 == 抓到的条目数」把漏检本身钉住。
     */
    const idCount = (generic.match(/\bid: '/g) ?? []).length
    expect(entries.length, '有通用卡没被守护正则抓到（键序变了？含嵌套对象？）').toBe(idCount)
    expect(entries.length).toBeGreaterThanOrEqual(10)
    for (const entry of entries) {
      expect(entry, `通用卡缺 href：${entry.slice(0, 60)}`).toContain("href: '/inventory/docs?create=")
    }
  })

  it('工作区只接受 OPERATIONS 里的卡片，通用卡走 Link 分支', () => {
    // active 的来源必须限定在 OPERATIONS（内置表单卡），不能把 GENERIC_OPERATIONS 也算进去。
    expect(source).toMatch(/const active = OPERATIONS\.find\(/)
    expect(source).toMatch(/if \(operation\.href\) \{/)
  })
})
