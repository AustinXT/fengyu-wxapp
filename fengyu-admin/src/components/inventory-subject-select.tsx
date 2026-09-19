'use client'

import { useEffect, useRef } from 'react'
import { Select } from '@/components/ui/select'

export interface InventorySubjectOption {
  /**
   * ⚠️ 两种 id 空间共用这一个字段，取哪种由**调用方**决定，组件不做校验：
   *   - `inventory_locations.location_id`（多数字段）
   *   - `org_nodes.id`（发货总部 / 退货主体 / 回库主体）
   *
   * 总部与市场两者同值（`engine.ts` 的同步 SQL 里 `location_id = org_nodes.id`），
   * **门店的 `location_id` 是 `store_id`，与 `org_node_id` 不同** —— 传错在只有总部 /
   * 市场的环境里测不出来，只有门店会炸。改调用点时务必对齐该表单 `submit()` 发给
   * server action 的字段。
   */
  value: string
  label: string
}

/**
 * 库存主体选择：候选唯一时自动选中，并把控件降级成只读文本（#189）。
 *
 * 判定按**候选数**而不是按「是不是总部」：`org_nodes` 并没有「总部唯一」的约束
 * （只有 `uq_org_nodes_parent_name`），硬编码根节点会在建第二个总部的那天悄悄
 * 选错主体。按候选数判定还顺带覆盖了「市场角色只管一个市场」「门店角色只管一家店」。
 *
 * 自动选中必须经 `onChange` 回传给表单，不能在这里自己存 state —— 各表单的
 * onChange 带着联动（报货门店要带出所属市场、员工购要按主体去拉员工列表、换主体
 * 要清空已选批次），绕过它等于把联动吞掉。
 */
export default function InventorySubjectSelect({
  options,
  value,
  onChange,
  placeholder,
  disabled = false,
  autoSelect = true,
}: {
  options: InventorySubjectOption[]
  value: string
  onChange: (value: string) => void
  placeholder: string
  disabled?: boolean
  /**
   * 值由**同表单的上游字段**联动决定时传 false（报货门店带出所属市场、退货主体带出
   * 回库主体）。这类字段不能自己补值：兄弟组件的 effect 在同一次 flush 里读到的是
   * 本轮渲染前的快照，补出来的值会反过来盖掉联动刚写进去的那个（后写胜出），
   * 而且在上游还没选时，只读文本展示的「唯一候选」根本不是最终会用的主体。
   */
  autoSelect?: boolean
}) {
  const sole = options.length === 1 ? options[0] : null
  // disabled 表达的是「此刻不接受改动」（如主体随单锁定），自动选中同样受它约束 ——
  // 否则单据没带主体时，会自动填一个并以只读形态呈现，看着像是单据带来的。
  const canAutoSelect = autoSelect && !disabled
  const soleValue = canAutoSelect ? (sole?.value ?? null) : null
  // 调用方传的几乎都是内联箭头函数（每次渲染新引用）。把它收进 ref，**下面那个**
  // 自动选中 effect 的依赖就只剩两个基本类型，不会因为父组件重渲染而反复触发。
  // （这个同步 ref 的 effect 本身没有依赖数组，每帧都跑 —— 它只赋值、不触发副作用。）
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    onChangeRef.current = onChange
  })

  // 记录已经上报过的候选。StrictMode（Next 15 默认开启）会把 effect 重放一遍，
  // 两次都闭包捕获同一个 `value=""`，光靠 `!value` 守卫拦不住第二次 —— 员工购那类
  // 带异步副作用的 onChange 会因此多打一发请求（请求序号只能丢弃旧结果，拦不住发出）。
  const reportedRef = useRef<string | null>(null)

  useEffect(() => {
    if (soleValue === null) {
      reportedRef.current = null
      return
    }
    // 值已落定就重新布防：下次值被清空（切到一张 target_org_node_id 为 null 的单据、
    // 或表单实例被复用）时还得再补一次。否则去重标记会一直挡着，而渲染仍走只读分支 ——
    // 用户看到一个写着主体名的只读字段，表单 state 其实是空的，一提交就说没选。
    if (value) {
      reportedRef.current = null
      return
    }
    // 只在「还没选」时补。选定来源单据后，表单的 useEffect 会把主体回填成单据自己的
    // 主体（采购订单 / 发货 / 入库 / 配货共 5 处），那是更权威的值；若这里无条件维持
    // 唯一候选，就会把随单锁定的主体悄悄改掉。
    if (reportedRef.current === soleValue) return
    reportedRef.current = soleValue
    onChangeRef.current(soleValue)
  }, [soleValue, value])

  // 只读展示的条件：值就是那个唯一候选，或者它马上会被自动填成唯一候选。
  // 反过来说，autoSelect=false 或 disabled 且值还空着时**不能**显示只读文本 ——
  // 那个值还没定，显示出来就是撒谎。
  if (sole && (value === sole.value || (canAutoSelect && !value))) {
    // 用 <output> 而不是 <div>：它是 labelable element，外层 FormField 的 <label>
    // 仍能把字段名关联上去（读屏会念「供应链库存主体 品牌总部」）。换成 div 的话
    // 这个 label 就变成「既没包裹控件也没有 for」的孤儿，a11y 与 UX 扫描都会挂。
    // leading-10 + h-10 与 ui/select 的 h-10 对齐，px-3 对齐它的内边距。
    // `data-fixed-subject` 只在**值真的落进表单 state 之后**才挂上去：它是测试与
    // UX 扫描判定「这个字段已定、无需选择」的唯一证据，若在自动上报落定前就渲染，
    // 把上报 effect 整个删掉，E2E 的 fixed 断言照样全绿（等于没守护）。
    const committed = value === sole.value
    return (
      <output
        className="block h-10 truncate px-3 text-sm leading-10"
        data-fixed-subject={committed ? sole.value : undefined}
        title={sole.label}
      >
        {sole.label}
      </output>
    )
  }

  // 值落在候选之外（随单回填了当前用户看不到的主体）时，给它补一个占位 option ——
  // 否则 select 的 selectedIndex 会是 -1，渲染成一个空白框，操作人既看不到单据带来的
  // 主体，也不知道为什么是空的。
  const outOfRangeValue = value && !options.some((option) => option.value === value) ? value : null

  return (
    <Select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      disabled={disabled || options.length === 0}
    >
      <option value="">{options.length === 0 ? '暂无可用主体' : placeholder}</option>
      {outOfRangeValue && (
        <option value={outOfRangeValue} title={outOfRangeValue}>当前主体（不在可选范围）</option>
      )}
      {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </Select>
  )
}
