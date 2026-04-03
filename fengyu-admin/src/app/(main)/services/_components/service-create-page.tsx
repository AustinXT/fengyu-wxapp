"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import { toast } from "sonner"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { searchCustomerByPhone } from "@/actions/customers"
import { getAvailableSaleItems, createServiceOrder } from "@/actions/services"
import type { AvailableSaleItem } from "@/actions/services"
import type { Store, Employee, Customer } from "@/lib/types"

const steps = ["选择顾客", "选择项目", "确认提交"]

function StepIndicator({ current }: { current: number }) {
  return (
    <div className="flex items-center justify-center gap-2 mb-8">
      {steps.map((label, idx) => (
        <div key={label} className="flex items-center gap-2">
          <div className={`flex items-center justify-center h-8 w-8 rounded-full text-sm font-medium ${
            idx < current ? "bg-[#3D8A5A] text-white" :
            idx === current ? "bg-[var(--primary)] text-white" :
            "bg-gray-200 text-[#999999]"
          }`}>
            {idx < current ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
            ) : (
              idx + 1
            )}
          </div>
          <span className={`text-sm hidden sm:inline ${idx === current ? "text-[var(--foreground)] font-medium" : "text-[#999999]"}`}>
            {label}
          </span>
          {idx < steps.length - 1 && <div className="w-8 h-px bg-gray-300" />}
        </div>
      ))}
    </div>
  )
}

interface SelectedItem {
  saleItemId: string
  sessionUsed: number
}

export default function ServiceCreatePageClient({
  stores,
  employees,
}: {
  stores: Store[]
  employees: Employee[]
}) {
  const [step, setStep] = useState(0)

  // Step 1: Customer
  const [phone, setPhone] = useState("")
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchDone, setSearchDone] = useState(false)

  // Step 2: Items + Config
  const [availableItems, setAvailableItems] = useState<AvailableSaleItem[]>([])
  const [loadingItems, setLoadingItems] = useState(false)
  const [selectedItems, setSelectedItems] = useState<SelectedItem[]>([])
  const [selectedStoreId, setSelectedStoreId] = useState<string>(stores[0]?.storeId || "")
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string>("")
  const [serviceDate, setServiceDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [remark, setRemark] = useState("")

  // Step 3: Submit
  const [submitting, setSubmitting] = useState(false)
  const [createdServiceOrderId, setCreatedServiceOrderId] = useState("")

  // Store change → clear employee if not in new store
  useEffect(() => {
    if (selectedEmployeeId && selectedStoreId) {
      const emp = employees.find(e => e.employeeId === selectedEmployeeId)
      if (emp && emp.storeId !== selectedStoreId) {
        setSelectedEmployeeId("")
      }
    }
  }, [selectedStoreId, selectedEmployeeId, employees])

  const searchCustomer = async () => {
    if (!phone.trim() || !/^1\d{10}$/.test(phone.trim())) {
      toast.error("请输入正确的手机号")
      return
    }
    setSearching(true)
    setSearchDone(false)
    try {
      const result = await searchCustomerByPhone(phone.trim())
      setSelectedCustomer(result)
      setSearchDone(true)
      if (result) {
        if (result.boundStoreId && stores.some(s => s.storeId === result.boundStoreId)) {
          setSelectedStoreId(result.boundStoreId)
        }
        if (result.boundEmployeeId && employees.some(e => e.employeeId === result.boundEmployeeId && !e.isResigned)) {
          setSelectedEmployeeId(result.boundEmployeeId)
        }
      }
    } catch {
      toast.error("搜索失败，请稍后重试")
    } finally {
      setSearching(false)
    }
  }

  const goToStep2 = async () => {
    if (!selectedCustomer) return
    setLoadingItems(true)
    try {
      const items = await getAvailableSaleItems(selectedCustomer.userId)
      setAvailableItems(items)
      setSelectedItems([])
      setStep(1)
    } catch {
      toast.error("加载可用项目失败")
    } finally {
      setLoadingItems(false)
    }
  }

  const toggleItem = (saleItemId: string) => {
    setSelectedItems(prev => {
      const exists = prev.find(i => i.saleItemId === saleItemId)
      if (exists) return prev.filter(i => i.saleItemId !== saleItemId)
      return [...prev, { saleItemId, sessionUsed: 1 }]
    })
  }

  const updateSessionUsed = (saleItemId: string, value: number) => {
    const item = availableItems.find(i => i.saleItemId === saleItemId)
    const max = item?.remainingSessions ?? 1
    const clamped = Math.max(1, Math.min(value, max))
    setSelectedItems(prev =>
      prev.map(i => i.saleItemId === saleItemId ? { ...i, sessionUsed: clamped } : i)
    )
  }

  const isItemSelected = (saleItemId: string) =>
    selectedItems.some(i => i.saleItemId === saleItemId)

  const getSessionUsed = (saleItemId: string) =>
    selectedItems.find(i => i.saleItemId === saleItemId)?.sessionUsed ?? 1

  const filteredEmployees = employees.filter(
    e => !e.isResigned && (!selectedStoreId || e.storeId === selectedStoreId)
  )

  const canSubmit = selectedItems.length > 0 && selectedStoreId && selectedEmployeeId

  const handleSubmit = async () => {
    if (!selectedCustomer || !canSubmit) return
    setSubmitting(true)
    try {
      const store = stores.find(s => s.storeId === selectedStoreId)
      const res = await createServiceOrder({
        storeId: selectedStoreId,
        marketName: store?.marketName || "未知市场",
        clientUserId: selectedCustomer.userId,
        assignedEmployeeId: selectedEmployeeId,
        serviceDate,
        remark: remark.trim() || null,
        items: selectedItems.map(i => ({
          saleItemId: i.saleItemId,
          sessionUsed: i.sessionUsed,
        })),
      })
      if (res.success) {
        toast.success(res.message)
        setCreatedServiceOrderId(res.serviceOrderId || "")
        setStep(2)
      } else {
        toast.error(res.message)
      }
    } catch {
      toast.error("创建服务单失败，请稍后重试")
    } finally {
      setSubmitting(false)
    }
  }

  const resetForm = () => {
    setStep(0)
    setPhone("")
    setSelectedCustomer(null)
    setSearchDone(false)
    setAvailableItems([])
    setSelectedItems([])
    setRemark("")
    setCreatedServiceOrderId("")
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link href="/services" className="text-[#999999] hover:text-[var(--foreground)]">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6" /></svg>
        </Link>
        <h1 className="text-2xl font-bold text-[var(--foreground)]">新建服务单</h1>
      </div>

      <StepIndicator current={step} />

      {/* Step 1: 选择顾客 */}
      {step === 0 && (
        <Card>
          <CardContent className="p-6 space-y-4">
            <h2 className="text-base font-semibold">搜索顾客</h2>
            <div className="flex gap-2">
              <Input
                placeholder="输入手机号搜索"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && searchCustomer()}
                className="w-64"
              />
              <Button onClick={searchCustomer} loading={searching}>搜索</Button>
            </div>
            {selectedCustomer && (
              <Card className="bg-[#FAFAFA]">
                <CardContent className="p-4">
                  <div className="grid grid-cols-2 md:grid-cols-5 gap-4 text-sm">
                    <div>
                      <span className="text-[#999999]">姓名</span>
                      <p className="font-medium">{selectedCustomer.name || "-"}</p>
                    </div>
                    <div>
                      <span className="text-[#999999]">手机</span>
                      <p className="font-medium">{selectedCustomer.phone}</p>
                    </div>
                    <div>
                      <span className="text-[#999999]">会员等级</span>
                      <p className="font-medium">{selectedCustomer.memberLevel || "-"}</p>
                    </div>
                    <div>
                      <span className="text-[#999999]">绑定门店</span>
                      <p className="font-medium">{selectedCustomer.storeName || "-"}</p>
                    </div>
                    <div>
                      <span className="text-[#999999]">绑定美容师</span>
                      <p className="font-medium">{selectedCustomer.employeeName || "-"}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}
            {searchDone && !selectedCustomer && (
              <Card className="bg-[#FFF8E6] border-[#D4820A]">
                <CardContent className="p-4 text-sm">
                  <p className="text-[#D4820A] font-medium">未找到已注册顾客</p>
                  <p className="text-[#999999] mt-1">服务单需要关联已注册顾客，请确认手机号是否正确</p>
                </CardContent>
              </Card>
            )}
            <div className="flex justify-end">
              <Button onClick={goToStep2} disabled={!selectedCustomer} loading={loadingItems}>下一步</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step 2: 选择项目 + 配置 */}
      {step === 1 && (
        <div className="space-y-4">
          <Card>
            <CardContent className="p-6 space-y-4">
              <h2 className="text-base font-semibold">选择服务项目</h2>
              {availableItems.length === 0 ? (
                <div className="text-center py-8 text-[#999999]">
                  <p>该顾客暂无可用服务项目</p>
                  <p className="text-xs mt-1">需先有已支付订单的疗程卡或单品项目</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-4 py-3 text-left font-medium text-gray-500 w-10"></th>
                        <th className="px-4 py-3 text-left font-medium text-gray-500">商品名称</th>
                        <th className="px-4 py-3 text-left font-medium text-gray-500">规格</th>
                        <th className="px-4 py-3 text-left font-medium text-gray-500">类型</th>
                        <th className="px-4 py-3 text-right font-medium text-gray-500">剩余/总次数</th>
                        <th className="px-4 py-3 text-right font-medium text-gray-500">单价</th>
                        <th className="px-4 py-3 text-left font-medium text-gray-500">到期日</th>
                        <th className="px-4 py-3 text-center font-medium text-gray-500">划卡次数</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200">
                      {availableItems.map((item) => {
                        const selected = isItemSelected(item.saleItemId)
                        return (
                          <tr
                            key={item.saleItemId}
                            className={`transition-colors cursor-pointer ${selected ? "bg-[#FFF0EE]" : "hover:bg-gray-50"}`}
                            onClick={() => toggleItem(item.saleItemId)}
                          >
                            <td className="px-4 py-3">
                              <input
                                type="checkbox"
                                checked={selected}
                                onChange={() => toggleItem(item.saleItemId)}
                                className="rounded"
                              />
                            </td>
                            <td className="px-4 py-3">{item.productName || "-"}</td>
                            <td className="px-4 py-3">{item.skuSpecName || "-"}</td>
                            <td className="px-4 py-3">
                              <span className={`inline-block px-2 py-0.5 rounded text-xs ${
                                item.productType === "疗程卡"
                                  ? "bg-[#F0F5FA] text-[#5E8BB3]"
                                  : "bg-[#F0F9F2] text-[#3D8A5A]"
                              }`}>
                                {item.productType}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-right">
                              {item.remainingSessions}/{item.sessionCount ?? "-"}
                            </td>
                            <td className="px-4 py-3 text-right">¥{Number(item.unitRealPrice).toFixed(2)}</td>
                            <td className="px-4 py-3">{item.expireDate || "永久"}</td>
                            <td className="px-4 py-3 text-center" onClick={e => e.stopPropagation()}>
                              {selected && (
                                <Input
                                  type="number"
                                  min={1}
                                  max={item.remainingSessions ?? 1}
                                  value={getSessionUsed(item.saleItemId)}
                                  onChange={(e) => updateSessionUsed(item.saleItemId, Number(e.target.value))}
                                  className="w-20 text-center mx-auto"
                                />
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6 space-y-4">
              <h2 className="text-base font-semibold">服务配置</h2>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                <div>
                  <label className="text-sm text-[#999999]">门店</label>
                  <Select className="mt-1" value={selectedStoreId} onChange={(e) => setSelectedStoreId(e.target.value)}>
                    {stores.map((s) => (
                      <option key={s.storeId} value={s.storeId}>{s.storeName}</option>
                    ))}
                  </Select>
                </div>
                <div>
                  <label className="text-sm text-[#999999]">负责美容师</label>
                  <Select className="mt-1" value={selectedEmployeeId} onChange={(e) => setSelectedEmployeeId(e.target.value)}>
                    <option value="">请选择</option>
                    {filteredEmployees.map((e) => (
                      <option key={e.employeeId} value={e.employeeId}>{e.name} ({e.positionName})</option>
                    ))}
                  </Select>
                </div>
                <div>
                  <label className="text-sm text-[#999999]">服务日期</label>
                  <Input type="date" className="mt-1" value={serviceDate} onChange={(e) => setServiceDate(e.target.value)} />
                </div>
                <div className="col-span-2">
                  <label className="text-sm text-[#999999]">备注（可选）</label>
                  <Input className="mt-1" placeholder="服务备注" value={remark} onChange={(e) => setRemark(e.target.value)} />
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="flex justify-between">
            <Button variant="outline" onClick={() => setStep(0)}>上一步</Button>
            <Button onClick={() => {
              if (!selectedEmployeeId) { toast.error("请选择负责美容师"); return }
              if (selectedItems.length === 0) { toast.error("请选择至少一个服务项目"); return }
              setStep(2)
            }} disabled={!canSubmit}>下一步</Button>
          </div>
        </div>
      )}

      {/* Step 3: 确认提交 / 成功 */}
      {step === 2 && !createdServiceOrderId && (
        <Card>
          <CardContent className="p-6 space-y-6">
            <h2 className="text-base font-semibold">确认服务单</h2>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <div>
                <span className="text-[#999999]">顾客</span>
                <p className="font-medium">{selectedCustomer?.name || "-"}</p>
              </div>
              <div>
                <span className="text-[#999999]">门店</span>
                <p className="font-medium">{stores.find(s => s.storeId === selectedStoreId)?.storeName || "-"}</p>
              </div>
              <div>
                <span className="text-[#999999]">负责美容师</span>
                <p className="font-medium">{employees.find(e => e.employeeId === selectedEmployeeId)?.name || "-"}</p>
              </div>
              <div>
                <span className="text-[#999999]">服务日期</span>
                <p className="font-medium">{serviceDate}</p>
              </div>
              {remark.trim() && (
                <div className="col-span-2">
                  <span className="text-[#999999]">备注</span>
                  <p className="font-medium">{remark}</p>
                </div>
              )}
            </div>

            <Separator />

            <div>
              <h3 className="text-sm font-semibold mb-3">服务项目</h3>
              <div className="space-y-2">
                {selectedItems.map(si => {
                  const item = availableItems.find(a => a.saleItemId === si.saleItemId)
                  if (!item) return null
                  return (
                    <div key={si.saleItemId} className="flex justify-between text-sm bg-[#FAFAFA] rounded px-3 py-2">
                      <span>{item.productName} - {item.skuSpecName || item.productType}</span>
                      <span className="font-medium">划卡 {si.sessionUsed} 次</span>
                    </div>
                  )
                })}
              </div>
            </div>

            <div className="flex justify-between">
              <Button variant="outline" onClick={() => setStep(1)}>上一步</Button>
              <Button loading={submitting} onClick={handleSubmit}>提交服务单</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 成功页 */}
      {step === 2 && createdServiceOrderId && (
        <Card>
          <CardContent className="p-6 text-center space-y-4">
            <div className="flex justify-center">
              <div className="h-16 w-16 rounded-full flex items-center justify-center bg-[#F0F9F2]">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#3D8A5A" strokeWidth="2"><polyline points="20 6 9 17 4 12" /></svg>
              </div>
            </div>
            <h2 className="text-xl font-bold text-[var(--foreground)]">服务单创建成功</h2>
            <p className="text-sm font-mono text-[var(--primary)]">{createdServiceOrderId}</p>
            <div className="flex justify-center gap-3 pt-4">
              <Link href={`/services/${createdServiceOrderId}`}>
                <Button variant="outline">查看服务单</Button>
              </Link>
              <Button onClick={resetForm}>继续新建</Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
