"use client"

import { useState, useMemo } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import type { OperationLog } from "@/lib/types"

const actionLabels: Record<string, string> = {
  "employee.create": "创建员工",
  "product.create": "创建商品",
  "order.create": "创建订单",
  "order.confirmOffline": "确认线下收款",
  "allocation.save": "保存分配",
  "service.complete": "完成服务",
  "permission.assign": "分配权限",
  "sync.trigger": "触发同步",
}

const targetTypeLabels: Record<string, string> = {
  employee: "员工",
  product: "商品",
  sale_order: "订单",
  service_order: "服务单",
  permission_role: "权限",
  system: "系统",
}

function formatDateTime(dt: string) {
  return new Date(dt).toLocaleString("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  })
}

interface Props {
  logs: OperationLog[]
}

export default function LogsPage({ logs }: Props) {
  const [operatorSearch, setOperatorSearch] = useState("")
  const [actionFilter, setActionFilter] = useState("")
  const [dateFrom, setDateFrom] = useState("")
  const [dateTo, setDateTo] = useState("")
  const [expandedId, setExpandedId] = useState<number | null>(null)

  const uniqueActions = useMemo(() => {
    return Array.from(new Set(logs.map((l) => l.action)))
  }, [logs])

  const filtered = useMemo(() => {
    return logs
      .filter((log) => {
        if (operatorSearch) {
          const q = operatorSearch.toLowerCase()
          if (
            !log.operatorName.toLowerCase().includes(q) &&
            !log.operatorEmployeeId.toLowerCase().includes(q)
          )
            return false
        }
        if (actionFilter && log.action !== actionFilter) return false
        if (dateFrom) {
          const from = new Date(dateFrom)
          if (new Date(log.createdAt) < from) return false
        }
        if (dateTo) {
          const to = new Date(dateTo + "T23:59:59")
          if (new Date(log.createdAt) > to) return false
        }
        return true
      })
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  }, [operatorSearch, actionFilter, dateFrom, dateTo, logs])

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-[var(--foreground)]">操作日志</h1>

      {/* Filters */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap gap-3">
            <Input
              className="w-48"
              placeholder="搜索操作人"
              value={operatorSearch}
              onChange={(e) => setOperatorSearch(e.target.value)}
            />
            <Select className="w-44" value={actionFilter} onChange={(e) => setActionFilter(e.target.value)}>
              <option value="">全部操作类型</option>
              {uniqueActions.map((a) => (
                <option key={a} value={a}>{actionLabels[a] || a}</option>
              ))}
            </Select>
            <div className="flex items-center gap-2">
              <Input
                type="date"
                className="w-40"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
              />
              <span className="text-[#999999]">-</span>
              <Input
                type="date"
                className="w-40"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 sticky top-0">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">时间</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">操作人</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">操作</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">目标</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">详情</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {filtered.map((log) => (
                  <>
                    <tr key={log.id} className="hover:bg-[#FFF0EE] transition-colors">
                      <td className="px-4 py-3 text-[#999999] whitespace-nowrap">{formatDateTime(log.createdAt)}</td>
                      <td className="px-4 py-3">
                        <div>
                          <span className="font-medium">{log.operatorName}</span>
                          {log.operatorRole && (
                            <span className="text-[#999999] text-xs ml-1">({log.operatorRole})</span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 font-medium">{actionLabels[log.action] || log.action}</td>
                      <td className="px-4 py-3">
                        <span className="text-[#999999] text-xs">{targetTypeLabels[log.targetType] || log.targetType}</span>
                        <span className="ml-1 font-mono text-xs">{log.targetId}</span>
                      </td>
                      <td className="px-4 py-3">
                        {log.detail && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setExpandedId(expandedId === log.id ? null : log.id)}
                            className="text-xs"
                          >
                            {expandedId === log.id ? "收起" : "展开"}
                          </Button>
                        )}
                      </td>
                    </tr>
                    {expandedId === log.id && log.detail && (
                      <tr key={`${log.id}-detail`}>
                        <td colSpan={5} className="px-4 py-3 bg-gray-50">
                          <pre className="text-xs font-mono text-[#666666] whitespace-pre-wrap overflow-x-auto">
                            {JSON.stringify(log.detail, null, 2)}
                          </pre>
                        </td>
                      </tr>
                    )}
                  </>
                ))}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-12 text-center text-[#999999]">暂无日志数据</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
