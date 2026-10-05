'use client'
import { useEffect, useState, useTransition } from 'react'
import { getEmployeeRoleMigration, reviewEmployeeRoleMigration } from '@/actions/role-migrations'
import { Button } from '@/components/ui/button'
import { actionErrorMessage } from '@/lib/action-error'
import { toast } from 'sonner'

type Preview = Awaited<ReturnType<typeof getEmployeeRoleMigration>>
export default function EmployeeRoleMigration({ initialEmployeeId, canAssign, canRevoke }: { initialEmployeeId: string; canAssign: boolean; canRevoke: boolean }) {
  const [employeeId, setEmployeeId] = useState(initialEmployeeId)
  const [query, setQuery] = useState(initialEmployeeId)
  const [data, setData] = useState<Preview | null>(null)
  const [selected, setSelected] = useState<number[]>([])
  const [busy, start] = useTransition()
  const [version, setVersion] = useState(0)
  useEffect(() => {
    let disposed = false
    setData(null); setSelected([])
    if (query) getEmployeeRoleMigration(query).then(result => { if (!disposed) setData(result) })
      .catch(error => { if (!disposed) toast.error(actionErrorMessage(error, '查询失败')) })
    return () => { disposed = true }
  }, [query, version])
  const chosen = data?.roles.filter(r => selected.includes(r.id)) ?? []
  function submit(decision: 'migrate' | 'retain') {
    const target = chosen[0]?.target_scope_id
    if (!chosen.length || (decision === 'migrate' && !target)) return
    const events = new Set(chosen.map(r => data?.pending.find(p => p.binding_id === r.id)?.event_id))
    if (decision === 'retain' && (events.size !== 1 || events.has(undefined))) { toast.error('保留兼任只适用于同一调店待办'); return }
    const eventId = events.size === 1 && !events.has(undefined) ? [...events][0] : undefined
    const summary = chosen.map(r => `${r.role_name}：${r.scope_name} → ${r.target_store_name}${r.target_exists ? '（保留已有绑定，不新增；移除旧绑定）' : ''}`).join('\n')
    if (!window.confirm(decision === 'retain' ? '确认保留所选旧店绑定为兼任？' : `确认迁移以下角色？\n${summary}`)) return
    start(async () => {
      try {
        await reviewEmployeeRoleMigration({ employeeId: query, targetScopeId: target ?? null, eventId, decision,
          bindings: chosen.map(r => ({ id: r.id, role: r.role, scopeId: r.scope_id })) })
        toast.success(decision === 'retain' ? '已确认保留兼任' : '角色迁移完成'); setVersion(v => v + 1)
      } catch (error) { toast.error(actionErrorMessage(error, '操作失败，请重新预览')); setVersion(v => v + 1) }
    })
  }
  return <section className="rounded border p-4 space-y-3">
    <h2 className="font-medium">按员工复核角色绑定</h2>
    <form onSubmit={event => { event.preventDefault(); setQuery(employeeId.trim()); setVersion(v => v + 1) }} className="flex gap-2">
      <input aria-label="员工编号" value={employeeId} onChange={event => setEmployeeId(event.target.value)} className="border rounded px-2" placeholder="输入员工编号" />
      <Button type="submit" disabled={busy}>查询全部绑定</Button>
    </form>
    {data && <>
      <p className="text-sm">调店后的旧店绑定需人工复核，可保留兼任或迁移；不会自动修改授权。</p>
      {data.pending.length > 0 && <p className="text-amber-700">调店待办：{data.pending.length} 条绑定待复核，超过 3 天将告警。</p>}
      <table className="w-full text-sm"><thead><tr><th>选择</th><th>角色</th><th>旧范围</th><th>当前门店 / 迁移预览</th><th>复核状态</th></tr></thead><tbody>
        {data.roles.map(role => {
          const candidate = role.scope_type === '门店' && (data.pending.some(p => p.binding_id === role.id) || (role.target_scope_id && role.scope_id !== role.target_scope_id))
          return <tr key={role.id}><td><input type="checkbox" aria-label={`选择${role.role_name} ${role.scope_name}`} disabled={!candidate || !role.canReview || !canAssign || busy || data.resigned}
            checked={selected.includes(role.id)} onChange={event => setSelected(old => event.target.checked ? [...old, role.id] : old.filter(id => id !== role.id))} /></td>
            <td>{role.role_name}</td><td>{role.scope_name}</td><td>{role.target_store_name ?? '无当前门店'}{candidate && role.target_exists ? '（已有同角色：保留现有绑定，不新增）' : ''}</td>
            <td>{data.pending.some(p => p.binding_id === role.id) ? '调店遗留：待复核' : candidate ? '跨店绑定：可能兼任' : '当前绑定'}</td></tr>
        })}
      </tbody></table>
      {canAssign && <div className="flex gap-2"><Button disabled={busy || !chosen.length || !canRevoke || chosen.some(r => !r.target_scope_id || !r.canMigrate)} onClick={() => submit('migrate')}>预览并确认迁移</Button>
        <Button disabled={busy || !chosen.length} onClick={() => submit('retain')}>确认保留兼任</Button></div>}
    </>}
  </section>
}
