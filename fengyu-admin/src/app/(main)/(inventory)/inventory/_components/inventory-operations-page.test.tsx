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
