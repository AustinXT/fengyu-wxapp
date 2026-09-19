'use client'

import { useEffect, useRef } from 'react'
import { Select } from '@/components/ui/select'

export interface InventorySubjectOption {
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
}: {
  options: InventorySubjectOption[]
  value: string
  onChange: (value: string) => void
  placeholder: string
  disabled?: boolean
}) {
  const sole = options.length === 1 ? options[0] : null
  const soleValue = sole?.value ?? null
  // 调用方传的几乎都是内联箭头函数（每次渲染新引用）。把它收进 ref，effect 的依赖
  // 就只剩两个基本类型，不会因为父组件重渲染而反复触发自动选中。
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    onChangeRef.current = onChange
  })

  useEffect(() => {
    // 只在「还没选」时补一次。选定来源单据后，表单的 useEffect 会把主体回填成单据
    // 自己的主体（采购订单 / 发货 / 入库 / 配货共 5 处），那是更权威的值；若这里
    // 无条件维持唯一候选，就会把随单锁定的主体悄悄改掉。
    if (soleValue !== null && !value) onChangeRef.current(soleValue)
  }, [soleValue, value])

  // 候选唯一但 value 是别的（随单回填了当前用户看不到的主体）时仍走下拉：
  // 此时只读文本会撒谎，下拉至少让操作人看得见值对不上。
  if (sole && (value === '' || value === sole.value)) {
    // 用 <output> 而不是 <div>：它是 labelable element，外层 FormField 的 <label>
    // 仍能把字段名关联上去（读屏会念「供应链库存主体 品牌总部」）。换成 div 的话
    // 这个 label 就变成「既没包裹控件也没有 for」的孤儿，a11y 与 UX 扫描都会挂。
    return (
      <output className="flex h-10 items-center text-sm" data-fixed-subject={sole.value}>
        {sole.label}
      </output>
    )
  }

  return (
    <Select value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled}>
      <option value="">{placeholder}</option>
      {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </Select>
  )
}
