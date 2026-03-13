"use client"

import { useState } from "react"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"

const syncModules = [
  { module: "组织架构", added: 0, updated: 2, skipped: 14, failed: 0 },
  { module: "门店信息", added: 0, updated: 1, skipped: 3, failed: 0 },
  { module: "员工档案", added: 1, updated: 3, skipped: 6, failed: 0 },
  { module: "顾客档案", added: 2, updated: 5, skipped: 1, failed: 0 },
  { module: "提成比例", added: 0, updated: 0, skipped: 7, failed: 0 },
]

const syncHistory = [
  { id: 1, time: "2026-03-13 08:00:00", type: "全量同步", status: "成功", operator: "张明", duration: "12.3s" },
  { id: 2, time: "2026-03-12 08:00:00", type: "全量同步", status: "成功", operator: "系统", duration: "11.8s" },
  { id: 3, time: "2026-03-11 20:00:00", type: "增量同步", status: "成功", operator: "系统", duration: "3.2s" },
  { id: 4, time: "2026-03-11 08:00:00", type: "全量同步", status: "部分失败", operator: "系统", duration: "15.1s" },
  { id: 5, time: "2026-03-10 08:00:00", type: "全量同步", status: "成功", operator: "系统", duration: "10.5s" },
]

const syncStatusMap: Record<string, string> = {
  "成功": "border-[#3D8A5A] text-[#3D8A5A] bg-[#F0F9F2]",
  "部分失败": "border-[#D4820A] text-[#D4820A] bg-[#FFF8E6]",
  "失败": "border-[#D94040] text-[#D94040] bg-[#FFF0F0]",
  "同步中": "border-[#5E8BB3] text-[#5E8BB3] bg-[#F0F5FA]",
}

export default function SyncPage() {
  const [syncing, setSyncing] = useState(false)

  const handleSync = (type: string) => {
    setSyncing(true)
    setTimeout(() => {
      setSyncing(false)
      alert(`${type}完成（Mock）`)
    }, 2000)
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-[var(--foreground)]">数据同步</h1>

      {/* 同步控制面板 */}
      <Card>
        <CardContent className="p-6">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <div>
              <h3 className="text-sm font-semibold text-[var(--foreground)]">最近同步</h3>
              <p className="text-sm text-[#999999] mt-1">
                {syncHistory[0].time} ({syncHistory[0].type})
              </p>
              <Badge variant="outline" className={`mt-2 ${syncStatusMap[syncHistory[0].status]}`}>
                {syncHistory[0].status}
              </Badge>
            </div>
            <div className="flex gap-3">
              <Button
                onClick={() => handleSync("全量同步")}
                loading={syncing}
                disabled={syncing}
              >
                触发全量同步
              </Button>
              <Button
                variant="outline"
                onClick={() => handleSync("增量同步")}
                loading={syncing}
                disabled={syncing}
              >
                触发增量同步
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 同步结果 */}
      <Card>
        <CardHeader>
          <CardTitle>最近同步结果</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 sticky top-0">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">模块</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-500">新增</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-500">更新</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-500">跳过</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-500">失败</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {syncModules.map((m) => (
                  <tr key={m.module} className="hover:bg-[#FFF0EE] transition-colors">
                    <td className="px-4 py-3 font-medium">{m.module}</td>
                    <td className="px-4 py-3 text-right">
                      {m.added > 0 ? <span className="text-[#3D8A5A] font-medium">+{m.added}</span> : <span className="text-[#999999]">0</span>}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {m.updated > 0 ? <span className="text-[#5E8BB3] font-medium">{m.updated}</span> : <span className="text-[#999999]">0</span>}
                    </td>
                    <td className="px-4 py-3 text-right text-[#999999]">{m.skipped}</td>
                    <td className="px-4 py-3 text-right">
                      {m.failed > 0 ? <span className="text-[#D94040] font-medium">{m.failed}</span> : <span className="text-[#999999]">0</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-gray-50 font-medium">
                <tr>
                  <td className="px-4 py-3">合计</td>
                  <td className="px-4 py-3 text-right text-[#3D8A5A]">+{syncModules.reduce((s, m) => s + m.added, 0)}</td>
                  <td className="px-4 py-3 text-right text-[#5E8BB3]">{syncModules.reduce((s, m) => s + m.updated, 0)}</td>
                  <td className="px-4 py-3 text-right text-[#999999]">{syncModules.reduce((s, m) => s + m.skipped, 0)}</td>
                  <td className="px-4 py-3 text-right text-[#D94040]">{syncModules.reduce((s, m) => s + m.failed, 0)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* 同步历史 */}
      <Card>
        <CardHeader>
          <CardTitle>同步历史</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 sticky top-0">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">时间</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">类型</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">状态</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">触发人</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-500">耗时</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {syncHistory.map((h) => (
                  <tr key={h.id} className="hover:bg-[#FFF0EE] transition-colors">
                    <td className="px-4 py-3 text-[#999999]">{h.time}</td>
                    <td className="px-4 py-3">{h.type}</td>
                    <td className="px-4 py-3">
                      <Badge variant="outline" className={syncStatusMap[h.status] || ""}>
                        {h.status}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">{h.operator}</td>
                    <td className="px-4 py-3 text-right text-[#999999]">{h.duration}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
