'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { searchCustomerByPhone } from '@/actions/customers'
import {
  createPickupRecord,
  getAvailablePickupItems,
  type AvailablePickupItem,
} from '@/actions/pickup-records'
import type { Customer, Store } from '@/lib/types'

interface Props {
  stores: Store[]
}

export default function PickupRecordCreatePageClient({ stores }: Props) {
  const router = useRouter()

  // 顾客搜索
  const [phone, setPhone] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchDone, setSearchDone] = useState(false)
  const [customer, setCustomer] = useState<Customer | null>(null)

  // 可提货明细
  const [items, setItems] = useState<AvailablePickupItem[]>([])
  const [loadingItems, setLoadingItems] = useState(false)
  const [selectedItemId, setSelectedItemId] = useState<string>('')

  // 提货参数
  const [pickupQuantity, setPickupQuantity] = useState<number>(1)
  const [pickupStoreId, setPickupStoreId] = useState<string>(stores[0]?.storeId || '')
  const [remark, setRemark] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const selectedItem = items.find((i) => i.saleItemId === selectedItemId)

  const handleSearch = async () => {
    if (!phone.trim() || !/^1\d{10}$/.test(phone.trim())) {
      toast.error('请输入正确的手机号')
      return
    }
    setSearching(true)
    setSearchDone(false)
    setCustomer(null)
    setItems([])
    setSelectedItemId('')
    try {
      const result = await searchCustomerByPhone(phone.trim())
      setSearchDone(true)
      if (!result) return
      setCustomer(result)
      if (result.boundStoreId && stores.some((s) => s.storeId === result.boundStoreId)) {
        setPickupStoreId(result.boundStoreId)
      }
      // 加载可提货明细
      setLoadingItems(true)
      try {
        const list = await getAvailablePickupItems(result.userId)
        setItems(list)
        if (list.length > 0) {
          setSelectedItemId(list[0].saleItemId)
          setPickupQuantity(1)
        }
      } finally {
        setLoadingItems(false)
      }
    } catch {
      toast.error('搜索顾客失败')
    } finally {
      setSearching(false)
    }
  }

  const handleSelectItem = (saleItemId: string) => {
    setSelectedItemId(saleItemId)
    setPickupQuantity(1)
  }

  const handleQuantityChange = (value: number) => {
    if (!selectedItem) {
      setPickupQuantity(1)
      return
    }
    const clamped = Math.max(1, Math.min(value, selectedItem.remaining))
    setPickupQuantity(clamped)
  }

  const canSubmit =
    !!customer &&
    !!selectedItem &&
    !!pickupStoreId &&
    pickupQuantity > 0 &&
    pickupQuantity <= (selectedItem?.remaining ?? 0)

  const handleSubmit = async () => {
    if (!canSubmit || !customer || !selectedItem) return
    setSubmitting(true)
    try {
      // 每次按钮点击生成新 idempotencyKey；按钮 disabled 期间双击不会重新生成
      const idempotencyKey = `pickup-${selectedItem.saleItemId}-${Date.now()}`
      const res = await createPickupRecord({
        saleItemId: selectedItem.saleItemId,
        pickupQuantity,
        storeId: pickupStoreId,
        clientUserId: customer.userId,
        remark: remark.trim() || null,
        idempotencyKey,
      })
      if (res.success) {
        toast.success(res.message)
        router.push('/pickup-records')
        router.refresh()
      } else {
        toast.error(res.message)
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '提交失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link
          href="/pickup-records"
          className="text-[#999999] hover:text-[var(--foreground)]"
          aria-label="返回列表"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </Link>
        <h1 className="text-2xl font-bold text-[var(--foreground)]">新建提货记录</h1>
      </div>

      {/* 步骤 1：搜索顾客 */}
      <Card>
        <CardContent className="p-6 space-y-4">
          <h2 className="text-base font-semibold">1. 搜索顾客</h2>
          <div className="flex gap-2">
            <Input
              placeholder="输入手机号搜索"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              className="w-64"
            />
            <Button onClick={handleSearch} loading={searching}>
              搜索
            </Button>
          </div>
          {customer && (
            <Card className="bg-[#FAFAFA]">
              <CardContent className="p-4">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                  <div>
                    <span className="text-[#999999]">姓名</span>
                    <p className="font-medium">{customer.name || '-'}</p>
                  </div>
                  <div>
                    <span className="text-[#999999]">手机</span>
                    <p className="font-medium">{customer.phone}</p>
                  </div>
                  <div>
                    <span className="text-[#999999]">会员等级</span>
                    <p className="font-medium">{customer.memberLevel || '-'}</p>
                  </div>
                  <div>
                    <span className="text-[#999999]">绑定门店</span>
                    <p className="font-medium">{customer.storeName || '-'}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
          {searchDone && !customer && (
            <Card className="bg-[#FFF8E6] border-[#D4820A]">
              <CardContent className="p-4 text-sm">
                <p className="text-[#D4820A] font-medium">未找到已注册顾客</p>
                <p className="text-[#999999] mt-1">
                  创建提货记录需要关联已注册顾客，请确认手机号是否正确
                </p>
              </CardContent>
            </Card>
          )}
        </CardContent>
      </Card>

      {/* 步骤 2：选择可提货明细 */}
      {customer && (
        <Card>
          <CardContent className="p-6 space-y-4">
            <h2 className="text-base font-semibold">2. 选择家居产品</h2>
            {loadingItems ? (
              <div className="text-center py-8 text-[#999999]">加载中...</div>
            ) : items.length === 0 ? (
              <div className="text-center py-8 text-[#999999]">
                <p>该顾客暂无可提货的家居产品</p>
                <p className="text-xs mt-1">
                  需要顾客在已支付订单中购买了家居产品，且尚未全部提完
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-3 text-left font-medium text-gray-500 w-10"></th>
                      <th className="px-4 py-3 text-left font-medium text-gray-500">
                        商品 / 规格
                      </th>
                      <th className="px-4 py-3 text-left font-medium text-gray-500">
                        销售明细号
                      </th>
                      <th className="px-4 py-3 text-left font-medium text-gray-500">
                        原销售门店
                      </th>
                      <th className="px-4 py-3 text-right font-medium text-gray-500">
                        总 / 已提
                      </th>
                      <th className="px-4 py-3 text-right font-medium text-gray-500">
                        可提
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {items.map((item) => {
                      const selected = item.saleItemId === selectedItemId
                      return (
                        <tr
                          key={item.saleItemId}
                          className={`transition-colors cursor-pointer ${
                            selected ? 'bg-[#FFF0EE]' : 'hover:bg-gray-50'
                          }`}
                          onClick={() => handleSelectItem(item.saleItemId)}
                        >
                          <td className="px-4 py-3">
                            <input
                              type="radio"
                              name="pickup-item"
                              checked={selected}
                              onChange={() => handleSelectItem(item.saleItemId)}
                            />
                          </td>
                          <td className="px-4 py-3">
                            <div className="font-medium">{item.productName || '-'}</div>
                            {item.skuSpecName && (
                              <div className="text-xs text-[#999999]">{item.skuSpecName}</div>
                            )}
                          </td>
                          <td className="px-4 py-3 font-mono text-xs text-[#666666]">
                            {item.saleItemId}
                          </td>
                          <td className="px-4 py-3">{item.storeName ?? '—'}</td>
                          <td className="px-4 py-3 text-right">
                            {item.quantity} / {item.pickedUpQuantity}
                          </td>
                          <td className="px-4 py-3 text-right font-medium text-[#C0322A]">
                            {item.remaining}
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
      )}

      {/* 步骤 3：填写提货信息 */}
      {customer && selectedItem && (
        <Card>
          <CardContent className="p-6 space-y-4">
            <h2 className="text-base font-semibold">3. 提货信息</h2>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <div>
                <label className="text-sm text-[#999999]">提货门店</label>
                <Select
                  className="mt-1"
                  value={pickupStoreId}
                  onChange={(e) => setPickupStoreId(e.target.value)}
                >
                  {stores.map((s) => (
                    <option key={s.storeId} value={s.storeId}>
                      {s.storeName}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <label className="text-sm text-[#999999]">
                  提货数量（可提 {selectedItem.remaining}）
                </label>
                <Input
                  type="number"
                  min={1}
                  max={selectedItem.remaining}
                  className="mt-1"
                  value={pickupQuantity}
                  onChange={(e) => handleQuantityChange(Number(e.target.value))}
                />
              </div>
              <div className="col-span-2">
                <label className="text-sm text-[#999999]">备注（可选）</label>
                <Input
                  className="mt-1"
                  placeholder="提货备注"
                  value={remark}
                  onChange={(e) => setRemark(e.target.value)}
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Link href="/pickup-records">
                <Button variant="outline">取消</Button>
              </Link>
              <Button loading={submitting} disabled={!canSubmit} onClick={handleSubmit}>
                提交提货记录
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
