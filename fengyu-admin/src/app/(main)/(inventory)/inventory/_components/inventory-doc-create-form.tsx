'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { createInventoryCoreDoc } from '@/actions/inventory/docs'
import { listInventoryLotOptions } from '@/actions/inventory/stocks'
import type {
  CreateInventoryDocInput,
  InventoryDocItemInput,
  InventoryDocType,
  InventoryLocationRow,
  InventoryLotRow,
  InventoryMarketTransferTarget,
} from '@/lib/inventory/types'
import { INVENTORY_GENERIC_DOC_TYPES } from '@/lib/inventory/types'
import { docActionErrorMessage, isStaleStateError } from '@/lib/inventory/doc-action-error'
import { actionErrorMessage } from '@/lib/action-error'
import { Button } from '@/components/ui/button'
import { DatePicker } from '@/components/ui/date-picker'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import InventorySubjectSelect from '@/components/inventory-subject-select'
import { InventorySkuSearchSelect } from './inventory-sku-search-select'
import { Textarea } from '@/components/ui/textarea'

/**
 * 通用建单表单（#191 从 `inventory-docs-page.tsx` 的 CreateDocDialog 抽出）。
 *
 * 两个调用方共用这一份：单据中心把它塞进 `<Dialog>`，办理台把它直接渲染在
 * 业务工作区的「填报表单」Tab 里。**外壳（弹窗 / 面板）由调用方提供**，
 * 这里只负责表单本体、批次取数与提交。
 */

export const SOURCE_LOT_DOC_TYPES = new Set<InventoryDocType>([
  '品项公司发货',
  '分院配货',
  '分院调货出库',
  '市场间调货出库',
  '员工购出库',
  '供应链员工购出库',
  '内部领用',
  '非凤御市场出库',
  '市场退货',
  '院退货',
  '院顾客产品出库',
  '市场产品报损',
  '院产品报损',
  '库存转换出库',
])

/**
 * 通用建单的**合法端点**口径，与 engine.ts `createInventoryCoreDoc` 里那段内联的端点规则
 * 同源（#200 S6-a）：同主体类型两端归一（`INTERNAL_SAME_NODE_DOC_TYPES`）、待收货类型两端都要
 * （`RECEIVE_REQUIRED_DOC_TYPES`）、其余按 `movementPlan` 的 `locationRole` 拒掉另一端。
 *
 * engine.ts 第 2 行是 `import 'server-only'`，前端 import 会把 `@/db` 一起拖进浏览器包，
 * 所以这里另写一份；两份不漂移由 `inventory-docs-page.test.tsx` 的源码字面量守护拦住
 * （它直接读 engine.ts 里 `NO_MOVEMENT_DOC_TYPES` / `RECEIVE_REQUIRED_DOC_TYPES` /
 *  `APPROVAL_DOC_TYPES` / `INBOUND_DOC_TYPES` / `OUTBOUND_DOC_TYPES` /
 *  `INTERNAL_SAME_NODE_DOC_TYPES` 六个集合的字面量，按 `defaultStatusForDoc` → `movementPlan`
 *  → 建单段单边规则的分支顺序推导期望值）。
 *
 * - `same-node`   两端指同一个库存主体。两个下拉**都保持可用**并互相镜像同值 ——
 *                 服务端两端不一致直接拒单（#200 AC4），镜像让用户点哪个都对。
 * - `both`        两端各自独立（调货出库：source 出货、target 收货）。
 * - `source-only` 只允许出库主体；入库主体下拉禁用，提交时该端点送 null。
 * - `target-only` 只允许入库主体；出库主体下拉禁用，提交时该端点送 null。
 *
 * ⚠️ 只禁用**非法**的那一端，两端都合法的类型一律 enabled：`tests/e2e-inventory-ui`
 * 的既有用例按 `selects.nth(n)` 定位并会直接操作同主体类型的 target 下拉
 * （inv-02 的「市场产品盘溢」、inv-06 的 createGenericDoc 同时传两端），
 * 禁用或删节点都会把它们打挂。
 */
export type GenericDocEndpointMode = 'same-node' | 'both' | 'source-only' | 'target-only'

const GENERIC_DOC_ENDPOINT_MODE = {
  分院调货出库: 'both',
  市场间调货出库: 'both',
  内部领用: 'same-node',
  院顾客退货: 'target-only',
  市场产品报损: 'same-node',
  院产品报损: 'same-node',
  市场产品盘溢: 'same-node',
  市场库存盘点: 'same-node',
  分院库存盘点: 'same-node',
  // `satisfies Record<通用类型联合, …>`：漏一种、多一种、键写错都是编译错误。
  // 别退化成 `Record<string, string>` —— 那样 tsc 就完全管不到了。
} as const satisfies Record<(typeof INVENTORY_GENERIC_DOC_TYPES)[number], GenericDocEndpointMode>

export function genericDocEndpointMode(docType: InventoryDocType): GenericDocEndpointMode {
  // 非通用类型走各自的专用业务表单，不经本表单；'both' = 不收窄，是不可达的兜底。
  // 服务端在这一支上本就 fail-closed（`createInventoryCoreDoc` 开头的
  // `INVENTORY_GENERIC_DOC_TYPES` 白名单直接抛「该库存单据不支持通用建单」），
  // 前端不跟着抛：表单层多放行一个端点只是少收窄一次，真正的闸门在服务端。
  return (
    (GENERIC_DOC_ENDPOINT_MODE as Partial<Record<InventoryDocType, GenericDocEndpointMode>>)[docType]
    ?? 'both'
  )
}

function formatDate(v: string | null | undefined) {
  return v ? v.slice(0, 10) : '—'
}

function shanghaiToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

function num(v: string): number | null {
  if (!v.trim()) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

interface DraftItem {
  lotId: string
  skuId: string
  batchNo: string
  expiryDate: string
  isGift: boolean
  quantity: string
  reason: string
  remark: string
}

function defaultItem(): DraftItem {
  return {
    lotId: '',
    skuId: '',
    batchNo: '',
    expiryDate: '',
    isGift: false,
    quantity: '1',
    reason: '',
    remark: '',
  }
}

/**
 * 批次取数缓存：(库位, SKU) → 在途/已完成的 Promise。
 *
 * key **不含代次** —— 代次只管「结果算不算新鲜」（编在 DocLotSelect 的 cacheKey 里），
 * 在途去重是另一回事。
 *
 * 取数时按 `settled` + `epoch` 决定复用还是重取：
 * - 还在途（`settled === false`）→ 无条件复用，并把它「过继」给当前代次
 *   （Server Action 不可 abort，作废等于白等一轮）
 * - 已完成且属于**旧代次** → 淘汰重取（可用量可能已经过期）
 * - 已完成且属于当前代次 → 复用（同一表单内多行去重）
 */
type LotCache = Map<string, { promise: Promise<InventoryLotRow[]>; settled: boolean; epoch: number }>

type LotLoadState = { key: string; lots: InventoryLotRow[]; failed?: boolean }

/** 缺省值用模块常量：内联 `= []` 每次渲染都是新数组，会让 targetOptions 的 useMemo 形同虚设。 */
const NO_MARKET_TRANSFER_TARGETS: readonly InventoryMarketTransferTarget[] = []

/** 字段名 + 控件。用 `<label>` 包裹而不是并列，控件（含只读 `<output>`）才能被正确关联。 */
function FieldLabel({ text, children }: { text: string; children: ReactNode }) {
  return (
    <label className="space-y-1.5">
      <span className="block text-sm font-medium">{text}</span>
      {children}
    </label>
  )
}

export function InventoryDocCreateForm({
  visible,
  locations,
  marketTransferTargets = NO_MARKET_TRANSFER_TARGETS,
  initialDocType,
  allowedDocTypes,
  onSuccess,
  onStale,
  onBusyChange,
  renderActions,
}: {
  /**
   * 表单当前是否「在用户眼前」。
   *
   * 两处的语义不同，各自都对：
   * - 单据中心：弹窗开合。原生 `<dialog>` 关闭不卸载 children，关着时绝不能取数。
   * - 办理台：**工作区是否打开**，而不是 Tab 是否在前台 —— 表单面板用 keepMounted
   *   保住用户填了一半的内容（#190），要是跟着 Tab 切换走，去看一眼单据回来
   *   已选的批次就被下面那个「不可见即推进代次」的 effect 清掉了。
   */
  visible: boolean
  locations: InventoryLocationRow[]
  /**
   * 「市场间调货出库」的接收主体候选（#340）：全部启用市场，**不按 scope**。
   * 只在这一种类型上替换 target 下拉，其余类型仍用 `locations`。调用方没有建这张单的
   * 权限时不必取，传空（缺省）即可 —— 那样选到这个类型也只是接收主体为空、无法提交。
   */
  marketTransferTargets?: readonly InventoryMarketTransferTarget[]
  initialDocType?: InventoryDocType
  allowedDocTypes?: readonly InventoryDocType[]
  /** 建单成功。`docId` 是刚建出来的单号，调用方拿去做可核对的反馈。 */
  onSuccess: (docId: string) => void
  /** 状态/权限已变化时刷新列表（不关闭表单）。⚠️ 别接成"成功"回调，失败时会弹绿色成功提示 */
  onStale: () => void
  /** 上报提交在途态，调用方据此锁自己的入口 */
  onBusyChange: (busy: boolean) => void
  /** 由调用方决定提交/取消按钮放哪（弹窗 footer vs 面板内联） */
  renderActions: (actions: { submit: () => void; submitting: boolean }) => ReactNode
}) {
  const availableDocTypes = allowedDocTypes ?? INVENTORY_GENERIC_DOC_TYPES
  const [submitting, setSubmitting] = useState(false)
  useEffect(() => {
    onBusyChange(submitting)
  }, [submitting, onBusyChange])
  // 卸载时把在途态归还给调用方：条件渲染（如权限翻转）把组件摘掉时，
  // 调用方的 busy 不能永远挂着
  useEffect(() => () => onBusyChange(false), [onBusyChange])
  const [docType, setDocType] = useState<InventoryDocType>(
    initialDocType && availableDocTypes.includes(initialDocType) ? initialDocType : availableDocTypes[0],
  )
  const [sourceOrgNodeId, setSourceOrgNodeId] = useState('')
  const [targetOrgNodeId, setTargetOrgNodeId] = useState('')
  const [docDate, setDocDate] = useState(shanghaiToday)
  const [remark, setRemark] = useState('')
  const [items, setItems] = useState<DraftItem[]>([defaultItem()])
  const requiresSourceLot = SOURCE_LOT_DOC_TYPES.has(docType)
  /** 当前类型允许哪些端点（#200 S6）：决定两个主体下拉的禁用/镜像与 payload 的置空 */
  const endpointMode = genericDocEndpointMode(docType)
  /**
   * 批次取数的表单级缓存：按 (库位, SKU) 存**Promise**，既去重在途请求也复用已取结果。
   * 没有它的话，N 条明细选同一个 SKU 就发 N 次；更隐蔽的是明细行用 index 当 React key，
   * 删掉中间一行会让其后每一行的 (库位,SKU) 组合整体平移，触发一连串重复请求 ——
   * 而 Server Action 走的是全局 FIFO 队列，这些请求串行排队，下拉会一起变灰，
   * 观感和 #129 的卡死几乎一样。
   *
   * ⚠️ 用 ref 不用 state：它**绝不能进任何 useEffect 的依赖数组**（#129 的成因正是如此）。
   */
  const lotCacheRef = useRef<LotCache>(new Map())
  /**
   * 缓存代次。表单在不可见时并不卸载（单据中心是原生 `<dialog>`，办理台是 keepMounted
   * 面板），`lotCacheRef` 与每行的 `loaded` 都会常驻 —— 只 clear() 缓存是不够的：
   * 子组件的 `loaded.key` 没变，effect 根本不会重跑。把代次编进 key，重新可见时
   * 所有批次下拉就会重新取数，不会拿几分钟前的数量去建下一张单
   * （提交必被服务端 FOR UPDATE + 可用量校验拒掉）。
   *
   * 代次在**转为不可见时**推进，不是变可见时：
   * - 变可见时推进的话，首帧 `loaded.key` 仍等于旧 cacheKey，会闪一下旧批次；
   * - 转不可见时推进，重新可见的第一帧渲染期就判定为过期 → 直接进加载态。
   * 配合传给 DocLotSelect 的 `active={visible}`（不可见只 cleanup 不取数），
   * 保证「不可见时不发请求、一次重开只产生一个新代次」—— 否则提交成功后表单已关，
   * N 个不同 SKU 的明细行会各发一次无用请求，排在重开后的可见请求前面，
   * 把批次框重新拖成长时间 disabled（正是 #129 的观感）。
   */
  const [lotEpoch, setLotEpoch] = useState(0)

  useEffect(() => {
    if (visible) return
    // 正确性由取数侧的 settled + epoch 判定负责（见 LotCache 注释）—— 在这里按
    // 「转不可见当刻是否 settled」一刀切会漏掉「之后、重新可见前才返回」的那批：它们当刻还在途、
    // 躲过清理，重新可见时又已完成，于是被当成新鲜结果复用。
    // 这里只做内存清扫：当刻已完成的条目下次取数必被代次淘汰，留着也只是占内存
    // （用户翻过很多 SKU 又一直不关页面时会累积）。在途的必须留着给下一代过继。
    for (const [key, entry] of lotCacheRef.current) {
      if (entry.settled) lotCacheRef.current.delete(key)
    }
    setLotEpoch((n) => n + 1)
    // 代次一换，已选的 lotId 可能指向下一代里已经不存在的批次：受控 select 会显示空白，
    // state 却还留着旧值，直接提交就只能靠服务端 lockLotById 兜底报错。换主体/换 SKU
    // 都清了 lotId，这条路径也要清。
    setItems((prev) => (prev.some((item) => item.lotId) ? prev.map((item) => ({ ...item, lotId: '' })) : prev))
  }, [visible])
  /*
   * ⚠️ value 用 **orgNodeId** 而不是 locationId：`InventorySubjectSelect` 的两种 id
   * 空间由调用方决定，而本表单 submit() 发给 server action 的就是
   * `sourceOrgNodeId` / `targetOrgNodeId`。总部与市场两者同值、**门店不同**，
   * 传错只有门店会炸，在只有总部/市场的环境里测不出来。
   */
  const subjectOptions = useMemo(
    () => locations
      .filter((location) => location.orgNodeId)
      .map((location) => ({
        value: location.orgNodeId!,
        label: `${location.locationType} · ${location.name}`,
      })),
    [locations],
  )
  /*
   * 市场间调货出库（#340）的两端候选与其他类型分叉：
   * - 发起端仍走 scope（`locations`），但只留市场 —— 服务端要求两端均为市场，给门店/总部
   *   只会让用户选完再被拒；收窄后单市场账号的发起端也能按 #189 唯一候选自动带出。
   * - 接收端改用 `marketTransferTargets`（不按 scope），并排除当前选中的发起市场 ——
   *   自己调给自己服务端同样会拒。
   * 其余类型两端都原样用 `subjectOptions`，与改前一致。
   */
  const isMarketTransfer = docType === '市场间调货出库'
  const sourceOptions = useMemo(
    () => (isMarketTransfer
      ? locations
        .filter((location) => location.orgNodeId && location.locationType === '市场')
        .map((location) => ({ value: location.orgNodeId!, label: `市场 · ${location.name}` }))
      : subjectOptions),
    [isMarketTransfer, locations, subjectOptions],
  )
  const targetOptions = useMemo(
    () => (isMarketTransfer
      ? marketTransferTargets
        .filter((market) => market.orgNodeId !== sourceOrgNodeId)
        .map((market) => ({ value: market.orgNodeId, label: `市场 · ${market.name}` }))
      : subjectOptions),
    [isMarketTransfer, marketTransferTargets, sourceOrgNodeId, subjectOptions],
  )
  const isDocTypeLocked = Boolean(initialDocType && availableDocTypes.includes(initialDocType))
  const sourceLocationId = locations.find((location) => location.orgNodeId === sourceOrgNodeId)?.locationId ?? ''

  function updateItem(index: number, patch: Partial<DraftItem>) {
    setItems((prev) => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)))
  }

  async function submit() {
    if (submitting) return
    setSubmitting(true)
    try {
      const payload: CreateInventoryDocInput = {
        docType,
        /*
         * 非法端点一律送 null（#200 S6-f）：服务端 `createInventoryCoreDoc` 里那条按
         * `movementPlan.locationRole` 推导的单边规则，对「不该出现却给了非空值」的端点
         * 是直接拒单（AC5，抛「…不接受出库/入库主体」），不是静默忽略 ——
         * 多送一个端点不会被吞掉，只会让用户收到一条他看不懂的报错。
         * same-node 两端已在 onChange 里镜像成同值，原样送给服务端归一即可。
         */
        sourceOrgNodeId: endpointMode === 'target-only' ? null : (sourceOrgNodeId || null),
        targetOrgNodeId: endpointMode === 'source-only' ? null : (targetOrgNodeId || null),
        docDate,
        remark,
        items: items.map<InventoryDocItemInput>((item) => ({
          lotId: num(item.lotId),
          skuId: item.skuId || null,
          batchNo: item.batchNo || null,
          expiryDate: item.expiryDate || null,
          isGift: item.isGift,
          quantity: Number(item.quantity || 0),
          reason: item.reason || null,
          remark: item.remark || null,
        })),
      }
      const result = await createInventoryCoreDoc(payload)
      /*
       * 提交成功必须就地清场，**不能**指望调用方去关弹窗 / 收起面板：
       *
       * 办理台的工作区提交完还开着（只 toast + router.refresh()，后者不重挂客户端组件），
       * 表单原样留在屏幕上、按钮解禁 —— 用户没看见 toast 再点一次，就建出第二张一模一样的单。
       * 而 `createInventoryCoreDoc` 没有幂等键，10 种通用类型里有 6 种**建单当刻就落库存流水**
       * （内部领用 / 顾客退货 / 盘溢 / 两种调货出库；#350 前还有顾客产品出库），重复提交 = 重复扣减或重复入库，
       * 事后只能红冲。同页的内置表单成功后都会 `setLines([初始行])`，这里对齐它们。
       *
       * **主体与日期也要清**，别为了「连续建单少选一次」把它们留着：明细已经清空、
       * 表单看着像新的，残留主体却会被下一张单原样提交。
       *
       * 这条的**理由在 #200 之后变了**，别照着旧版本推断行为：同主体类型服务端原先走
       * `source ?? target`（engine.ts 的 INTERNAL_SAME_NODE_DOC_TYPES），残留 source 会
       * 静默吃掉用户这次选的 target 并照常返回成功单号 —— 那个「悄悄把货记到上一张单的
       * 主体上」的失败模式**已经不存在**：`createInventoryCoreDoc` 的端点校验段现在对
       * 「同主体类型两端不一致」（AC4）与「非法端点给了非空值」（AC5）一律硬拒单。
       * 代价于是换成了另一种：用户对着一张看起来是空的表单，收到
       * 「…不接受入库主体」/「该单据的出库主体与入库主体必须是同一个」这类对不上号的报错。
       * 静默记错主体和突兀报错都不该给用户，清场是同一个解 ——
       * 换单据类型那条路径同理，清在上面 docType 的 onChange（#200 S6-b）。
       * 日期同理：不重置的话下一张单会沿用上次补录的历史日期。
       *
       * 注：**单候选环境**（市场角色只管一个市场、门店角色只管一家店）下，主体清空后
       * 会被 `InventorySubjectSelect` 立刻填回那个唯一候选 —— 这是预期，不是没清掉。
       * 那种环境里一张单也只可能是它，上面说的残留风险根本无从发生。
       */
      setItems([defaultItem()])
      setRemark('')
      setSourceOrgNodeId('')
      setTargetOrgNodeId('')
      setDocDate(shanghaiToday())
      /*
       * 批次可用量刚被自己这一单改掉，缓存里的数字立刻就是旧的。
       * 推代次 + 清掉已完成条目，下一张单的批次下拉会重新取数 ——
       * 否则第二行选同一个 SKU 时显示的还是扣减前的可用量，提交必被服务端拒掉，
       * 而用户看到的是「界面写着有货、提交说没货」。
       */
      for (const [key, entry] of lotCacheRef.current) {
        if (entry.settled) lotCacheRef.current.delete(key)
      }
      setLotEpoch((n) => n + 1)
      onSuccess(result.id)
    } catch (err) {
      toast.error(docActionErrorMessage(err, '创建单据失败'))
      /*
       * 失败也要推代次。最常见的失败就是「别人并发扣了库存」，服务端回的是
       * 「可用 5」，而批次下拉里还写着「可用 30」—— 用户对着自相矛盾的数字反复盲试。
       * 办理台的 visible 恒 true，不在这里刷新的话它**没有任何**重取入口
       * （单据中心至少还能关弹窗再开）。
       */
      for (const [key, entry] of lotCacheRef.current) {
        if (entry.settled) lotCacheRef.current.delete(key)
      }
      setLotEpoch((n) => n + 1)
      // 状态/权限已变化时刷新列表给出路，但**不关闭表单** —— 里面是用户敲进去的内容，
      // 关掉就全没了；动作弹窗只有一个备注框，关掉代价小，两者取舍不同。
      if (isStaleStateError(err)) onStale()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-4">
      {/*
        * 四个字段都带可见 label。主体字段**必须**有 —— `InventorySubjectSelect` 在
        * 候选唯一时会降级成只读 `<output>`，占位文案（「出库/发起主体」「入库/接收主体」）
        * 随之消失，两个字段会显示成一模一样的「市场 · 某某」，用户和读屏都分不清谁是谁。
        * `<output>` 是 labelable element，外层 `<label>` 能正确关联上去。
        */}
      <div className="grid grid-cols-4 gap-3">
        <FieldLabel text="单据类型">
          <Select
            value={docType}
            disabled={isDocTypeLocked}
            onChange={(e) => {
              setDocType(e.target.value as InventoryDocType)
              /*
               * 换类型必须清两端主体与各行批次（#200 S6-b）：新类型的合法端点可能不同。
               * 不清的话，先选「院产品报损」填了出库主体、再切「院顾客退货」，
               * 用户对着一个看起来空的表单收到「只能指定入库主体」。
               * 批次同理：批次是按出库主体的库位取的，主体一清旧 lotId 就不属于这张单了。
               *
               * ⚠️ 用 onChange 而不是 `useEffect([docType])` —— 这条链路有过 useEffect
               * 自循环把批次下拉卡死的 P0（#129，见 DocLotSelect 的注释），不再往里加 effect。
               */
              setSourceOrgNodeId('')
              setTargetOrgNodeId('')
              setItems((prev) => (prev.some((item) => item.lotId) ? prev.map((item) => ({ ...item, lotId: '' })) : prev))
            }}
          >
            {availableDocTypes.map((type) => (
              <option key={type} value={type}>{type}</option>
            ))}
          </Select>
        </FieldLabel>
        <FieldLabel text="单据日期">
          <DatePicker value={docDate} onValueChange={setDocDate} aria-label="单据日期" />
        </FieldLabel>
        <FieldLabel text="出库/发起主体">
          <InventorySubjectSelect
            options={sourceOptions}
            value={sourceOrgNodeId}
            placeholder="出库/发起主体"
            // 只禁非法端点：入库类（院顾客退货）没有出库主体这一说（#200 S6-c）
            disabled={endpointMode === 'target-only'}
            onChange={(value) => {
              setSourceOrgNodeId(value)
              // same-node：两端指同一个主体，服务端两端不一致直接拒单（#200 AC4）。
              // 镜像而不是把 target 禁掉 —— 既有 e2e（inv-02 / inv-06）会直接操作 target 下拉。
              if (endpointMode === 'same-node') setTargetOrgNodeId(value)
              // 市场间调货：发起市场改成了当前的接收市场，接收端就不再合法（它已从候选里被排除），
              // 清掉让用户重选，别留一个「当前主体（不在可选范围）」的自己调给自己。
              if (isMarketTransfer && value && value === targetOrgNodeId) setTargetOrgNodeId('')
              // 换主体必须清批次：批次是按 (库位, SKU) 取的，换了库位旧的 lotId 就不属于这张单了。
              // 自动选中（唯一候选）同样走这条 onChange，联动不会被绕过。
              // 条件重建：mount 自动选中与清场后回填时 lotId 本就是空的，没必要多一次渲染。
              setItems((prev) => (prev.some((item) => item.lotId) ? prev.map((item) => ({ ...item, lotId: '' })) : prev))
            }}
          />
        </FieldLabel>
        <FieldLabel text="入库/接收主体">
          <InventorySubjectSelect
            options={targetOptions}
            value={targetOrgNodeId}
            placeholder="入库/接收主体"
            /*
             * 市场间调货：发起端未落定前接收端不自动选中。两端的唯一候选自动选中在同一次提交里
             * 各自回调，此刻 targetOptions 还没排除发起市场 —— 全局只有一个启用市场时两端会被
             * 同时填成它（自己调给自己，服务端必拒）。等发起端落定、候选按它收窄后再自动带出。
             */
            autoSelect={!isMarketTransfer || Boolean(sourceOrgNodeId)}
            // 只禁非法端点：纯出库类没有入库主体这一说（#200 S6-d）。#350 起通用类型里已无此类
            // （院顾客产品出库改由提货服务产生），保留分支与服务端按 locationRole 推导的单边规则同构
            disabled={endpointMode === 'source-only'}
            onChange={(value) => {
              // 与发起端的清空逻辑对称：市场间调货不接受「接收市场 = 发起市场」
              if (isMarketTransfer && value && value === sourceOrgNodeId) return
              setTargetOrgNodeId(value)
              if (endpointMode === 'same-node') {
                // 同主体类型下 target 也决定了 source，而批次是按 source 的库位取的，一并清
                setSourceOrgNodeId(value)
                setItems((prev) => (prev.some((item) => item.lotId) ? prev.map((item) => ({ ...item, lotId: '' })) : prev))
              }
            }}
          />
        </FieldLabel>
      </div>
      <Textarea placeholder="备注" value={remark} onChange={(e) => setRemark(e.target.value)} />

      <div className="space-y-2">
        {items.map((item, index) => (
          <div
            key={index}
            className={`${requiresSourceLot ? 'grid-cols-7' : 'grid-cols-6'} grid gap-2 rounded-md border border-[var(--border)] p-2`}
          >
            {requiresSourceLot && (
              <DocLotSelect
                locationId={sourceLocationId}
                skuId={item.skuId}
                value={item.lotId}
                onChange={(lotId) => updateItem(index, { lotId })}
                cache={lotCacheRef.current}
                epoch={lotEpoch}
                active={visible}
                label={`明细 ${index + 1} 来源批次`}
              />
            )}
            <InventorySkuSearchSelect
              value={item.skuId}
              onChange={(skuId) => updateItem(index, { skuId, lotId: '' })}
              placeholder="库存 SKU"
              ariaLabel={`明细 ${index + 1} 库存 SKU`}
            />
            <Input placeholder="批号" value={item.batchNo} onChange={(e) => updateItem(index, { batchNo: e.target.value })} />
            <DatePicker value={item.expiryDate} onValueChange={(value) => updateItem(index, { expiryDate: value })} aria-label={`明细 ${index + 1} 效期`} />
            <Input type="number" min="0" step="0.01" max="9999999999.99" placeholder="数量" value={item.quantity} onChange={(e) => updateItem(index, { quantity: e.target.value })} />
            <Input placeholder="原因" value={item.reason} onChange={(e) => updateItem(index, { reason: e.target.value })} />
            <Button
              variant="outline"
              onClick={() => setItems((prev) => prev.length === 1 ? prev : prev.filter((_, i) => i !== index))}
            >
              删除
            </Button>
          </div>
        ))}
        <Button variant="outline" onClick={() => setItems((prev) => [...prev, defaultItem()])}>
          添加明细
        </Button>
      </div>

      {renderActions({ submit: () => { void submit() }, submitting })}
    </div>
  )
}

/**
 * 来源批次下拉：每行一个实例、自带 state，按 (locationId, skuId) 拉取，取数走表单级 Promise 缓存。
 *
 * ⚠️ 依赖数组只能放**真实输入**（locationId / skuId / 显式的重试计数），
 * 绝不能放这个 effect 自己 set 的 state。曾经的写法是父层共享 `lotOptionsByKey` /
 * `loadingLotKeys` 两个 Record 再把它们塞进依赖数组：setState → re-render → 依赖变 →
 * effect 重跑 → cleanup 把上一轮 `cancelled` 置 true → 首次请求的 then/catch/finally
 * 全被跳过 → loading 永远停在 true → 下拉永久 disabled，6 种需选来源批次的单据
 * 全部建不出来（#129）。
 * （`retryToken` 虽然也是本组件的 state，但它只在 onFocus 里 set、不在 effect 体内 set，
 *   不构成自触发环 —— 区别就在这里。）
 */
function DocLotSelect({
  locationId,
  skuId,
  value,
  onChange,
  cache,
  epoch,
  active,
  label,
}: {
  locationId: string
  skuId: string
  value: string
  onChange: (lotId: string) => void
  /** 表单级 (库位,SKU) → Promise 缓存，见 InventoryDocCreateForm 的 lotCacheRef */
  cache: LotCache
  /** 缓存代次，表单转为不可见时递增，用来强制下次可见时重新取数 */
  epoch: number
  /** 表单是否在用户眼前。不可见时绝不能取数（见 InventoryDocCreateForm 的 visible） */
  active: boolean
  label: string
}) {
  // 用 JSON 数组当 key，避免 ('a:b','c') 与 ('a','b:c') 这类分隔符歧义撞进同一个缓存槽。
  // 组件自己的新鲜度 key 含代次（换代即判定过期）；查缓存用的 key 不含代次（在途请求跨代可复用）。
  const cacheKey = locationId && skuId ? JSON.stringify([epoch, locationId, skuId]) : ''
  const requestKey = locationId && skuId ? JSON.stringify([locationId, skuId]) : ''
  const [retryToken, setRetryToken] = useState(0)
  const [loaded, setLoaded] = useState<LotLoadState | null>(null)

  useEffect(() => {
    if (!active || !cacheKey) return
    let cancelled = false
    let entry = cache.get(requestKey)
    // 已完成且属于旧代次 → 结果可能过期，淘汰重取（在途的不动，见 LotCache 注释）
    if (entry && entry.settled && entry.epoch !== epoch) {
      cache.delete(requestKey)
      entry = undefined
    }
    if (!entry) {
      const promise = listInventoryLotOptions(locationId, skuId).then((lots) => {
        // 契约异常（灰度不一致 / action 回归返回了非数组）必须走失败路径，
        // 不能吞成「正常的空列表」—— 那会和 #129 一样让用户误判为「没货」
        if (!Array.isArray(lots)) throw new Error('批次接口返回格式异常')
        return lots
      })
      entry = { promise, settled: false, epoch }
      cache.set(requestKey, entry)
      const created = entry
      void promise.then(
        () => { created.settled = true },
        () => { created.settled = true },
      )
    } else {
      // 在途条目被新代次接手：它落地后，同代次的其它明细行直接复用，不再多发一次
      entry.epoch = epoch
    }
    entry.promise
      .then((lots) => {
        if (!cancelled) setLoaded({ key: cacheKey, lots })
      })
      .catch((error) => {
        // 失败的 Promise 不能留在缓存里，否则重试会拿到同一个已 reject 的 Promise
        cache.delete(requestKey)
        // 失败必须让用户看见：静默吞掉会和「该批次真的没货」长得一模一样。
        // 多行共用同一个 key 时会各自 catch，用 cacheKey 当 toast id 去重，避免弹 N 条一样的。
        if (!cancelled) {
          setLoaded({ key: cacheKey, lots: [], failed: true })
          toast.error(actionErrorMessage(error, '加载可用批次失败'), { id: cacheKey })
        }
      })
    return () => {
      cancelled = true
    }
  }, [active, cacheKey, requestKey, epoch, locationId, skuId, cache, retryToken])

  const isCurrent = loaded?.key === cacheKey
  const lots = isCurrent ? loaded.lots : []
  const failed = isCurrent && loaded.failed === true
  const isLoadingLots = Boolean(cacheKey) && !isCurrent

  return (
    <Select
      aria-label={label}
      value={value}
      disabled={!locationId || !skuId || isLoadingLots}
      onChange={(e) => onChange(e.target.value)}
      onFocus={() => {
        // 失败态是唯一的重试入口：表单在不可见时不卸载（原生 <dialog> / keepMounted 面板），
        // 不给入口的话用户只能靠「切到别的 SKU 再切回来」猜出来。
        if (failed) {
          setLoaded(null)
          setRetryToken((n) => n + 1)
        }
      }}
    >
      <option value="">
        {!locationId
          ? '先选择出库主体'
          : !skuId
            ? '先选择库存 SKU'
            : isLoadingLots
              ? '加载库存批次...'
              : failed
                ? '批次加载失败，点此重试'
                : '选择库存批次'}
      </option>
      {lots.map((lot) => (
        <option key={lot.id} value={String(lot.id)}>
          {/*
            用 availableQuantity（在手 − 未完成预留）而不是 quantityOnHand：
            服务端扣减时校验的就是可用量，显示在手量会出现「界面写着可用 30、提交却报库存不足」
            的自相矛盾。接口本来就把这个字段算好返回了，之前只是没用上。
          */}
          {`${lot.batchNo || '无批号'} · 可用 ${lot.availableQuantity}${lot.expiryDate ? ` · ${formatDate(lot.expiryDate)}` : ''}`}
        </option>
      ))}
    </Select>
  )
}
