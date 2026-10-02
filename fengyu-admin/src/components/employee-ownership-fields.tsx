"use client"

import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { OrgTreeSelect } from "@/components/ui/org-tree-select"
import { applyOrgNodeSelection, applyStoreSelection, type OwnershipFields } from "@/lib/utils"
import type { OrgNode, Store } from "@/lib/types"

/**
 * 员工的「所属组织 + 所属门店」这一对联动字段（#259）。
 *
 * ## 为什么单独抽成组件
 *
 * 这两个字段必须**双向联动**，否则合法操作会被服务端的归属自洽校验拒掉 ——
 * 生产两条脏数据（王芳、王小凤）正是「同市场内改门店、没动所属组织」造出来的。
 *
 * 联动口径本身已经是纯函数（`applyOrgNodeSelection` / `applyStoreSelection`，见 lib/utils），
 * 但**接线**（补丁有没有真的合并进表单状态）此前只能靠页面源码的正则守护去认，而 codex 谱系
 * 连着两轮给出了绕过：`void applyX(...)`（算了不用）、只保留单方向、以及
 * `{ ...prev, ...applyStoreSelection(...), orgNodeId: prev.orgNodeId }`（补丁被随后的属性覆盖）——
 * 正则全绿而真实页面重新提交不自洽的归属。
 *
 * 抽成组件后，`employee-ownership-fields.test.tsx` 能真的渲染它、真的触发两个 Select 的
 * onChange、断言**另一个字段的受控值**变成了什么。这是第三次走同一条路（前两次是两条递归 CTE
 * 与联动纯函数）：要提高保障等级就让它可测，而不是继续给正则加花样。
 *
 * 两个页面共用同一份实现，也顺带消掉了「只修一侧等于没修」这个反复出现的风险（#228 的教训）。
 */
export interface EmployeeOwnershipFieldsProps {
  value: OwnershipFields
  onChange: (patch: Partial<OwnershipFields>) => void
  orgNodes: OrgNode[]
  /** 全量门店：联动要按 `org_node_id` 反查门店，不能只看下拉里那几个 */
  stores: Store[]
  /** 门店下拉的可选项（页面按所属组织的市场过滤后的结果） */
  storeOptions: Store[]
  /**
   * 只读态要展示的文本。给了就渲染 disabled Input（员工详情页非编辑态），
   * 不给就渲染两个可编辑的 Select（新建页、详情页编辑态）。
   */
  readonlyView?: { orgPath: string; storeName: string }
}

export function EmployeeOwnershipFields({
  value,
  onChange,
  orgNodes,
  stores,
  storeOptions,
  readonlyView,
}: EmployeeOwnershipFieldsProps) {
  return (
    <>
      <div className="space-y-2">
        <label className="text-sm font-medium">所属组织</label>
        {readonlyView ? (
          <Input value={readonlyView.orgPath} disabled />
        ) : (
          <OrgTreeSelect
            orgNodes={orgNodes}
            value={value.orgNodeId}
            onChange={(id) => onChange(applyOrgNodeSelection(value, id, orgNodes, stores))}
            placeholder="请选择所属组织"
          />
        )}
      </div>
      <div className="space-y-2">
        <label className="text-sm font-medium" htmlFor="ownership-store">所属门店</label>
        {readonlyView ? (
          <Input value={readonlyView.storeName} disabled />
        ) : (
          <Select
            id="ownership-store"
            aria-label="所属门店"
            value={value.storeId}
            onChange={(e) => onChange(applyStoreSelection(value, e.target.value, orgNodes, stores))}
          >
            <option value="">请选择门店</option>
            {storeOptions.map((s) => (
              <option key={s.storeId} value={s.storeId}>
                {s.storeName}
              </option>
            ))}
          </Select>
        )}
      </div>
    </>
  )
}
