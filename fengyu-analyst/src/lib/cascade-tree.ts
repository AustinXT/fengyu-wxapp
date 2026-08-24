/**
 * 级联选择器（Cascader）的通用选项节点。
 * 供各看板的 getCascadeTree 函数与 FilterCascader 组件共用，
 * 保证「全量选项树」在服务端（lib）与客户端（组件）之间形态一致。
 */
export interface CascadeOption {
  value: string
  label: string
  children?: CascadeOption[]
}

/**
 * 按 (parent → child) 对分桶为两级 Cascader 选项树，统一按简体中文排序。
 * 入参 pairs 已由各 lib 自行清洗（去空串）。
 */
export function bucketCascadeOptions(pairs: Array<{ parent: string; child: string }>): CascadeOption[] {
  const grouped = new Map<string, Set<string>>()
  for (const { parent, child } of pairs) {
    if (!parent || !child) continue
    const set = grouped.get(parent) ?? new Set<string>()
    set.add(child)
    grouped.set(parent, set)
  }
  return Array.from(grouped.entries())
    .map(([value, childSet]) => ({
      value,
      label: value,
      children: Array.from(childSet)
        .sort((a, b) => a.localeCompare(b, "zh-Hans-CN"))
        .map((child) => ({ value: child, label: child })),
    }))
    .sort((a, b) => a.label.localeCompare(b.label, "zh-Hans-CN"))
}
