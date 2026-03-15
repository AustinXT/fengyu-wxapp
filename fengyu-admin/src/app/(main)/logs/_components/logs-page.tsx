"use client"

import { Fragment, useState, useMemo, useCallback } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Pagination } from "@/components/ui/pagination"
import { useUrlFilters } from "@/lib/hooks/use-url-filters"
import type { OperationLog } from "@/lib/types"

const PAGE_SIZE_OPTIONS = [20, 50, 100]

const actionLabels: Record<string, string> = {
  // 组织
  "org.create": "创建组织节点", "org.update": "编辑组织节点", "org.delete": "停用组织节点",
  // 门店
  "store.create": "创建门店", "store.update": "编辑门店",
  // 员工
  "employee.create": "创建员工", "employee.update": "编辑员工",
  // 商品
  "product.create": "创建商品", "product.update": "编辑商品",
  "category.create": "创建分类", "category.update": "编辑分类",
  "sku.create": "创建规格", "sku.update": "编辑规格", "sku.delete": "删除规格",
  // 订单
  "order.create": "创建订单", "order.confirmPayment": "确认收款",
  "order.close": "关闭订单", "order.resetFailed": "重置支付失败",
  // 分配
  "allocation.save": "保存分配", "allocation.delete": "删除分配", "allocation.batchSave": "批量保存分配",
  // 服务
  "service.create": "创建服务单", "service.start": "开始服务",
  "service.complete": "完成服务", "service.cancel": "取消服务",
  // 预约
  "appointment.confirm": "确认预约", "appointment.checkin": "预约签到", "appointment.cancel": "取消预约",
  // 权限
  "permission.assign": "分配角色", "permission.revoke": "撤销角色",
  // 顾客
  "customer.create": "创建顾客", "customer.update": "编辑顾客档案",
  // 优惠券
  "coupon.create": "创建优惠券", "coupon.update": "编辑优惠券",
  "coupon.启用": "启用优惠券", "coupon.停用": "停用优惠券",
  // 提成
  "commission.create": "创建提成规则", "commission.update": "编辑提成规则", "commission.delete": "删除提成规则",
  // 解绑
  "store_unbind.approve": "通过解绑申请", "store_unbind.reject": "拒绝解绑申请",
  // 同步
  "sync.full": "全量同步", "sync.incremental": "增量同步",
  // 系统
  "system.saveConfig": "保存系统配置",
}

const targetTypeLabels: Record<string, string> = {
  employee: "员工",
  product: "商品",
  product_category: "品项分类",
  product_sku: "商品规格",
  sale_order: "订单",
  sale_allocation: "营业额分配",
  service_order: "服务单",
  appointment: "预约",
  permission_role: "权限角色",
  customer: "顾客",
  coupon_template: "优惠券模板",
  commission_rate: "提成规则",
  org_node: "组织节点",
  store: "门店",
  store_unbind_request: "解绑申请",
  sync: "数据同步",
  system_config: "系统配置",
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
  const { get, set, setMany } = useUrlFilters()

  /** 筛选变更时重置到第 1 页 */
  const setFilter = useCallback((key: string, value: string) => {
    setMany({ [key]: value, page: '' })
  }, [setMany])

  // 搜索框防抖：本地 state 即时响应，URL 延迟更新
  const [searchInput, setSearchInput] = useState(get("q"))
  const debounceRef = useState<ReturnType<typeof setTimeout> | null>(null)

  const handleSearchChange = useCallback((value: string) => {
    setSearchInput(value)
    if (debounceRef[0]) clearTimeout(debounceRef[0])
    debounceRef[0] = setTimeout(() => setFilter("q", value), 300)
  }, [setFilter, debounceRef])

  const operatorSearch = get("q")
  const actionFilter = get("action")
  const targetTypeFilter = get("target")
  const dateFrom = get("from")
  const dateTo = get("to")
  const currentPage = Math.max(1, Number(get("page", "1")) || 1)
  const pageSize = PAGE_SIZE_OPTIONS.includes(Number(get("size"))) ? Number(get("size")) : 20
  const [expandedId, setExpandedId] = useState<number | null>(null)

  const uniqueActions = useMemo(() => {
    return Array.from(new Set(logs.map((l) => l.action)))
  }, [logs])

  const uniqueTargetTypes = useMemo(() => {
    return Array.from(new Set(logs.map((l) => l.targetType)))
  }, [logs])

  const filtered = useMemo(() => {
    return logs.filter((log) => {
      if (operatorSearch) {
        const q = operatorSearch.toLowerCase()
        if (
          !log.operatorName.toLowerCase().includes(q) &&
          !log.operatorEmployeeId.toLowerCase().includes(q)
        )
          return false
      }
      if (actionFilter && log.action !== actionFilter) return false
      if (targetTypeFilter && log.targetType !== targetTypeFilter) return false
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
    // 服务端已按 desc(createdAt) 排序，无需客户端重排
  }, [operatorSearch, actionFilter, targetTypeFilter, dateFrom, dateTo, logs])

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const safePage = Math.min(currentPage, totalPages)
  const paged = filtered.slice((safePage - 1) * pageSize, safePage * pageSize)

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
              value={searchInput}
              onChange={(e) => handleSearchChange(e.target.value)}
            />
            <Select className="w-44" value={actionFilter} onChange={(e) => setFilter("action", e.target.value)}>
              <option value="">全部操作类型</option>
              {uniqueActions.map((a) => (
                <option key={a} value={a}>{actionLabels[a] || a}</option>
              ))}
            </Select>
            <Select className="w-40" value={targetTypeFilter} onChange={(e) => setFilter("target", e.target.value)}>
              <option value="">全部目标类型</option>
              {uniqueTargetTypes.map((t) => (
                <option key={t} value={t}>{targetTypeLabels[t] || t}</option>
              ))}
            </Select>
            <div className="flex items-center gap-2">
              <Input
                type="date"
                className="w-40"
                value={dateFrom}
                onChange={(e) => setFilter("from", e.target.value)}
              />
              <span className="text-[#999999]">-</span>
              <Input
                type="date"
                className="w-40"
                value={dateTo}
                onChange={(e) => setFilter("to", e.target.value)}
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
                {paged.map((log) => (
                  <Fragment key={log.id}>
                    <tr className="hover:bg-[#FFF0EE] transition-colors">
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
                      <tr>
                        <td colSpan={5} className="px-4 py-3 bg-gray-50">
                          <pre className="text-xs font-mono text-[#666666] whitespace-pre-wrap overflow-x-auto">
                            {JSON.stringify(log.detail, null, 2)}
                          </pre>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
                {paged.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-12 text-center text-[#999999]">
                      {filtered.length === 0 ? "暂无日志数据" : "未找到匹配结果，请调整筛选条件"}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Pagination
        total={filtered.length}
        pageSize={pageSize}
        page={safePage}
        onPageChange={(p) => set("page", p === 1 ? "" : String(p))}
        pageSizeOptions={PAGE_SIZE_OPTIONS}
        onPageSizeChange={(size) => setMany({ size: String(size), page: '' })}
      />
    </div>
  )
}
