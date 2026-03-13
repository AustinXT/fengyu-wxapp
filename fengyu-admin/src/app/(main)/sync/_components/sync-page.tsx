"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import type { SyncHistoryEntry } from "@/actions/sync"

const syncStatusMap: Record<string, string> = {
  "成功": "border-[#3D8A5A] text-[#3D8A5A] bg-[#F0F9F2]",
  "部分失败": "border-[#D4820A] text-[#D4820A] bg-[#FFF8E6]",
  "失败": "border-[#D94040] text-[#D94040] bg-[#FFF0F0]",
  "同步中": "border-[#5E8BB3] text-[#5E8BB3] bg-[#F0F5FA]",
}

export default function SyncPageClient({ history }: { history: SyncHistoryEntry[] }) {
  const [syncing, setSyncing] = useState(false)
  const router = useRouter()

  const handleSync = async (type: string) => {
    setSyncing(true)
    toast.info(`${type}已触发，同步功能需要连接 WorkFine 服务器`)
    // Sync requires WorkFine MSSQL connection, which is only available
    // through db/scripts/sync-workfine.js. The admin panel can trigger
    // it via a background process in production.
    setTimeout(() => {
      setSyncing(false)
      toast.warning(`${type}需通过服务器端脚本执行，请联系管理员运行 sync-workfine.js`)
      router.refresh()
    }, 1000)
  }

  const lastSync = history[0]

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-[var(--foreground)]">数据同步</h1>

      {/* 同步控制面板 */}
      <Card>
        <CardContent className="p-6">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <div>
              <h3 className="text-sm font-semibold text-[var(--foreground)]">最近同步</h3>
              {lastSync ? (
                <>
                  <p className="text-sm text-[#999999] mt-1">
                    {lastSync.time} ({lastSync.type})
                  </p>
                  <Badge variant="outline" className={`mt-2 ${syncStatusMap[lastSync.status] || ""}`}>
                    {lastSync.status}
                  </Badge>
                </>
              ) : (
                <p className="text-sm text-[#999999] mt-1">暂无同步记录</p>
              )}
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

      {/* 同步提示 */}
      <Card className="border-[#D4820A] bg-[#FFF8E6]">
        <CardContent className="p-4">
          <p className="text-sm text-[#D4820A]">
            数据同步功能依赖 WorkFine SQL Server 连接，需通过服务器端脚本 <code className="font-mono bg-white/50 px-1 rounded">db/scripts/sync-workfine.js</code> 执行。
            管理后台可查看同步历史记录。
          </p>
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
                {history.length > 0 ? history.map((h) => (
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
                )) : (
                  <tr>
                    <td colSpan={5} className="px-4 py-12 text-center text-[#999999]">暂无同步记录</td>
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
