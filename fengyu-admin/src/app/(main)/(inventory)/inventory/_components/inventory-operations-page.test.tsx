import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { INVENTORY_GENERIC_DOC_TYPES } from '@/lib/inventory/types'
import { INVENTORY_BUSINESS_LEVELS, genericDocBusinessLevel } from '@/lib/inventory/business-level'

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
    // #194 把「供应链采购订单」并入「采购订单」，原右锚 SupplyChainPurchaseOrderForm 已不存在，
    // 改用紧随其后的 interface 作右锚。
    const purchase = block('function PurchaseOrderForm(', 'interface ShipmentDraftLine {')
    expect(purchase).toMatch(/<FormField label="采购数量">/)
    expect(purchase).toMatch(/min="0"/)
    // 市场报货汇总（#193）同属「至少填一条」语义，也走 min="0"
    const summary = block('function MarketReportSummaryForm(', 'interface PurchaseSourceLine {')
    expect(summary).toMatch(/min="0"/)
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
    const purchase = block('function PurchaseOrderForm(', 'interface ShipmentDraftLine {')
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
    // #194 把两张采购表单合并成一张：`SupplyChainPurchaseOrderForm` 已不存在，
    // 清单从 5 条减到 4 条。合并后的 `PurchaseOrderForm` 没有单选的来源单，
    // 同一语义写成 `autoSelect={selectedDocIds.length === 0}`（勾了来源就交还单据决定），
    // 所以它不计入 `!doc` 那一组，单独断言。
    expect(source.match(/autoSelect=\{!doc\}/g) ?? []).toHaveLength(3)

    for (const [from, to] of [
      ['function CompanyShipmentForm(', 'interface ReceiptProgressLine'],
      ['function SupplyChainPurchaseReceiptForm(', 'function SupplyChainPurchaseCancelForm('],
      ['function StoreAllocationForm(', 'function ReturnForm('],
    ] as const) {
      expect(block(from, to)).toMatch(/autoSelect=\{!doc\}/)
    }
    expect(block('function PurchaseOrderForm(', 'interface ShipmentDraftLine {'))
      .toMatch(/autoSelect=\{selectedDocIds\.length === 0\}/)
  })

  it('必填标记覆盖到全部表单，不只是 UX 扫描点到的那 5 个', () => {
    // 只改被扫描到的 5 个表单，会让同一个 FormField 组件在页面内自相矛盾：
    // 用户看到有些字段带 *、有些不带，会以为不带的都是可选。
    //
    // 58 → 55：#194 把两张采购表单合成一张。原先两张各带 3 个必填（来源单 / 供应商 /
    // 供应链主体 = 6 个），合并后供应商不再手选（按商品带出）、来源单改成多选清单
    // （标题上自带 *，不是 FormField），只剩「供应链库存主体」1 个；
    // #193 新增的市场报货汇总表单同样只有 1 个 —— 这两项合计 6 → 2。
    // 品项公司发货表单则多出 1 个「发往市场」（混合单一次只能发一个市场）。净减 3。
    const marked = source.match(/<(?:FormField|DocPicker) label=(?:"[^"]*"|\{[^}]*\}) required/g) ?? []
    expect(marked.length).toBe(55)
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
    //
    // #190 返回入口起 defaultValue 改吃 defaultTab，但它只能来自**一次性券**：
    // key 在 A→B→A 时重建 Tabs，直接读 URL 上的 tab 会让用户之后每次打开那张卡
    // 都被弹到单据 Tab，且没有任何报错 —— 本次改动最隐蔽的一个回归面。
    expect(source).toMatch(/<Tabs key=\{operation\} defaultValue=\{defaultTab\}>/)
    expect(source).toMatch(/defaultTab=\{pendingDocsTabFor === active\.id \? 'docs' : 'form'\}/)
    expect(source).not.toMatch(/defaultValue=\{initialTab\}/)
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
    expect(tab).not.toMatch(/onRowClick/)
    // #190：rel 必须留着 opener，详情页的「返回XX办理台」靠 window.opener 判断
    // 本标签是不是办理台开出来的 —— 能判才敢 window.close() 真正回到原标签。
    // 换回 noopener 的话返回会静默退化成「在新标签里再开一个空办理台」。
    expect(tab).toMatch(/rel="opener"/)
    expect(tab).not.toMatch(/rel="noopener/)
  })

  it('单据号 href 必须带来源参数，漏了详情页的返回入口会静默退化', () => {
    // 漏传 from/level/op 的后果：详情页 resolveInventoryDocReturn 返回 null，
    // 返回入口退化成「返回」→ 单据中心。两个页面各自看都完全正常，没人看得出来。
    const tab = source.slice(source.indexOf('function OperationDocsTab('))
    expect(tab).toMatch(/href=\{inventoryOperationDocHref\(row\.id, level, operation\)\}/)
    expect(tab).not.toMatch(/href=\{`\/inventory\/docs\/\$\{row\.id\}`\}/)
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
 * 通用建单业务卡片（#191 把 #190 里「通用卡走 Link、不参与单据 Tab」那层临时保护
 * 换成了真正的映射）。
 *
 * 这批卡以前借用三个转换业务的 id 当 React key，靠 `href` 分支绕开单据 Tab；
 * 现在它们和内置卡一样能打开工作区，保护必须落在 **id 与 docType 的对应关系**上 ——
 * 借错 id 的后果是「市场产品报损」的 Tab 列出库存转换单：页面完全正常，数据完全不对。
 */
describe('通用建单业务卡片（#191）', () => {
  const source = readFileSync(resolve(__dirname, 'inventory-operations-page.tsx'), 'utf8')

  const genericBlock = source.slice(
    source.indexOf('const GENERIC_OPERATIONS'),
    source.indexOf('function genericAsOperation'),
  )

  it('通用卡只声明 docType，不再借用内置业务 id', () => {
    // 有 `id:` 就说明又开始手写 id 了 —— 那正是借错 id 的入口。
    expect(genericBlock).not.toMatch(/\bid: '/)
    const docTypes = [...genericBlock.matchAll(/docType: '([^']+)'/g)].map((m) => m[1])
    expect(docTypes.length).toBe(10)
    // 每张卡的类型必须真属于「无需上游血缘」的通用建单类型，
    // 混进 '品项公司发货' 这种业务单类型就等于从通用入口绕过专用服务的校验。
    for (const docType of docTypes) {
      expect(INVENTORY_GENERIC_DOC_TYPES, `${docType} 不是通用建单类型`).toContain(docType)
    }
    // 10 张卡覆盖全部 10 种通用类型，不重不漏
    expect([...docTypes].sort()).toEqual([...INVENTORY_GENERIC_DOC_TYPES].sort())
  })

  it('通用卡所在层级与 genericDocBusinessLevel 一致', () => {
    // 不一致的话，深链 `?create=<docType>` 的层级校验会把用户挡在门外，
    // 而卡片就明晃晃摆在那个层级的页面上 —— 点得开、深链打不开，自相矛盾。
    for (const level of INVENTORY_BUSINESS_LEVELS) {
      const levelBlock = genericBlock.slice(
        genericBlock.indexOf(`${level === 'supply-chain' ? "'supply-chain'" : level}: [`),
      )
      const firstEntryEnd = levelBlock.indexOf('\n  ],')
      const entries = [...levelBlock.slice(0, firstEntryEnd).matchAll(/docType: '([^']+)'/g)].map((m) => m[1])
      expect(entries.length, `${level} 没解析到通用卡`).toBeGreaterThan(0)
      for (const docType of entries) {
        expect(genericDocBusinessLevel(docType as never), `${docType} 挂错层级`).toBe(level)
      }
    }
  })

  it('通用业务走共享建单表单，且 visible 不跟 Tab 切换走', () => {
    // visible 接到 Tab 上的话，用户切去看单据再回来，已选的批次会被
    // 共享表单的「不可见即推进代次」effect 清掉 —— 直接违背 #190 的「切 Tab 不丢表单」。
    const workspace = source.slice(source.indexOf('function OperationWorkspace('))
    expect(workspace).toMatch(/<InventoryDocCreateForm\s+visible\s/)
    expect(workspace).toMatch(/allowedDocTypes=\{\[card\.docType\]\}/)
    // 锁死单一类型：不锁的话用户能在「市场产品报损」的工作区里改选成盘点单。
    expect(workspace).toMatch(/initialDocType=\{card\.docType\}/)
  })

  it('卡片渲染不再有 href/Link 分支', () => {
    const cardsBlock = source.slice(source.indexOf('{levelOperations.filter('), source.indexOf('{active && ('))
    expect(cardsBlock).not.toMatch(/operation\.href/)
    expect(cardsBlock).not.toMatch(/<Link/)
  })
})

/**
 * 共享建单表单接进办理台时的闸门（#191 pr-ready 三方审计的 P1/P2）。
 *
 * 这几条防的都是「页面看起来完全正常，但用户多建了一张实扣库存的单」。
 */
describe('办理台内嵌建单的闸门（#191）', () => {
  const source = readFileSync(resolve(__dirname, 'inventory-operations-page.tsx'), 'utf8')
  const formSource = readFileSync(resolve(__dirname, 'inventory-doc-create-form.tsx'), 'utf8')

  it('建单成功后表单就地清场，不能靠调用方去关弹窗', () => {
    /*
     * 办理台提交完工作区还开着（只 toast + router.refresh()，后者不重挂客户端组件）。
     * 不清场的话用户再点一次就是第二张一模一样的单，而 10 种通用类型里有 6 种
     * 建单当刻就落库存流水 —— 重复提交＝重复扣减，只能事后红冲。
     */
    const submitBody = formSource.slice(
      formSource.indexOf('const result = await createInventoryCoreDoc(payload)'),
      formSource.indexOf('} catch (err) {', formSource.indexOf('const result = await createInventoryCoreDoc')),
    )
    expect(submitBody).toMatch(/setItems\(\[defaultItem\(\)\]\)/)
    expect(submitBody).toMatch(/setRemark\(''\)/)
    // 批次可用量刚被自己这单改掉，必须推代次让下一张单重新取数
    expect(submitBody).toMatch(/setLotEpoch\(\(n\) => n \+ 1\)/)
    // 单号要交回给调用方做可核对的反馈
    expect(submitBody).toMatch(/onSuccess\(result\.id\)/)
  })

  it('onStale 只刷新，不碰任何成功通道', () => {
    // 接成 onSuccess 的话，提交失败时会在红色错误 toast 旁边再弹一条绿色「成功」。
    // ⚠️ 不能只防 `onStale={() => onSuccess(...)}` 这一种字面写法 ——
    // 包成 `onStale={() => { router.refresh(); onSuccess('x') }}` 就绕过去了。
    // 改成：把 onStale 的整个表达式切出来，断言里面除了 router.refresh() 什么都没有。
    const workspace = source.slice(source.indexOf('function OperationWorkspace('))
    const onStaleStart = workspace.indexOf('onStale={')
    expect(onStaleStart).toBeGreaterThan(-1)
    const onStaleExpr = workspace.slice(onStaleStart, workspace.indexOf('\n', onStaleStart))
    expect(onStaleExpr).toMatch(/onStale=\{\(\) => router\.refresh\(\)\}/)
    expect(onStaleExpr).not.toMatch(/onSuccess|toast/)
  })

  it('提交在途时卡片与关闭按钮一起上锁', () => {
    // 这时候切走会把表单连同在途请求一起卸载：单已经建出去了，用户却只看到面板消失。
    // ⚠️ 锚定到 enabled 的计算式里，不要全文找 `!workspaceBusy` —— 那样任何无关位置
    // 出现这个子串都算过，「锁卡片」这条被单独拆掉时反而抓不住。
    // #190 把权限判据抽成 operationEnabled 后，锚点从内联的三元表达式换成这一行；
    // `!workspaceBusy` 刻意留在卡片侧（它是临时态、不是权限），别塞进 operationEnabled。
    const enabledStart = source.indexOf('const enabled = operationEnabled(operation)')
    expect(enabledStart).toBeGreaterThan(-1)
    const enabledExpr = source.slice(enabledStart, source.indexOf('const content = ('))
    expect(enabledExpr).toMatch(/&& !workspaceBusy/)
    expect(source).toMatch(/closeDisabled=\{busy\}/)
    expect(source).toMatch(/onBusyChange=\{setWorkspaceBusy\}/)
  })

  it('深链先打开工作区再抹掉 ?create=，顺序不能反', () => {
    // 只抹参数不打开的话，客户端软导航（Link / router.push 带 ?create=）会静默失效：
    // useState 只吃首次挂载的初值，服务端 prop 变了组件却不重挂。
    const effect = source.slice(
      source.indexOf('if (!initialOperationId) return'),
      source.indexOf('}, [initialOperationId, level, router])'),
    )
    const setIndex = effect.indexOf('setActiveOperation(initialOperationId)')
    const replaceIndex = effect.indexOf('router.replace(')
    expect(setIndex).toBeGreaterThan(-1)
    expect(replaceIndex).toBeGreaterThan(setIndex)
  })

  it('通用卡的 docType 有编译期覆盖性检查，不只靠测试扫源码', () => {
    // 漏配一张卡时 tsc 直接报错并点名缺哪种类型（已做变异验证）。
    expect(source).toMatch(/as const satisfies Record<InventoryBusinessLevel, readonly GenericOperationDefinition\[\]>/)
    expect(source).toMatch(/Exclude<InventoryGenericDocType, DeclaredGenericDocTypes>/)
  })
})

/**
 * 办理台 URL 恢复（#190「返回要求仍然可以返回到原来的页面」的降级路径）。
 *
 * 首选路径是详情页 window.close() 回到原标签（表单一个字不丢）；关不掉时才导航到
 * `/inventory/operations/<level>?op=…&tab=docs`。下面钉的都是「页面照常渲染、
 * 恢复却静默跑偏」的点。
 */
describe('办理台 URL 恢复（#190 返回）', () => {
  const source = readFileSync(resolve(__dirname, 'inventory-operations-page.tsx'), 'utf8')

  it('恢复参数用 op/tab，不能撞上会被整体重定向的 create/view', () => {
    // 办理台的服务端入口对 `?view=docs` 做整体 redirect 到单据中心。
    // 恢复参数一旦叫 view/create，用户点返回会被静默弹到单据中心，永远回不到办理台 ——
    // 两个文件各自看都对，联调才炸。
    const levelPage = readFileSync(
      resolve(__dirname, '..', 'operations', '[level]', 'page.tsx'),
      'utf8',
    )
    expect(levelPage).toMatch(/if \(query\.view === 'docs'\)/)
    expect(source).toMatch(/searchParams\.get\('op'\)/)
    expect(source).toMatch(/searchParams\.get\('tab'\)/)
    expect(source).not.toMatch(/searchParams\.get\('create'\)/)
    expect(source).not.toMatch(/searchParams\.get\('view'\)/)
  })

  it('URL 恢复出来的业务必须过和卡片同一道权限判据', () => {
    // 不加的话，手改 URL `?op=purchase-order` 能打开一张按钮本来 disabled 的卡片。
    // 只是 UI 越权（server action 侧 withPermission 仍会拦），但不该让表单渲染出来。
    expect(source).toMatch(/const active = levelOperations\.find\(\s*\n?\s*\(operation\) => operation\.id === activeOperation && operationEnabled\(operation\),/)
    // 反向：判据不得再有第二份内联展开，否则卡片与恢复两处会各走各的。
    expect(source.match(/const hasShipmentCancellationAccess = operation\./g) ?? []).toHaveLength(1)
  })

  it('op 的白名单解析走共享纯函数，不在组件里手搓', () => {
    // 手搓的话「generic:<docType>」这一支很容易漏掉（通用卡的 id 不在
    // INVENTORY_OPERATION_IDS 里），表现为通用业务永远恢复不出来。
    expect(source).toMatch(/parseInventoryOperationId\(searchParams\.get\('op'\)\)/)
    expect(source).toMatch(/parseInventoryOperationsTab\(searchParams\.get\('tab'\)\)/)
  })

  it('手点卡片会清掉单据 Tab 的一次性券', () => {
    // 漏改这处的后果：带 tab=docs 返回后再点别的卡片，那张卡也被弹到单据 Tab。
    expect(source).toMatch(/onClick=\{\(\) => selectOperation\(operation\.id\)\}/)
    expect(source).not.toMatch(/onClick=\{\(\) => setActiveOperation\(operation\.id\)\}/)
    const selectOperationBody = source.slice(
      source.indexOf('const selectOperation = useCallback('),
      source.indexOf('const groups = useMemo('),
    )
    expect(selectOperationBody).toMatch(/setPendingDocsTabFor\(null\)/)
  })

  it('恢复后滚到已展开的工作区，且只滚一次', () => {
    // 工作区渲染在卡片网格下方，不滚的话用户落在页面顶部看不到恢复出来的卡，
    // 会以为返回没生效。但只能在恢复路径生效 —— 手点卡片被页面拽走是另一种烦人。
    expect(source).toMatch(/<Card ref=\{workspaceRef\}>/)
    const effect = source.slice(
      source.indexOf('if (restoreScrolled.current) return'),
      source.indexOf('}, [restoredOperation])'),
    )
    expect(effect).toMatch(/if \(!restoredOperation\) return/)
    expect(effect).toMatch(/restoreScrolled\.current = true/)
    expect(effect).toMatch(/scrollIntoView\(/)
  })
})

/**
 * 表格行内控件的可访问名（#194）。
 *
 * 这些控件在 `<td>` 里，没有 `<label>` 可包裹（字段名只在 `<th>` 上），读屏只会念
 * 「编辑框」「复选框」，E2E 也只能按行结构猜位置 —— inv-03 卡在「本次汇总」就是这么来的。
 *
 * 口径：`<字段名> <行标识>`，行标识统一由各表自己的 `rowName` 给出，**必须行内唯一**。
 * 只带商品名是不够的：`skuName` 落库时取的是 `sku.productName`（纯商品名，不含规格），
 * 而这几张表都把规格当独立副标题渲染 —— 同一商品的两个规格同时成行时，
 * 可访问名会完全重复：读屏分不清，Playwright 要么 strict mode violation、要么静默填错行。
 */
describe('行内控件的可访问名（#194）', () => {
  const source = readFileSync(resolve(__dirname, 'inventory-operations-page.tsx'), 'utf8')

  it('三张表格的行内控件都带 aria-label，文案口径是「<字段名> <行标识>」', () => {
    for (const label of [
      '选择 ${rowName}',      // 市场报货（市场汇总报货）：勾选
      '实际采购 ${rowName}',   // 市场报货：数量
      '福利方案 ${rowName}',   // 市场报货：福利方案下拉（原来是「${line.skuName}福利方案」，同样会重名）
      '汇总 ${rowName}',      // 市场报货汇总：勾选
      '本次汇总 ${rowName}',   // 市场报货汇总：数量
      '本次实收 ${rowName}',   // 收货进度：数量
      '明细备注 ${rowName}',   // 收货进度：备注
    ]) {
      expect(source, `缺 aria-label：${label}`).toContain(`aria-label={\`${label}\`}`)
    }
    // 反向：行内 aria-label 不得再直接插 `${line.skuName}` —— 那正是 #194 的重名缺陷本身。
    // 只断言正向的话，任何一处偷偷退回「只带商品名」都照样全绿。
    expect(source).not.toMatch(/aria-label=\{`[^`]*\$\{line\.skuName\}/)
  })

  it('每张表的 rowName 按自己的行唯一键拼，不是三份抄来抄去的商品名', () => {
    // 行唯一键必须读渲染/聚合口径定，不能猜 —— 猜错的表现就是「页面看着好好的，
    // 多规格一上就两行重名」，静态看不出来。
    // 市场报货：明细按 sku 聚合，一行 = 一个 skuId；规格缺省时退回天然唯一的 skuId
    //（和「商品」列副标题 `{line.specName || line.skuId}` 同一个表达式，屏幕内容与可访问名一致）。
    expect(source).toContain('const rowName = `${line.skuName} ${line.specName || line.skuId}`')
    // 市场报货汇总：行唯一键 = skuId + marketId（lineKey 就是 `${skuId}@${marketId}`），
    // 所以商品维度之外还得带市场名。
    expect(source).toContain('const rowName = `${line.skuName} ${line.specName || line.skuId} ${line.marketName}`')
    // 收货进度：一行 = 发货单的一条明细，**不按 sku 聚合**，同一 sku 的赠品行与正常行
    // 连 skuId 都相同；payload（ReceiptProgressLine）里又没有 specName。
    // 故这张表用行序号兜底 —— lines 装载后不排序不增删，updateLine 也按 index 打补丁。
    expect(source).toContain('const rowName = `${line.skuName} 第${index + 1}行`')
  })

  it('aria-label 一律写在 type="number" 之前', () => {
    // 写在之后的话，模板串里的 `>` 会截断本文件「数值输入带 min/step/max」那条守护
    // 抓属性串的正则（/type="number"[^/>]*/），三条断言会一起红 —— 排查成本远高于收益。
    expect(source).not.toMatch(/type="number"[^/>]*aria-label/)
  })
})
