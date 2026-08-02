"use client"

import { Fragment, useState, useMemo, useCallback } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Pagination } from "@/components/ui/pagination"
import { useUrlFilters } from "@/lib/hooks/use-url-filters"
import type { OperationLog } from "@/lib/types"
import { formatDateTime as fmtDateTime } from "@/lib/utils"
import { RowDeleteMenu } from "@/components/delete-action"
import { deleteOperationLog } from "@/actions/logs"

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
  "order.delete": "删除订单",  // 含历史已作废单清理（detail.snapshot.auditReason=historical_void_cleanup 区分场景）
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
  // 品项一级分类
  "product_kind.update": "编辑品项一级分类",
  // 商城
  "mall_product_sku.update": "编辑商城规格", "mall_product_sku.delete": "移除商城规格",
  "mall_category.create": "创建商城分类", "mall_category.update": "编辑商城分类",
  "mall_category_group.update": "编辑商城分组",
  "bundle_group.create": "创建套餐分组", "bundle_group.update": "编辑套餐分组", "bundle_group.delete": "删除套餐分组",
  // 职位 / 标签
  "position.create": "创建职位", "position.update": "编辑职位",
  "skillTag.create": "创建技能标签", "skillTag.update": "编辑技能标签",
  // 员工端（staffApi）专有动作
  "order.confirmOffline": "确认线下收款", "order.createRefund": "发起退款",
  "order.approveRefund": "审批退款通过", "order.rejectRefund": "驳回退款",
  "order.createRepayment": "订单回款", "order.createConversion": "创建转换单",
  "order.createPickup": "家居产品提货", "order.createDeposit": "寄存单初始化",
  "order.approveDeposit": "审批寄存单通过", "order.rejectDeposit": "驳回寄存单",
  "service.confirm": "确认完成服务", "serviceCommission.save": "保存服务提成",
  "card.recharge": "充值卡开单", "card.createRefund": "发起充值卡退款",
  "card.approveRefund": "审批充值卡退款", "card.rejectRefund": "驳回充值卡退款",
  "customer.updateNotes": "编辑顾客备注", "customer.assign": "分配顾客",
  "customer.memberLevelChange": "会员等级变更",
}

const targetTypeLabels: Record<string, string> = {
  employee: "员工",
  product: "商品",
  product_category: "品项分类",
  product_sku: "商品规格",
  sale_order: "订单",
  sale_allocation: "营业额分配（旧）",
  sale_payment_item_allocation: "营业额分配",
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
  mall_product_sku: "商城规格",
  mall_category: "商城分类",
  mall_bundle_group: "套餐分组",
  position: "职位",
  skill_tag: "技能标签",
  sale_order_payment: "收退款流水",
  sale_item: "订单商品行",
  service_commission: "服务提成",
}

/** 字段名 → 中文标签 */
const fieldLabels: Record<string, string> = {
  // 通用
  name: "名称", phone: "电话", description: "描述", sortOrder: "排序",
  isValid: "是否有效", isActive: "是否启用", isEnabled: "是否启用",
  isVisible: "是否可见", isClosed: "是否关闭", isResigned: "是否离职",
  isBundle: "是否套餐", createdAt: "创建时间", updatedAt: "更新时间",
  // 门店
  storeName: "门店名称", orgNodeId: "组织节点", openingDate: "开业日期",
  bedCount: "床位数", coverImage: "封面图", images: "门店图片",
  district: "区域", streetAddress: "街道地址", latitude: "纬度", longitude: "经度",
  businessHours: "营业时间", announcement: "公告", parkingInfo: "停车信息",
  // 员工
  gender: "性别", idCard: "身份证", storeId: "门店",
  positionName: "职位", birthday: "生日", skills: "技能标签",
  // 组织
  type: "类型", parentId: "上级节点", isActive_org: "是否启用",
  // 商品
  categoryName: "分类名称", productKind: "品项一级分类", salesCategory: "销售分类",
  categoryId: "分类", specName: "规格名称", price: "价格",
  specialPrice: "特惠价", sessionCount: "次数", serviceFee: "服务费",
  isShengmei: "是否生美", marketScope: "市场范围", productType: "商品类型",
  detailImages: "详情图", manageScope: "管理范围",
  // 套餐分组
  groupName: "分组名称", pickCount: "可选数量",
  bundlePrice: "套餐价", bundleGroupId: "所属分组",
  // 优惠券
  discountType: "优惠类型", discountValue: "优惠值", minSpend: "最低消费",
  totalCount: "总量限制", validFrom: "有效开始", validTo: "有效截止",
  // 提成
  orgId: "组织", orderType: "订单类型", roleType: "角色类型",
  amountTierMin: "金额下限", amountTierMax: "金额上限",
  commissionRate: "提成比例", commissionType: "提成类型",
  // 顾客
  memberLevel: "会员等级", skinType: "肤质", notes: "备注",
  boundStoreId: "绑定门店", boundEmployeeId: "绑定美容师",
  // 系统配置
  newMemberThreshold: "新客阈值", orderTimeout: "订单超时",
  bannerImages: "轮播图", fengyuguanImage: "凤御馆图",
  // 状态流转 context
  customerName: "顾客", totalAmount: "金额", clientName: "顾客",
  employeeName: "美容师", appointmentTime: "预约时间",
  fromStoreId: "原门店", userId: "用户", reason: "原因",
}

/** 格式化单个值用于展示 */
function formatValue(val: unknown): string {
  if (val === null || val === undefined) return "—"
  if (typeof val === "boolean") return val ? "是" : "否"
  if (Array.isArray(val)) return val.length === 0 ? "-" : val.join(", ")
  if (typeof val === "string" && /^\d{4}-\d{2}-\d{2}T/.test(val)) {
    return fmtDateTime(val)
  }
  return String(val)
}

/** 生成日志摘要（显示在表格详情列，无需展开） */
function getDetailSummary(detail: Record<string, unknown>): string | null {
  if (detail._v === 2 && detail._t === "update") {
    const changes = detail.changes as Record<string, { from: unknown; to: unknown }> | undefined
    if (!changes) return null
    const keys = Object.keys(changes)
    const labels = keys.map((k) => fieldLabels[k] || k)
    return `修改了${labels.join("、")}`
  }
  if (detail._v === 2 && detail._t === "transition") {
    return `${detail.from} \u2192 ${detail.to}`
  }
  return null
}

/** 渲染结构化日志详情 */
function LogDetail({ detail }: { detail: Record<string, unknown> }) {
  // v2 update — 变更对比表
  if (detail._v === 2 && detail._t === "update") {
    const changes = detail.changes as Record<string, { from: unknown; to: unknown }> | undefined
    if (!changes) return <span className="text-[#999999] text-xs">无变更</span>
    return (
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-[#999999]">
            <th className="pr-4 py-1 font-medium">字段</th>
            <th className="pr-4 py-1 font-medium">修改前</th>
            <th className="py-1 font-medium">修改后</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(changes).map(([field, { from, to }]) => (
            <tr key={field} className="border-t border-gray-100">
              <td className="pr-4 py-1 text-[#666666] font-medium whitespace-nowrap">
                {fieldLabels[field] || field}
              </td>
              <td className="pr-4 py-1 text-red-600/70 break-all max-w-[200px]">
                {formatValue(from)}
              </td>
              <td className="py-1 text-green-700/80 break-all max-w-[200px]">
                {formatValue(to)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    )
  }

  // v2 transition — 状态流转
  if (detail._v === 2 && detail._t === "transition") {
    const ctx = detail.context as Record<string, unknown> | undefined
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-sm">
          <span className="px-2 py-0.5 rounded text-xs font-medium bg-[#D4820A]/10 text-[#D4820A]">
            {String(detail.from)}
          </span>
          <span className="text-[#999999]">&rarr;</span>
          <span className="px-2 py-0.5 rounded text-xs font-medium bg-[#3D8A5A]/10 text-[#3D8A5A]">
            {String(detail.to)}
          </span>
        </div>
        {ctx && Object.keys(ctx).length > 0 && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[#666666]">
            {Object.entries(ctx).map(([k, v]) => (
              v != null && <span key={k}>{fieldLabels[k] || k}: {formatValue(v)}</span>
            ))}
          </div>
        )}
      </div>
    )
  }

  // legacy — 原始 JSON
  return (
    <pre className="text-xs font-mono text-[#666666] whitespace-pre-wrap overflow-x-auto">
      {JSON.stringify(detail, null, 2)}
    </pre>
  )
}

function formatDateTime(dt: string | null | undefined) {
  if (!dt) return "—"
  return fmtDateTime(dt)
}

interface Props {
  logs: OperationLog[]
  total: number
  /** 是否展示行内删除入口（仅系统管理员 operation_log:delete） */
  canDelete?: boolean
}

export default function LogsPage({ logs, total, canDelete = false }: Props) {
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
    return Array.from(new Set([...Object.keys(actionLabels), ...logs.map((l) => l.action)])).sort()
  }, [logs])

  const uniqueTargetTypes = useMemo(() => {
    return Array.from(new Set([...Object.keys(targetTypeLabels), ...logs.map((l) => l.targetType)])).sort()
  }, [logs])

  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const safePage = Math.min(currentPage, totalPages)

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
                  {canDelete && <th className="px-4 py-3 text-left font-medium text-gray-500">操作</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {logs.map((log) => (
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
                        {log.detail && (() => {
                          const summary = getDetailSummary(log.detail)
                          return (
                            <div className="flex items-center gap-2">
                              {summary && <span className="text-xs text-[#666666]">{summary}</span>}
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setExpandedId(expandedId === log.id ? null : log.id)}
                                className="text-xs shrink-0"
                              >
                                {expandedId === log.id ? "收起" : "展开"}
                              </Button>
                            </div>
                          )
                        })()}
                      </td>
                      {canDelete && (
                        <td className="px-4 py-3">
                          <RowDeleteMenu
                            entityLabel="日志"
                            onConfirm={() => deleteOperationLog(log.id)}
                            description={<>确定要删除该条操作日志吗？此操作不可恢复。</>}
                          />
                        </td>
                      )}
                    </tr>
                    {expandedId === log.id && log.detail && (
                      <tr>
                        <td colSpan={canDelete ? 6 : 5} className="px-4 py-3 bg-gray-50">
                          <LogDetail detail={log.detail} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
                {logs.length === 0 && (
                  <tr>
                    <td colSpan={canDelete ? 6 : 5} className="px-4 py-12 text-center text-[#999999]">
                      暂无日志数据
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Pagination
        total={total}
        pageSize={pageSize}
        page={safePage}
        onPageChange={(p) => set("page", p === 1 ? "" : String(p))}
        pageSizeOptions={PAGE_SIZE_OPTIONS}
        onPageSizeChange={(size) => setMany({ size: String(size), page: '' })}
      />
    </div>
  )
}
