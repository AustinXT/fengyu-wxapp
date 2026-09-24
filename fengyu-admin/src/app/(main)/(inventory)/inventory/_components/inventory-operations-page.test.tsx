import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { INVENTORY_GENERIC_DOC_TYPES } from '@/lib/inventory/types'
import type { InventoryDocDetail, InventoryDocRow, InventoryLocationRow } from '@/lib/inventory/types'
import {
  INVENTORY_BUSINESS_LEVELS,
  genericDocBusinessLevel,
  type InventoryBusinessLevel,
} from '@/lib/inventory/business-level'

/*
 * ────────── 渲染测试要的替身 ──────────
 *
 * 本文件前半段是纯源码守护（完全不加载组件），后半段（#192 待办区）直接渲染导出的
 * `OperationDocsTab`。mock 必须盖住它整条 import 链上的 server action 模块 ——
 * 漏一个就会把 `@/db` 拖进测试进程。
 */
const { mockRefresh } = vi.hoisted(() => ({ mockRefresh: vi.fn() }))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: mockRefresh }),
  usePathname: () => '/inventory/operations/market',
  useSearchParams: () => new URLSearchParams(''),
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }))
vi.mock('@/actions/inventory/skus', () => ({ listInventorySkus: vi.fn() }))
vi.mock('./inventory-sku-search-select', () => import('./__stubs__/inventory-sku-search-select.stub'))

vi.mock('@/actions/inventory/docs', () => ({
  confirmInventoryCoreReceive: vi.fn(),
  createInventoryCoreDoc: vi.fn(),
  getInventoryCoreDocById: vi.fn(),
  listInventoryOperationDocs: vi.fn(),
}))

vi.mock('@/actions/inventory/stocks', () => ({ listInventoryLotOptions: vi.fn() }))

vi.mock('@/actions/inventory/business', () =>
  Object.fromEntries(
    [
      'approveItemCompanyShipmentCancellation',
      'approveReturnForRestock',
      'cancelSupplyChainPurchaseOrder',
      'createExternalMarketOutbound',
      'createInventoryConversion',
      'createItemCompanyReplenishment',
      'createItemCompanyShipment',
      'createMarketReplenishment',
      'createMarketReportSummary',
      'createMarketStaffPurchase',
      'createPurchaseOrder',
      'createReturnForRestock',
      'createSelfPurchasedReceipt',
      'createStoreAllocation',
      'createStoreReplenishmentRequest',
      'createSupplyChainStaffPurchase',
      'getShipmentReceiptProgress',
      'listMarketEmployeeOptions',
      'listSupplyChainEmployeeOptions',
      'quoteMarketReplenishmentPrices',
      'receiveItemCompanyShipment',
      'receiveItemCompanyShipmentInFull',
      'receiveStoreAllocation',
      'receiveStoreAllocationInFull',
      'receiveSupplyChainPurchaseOrder',
      'rejectItemCompanyShipmentCancellation',
      'rejectReturnForRestock',
      'requestItemCompanyShipmentCancellation',
      'resolveInventorySkuSupplierStatus',
      'summarizeMarketReplenishmentRequests',
      'summarizeStoreReplenishmentRequests',
    ].map((name) => [name, vi.fn()]),
  ),
)

import { listInventoryLotOptions } from '@/actions/inventory/stocks'
import { listInventorySkus } from '@/actions/inventory/skus'
import { toast } from 'sonner'
import {
  confirmInventoryCoreReceive,
  getInventoryCoreDocById,
  listInventoryOperationDocs,
} from '@/actions/inventory/docs'
import {
  approveItemCompanyShipmentCancellation,
  approveReturnForRestock,
  cancelSupplyChainPurchaseOrder,
  receiveItemCompanyShipmentInFull,
  receiveStoreAllocationInFull,
  rejectItemCompanyShipmentCancellation,
  rejectReturnForRestock,
} from '@/actions/inventory/business'
import InventoryOperationsPage, { OperationDocsTab } from './inventory-operations-page'
import type { InventoryAnyOperationId } from '@/lib/inventory/operation-doc-types'
import { asGenericDocType, parseGenericOperationId } from '@/lib/inventory/operation-doc-types'

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

  it('工作区默认停在填报表单，且换业务时两道 key 一起强制重建', () => {
    // 办理台的主用途是办业务。默认落到单据 Tab 会让每个人每次都多点一下。
    // ⚠️ Tabs 原本是 uncontrolled：父层在 activeOperation A→B 时原地更新不重挂，
    // 选中态会跟着跑到下一个业务 —— 点开 B 直接落在 B 的单据页。key 是唯一的拦法，
    // 只断言 defaultValue/value 的话，这个回归照样全绿。
    //
    // #192 把 Tabs 改成受控（待办区「去收货」要能把人送回填报表单），于是选中态从
    // Tabs 内部搬到了 OperationWorkspace 的 useState —— `<Tabs key>` 只重建 Tabs 子树，
    // 管不到 OperationWorkspace 自己的 state。所以**外层也要一道 key**，
    // 否则 A→B 时 B 会继承 A 的 Tab 选中态与「去收货」的预选券。
    expect(source).toMatch(/<Tabs key=\{operation\} value=\{tab\} onValueChange=\{setTab\}>/)
    expect(source).toMatch(/const \[tab, setTab\] = useState<string>\(defaultTab\)/)
    expect(source).toMatch(/key=\{active\.id\}/)
    expect(source).toMatch(/defaultTab=\{pendingDocsTabFor === active\.id \? 'docs' : 'form'\}/)
    expect(source).not.toMatch(/defaultValue=\{initialTab\}/)
    expect(source).toMatch(/<TabsTrigger value="form">填报表单<\/TabsTrigger>/)
    expect(source).toMatch(/<TabsTrigger value="docs">/)
  })

  it('两个面板都带 keepMounted：表单不丢输入，单据 Tab 的待办角标不归零', () => {
    // 去掉表单面板的 keepMounted 后页面完全正常，只是每次切 Tab 回来数据没了 ——
    // 这种回归没人会在 code review 里看出来。
    expect(source).toMatch(/<TabsContent value="form" keepMounted/)
    // #192：单据面板也 keepMounted，否则切到表单 Tab 时 OperationDocsTab 卸载 ——
    // 待办角标归零（「不点开也知道有没有活」直接失效），切回来还要重发两次查询。
    expect(source).toMatch(/<TabsContent value="docs" keepMounted>/)
  })

  it('金额列头只看会话级价格权限，不从当前页数据反推', () => {
    // 反推（`rows.some(r => r.totalAmount != null)`）看着能少一列空「—」，实则更糟：
    // 行级遮蔽后 totalAmount 就是 undefined，混合绑定账号翻到整页都被遮蔽的那一页时
    // 金额列会整列消失、翻回去又出现，表头随页抖动；无权限的行也不再显示「—」。
    const tab = source.slice(source.indexOf('export function OperationDocsTab('))
    expect(tab).toMatch(/setPriceVisible\(result\.produced\.canViewPrice\)/)
    expect(tab).toMatch(/\.\.\.\(priceVisible\s*\n?\s*\?/)
    expect(tab).not.toMatch(/rows\.some\([^)]*totalAmount/)
  })

  it('请求失败的空表与真的没单据，文案必须不同', () => {
    // 两者都渲染「暂无单据」的话，用户会以为这个业务真的一张单都没有。
    const tab = source.slice(source.indexOf('export function OperationDocsTab('))
    expect(tab).toMatch(/setFailed\(true\)/)
    expect(tab).toMatch(/emptyText=\{failed \? '单据加载失败/)
    // 待办段同理，且文案要跟产出段区分开 —— 两段都说「加载失败」的话，
    // 用户看不出是哪一段没取到。
    expect(tab).toMatch(/setInboxFailed\(true\)/)
    expect(tab).toMatch(/inboxFailed \? '待办加载失败/)
  })

  it('分页器用服务端返回的 pageSize，不用前端常量；两段各存一份', () => {
    // engine 会把非白名单页长静默夹成 20。前端按自己那份算总页数的话，
    // 页码条少算页数，最后几页永远翻不到且没有任何提示。
    const tab = source.slice(source.indexOf('export function OperationDocsTab('))
    expect(tab).toMatch(/setPageSize\(result\.produced\.pageSize\)/)
    expect(tab).toMatch(/<Pagination total=\{total\} page=\{page\} pageSize=\{pageSize\}/)
    // #192：待办段的页长是**另一次** engine 调用回传的，共用一个 state 会让其中一段算错总页数。
    expect(tab).toMatch(/setInboxPageSize\(result\.inbox\.pageSize\)/)
    expect(tab).toMatch(/pageSize=\{inboxPageSize\}/)
  })

  it('请求失败不清零 total，否则用户被静默弹回第 1 页并触发第二次请求', () => {
    // Pagination 的越界自纠：total=0 → totalPages=1 → 第 3 页越界 → onPageChange(1)
    // → effect 依赖变 → 再发一次请求。一次瞬时失败被放大成跳页 + 重复请求。
    const catchBlock = source.slice(source.indexOf('.catch((error) => {', source.indexOf('export function OperationDocsTab(')))
    expect(catchBlock.slice(0, 400)).toMatch(/setRows\(\[\]\)/)
    expect(catchBlock.slice(0, 400)).not.toMatch(/setTotal\(0\)/)
    // 待办段同理（它自己的 total 也不能清）
    expect(catchBlock.slice(0, 400)).toMatch(/setInboxRows\(\[\]\)/)
    expect(catchBlock.slice(0, 400)).not.toMatch(/setInboxTotal\(0\)/)
  })

  it('单据号用新标签打开详情，不做整行 router.push', () => {
    // keepMounted 的全部意义是「去单据 Tab 看一眼回来表单还在」。行内 router.push
    // 会把整个办理台连同填了一半的明细卸载掉，而 returnTo 只恢复 URL、恢复不了 React state。
    const tab = source.slice(source.indexOf('export function OperationDocsTab('))
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
    const tab = source.slice(source.indexOf('export function OperationDocsTab('))
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
    expect(docTypes.length).toBe(9)
    // 每张卡的类型必须真属于「无需上游血缘」的通用建单类型，
    // 混进 '品项公司发货' 这种业务单类型就等于从通用入口绕过专用服务的校验。
    for (const docType of docTypes) {
      expect(INVENTORY_GENERIC_DOC_TYPES, `${docType} 不是通用建单类型`).toContain(docType)
    }
    // 9 张卡覆盖全部 9 种通用类型，不重不漏（#350 起「顾客产品出库」是跳转卡，不在这里）
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

  it('内置 / 通用卡的渲染没有 href/Link 分支（跳转卡是单独一张表）', () => {
    // 只切到内置 + 通用卡的 map 为止：#350 的跳转卡（LINK_OPERATIONS）刻意单独渲染成 Link，
    // 它不进 levelOperations，也就不会借用业务 id、不会有工作区与单据 Tab。
    const cardsBlock = source.slice(source.indexOf('{levelOperations.filter('), source.indexOf('{levelLinkOperations.filter('))
    expect(cardsBlock.length).toBeGreaterThan(0)
    expect(cardsBlock).not.toMatch(/operation\.href/)
    expect(cardsBlock).not.toMatch(/<Link/)
    // 跳转卡不得混进 levelOperations（否则 `?op=` 能把它当工作区打开）
    const levelOpsBlock = source.slice(source.indexOf('const levelOperations = useMemo'), source.indexOf('const operationEnabled'))
    expect(levelOpsBlock).not.toContain('LINK_OPERATIONS')
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

/*
 * ══════════════════════════════════════════════════════════════════════
 * 办理台单据 Tab 的「待我处理」区与行内动作（#192）—— 渲染测试
 * ══════════════════════════════════════════════════════════════════════
 *
 * 上面那批是源码守护，钉的是「写法别退回去」；这一批钉的是**行为**：
 * 按钮矩阵、权限、防重、状态冲突、两段独立分页。二者互不替代 ——
 * 源码守护看不出按钮在什么状态下真的出现，渲染测试看不出注释里那些
 * 「为什么不能改成另一种写法」。
 */

type OperationDocsResult = Awaited<ReturnType<typeof listInventoryOperationDocs>>
type OperationDocsSegment = OperationDocsResult['produced']

function docRow(overrides: Partial<InventoryDocRow> & Pick<InventoryDocRow, 'id'>): InventoryDocRow {
  return {
    docType: '院退货',
    status: '待审批',
    sourceOrgNodeId: 'S1',
    sourceOrgNodeName: '一分院',
    sourceOrgNodeType: '门店',
    targetOrgNodeId: 'M1',
    targetOrgNodeName: '南昌市场',
    targetOrgNodeType: '市场',
    marketId: 'M1',
    supplierId: null,
    docDate: '2026-09-20',
    relatedSaleOrderId: null,
    customerName: null,
    employeeName: null,
    supplierName: null,
    externalPartyName: null,
    logisticsCompany: null,
    trackingNo: null,
    receiptAttachmentUrl: null,
    totalQuantity: 3,
    totalAmount: 120,
    remark: null,
    auditRemark: null,
    createdBy: 'E1',
    confirmedAt: null,
    approvedAt: null,
    rejectedAt: null,
    cancellationRequestReason: null,
    cancellationRequestedBy: null,
    cancellationRequestedAt: null,
    cancellationReason: null,
    cancelledAt: null,
    createdAt: '2026-09-20T10:00:00+08:00',
    updatedAt: '2026-09-20T10:00:00+08:00',
    ...overrides,
  }
}

function segment(data: InventoryDocRow[], total = data.length, pageSize = 20): OperationDocsSegment {
  return { data, total, pageSize, canViewPrice: true, priceVisibility: 'all' }
}

/** 一次性把两段数据挂上去。`inbox: null` = 这个业务没有待办语义。 */
function mockDocs(result: { produced?: OperationDocsSegment; inbox?: OperationDocsSegment | null }) {
  vi.mocked(listInventoryOperationDocs).mockResolvedValue({
    produced: result.produced ?? segment([]),
    inbox: result.inbox === undefined ? null : result.inbox,
  })
}

function renderTab(
  props: {
    operation?: InventoryAnyOperationId
    canAct?: boolean
    onGotoForm?: (docId: string) => void
    onInboxTotalChange?: (total: number) => void
  } = {},
) {
  const onGotoForm = props.onGotoForm ?? vi.fn()
  const onInboxTotalChange = props.onInboxTotalChange ?? vi.fn()
  // 稳定引用（vi.fn() 建一次就不再变），符合 onActionBusyChange 对调用方的要求
  const onActionBusyChange = vi.fn()
  const view = render(
    <OperationDocsTab
      operation={props.operation ?? 'store-return-approval'}
      level="market"
      canViewPrice
      canAct={props.canAct ?? true}
      onGotoForm={onGotoForm}
      onInboxTotalChange={onInboxTotalChange}
      onActionBusyChange={onActionBusyChange}
    />,
  )
  return { ...view, onGotoForm, onInboxTotalChange, onActionBusyChange }
}

/**
 * 整页渲染（默认导出）。上面的 `renderTab` 只拿得到单据 Tab，而业务卡片与
 * 「关闭」按钮在页面/工作区层 —— 「在途时锁住它俩」这条只能整页验。
 */
function renderPage(options: {
  level: InventoryBusinessLevel
  operation?: InventoryAnyOperationId
  workflowDocs?: InventoryDocRow[]
  locations?: InventoryLocationRow[]
  canSelfPurchase?: boolean
  canCreatePickupRecord?: boolean
}) {
  return render(
    <InventoryOperationsPage
      level={options.level}
      locations={options.locations ?? []}
      suppliers={[]}
      workflowDocs={options.workflowDocs ?? []}
      canCreate
      canApprove
      canSelfPurchase={options.canSelfPurchase ?? false}
      canRequestShipmentCancellation={false}
      canApproveShipmentCancellation={false}
      canViewPrice
      canCreatePickupRecord={options.canCreatePickupRecord ?? true}
      // 深链入口：省掉「先点卡片」这一步，工作区直接展开在目标业务上
      initialOperationId={options.operation}
    />,
  )
}

/** 工作区默认停在填报表单，切到「单据」Tab 才看得到待办区。 */
async function openDocsTab() {
  fireEvent.click(screen.getByRole('tab', { name: /单据/ }))
  await screen.findByText('待我处理')
}

/** 整页渲染时 `getInventoryCoreDocById` 的最小可用替身（选中单据后表单要拿它装载明细）。 */
function docDetail(row: InventoryDocRow): InventoryDocDetail {
  return { ...row, items: [], lineage: [], fulfillmentProgress: null }
}

/**
 * 某一行上渲染出来的动作按钮文案集合。
 *
 * 按 `aria-label` 的「<文案> <单据号>」后缀取（#194 口径）：一页十几行按钮全叫「通过」，
 * 不带行标识既分不清也没法断言。
 */
function rowActionNames(docId: string): string[] {
  // queryAll 而不是 getAll：整页一个按钮都没有正是要断言的情形之一（无权限 / 终态行）
  return screen
    .queryAllByRole('button')
    .map((button) => button.getAttribute('aria-label') ?? '')
    .filter((name) => name.endsWith(` ${docId}`))
    .map((name) => name.slice(0, name.length - docId.length - 1))
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  // vitest.config.ts 没开 clearMocks/restoreMocks：必须 reset 而不是 clear，
  // 否则忘记设 mock 的新用例会静默继承上一条的 mockResolvedValue。
  vi.resetAllMocks()
  mockRefresh.mockClear()
})

describe('待办区的按钮可见性矩阵（#192）', () => {
  /**
   * 七个内置业务 + 两个通用业务的「状态 → 按钮」矩阵。
   *
   * 期望值不是抄实现的：每条都对齐服务端 inbox 查询条件里的 docType/statuses
   * （`INVENTORY_OPERATION_DOC_QUERY` / `INVENTORY_GENERIC_OPERATION_INBOX`），
   * 那边又逐条对齐 business.ts 事务内的断言。配错了的表现是
   * 「待办区列出服务端必拒的单，点一次报一次错」。
   */
  const matrix: Array<{
    operation: InventoryAnyOperationId
    docType: InventoryDocRow['docType']
    status: InventoryDocRow['status']
    actions: string[]
  }> = [
    { operation: 'store-return-approval', docType: '院退货', status: '待审批', actions: ['通过', '驳回'] },
    { operation: 'market-return-approval', docType: '市场退货', status: '待审批', actions: ['通过', '驳回'] },
    { operation: 'shipment-cancel-approval', docType: '品项公司发货', status: '待审批', actions: ['通过', '驳回'] },
    { operation: 'market-receipt', docType: '品项公司发货', status: '待收货', actions: ['一键收货', '去收货'] },
    { operation: 'store-receipt', docType: '分院配货', status: '待收货', actions: ['一键收货', '去收货'] },
    // 供应链采购入库要逐行核对效期（批号可自动生成，#345），刻意没有一键版
    { operation: 'supply-chain-receipt', docType: '采购订单', status: '待收货', actions: ['去收货'] },
    { operation: 'supply-chain-purchase-cancel', docType: '采购订单', status: '待收货', actions: ['关闭采购'] },
    { operation: 'generic:分院调货出库', docType: '分院调货出库', status: '待收货', actions: ['确认收货'] },
    { operation: 'generic:市场间调货出库', docType: '市场间调货出库', status: '待收货', actions: ['确认收货'] },
  ]

  for (const entry of matrix) {
    it(`${entry.operation}：${entry.status} 的单渲染 ${entry.actions.join(' / ')}`, async () => {
      mockDocs({ inbox: segment([docRow({ id: 'D-1', docType: entry.docType, status: entry.status })]) })
      renderTab({ operation: entry.operation })

      await screen.findByText('待我处理')
      expect(rowActionNames('D-1').sort()).toEqual([...entry.actions].sort())
    })
  }

  for (const status of ['已完成', '已驳回', '已取消'] as const) {
    it(`终态（${status}）的行不渲染任何动作按钮，只剩单据号链接`, async () => {
      // 服务端的 inbox.statuses 已经把终态挡在外面了，这里是**第二道**：
      // 哪天映射表放宽了状态，按钮不能跟着出现在点了必报错的行上。
      mockDocs({ inbox: segment([docRow({ id: 'D-9', docType: '院退货', status })]) })
      renderTab({ operation: 'store-return-approval' })

      await screen.findByText('待我处理')
      expect(rowActionNames('D-9')).toEqual([])
      // 「仅查看」= 单据号链接还在
      expect(screen.getByRole('link', { name: 'D-9' })).toBeInTheDocument()
    })
  }

  it('无权限账号看得见待办、但一个动作按钮都没有，连「操作」列都不渲染', async () => {
    // 前端隐藏只是体验：真正的授权边界在 Server Action 的 withPermission +
    // lib 层 assertLocationWritable，伪造调用照样被拒（actions 层有对应用例）。
    mockDocs({ inbox: segment([docRow({ id: 'D-2', docType: '院退货', status: '待审批' })]) })
    renderTab({ operation: 'store-return-approval', canAct: false })

    await screen.findByText('待我处理')
    expect(rowActionNames('D-2')).toEqual([])
    // 无动作时不留空按钮位 —— 整列都不渲染
    expect(screen.queryByRole('columnheader', { name: '操作' })).not.toBeInTheDocument()
    // 但待办本身仍然看得见（能知道有活，只是不能办）
    expect(screen.getByRole('link', { name: 'D-2' })).toBeInTheDocument()
  })

  it('撤回审批的待办多一列「撤回原因」，别的业务没有', async () => {
    mockDocs({
      inbox: segment([
        docRow({
          id: 'FH-1',
          docType: '品项公司发货',
          status: '待审批',
          cancellationRequestReason: '客户临时取消',
        }),
      ]),
    })
    const { unmount } = renderTab({ operation: 'shipment-cancel-approval' })
    await screen.findByText('待我处理')
    expect(screen.getByRole('columnheader', { name: '撤回原因' })).toBeInTheDocument()
    expect(screen.getByText('客户临时取消')).toBeInTheDocument()
    unmount()

    mockDocs({ inbox: segment([docRow({ id: 'D-3', docType: '院退货', status: '待审批' })]) })
    renderTab({ operation: 'store-return-approval' })
    await screen.findByText('待我处理')
    expect(screen.queryByRole('columnheader', { name: '撤回原因' })).not.toBeInTheDocument()
  })
})

describe('待办区与产出区的分段渲染（#192）', () => {
  it('没有待办语义的业务完全不渲染「待我处理」，且只发一次查询', async () => {
    mockDocs({ produced: segment([docRow({ id: 'YTH-1', docType: '院退货' })]), inbox: null })
    const { onInboxTotalChange } = renderTab({ operation: 'store-return' })

    await screen.findByRole('link', { name: 'YTH-1' })
    expect(screen.queryByText('待我处理')).not.toBeInTheDocument()
    // 角标也必须保持 0，否则「单据」Tab 上会挂一个点开什么都没有的数字
    expect(onInboxTotalChange).toHaveBeenLastCalledWith(0)
  })

  it('有待办段但一条都没有时：区块仍在，空态收成一行字', async () => {
    mockDocs({ produced: segment([docRow({ id: 'SRK-1', docType: '市场退货入库' })]), inbox: segment([]) })
    renderTab({ operation: 'store-return-approval' })

    await screen.findByText('待我处理')
    expect(screen.getByText('当前没有待处理单据')).toBeInTheDocument()
    // 「暂无单据」是两边都空时才给的总结论，这里产出段有数据，不该出现
    expect(screen.queryByText('暂无单据')).not.toBeInTheDocument()
  })

  it('待办有内容而产出为空时，产出段收成一行字，不占一大块空表', async () => {
    mockDocs({
      produced: segment([]),
      inbox: segment([docRow({ id: 'D-4', docType: '院退货', status: '待审批' })]),
    })
    renderTab({ operation: 'store-return-approval' })

    await screen.findByText('待我处理')
    expect(screen.getByText('本业务暂无产出单据')).toBeInTheDocument()
    expect(screen.queryByText('暂无单据')).not.toBeInTheDocument()
  })

  it('两边都空时才出现「暂无单据」', async () => {
    mockDocs({ produced: segment([]), inbox: segment([]) })
    renderTab({ operation: 'store-return-approval' })

    await screen.findByText('当前没有待处理单据')
    expect(screen.getByText('暂无单据')).toBeInTheDocument()
  })

  it('待办条数上报给工作区，供「单据」Tab 挂角标', async () => {
    mockDocs({ inbox: segment([docRow({ id: 'D-5', docType: '院退货', status: '待审批' })], 7) })
    const { onInboxTotalChange } = renderTab({ operation: 'store-return-approval' })

    await waitFor(() => expect(onInboxTotalChange).toHaveBeenLastCalledWith(7))
  })

  it('待办加载失败有自己的文案，且不清零 total（否则被静默弹回第 1 页）', async () => {
    // 先成功一次拿到 total=45，再让翻页那次失败 —— total 清零会让 Pagination
    // 算出 totalPages=1，越界自纠把人从第 2 页弹回第 1 页并再发一次请求。
    vi.mocked(listInventoryOperationDocs)
      .mockResolvedValueOnce({
        produced: segment([docRow({ id: 'SRK-2', docType: '市场退货入库' })], 3),
        inbox: segment([docRow({ id: 'D-6', docType: '院退货', status: '待审批' })], 45),
      })
      .mockRejectedValue(new Error('boom'))
    renderTab({ operation: 'store-return-approval' })

    await screen.findByText('共 45 条')
    fireEvent.click(screen.getAllByRole('button', { name: '下一页' })[0])

    await screen.findByText('待办加载失败，请稍后重试')
    // total 保住了：分页器还停在 45 条
    expect(screen.getByText('共 45 条')).toBeInTheDocument()
    expect(vi.mocked(toast.error)).toHaveBeenCalled()
  })

  it('待办与产出各自翻页，互不干扰', async () => {
    mockDocs({
      produced: segment([docRow({ id: 'SRK-3', docType: '市场退货入库' })], 60),
      inbox: segment([docRow({ id: 'D-7', docType: '院退货', status: '待审批' })], 45),
    })
    renderTab({ operation: 'store-return-approval' })

    await screen.findByText('共 45 条')
    // 待办段的分页器在上、产出段在下
    const [inboxNext, producedNext] = screen.getAllByRole('button', { name: '下一页' })

    fireEvent.click(inboxNext)
    await waitFor(() =>
      expect(vi.mocked(listInventoryOperationDocs)).toHaveBeenLastCalledWith({
        operationId: 'store-return-approval',
        page: 1,
        inboxPage: 2,
        pageSize: 20,
      }),
    )

    fireEvent.click(producedNext)
    await waitFor(() =>
      expect(vi.mocked(listInventoryOperationDocs)).toHaveBeenLastCalledWith({
        operationId: 'store-return-approval',
        page: 2,
        inboxPage: 2,
        pageSize: 20,
      }),
    )
  })
})

describe('待办行内动作的提交链路（#192）', () => {
  async function openReject(docId = 'D-8') {
    mockDocs({ inbox: segment([docRow({ id: docId, docType: '院退货', status: '待审批' })]) })
    const view = renderTab({ operation: 'store-return-approval' })
    await screen.findByText('待我处理')
    fireEvent.click(screen.getByRole('button', { name: `驳回 ${docId}` }))
    return view
  }

  it('驳回走页内 Dialog，不是原生 prompt', async () => {
    const nativePrompt = vi.fn()
    vi.stubGlobal('prompt', nativePrompt)
    await openReject()

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('驳回退货申请')).toBeInTheDocument()
    expect(nativePrompt).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('驳回原因必填：留空（含只填零宽空格）被拦，填了才提交且传 trim 后的值', async () => {
    await openReject()
    const confirm = screen.getByRole('button', { name: '确认驳回' })

    fireEvent.click(confirm)
    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalledWith('请填写驳回原因'))
    expect(vi.mocked(rejectReturnForRestock)).not.toHaveBeenCalled()
    // 可见的校验提示，不只是一条会消失的 toast
    expect(screen.getByText('请填写驳回原因')).toBeInTheDocument()

    // 零宽空格（Unicode Cf）肉眼看不见、trim() 也吃不掉，不能拿它绕过必填
    fireEvent.change(screen.getByLabelText(/驳回原因/), { target: { value: '​​' } })
    fireEvent.click(confirm)
    expect(vi.mocked(rejectReturnForRestock)).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText(/驳回原因/), { target: { value: '  数量不符  ' } })
    fireEvent.click(confirm)
    await waitFor(() =>
      expect(vi.mocked(rejectReturnForRestock)).toHaveBeenCalledWith({
        returnDocId: 'D-8',
        auditRemark: '数量不符',
      }),
    )
  })

  it('审批通过备注可选，不填也能提交（与服务端 auditRemark 可选一致）', async () => {
    mockDocs({ inbox: segment([docRow({ id: 'D-10', docType: '院退货', status: '待审批' })]) })
    renderTab({ operation: 'store-return-approval' })
    await screen.findByText('待我处理')

    fireEvent.click(screen.getByRole('button', { name: '通过 D-10' }))
    fireEvent.click(screen.getByRole('button', { name: '确认通过' }))
    await waitFor(() =>
      expect(vi.mocked(approveReturnForRestock)).toHaveBeenCalledWith({
        returnDocId: 'D-10',
        auditRemark: null,
      }),
    )
  })

  it('撤回审批打到撤回专用 action，不会误调退货审批', async () => {
    mockDocs({ inbox: segment([docRow({ id: 'FH-2', docType: '品项公司发货', status: '待审批' })]) })
    renderTab({ operation: 'shipment-cancel-approval' })
    await screen.findByText('待我处理')

    fireEvent.click(screen.getByRole('button', { name: '驳回 FH-2' }))
    fireEvent.change(screen.getByLabelText(/驳回原因/), { target: { value: '货已在途' } })
    fireEvent.click(screen.getByRole('button', { name: '确认驳回' }))
    await waitFor(() =>
      expect(vi.mocked(rejectItemCompanyShipmentCancellation)).toHaveBeenCalledWith({
        shipmentId: 'FH-2',
        auditRemark: '货已在途',
      }),
    )
    expect(vi.mocked(rejectReturnForRestock)).not.toHaveBeenCalled()
    expect(vi.mocked(approveItemCompanyShipmentCancellation)).not.toHaveBeenCalled()
  })

  it('关闭采购的原因必填，且打到 cancelSupplyChainPurchaseOrder', async () => {
    mockDocs({ inbox: segment([docRow({ id: 'CGD-1', docType: '采购订单', status: '待收货' })]) })
    renderTab({ operation: 'supply-chain-purchase-cancel' })
    await screen.findByText('待我处理')

    fireEvent.click(screen.getByRole('button', { name: '关闭采购 CGD-1' }))
    const confirm = screen.getByRole('button', { name: '确认关闭' })
    fireEvent.click(confirm)
    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalledWith('请填写关闭原因'))
    expect(vi.mocked(cancelSupplyChainPurchaseOrder)).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText(/关闭原因/), { target: { value: '供应商断货' } })
    fireEvent.click(confirm)
    await waitFor(() =>
      expect(vi.mocked(cancelSupplyChainPurchaseOrder)).toHaveBeenCalledWith({
        purchaseOrderId: 'CGD-1',
        cancellationReason: '供应商断货',
      }),
    )
  })

  it('一键收货按业务分发到两个单权限 action，绝不互串', async () => {
    // 合成一个 withAnyPermission 的聚合入口会让只有 market_operate 的角色替门店收货
    //（lib 层只有 scope 校验、没有 action 级校验），所以这条分发是**越权防线**的一部分。
    vi.mocked(receiveItemCompanyShipmentInFull).mockResolvedValue({ id: 'SCRK-9', shipmentId: 'FH-3' })
    mockDocs({ inbox: segment([docRow({ id: 'FH-3', docType: '品项公司发货', status: '待收货' })]) })
    const market = renderTab({ operation: 'market-receipt' })
    await screen.findByText('待我处理')
    fireEvent.click(screen.getByRole('button', { name: '一键收货 FH-3' }))
    fireEvent.click(screen.getByRole('button', { name: '确认整单收货' }))
    await waitFor(() =>
      expect(vi.mocked(receiveItemCompanyShipmentInFull)).toHaveBeenCalledWith({
        shipmentId: 'FH-3',
        remark: null,
      }),
    )
    // 新入库单号要带进 toast —— 那是用户下一步要找的东西
    await waitFor(() =>
      expect(vi.mocked(toast.success)).toHaveBeenCalledWith('收货已确认，已生成入库单 SCRK-9'),
    )
    expect(vi.mocked(receiveStoreAllocationInFull)).not.toHaveBeenCalled()
    market.unmount()

    vi.mocked(receiveStoreAllocationInFull).mockResolvedValue({ id: 'YRK-9', shipmentId: 'FYPH-1' })
    mockDocs({ inbox: segment([docRow({ id: 'FYPH-1', docType: '分院配货', status: '待收货' })]) })
    renderTab({ operation: 'store-receipt' })
    await screen.findByText('待我处理')
    fireEvent.click(screen.getByRole('button', { name: '一键收货 FYPH-1' }))
    fireEvent.click(screen.getByRole('button', { name: '确认整单收货' }))
    await waitFor(() =>
      expect(vi.mocked(receiveStoreAllocationInFull)).toHaveBeenCalledWith({
        shipmentId: 'FYPH-1',
        remark: null,
      }),
    )
  })

  it('门店调拨的待办走 generic 三件套里唯一能用的那个：confirmInventoryCoreReceive', async () => {
    vi.mocked(confirmInventoryCoreReceive).mockResolvedValue({ inboundDocId: 'FYDHRK-1' } as never)
    mockDocs({ inbox: segment([docRow({ id: 'FYDHCK-1', docType: '分院调货出库', status: '待收货' })]) })
    renderTab({ operation: 'generic:分院调货出库' })
    await screen.findByText('待我处理')

    fireEvent.click(screen.getByRole('button', { name: '确认收货 FYDHCK-1' }))
    fireEvent.click(screen.getByRole('button', { name: '确认收货' }))
    await waitFor(() =>
      expect(vi.mocked(confirmInventoryCoreReceive)).toHaveBeenCalledWith('FYDHCK-1', ''),
    )
  })

  it('「去收货」不开弹窗、直接回调；同一张单连点两次要能触发两次', async () => {
    const onGotoForm = vi.fn()
    mockDocs({ inbox: segment([docRow({ id: 'CGD-2', docType: '采购订单', status: '待收货' })]) })
    renderTab({ operation: 'supply-chain-receipt', onGotoForm })
    await screen.findByText('待我处理')

    const goto = screen.getByRole('button', { name: '去收货 CGD-2' })
    fireEvent.click(goto)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.click(goto)
    // 两次都要到位：工作区侧用自增 token 承接，裸 docId 的话第二次会静默失效
    expect(onGotoForm.mock.calls).toEqual([['CGD-2'], ['CGD-2']])
  })

  it('动作成功后就地重取本 Tab 两段，并额外 router.refresh() 刷 RSC 的表单候选', async () => {
    vi.mocked(approveReturnForRestock).mockResolvedValue({ id: 'SRK-9' } as never)
    mockDocs({ inbox: segment([docRow({ id: 'D-11', docType: '院退货', status: '待审批' })]) })
    renderTab({ operation: 'store-return-approval' })
    await screen.findByText('待我处理')
    expect(vi.mocked(listInventoryOperationDocs)).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: '通过 D-11' }))
    fireEvent.click(screen.getByRole('button', { name: '确认通过' }))

    // 只调 router.refresh() 是不够的：本 Tab 的数据是客户端 action 拉的，
    // RSC 刷新对它完全无效，办完的单会一直留在待办区。
    await waitFor(() => expect(vi.mocked(listInventoryOperationDocs)).toHaveBeenCalledTimes(2))
    expect(mockRefresh).toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })
})

describe('待办行内动作的失败与防重（#192）', () => {
  async function openApprove(docId = 'D-12') {
    mockDocs({ inbox: segment([docRow({ id: docId, docType: '院退货', status: '待审批' })]) })
    renderTab({ operation: 'store-return-approval' })
    await screen.findByText('待我处理')
    fireEvent.click(screen.getByRole('button', { name: `通过 ${docId}` }))
  }

  /*
   * 三种「状态型」错误：单据被别人改过 / 状态机不允许 / 权限被收回。
   * 共同点是留在原地反复点也不会成功，必须关窗 + 刷新给出路。
   * 裸 `PERMISSION_DENIED`（无冒号无文案）是 PermissionError 的真实 digest 形态，
   * 只认带冒号的串会恰好漏掉这条最直接的路径。
   */
  const staleCases: Array<{ name: string; digest: string }> = [
    { name: 'CONFLICT', digest: 'CONFLICT: 单据状态已被其他操作修改' },
    { name: 'INVALID_STATE', digest: 'INVALID_STATE: 该发货单不是待收货状态，请刷新后重试' },
    { name: '裸 PERMISSION_DENIED', digest: 'PERMISSION_DENIED' },
  ]

  for (const item of staleCases) {
    it(`状态冲突（${item.name}）：提示 + 关弹窗 + 重取列表`, async () => {
      const error = Object.assign(new Error('server'), { digest: item.digest })
      vi.mocked(approveReturnForRestock).mockRejectedValue(error)
      await openApprove()

      fireEvent.click(screen.getByRole('button', { name: '确认通过' }))
      await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalled())
      // 关窗 + 重取（第 2 次调用就是 reloadToken 触发的）
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      await waitFor(() => expect(vi.mocked(listInventoryOperationDocs)).toHaveBeenCalledTimes(2))
    })
  }

  it('对照组：普通网络抖动时弹窗留着让人重试，也不重取列表', async () => {
    vi.mocked(approveReturnForRestock).mockRejectedValue(new Error('Failed to fetch'))
    await openApprove('D-13')

    fireEvent.click(screen.getByRole('button', { name: '确认通过' }))
    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalledWith('退货审批失败'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(vi.mocked(listInventoryOperationDocs)).toHaveBeenCalledTimes(1)
    // 失败后锁要解开，否则这张单再也提交不了
    await waitFor(() => expect(screen.getByRole('button', { name: '确认通过' })).toBeEnabled())
  })

  it('防重：在途时确认按钮 disabled，连点两次只发一次请求', async () => {
    const gate = deferred<{ id: string }>()
    vi.mocked(approveReturnForRestock).mockReturnValue(gate.promise as never)
    await openApprove('D-14')

    fireEvent.click(screen.getByRole('button', { name: '确认通过' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '处理中…' })).toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: '处理中…' }))

    await act(async () => {
      gate.resolve({ id: 'SRK-8' })
      await gate.promise
    })
    expect(vi.mocked(approveReturnForRestock)).toHaveBeenCalledTimes(1)
  })

  it('防重：在途时点另一行的动作不开新弹窗，且那个按钮本身没有 disabled 属性', async () => {
    const gate = deferred<{ id: string }>()
    vi.mocked(approveReturnForRestock).mockReturnValue(gate.promise as never)
    mockDocs({
      inbox: segment([
        docRow({ id: 'D-15', docType: '院退货', status: '待审批' }),
        docRow({ id: 'D-16', docType: '院退货', status: '待审批' }),
      ]),
    })
    renderTab({ operation: 'store-return-approval' })
    await screen.findByText('待我处理')

    fireEvent.click(screen.getByRole('button', { name: '通过 D-15' }))
    fireEvent.click(screen.getByRole('button', { name: '确认通过' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '处理中…' })).toBeDisabled())

    const otherRow = screen.getByRole('button', { name: '驳回 D-16' })
    /*
     * 开窗入口走**点击闸**而不是 disabled：点下去就 disabled 会让 showModal()
     * 记不到「打开前的焦点」，关窗后焦点回不到触发按钮上（#134）。
     * 所以这里既要「点了没反应」，也要「按钮没被 disable」。
     */
    expect(otherRow).not.toBeDisabled()
    fireEvent.click(otherRow)
    // 仍是 D-15 那一张的审批窗，没被 D-16 顶掉
    expect(screen.getByText('确认通过退货？')).toBeInTheDocument()
    expect(screen.queryByText('驳回退货申请')).not.toBeInTheDocument()

    await act(async () => {
      gate.resolve({ id: 'SRK-7' })
      await gate.promise
    })
  })
})

/**
 * DocPicker 的选中值兜底（#192 pr-ready 抓到的 P2-1）。
 *
 * 待办区「去收货」预选的单据来自服务端按类型 + 状态**全量分页**的待办段，
 * 而 DocPicker 的候选只有 RSC 传下来的 `workflowDocs`（全类型混排的最近 100 张）——
 * 长期挂着的待收货单大概率不在里面。`<select>` 匹配不到 option 时落到
 * `selectedIndex = -1`：下拉空白、下方明细表却已加载好，没有任何报错。
 */
describe('DocPicker 的选中值兜底（#192 follow-up）', () => {
  const source = readFileSync(resolve(__dirname, 'inventory-operations-page.tsx'), 'utf8')

  it('「去收货」预选的单不在候选集里时，下拉仍选中它而不是空白', async () => {
    const row = docRow({ id: 'CGD-77', docType: '采购订单', status: '待收货' })
    vi.mocked(getInventoryCoreDocById).mockResolvedValue(docDetail(row))
    mockDocs({ inbox: segment([row]) })
    // workflowDocs 为空 = 这张单掉出了「最近 100 张」，正是本条要修的场景
    renderPage({ level: 'supply-chain', operation: 'supply-chain-receipt', workflowDocs: [] })

    await openDocsTab()
    fireEvent.click(screen.getByRole('button', { name: '去收货 CGD-77' }))

    // 跳回填报表单后：选项补出来了，且真的被选中（修复前这里 selectedIndex 是 -1）
    const option = await screen.findByRole<HTMLOptionElement>('option', { name: /^CGD-77 · / })
    const select = option.closest('select') as HTMLSelectElement
    expect(option.selected).toBe(true)
    expect(select.selectedIndex).toBeGreaterThan(-1)
    expect(select).toHaveValue('CGD-77')
  })

  it('候选集里本来就有这张单时不补重复选项', async () => {
    const row = docRow({ id: 'CGD-88', docType: '采购订单', status: '待收货' })
    vi.mocked(getInventoryCoreDocById).mockResolvedValue(docDetail(row))
    mockDocs({ inbox: segment([row]) })
    renderPage({ level: 'supply-chain', operation: 'supply-chain-receipt', workflowDocs: [row] })

    await openDocsTab()
    fireEvent.click(screen.getByRole('button', { name: '去收货 CGD-88' }))

    /*
     * 先等单据明细装载完再数：兜底项在加载期只显示裸单号（文案对不上这个正则），
     * 早数一步的话「无条件补一条」这种写法会蒙混过关。
     */
    await waitFor(() => {
      const loaded = screen.getAllByRole<HTMLOptionElement>('option', { name: /^CGD-88 · / })
      expect(loaded.some((option) => option.selected)).toBe(true)
    })
    // 补一条「无条件的」兜底选项会让同一张单在下拉里出现两次
    expect(screen.getAllByRole('option', { name: /^CGD-88 · / })).toHaveLength(1)
  })

  it('每个 DocPicker 调用点都把当前单据交给 current', () => {
    /*
     * 漏传一处的后果只是「那个表单的下拉偶尔空白」—— 页面不报错、别的表单都正常，
     * 靠肉眼 review 看不出来。这里把接线本身钉住：新加的选择器也必须带上。
     *
     * 不止预选那三个表单：候选集是按状态过滤的（docCandidates 的第三个参数），
     * 行内动作 / 建单成功后的 router.refresh() 会让已选中的单据换状态、掉出候选，
     * 正常路径也能走到同一个空白态。
     */
    const calls = source.match(/<DocPicker\b[\s\S]*?\/>/g) ?? []
    expect(calls.length).toBeGreaterThanOrEqual(8)
    for (const call of calls) {
      expect(call).toMatch(/current=\{doc\}/)
    }
  })

  it('兜底只在选中值缺席时出现，且不动候选集本身', () => {
    const picker = source.slice(
      source.indexOf('function DocPicker('),
      source.indexOf('function SkuPicker('),
    )
    // 「缺席」判据：有值 且 候选里找不到。少了后半句就变成无条件补，会出重复选项。
    expect(picker).toMatch(/const selectedMissing = value !== '' && !docs\.some\(\(doc\) => doc\.id === value\)/)
    // 还在加载（current 尚为 null）时用单号占位，保证任何时刻 select 都有选中项
    expect(picker).toMatch(/current && current\.id === value \? formatDoc\(current\) : value/)
    // 反向：不能把兜底项塞进 docs 再渲染 —— 那会污染候选集本身
    expect(picker).not.toMatch(/\[current, \.\.\.docs\]/)
  })
})

/**
 * 行内动作的在途态上报（#192 pr-ready 抓到的 P2-2）。
 *
 * 同一个工作区里有两条提交路径：填报表单侧的建单、单据 Tab 里的行内动作。
 * 前者在途时会锁住业务卡片与「关闭」按钮，后者原先只喂了自己 Tab 的点击闸 ——
 * 提交在途时切走会把在途请求连同工作区一起卸载：单已经办出去了，界面上却只是面板消失。
 */
describe('行内动作的在途态上报（#192 follow-up）', () => {
  const source = readFileSync(resolve(__dirname, 'inventory-operations-page.tsx'), 'utf8')

  it('提交在途时业务卡片与「关闭」按钮一起被锁，办完恢复', async () => {
    const gate = deferred<{ id: string }>()
    vi.mocked(approveReturnForRestock).mockReturnValue(gate.promise as never)
    mockDocs({ inbox: segment([docRow({ id: 'D-20', docType: '院退货', status: '待审批' })]) })
    renderPage({ level: 'market', operation: 'store-return-approval' })

    /*
     * 先把两个节点抓在手里再开弹窗：`DialogClose` 的 sr-only 文案也叫「关闭」，
     * 弹窗开着时按名字查会撞上两个。节点引用跨重渲染是稳定的（React 原地复用 DOM）。
     */
    const card = screen.getByRole('button', { name: /审批门店退货/ })
    const close = screen.getByRole('button', { name: '关闭' })
    expect(card).toBeEnabled()
    expect(close).toBeEnabled()

    await openDocsTab()
    fireEvent.click(screen.getByRole('button', { name: '通过 D-20' }))
    fireEvent.click(screen.getByRole('button', { name: '确认通过' }))

    await waitFor(() => expect(close).toBeDisabled())
    expect(card).toBeDisabled()

    await act(async () => {
      gate.resolve({ id: 'SRK-20' })
      await gate.promise
    })
    await waitFor(() => expect(close).toBeEnabled())
    expect(card).toBeEnabled()
  })

  it('在途态既上报给工作区，也留着本 Tab 自己的点击闸', async () => {
    const gate = deferred<{ id: string }>()
    vi.mocked(approveReturnForRestock).mockReturnValue(gate.promise as never)
    mockDocs({
      inbox: segment([
        docRow({ id: 'D-21', docType: '院退货', status: '待审批' }),
        docRow({ id: 'D-22', docType: '院退货', status: '待审批' }),
      ]),
    })
    const { onActionBusyChange } = renderTab({ operation: 'store-return-approval' })
    await screen.findByText('待我处理')
    // 挂载时 DocActionDialog 会先报一次 false，清掉免得干扰下面的断言
    onActionBusyChange.mockClear()

    fireEvent.click(screen.getByRole('button', { name: '通过 D-21' }))
    fireEvent.click(screen.getByRole('button', { name: '确认通过' }))
    await waitFor(() => expect(onActionBusyChange).toHaveBeenLastCalledWith(true))

    // 上报出去了不等于本地那道闸可以撤：在途时点另一行仍然不开第二个弹窗
    fireEvent.click(screen.getByRole('button', { name: '驳回 D-22' }))
    expect(screen.queryByText('驳回退货申请')).not.toBeInTheDocument()

    await act(async () => {
      gate.resolve({ id: 'SRK-21' })
      await gate.promise
    })
    await waitFor(() => expect(onActionBusyChange).toHaveBeenLastCalledWith(false))
  })

  it('两条在途来源各存一份再 OR 上报，不共用一个布尔', () => {
    /*
     * 共用一个布尔的话，两个面板都是 keepMounted 的 ——「建单在途时切到单据 Tab
     * 再办一张待办」完全可达，先结束的那条会把仍在途的那条一起解锁。
     */
    const workspace = source.slice(
      source.indexOf('function OperationWorkspace('),
      source.indexOf('const OPERATION_DOCS_PAGE_SIZE'),
    )
    expect(workspace).toMatch(/const \[formBusy, setFormBusy\] = useState\(false\)/)
    expect(workspace).toMatch(/const \[actionBusy, setActionBusy\] = useState\(false\)/)
    expect(workspace).toMatch(/onBusyChange\(formBusy \|\| actionBusy\)/)
    expect(workspace).toMatch(/onBusyChange=\{setFormBusy\}/)
    expect(workspace).toMatch(/onActionBusyChange=\{setActionBusy\}/)
  })

  it('上报走稳定引用的 useCallback，不是内联箭头', () => {
    // DocActionDialog 的 effect cleanup 会在 onBusyChange 引用变化时补一次 false，
    // 内联箭头等于每次重渲都把在途态闪断一下 —— 锁会在提交途中自己松开。
    const tab = source.slice(source.indexOf('export function OperationDocsTab('))
    expect(tab).toMatch(/const handleActionBusyChange = useCallback\(\(busy: boolean\) => \{/)
    expect(tab).toMatch(/onBusyChange=\{handleActionBusyChange\}/)
    // 本地那份仍然在，点击闸读的是它
    expect(tab).toMatch(/if \(pendingInboxAction \|\| actionBusy\) return/)
  })
})

/**
 * SKU 候选的业务过滤（#339）。原先是前端对「预加载的前 100 条」再筛一遍，
 * 排在后面的合法商品根本进不了候选；现在过滤条件随请求交给服务端。
 * 这里钉住每个入口交给选择器的 `filters` —— 它必须与该业务建单时的服务端校验同口径
 * （SQL 层的渲染断言见 engine.test.ts「SKU 候选检索过滤」）。
 */
describe('SKU 候选按业务口径交给服务端过滤（#339）', () => {
  const LOCATIONS: InventoryLocationRow[] = [
    { locationId: 'HQ', locationType: '总部', name: '品牌总部', orgNodeId: 'HQ', storeId: null, parentLocationId: null, isActive: true },
    { locationId: 'M1', locationType: '市场', name: '市场一部', orgNodeId: 'M1', storeId: null, parentLocationId: 'HQ', isActive: true },
    { locationId: 'M2', locationType: '市场', name: '市场二部', orgNodeId: 'M2', storeId: null, parentLocationId: 'HQ', isActive: true },
    { locationId: 'S1', locationType: '门店', name: '一店', orgNodeId: 'N-S1', storeId: 'S1', parentLocationId: 'M1', isActive: true },
    { locationId: 'S2', locationType: '门店', name: '二店', orgNodeId: 'N-S2', storeId: 'S2', parentLocationId: 'M2', isActive: true },
  ]
  beforeEach(() => mockDocs({}))
  const pickers = () => Array.from(document.querySelectorAll<HTMLSelectElement>('[data-sku-picker]'))
  const filtersOf = (picker: HTMLSelectElement) => JSON.parse(picker.dataset.filters ?? '{}')
  function chooseSubject(placeholder: string, value: string) {
    const select = screen.getByRole('option', { name: placeholder }).closest('select') as HTMLSelectElement
    fireEvent.change(select, { target: { value } })
  }

  it('门店报货代建：未选门店时禁用；选定后只出可报货 + 门店所属市场可用的商品（Q1=A，与 staff 同口径）', () => {
    renderPage({ level: 'store', operation: 'store-request', locations: LOCATIONS })
    expect(pickers()[0]).toBeDisabled()
    chooseSubject('请选择门店', 'S2')
    expect(pickers()[0]).not.toBeDisabled()
    expect(filtersOf(pickers()[0])).toEqual({ reportable: true, availableToMarketId: 'M2' })
  })

  it('门店报货代建：换到另一个市场的门店时清掉已选商品', () => {
    renderPage({ level: 'store', operation: 'store-request', locations: LOCATIONS })
    chooseSubject('请选择门店', 'S1')
    fireEvent.change(pickers()[0], { target: { value: 'SKU-1' } })
    expect(pickers()[0].value).toBe('SKU-1')
    chooseSubject('请选择门店', 'S2')
    expect(pickers()[0].value).toBe('')
  })

  it('商品选择器不放进 <label>：字段用 role=group + aria-labelledby 关联字段名', () => {
    renderPage({ level: 'store', operation: 'store-request', locations: LOCATIONS })
    const picker = pickers()[0]
    expect(picker.closest('label')).toBeNull()
    const group = picker.closest('[role="group"]') as HTMLElement
    expect(document.getElementById(group.getAttribute('aria-labelledby') ?? '')?.textContent).toMatch(/^商品/)
    // 源码守护：每个 SkuPicker 调用点的外层 FormField 都得带 group（新加入口时别漏）
    const source = readFileSync(resolve(__dirname, 'inventory-operations-page.tsx'), 'utf8')
    const calls = source.match(/<SkuPicker /g) ?? []
    const grouped = source.match(/<FormField label="[^"]*"(?: required)? group>\s*<SkuPicker /g) ?? []
    expect(calls.length).toBeGreaterThanOrEqual(9)
    expect(grouped.length).toBe(calls.length)
  })

  it('品项公司报货需求：只出供应链来源 + 可报货', () => {
    renderPage({ level: 'supply-chain', operation: 'item-company-request', locations: LOCATIONS })
    expect(filtersOf(pickers()[0])).toEqual({ sourceType: '供应链', reportable: true })
  })

  it('自采产品入库：未选市场时禁用；选定后只出归属本市场的非供应链商品', () => {
    renderPage({ level: 'market', operation: 'self-purchase', locations: LOCATIONS, canSelfPurchase: true })
    expect(pickers()[0]).toBeDisabled()
    chooseSubject('请选择市场', 'M1')
    expect(filtersOf(pickers()[0])).toEqual({ ownedByMarketId: 'M1' })
    expect(screen.getAllByPlaceholderText('留空自动生成')).toHaveLength(1) // #345
  })

  it('库存转换目标：总部主体 → 仅供应链；来源商品不加过滤（批次兜底）', () => {
    // #343 起库存转换只剩供应链（总部主体）一层，市场 / 门店转换卡已下线
    renderPage({ level: 'supply-chain', operation: 'supply-chain-conversion', locations: LOCATIONS })
    const [source, target] = pickers()
    expect(filtersOf(source)).toEqual({})
    expect(filtersOf(target)).toEqual({ sourceType: '供应链' })
    expect(screen.getAllByPlaceholderText('留空自动生成')).toHaveLength(1) // #345：目标批号留空生成新批号
  })
})

/**
 * 分院配货的门店标准单价（#339）：原先查办理台预加载的前 100 条 SKU，排在后面的商品静默退回
 * 明细快照价；现在按本单明细的 skuIds 精确查，分块各自生效，失败时提示且不阻断。
 */
describe('分院配货按 skuIds 精确取当前门店进货价（#339）', () => {
  const request = docRow({ id: 'DBH-1', docType: '门店报货', status: '已完成' })
  function item(id: number, skuId: string, standardUnitPrice: number | null) {
    return {
      id, docId: 'DBH-1', lotId: null, skuId, skuName: `商品${skuId}`, specName: null, quantity: 2, fulfilledQuantity: 0,
      standardUnitPrice, actualUnitPrice: null, unitDiscount: 0,
    } as unknown as InventoryDocDetail['items'][number]
  }
  const prices = () => screen.queryAllByText('门店标准单价').map((label) => label.nextElementSibling?.textContent)

  beforeEach(() => {
    mockDocs({})
    vi.mocked(listInventorySkus).mockReset()
    vi.mocked(toast.warning).mockReset()
    // 每行的市场批次下拉会取数，给个空结果即可
    vi.mocked(listInventoryLotOptions).mockResolvedValue([])
  })

  async function pickRequest(items: InventoryDocDetail['items']) {
    vi.mocked(getInventoryCoreDocById).mockResolvedValue({ ...docDetail(request), items })
    renderPage({ level: 'market', operation: 'store-allocation', workflowDocs: [request] })
    const option = await screen.findByRole<HTMLOptionElement>('option', { name: /^DBH-1/ })
    fireEvent.change(option.closest('select') as HTMLSelectElement, { target: { value: 'DBH-1' } })
  }

  it('取到档案价就覆盖快照价；只补价格列、按明细 skuIds 精确查（含已停用）', async () => {
    vi.mocked(listInventorySkus).mockResolvedValue({
      data: [{ skuId: 'S-200', storePurchasePrice: 88.5 } as never], total: 1,
    })
    await pickRequest([item(1, 'S-200', 60), item(2, 'S-201', 70)])
    await waitFor(() => expect(prices()).toEqual(['88.50', '70.00']))
    expect(listInventorySkus).toHaveBeenCalledWith({ skuIds: ['S-200', 'S-201'], onlyActive: false, page: 1, pageSize: 100 })
    expect(toast.warning).not.toHaveBeenCalled()
  })

  it('批次下拉渲染正常与赠送两条批号不同的选项（#345）', async () => {
    vi.mocked(listInventorySkus).mockResolvedValue({ data: [], total: 0 })
    vi.mocked(listInventoryLotOptions).mockResolvedValue([
      { id: 11, batchNo: 'B100', isGift: false, quantityOnHand: 6, expiryDate: null },
      { id: 12, batchNo: 'GFH-20260925-0001-02', isGift: true, quantityOnHand: 2, expiryDate: null },
    ] as never)
    await pickRequest([item(1, 'S-200', 60)])
    const normal = await screen.findByRole<HTMLOptionElement>('option', { name: /^批次 B100 · 可用 6$/ })
    const gift = screen.getByRole<HTMLOptionElement>('option', { name: /^批次 GFH-20260925-0001-02 · 可用 2$/ })
    expect(normal.closest('select')).not.toBeNull()
    expect(normal.closest('select')).toBe(gift.closest('select'))
    expect(listInventoryLotOptions).toHaveBeenCalledWith(expect.any(String), 'S-200')
  })

  it('取价失败：退回快照价并提示，不阻断配货', async () => {
    vi.mocked(listInventorySkus).mockRejectedValue(new Error('NETWORK'))
    await pickRequest([item(1, 'S-200', 60)])
    await waitFor(() => expect(toast.warning).toHaveBeenCalled())
    expect(prices()).toEqual(['60.00'])
  })
})

/**
 * #335：采购订单的所有行都走供应链采购入库；采购行 fulfilledQuantity 只记入库量，
 * 品项公司发货的剩余可发量改看发货进度（fulfillmentProgress.shippedQuantity）。
 */
describe('采购订单市场行走供应链采购入库（#335）', () => {
  beforeEach(async () => {
    mockDocs({})
    const { listInventoryLotOptions } = await import('@/actions/inventory/stocks')
    vi.mocked(listInventoryLotOptions).mockResolvedValue([] as never)
  })

  function purchaseItem(overrides: Partial<InventoryDocDetail['items'][number]>): InventoryDocDetail['items'][number] {
    return {
      id: 1, docId: 'CGD-335', lotId: null, skuId: 'SKU-1', saleItemId: null,
      skuName: '供应链产品', specName: null, supplier: null, supplierId: null,
      marketId: null, marketName: null, productSeries: null, batchNo: '', expiryDate: null,
      isGift: false, quantity: 10, stockSnapshot: null, requestQuantity: 10, fulfilledQuantity: 0,
      promotionPlanId: null, promotionPlanNoSnapshot: null, promotionPlanNameSnapshot: null,
      promotionRuleTypeSnapshot: null, promotionSelectionMode: null,
      reason: null, remark: null, createdAt: '2026-09-24T00:00:00.000Z',
      ...overrides,
    } as InventoryDocDetail['items'][number]
  }

  async function pickPurchaseOrder(row: InventoryDocRow) {
    const option = await screen.findByRole<HTMLOptionElement>('option', { name: new RegExp(`^${row.id} · `) })
    fireEvent.change(option.closest('select') as HTMLSelectElement, { target: { value: row.id } })
  }

  it('供应链采购入库表单装载市场行与自用行，按未入库量预填', async () => {
    const row = docRow({ id: 'CGD-335', docType: '采购订单', status: '待收货' })
    vi.mocked(getInventoryCoreDocById).mockResolvedValue({
      ...docDetail(row),
      items: [
        purchaseItem({ id: 1, skuName: '自用行', quantity: 10, fulfilledQuantity: 4 }),
        purchaseItem({ id: 2, skuName: '市场行', marketId: 'M1', marketName: '市场甲', quantity: 20, fulfilledQuantity: 3 }),
      ],
    })
    renderPage({ level: 'supply-chain', operation: 'supply-chain-receipt', workflowDocs: [row] })
    await pickPurchaseOrder(row)

    await screen.findByText('本次实收入库')
    // 市场行曾被过滤掉（#194），现在必须出现并按 20 − 3 预填
    expect(screen.getAllByText('市场行').length).toBeGreaterThan(0)
    expect(screen.getByDisplayValue('17')).toBeInTheDocument()
    expect(screen.getByDisplayValue('6')).toBeInTheDocument()
    // 批号留空由服务端生成（#345），每行批号框都要提示
    expect(screen.getAllByPlaceholderText('留空自动生成')).toHaveLength(2)
  })

  it('品项公司发货的剩余可发量看发货进度，不看已入库量', async () => {
    const row = docRow({ id: 'CGD-335', docType: '采购订单', status: '待收货' })
    vi.mocked(getInventoryCoreDocById).mockResolvedValue({
      ...docDetail(row),
      items: [purchaseItem({ id: 2, marketId: 'M1', marketName: '市场甲', quantity: 10, fulfilledQuantity: 4 })],
      fulfillmentProgress: {
        kind: '供应链采购收货',
        items: [{ itemId: 2, purchasedQuantity: 10, receivedQuantity: 4, outstandingQuantity: 6, shippedQuantity: 3 }],
      },
    })
    renderPage({ level: 'supply-chain', operation: 'company-shipment', workflowDocs: [row] })
    await pickPurchaseOrder(row)

    // 10 − 已发 3 = 7；按旧口径读 fulfilledQuantity（已入库 4）会得到 6
    expect(await screen.findByDisplayValue('7')).toBeInTheDocument()
    expect(screen.queryByDisplayValue('6')).not.toBeInTheDocument()
  })

  it('候选下拉把「待收货 + 已有入库」的采购订单标成「部分入库」', async () => {
    const row = docRow({ id: 'CGD-336', docType: '采购订单', status: '待收货', partiallyReceived: true })
    renderPage({ level: 'supply-chain', operation: 'supply-chain-receipt', workflowDocs: [row] })
    expect(await screen.findByRole('option', { name: /^CGD-336 · .* · 部分入库$/ })).toBeInTheDocument()
  })
})

describe('库存转换卡片只剩供应链一张（#343）', () => {
  const source = readFileSync(resolve(__dirname, 'inventory-operations-page.tsx'), 'utf8')

  it('卡片数组与渲染分支里都没有市场 / 门店转换', () => {
    expect(source).not.toMatch(/id: 'market-conversion'/)
    expect(source).not.toMatch(/id: 'store-conversion'/)
    expect(source).not.toMatch(/operation === '(market|store)-conversion'/)
    expect(source).toMatch(/id: 'supply-chain-conversion', level: 'supply-chain'/)
    // 唯一的 ConversionForm 调用点固定总部主体
    const calls = source.match(/<ConversionForm\b[^>]*\/>/g) ?? []
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('locationType="总部"')
  })
})

describe('门店办理台「顾客产品出库」改为跳转提货录入（#350）', () => {
  it('有提货录入权限：渲染成指向 /pickup-records/create 的链接，不再是通用建单卡', () => {
    renderPage({ level: 'store', canCreatePickupRecord: true })
    const link = screen.getByRole('link', { name: /顾客产品出库/ })
    expect(link.getAttribute('href')).toBe('/pickup-records/create')
    // 不再有打开通用建单工作区的按钮
    expect(screen.queryByRole('button', { name: /顾客产品出库/ })).toBeNull()
  })

  it('没有提货录入权限（如代建门店业务的市场财务）：卡片置灰且不是链接', () => {
    renderPage({ level: 'store', canCreatePickupRecord: false })
    expect(screen.queryByRole('link', { name: /顾客产品出库/ })).toBeNull()
    const card = screen.getByRole('button', { name: /顾客产品出库/ })
    expect((card as HTMLButtonElement).disabled).toBe(true)
    expect(card.textContent).toContain('需提货录入权限')
  })

  it('市场 / 供应链办理台没有这张跳转卡', () => {
    renderPage({ level: 'market', canCreatePickupRecord: true })
    expect(screen.queryByRole('link', { name: /顾客产品出库/ })).toBeNull()
  })

  it('深链 ?create=院顾客产品出库 不再打开任何工作区', () => {
    expect(asGenericDocType('院顾客产品出库')).toBeNull()
    expect(parseGenericOperationId('generic:院顾客产品出库')).toBeNull()
  })
})
