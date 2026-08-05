'use client'

import { Fragment, useMemo, useState, useTransition } from 'react'
import { toast } from 'sonner'
import { useUnsavedChanges } from '@/lib/hooks/use-unsaved-changes'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { ROLE_LABELS, type RoleType } from '@/lib/types'
import { saveMatrix, resetMatrix, type PermissionMatrix } from '@/actions/permission-matrix'

interface Props {
  initialMatrix: PermissionMatrix
  allActions: string[]
}

const ROLES: RoleType[] = [
  'admin', 'manager', 'finance', 'hr', 'product', 'customer_mgr', 'staff',
]

/** action key 的中文分组：用前缀切片 → 中文段名，便于扫读 */
const PREFIX_GROUP_LABELS: Record<string, string> = {
  dashboard: '工作台',
  org: '组织架构',
  store: '门店',
  merchant: '商户管理',
  employee: '员工',
  product: '商品',
  commission: '提成',
  coupon: '优惠券',
  customer: '顾客',
  sale_order: '销售订单',
  sale_item: '销售明细',
  allocation: '营业额分配',
  service: '服务单',
  appointment: '预约',
  permission: '权限',
  operation_log: '操作日志',
  point_transaction: '积分流水',
  card_transaction: '充值卡流水',
  pickup_record: '提货记录',
  store_unbind: '门店解绑',
  data_center: '数据中心',
  message: '消息',
  system: '系统',
  admin: '管理员专属',
}

function groupOf(action: string): string {
  const prefix = action.split(':')[0]
  return PREFIX_GROUP_LABELS[prefix] ?? prefix
}

/** action 动词后缀 → 中文操作名 */
const VERB_LABELS: Record<string, string> = {
  list: '查看',
  view: '查看',
  create: '新增',
  update: '编辑',
  delete: '删除',
  save: '保存',
  send: '发送',
  approve: '通过',
  reject: '驳回',
  assign: '分配',
  revoke: '撤销',
  confirm: '确认',
  checkin: '到店核销',
  pull: '拉取',
  config: '配置',
  dashboard: '看板',
  deposit_approve: '审批寄存单',
  record_payment: '记录收款',
  refund_create: '发起退款',
  refund_approve: '审批退款',
  assign_admin: '分配管理员',
  reset_password: '重置密码',
  update_phone: '改手机号',
  update_amount: '改金额',
  lakala_config: '收款配置',
}

/** 权限键 → 中文译名（资源组·操作），如 sale_order:refund_create → 销售订单·发起退款。底层英文键不变。 */
function actionLabel(action: string): string {
  const [prefix, verb] = action.split(':')
  const group = PREFIX_GROUP_LABELS[prefix] ?? prefix
  return `${group}·${VERB_LABELS[verb] ?? verb}`
}

function actionKey(a: string, role: RoleType): string {
  return `${role}::${a}`
}

export default function PermissionMatrixPage({ initialMatrix, allActions }: Props) {
  const [matrix, setMatrix] = useState<PermissionMatrix>(initialMatrix)
  const [pending, startTransition] = useTransition()

  const initialJson = useMemo(() => JSON.stringify(initialMatrix), [initialMatrix])
  const currentJson = useMemo(() => JSON.stringify(matrix), [matrix])
  const dirty = initialJson !== currentJson
  useUnsavedChanges(dirty)

  /** 按 action 前缀分组渲染（提升可读性，51 行铺平太密集） */
  const groupedActions = useMemo(() => {
    const groups = new Map<string, string[]>()
    for (const a of allActions) {
      const g = groupOf(a)
      if (!groups.has(g)) groups.set(g, [])
      groups.get(g)!.push(a)
    }
    return Array.from(groups.entries())
  }, [allActions])

  function toggle(role: RoleType, action: string) {
    setMatrix((prev) => {
      const has = prev[role]?.includes(action) ?? false
      const next = has
        ? prev[role].filter((a) => a !== action)
        : [...(prev[role] ?? []), action].sort()
      return { ...prev, [role]: next }
    })
  }

  function setAllForRole(role: RoleType, on: boolean) {
    setMatrix((prev) => ({
      ...prev,
      [role]: on ? [...allActions].sort() : [],
    }))
  }

  function setAllForAction(action: string, on: boolean) {
    setMatrix((prev) => {
      const next = { ...prev }
      for (const role of ROLES) {
        const has = next[role]?.includes(action) ?? false
        if (on && !has) next[role] = [...(next[role] ?? []), action].sort()
        else if (!on && has) next[role] = next[role].filter((a) => a !== action)
      }
      return next
    })
  }

  function handleSave() {
    startTransition(async () => {
      try {
        const res = await saveMatrix(matrix)
        if (res.success) {
          toast.success(res.message)
          // 把 initial 同步到 current 以重置 dirty——避免再次提示离开
          window.location.reload()
        } else {
          toast.error(res.message)
        }
      } catch (e) {
        toast.error(e instanceof Error ? e.message : '保存失败')
      }
    })
  }

  function handleReset() {
    if (!window.confirm('确定重置为代码默认矩阵？\n所有自定义改动将丢失，重置后立即对全员生效。')) return
    startTransition(async () => {
      try {
        const res = await resetMatrix()
        if (res.success) {
          toast.success(res.message)
          window.location.reload()
        } else {
          toast.error(res.message)
        }
      } catch (e) {
        toast.error(e instanceof Error ? e.message : '重置失败')
      }
    })
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[var(--foreground)]">权限矩阵</h1>
          <p className="text-xs text-[#999999] mt-1">
            勾选某个角色拥有的权限项。保存后 30 秒内全员生效（新登录立即生效）。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={handleReset} disabled={pending}>
            重置默认
          </Button>
          <Button onClick={handleSave} loading={pending} disabled={!dirty}>
            保存
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>角色 × 权限项 真值表</span>
            <span className="text-xs font-normal text-[#999999]">
              共 {allActions.length} 个权限项 × {ROLES.length} 个角色
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-auto">
            <table className="w-full border-collapse text-sm">
              <thead className="sticky top-0 z-10 bg-[var(--background)]">
                <tr className="border-b border-[var(--border)]">
                  <th className="sticky left-0 z-20 bg-[var(--background)] px-3 py-2 text-left text-xs font-medium text-[#999999] min-w-[260px]">
                    权限项
                  </th>
                  {ROLES.map((role) => {
                    const total = matrix[role]?.length ?? 0
                    const allOn = total === allActions.length
                    return (
                      <th key={role} className="px-2 py-2 text-center font-medium min-w-[88px]">
                        <div className="flex flex-col items-center gap-0.5">
                          <span className="text-xs text-[var(--foreground)]">{ROLE_LABELS[role]}</span>
                          <span className="text-[10px] text-[#999999]">{role}</span>
                          <button
                            type="button"
                            className="text-[10px] text-[var(--primary)] hover:underline"
                            onClick={() => setAllForRole(role, !allOn)}
                          >
                            {allOn ? '全清' : `全选(${total})`}
                          </button>
                        </div>
                      </th>
                    )
                  })}
                </tr>
              </thead>
              <tbody>
                {groupedActions.map(([group, actions]) => (
                  <Fragment key={`grp-${group}`}>
                    <tr className="bg-[var(--muted)]/30">
                      <td className="sticky left-0 z-10 bg-[var(--muted)]/30 px-3 py-1.5 text-xs font-semibold text-[#666666]" colSpan={ROLES.length + 1}>
                        {group}
                        <span className="ml-2 text-[10px] text-[#999999]">({actions.length})</span>
                      </td>
                    </tr>
                    {actions.map((action) => {
                      const rowCount = ROLES.reduce(
                        (n, role) => n + (matrix[role]?.includes(action) ? 1 : 0),
                        0,
                      )
                      const allOn = rowCount === ROLES.length
                      return (
                        <tr key={action} className="border-b border-[var(--border)] hover:bg-[var(--accent)]/20">
                          <td className="sticky left-0 z-10 bg-[var(--background)] px-3 py-2 text-xs text-[var(--foreground)]">
                            <div className="flex items-center justify-between gap-2">
                              <span className="flex flex-col leading-tight">
                                <span>{actionLabel(action)}</span>
                                <span className="font-mono text-[10px] text-[#999999]">{action}</span>
                              </span>
                              <button
                                type="button"
                                className="text-[10px] text-[var(--primary)] hover:underline shrink-0"
                                onClick={() => setAllForAction(action, !allOn)}
                              >
                                {allOn ? '全清' : `全选(${rowCount})`}
                              </button>
                            </div>
                          </td>
                          {ROLES.map((role) => {
                            const checked = matrix[role]?.includes(action) ?? false
                            return (
                              <td key={actionKey(action, role)} className="px-2 py-2 text-center">
                                <input
                                  type="checkbox"
                                  className="h-4 w-4 cursor-pointer accent-[var(--primary)]"
                                  checked={checked}
                                  onChange={() => toggle(role, action)}
                                  aria-label={`${ROLE_LABELS[role]} - ${actionLabel(action)}`}
                                />
                              </td>
                            )
                          })}
                        </tr>
                      )
                    })}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>使用说明</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-xs text-[#999999]">
          <p>· 矩阵保存到 <code className="px-1 bg-[var(--muted)] rounded">system_configs.permission_matrix</code>（DB 单源），30 秒进程缓存。</p>
          <p>· admin 角色必须保留 <code className="px-1 bg-[var(--muted)] rounded">system:config</code> / <code className="px-1 bg-[var(--muted)] rounded">permission:assign_admin</code> / <code className="px-1 bg-[var(--muted)] rounded">admin:reset_password</code>，否则系统会拒绝保存（防自锁）。</p>
          <p>· 已登录用户的权限来自 JWT session 缓存：保存矩阵后让对方<strong className="text-[var(--foreground)]">退出重新登录</strong>立即生效；不登出最长 24 小时（JWT TTL）后随 cookie 过期自然重算。</p>
          <p>· "重置默认"会 DELETE DB 行 → 回退到代码常量 DEFAULT_PERMISSION_MATRIX。</p>
        </CardContent>
      </Card>
    </div>
  )
}
