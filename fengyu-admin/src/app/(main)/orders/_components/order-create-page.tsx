"use client"

import { useState } from "react"
import Link from "next/link"
import { toast } from "sonner"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { searchCustomerByPhone } from "@/actions/customers"
import { createOrder } from "@/actions/orders"
import type { ProductCategory, Product, ProductSku, Store, Employee, Customer } from "@/lib/types"

interface CartItem {
  sku: ProductSku
  product: Product
  quantity: number
}

const steps = ["选择顾客", "选择商品", "确认订单", "完成"]

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

export default function OrderCreatePageClient({
  categories,
  products,
  skus,
  stores,
  employees,
}: {
  categories: ProductCategory[]
  products: Product[]
  skus: ProductSku[]
  stores: Store[]
  employees: Employee[]
}) {
  const [step, setStep] = useState(0)
  const [phone, setPhone] = useState("")
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null)
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>(categories[0]?.categoryId || "")
  const [cart, setCart] = useState<CartItem[]>([])
  const [orderType, setOrderType] = useState<'普通' | '体验' | '内部' | '福利活动'>("普通")
  const [paymentMethod, setPaymentMethod] = useState("wechat")
  const [selectedStoreId, setSelectedStoreId] = useState<string>(stores[0]?.storeId || "")
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string>("")
  const [searching, setSearching] = useState(false)
  const [remark, setRemark] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [createdOrderId, setCreatedOrderId] = useState<string>("")
  const [searchDone, setSearchDone] = useState(false)

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
      if (!result) {
        toast.info("未找到该手机号对应的顾客，可直接使用手机号开单")
      }
    } catch {
      toast.error("搜索失败，请稍后重试")
    } finally {
      setSearching(false)
    }
  }

  const categoryProducts = products.filter((p) => p.categoryId === selectedCategoryId)

  const addToCart = (product: Product, sku: ProductSku) => {
    setCart((prev) => {
      const existing = prev.find((i) => i.sku.skuId === sku.skuId)
      if (existing) {
        return prev.map((i) =>
          i.sku.skuId === sku.skuId ? { ...i, quantity: i.quantity + 1 } : i
        )
      }
      return [...prev, { sku, product, quantity: 1 }]
    })
  }

  const removeFromCart = (skuId: string) => {
    setCart((prev) => prev.filter((i) => i.sku.skuId !== skuId))
  }

  const totalAmount = cart.reduce((sum, item) => {
    const price = item.sku.specialPrice ? Number(item.sku.specialPrice) : Number(item.sku.price)
    return sum + price * item.quantity
  }, 0)

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link href="/orders" className="text-[#999999] hover:text-[var(--foreground)]">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6" /></svg>
        </Link>
        <h1 className="text-2xl font-bold text-[var(--foreground)]">新建订单</h1>
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
                className="w-64"
              />
              <Button onClick={searchCustomer} loading={searching}>搜索</Button>
            </div>
            {selectedCustomer && (
              <Card className="bg-[#FAFAFA]">
                <CardContent className="p-4">
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
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
                  </div>
                </CardContent>
              </Card>
            )}
            {searchDone && !selectedCustomer && (
              <Card className="bg-[#FFF8E6] border-[#D4820A]">
                <CardContent className="p-4 text-sm">
                  <p className="text-[#D4820A] font-medium">未找到已注册顾客</p>
                  <p className="text-[#999999] mt-1">将使用手机号 {phone} 开单，顾客后续注册绑定手机号后历史订单会自动关联</p>
                </CardContent>
              </Card>
            )}
            <div className="flex justify-end">
              <Button onClick={() => setStep(1)} disabled={!searchDone && !selectedCustomer}>下一步</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step 2: 选择商品 */}
      {step === 1 && (
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
          {/* Category nav */}
          <Card className="lg:col-span-1">
            <CardContent className="p-3">
              <h3 className="text-sm font-semibold text-[#999999] mb-2">商品分类</h3>
              <div className="space-y-1">
                {categories.map((cat) => (
                  <button
                    key={cat.categoryId}
                    onClick={() => setSelectedCategoryId(cat.categoryId)}
                    className={`w-full text-left px-3 py-2 rounded text-sm transition-colors ${
                      selectedCategoryId === cat.categoryId
                        ? "bg-[var(--primary)] text-white"
                        : "hover:bg-[#FFF0EE]"
                    }`}
                  >
                    {cat.categoryName}
                    <span className="text-xs ml-1 opacity-70">({cat.productKind})</span>
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Products */}
          <div className="lg:col-span-3 space-y-4">
            <Card>
              <CardContent className="p-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {categoryProducts.map((product) => {
                    const productSkus = skus.filter((s) => s.productId === product.productId)
                    return (
                      <Card key={product.productId} className="bg-[#FAFAFA]">
                        <CardContent className="p-4 space-y-2">
                          <div className="flex justify-between items-start">
                            <h4 className="font-medium text-sm">{product.name}</h4>
                            <span className="text-xs text-[#999999]">¥{product.price}</span>
                          </div>
                          <p className="text-xs text-[#999999] line-clamp-2">{product.description}</p>
                          <Separator />
                          <div className="space-y-1">
                            {productSkus.map((sku) => (
                              <div key={sku.skuId} className="flex items-center justify-between">
                                <span className="text-xs">
                                  {sku.specName}
                                  <span className="text-[#999999] ml-1">
                                    ¥{sku.specialPrice || sku.price}
                                  </span>
                                </span>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => addToCart(product, sku)}
                                  className="h-6 text-xs px-2"
                                >
                                  加入
                                </Button>
                              </div>
                            ))}
                          </div>
                        </CardContent>
                      </Card>
                    )
                  })}
                  {categoryProducts.length === 0 && (
                    <p className="text-sm text-[#999999] py-8 text-center col-span-2">该分类暂无商品</p>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Cart */}
            <Card>
              <CardContent className="p-4">
                <h3 className="text-sm font-semibold mb-3">
                  购物车 <span className="text-[#999999]">({cart.length} 件)</span>
                </h3>
                {cart.length > 0 ? (
                  <div className="space-y-2">
                    {cart.map((item) => (
                      <div key={item.sku.skuId} className="flex items-center justify-between bg-[#FAFAFA] rounded px-3 py-2 text-sm">
                        <div>
                          <span className="font-medium">{item.product.name}</span>
                          <span className="text-[#999999] ml-2">{item.sku.specName}</span>
                          <span className="text-[#999999] ml-2">x{item.quantity}</span>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="font-medium">
                            ¥{((item.sku.specialPrice ? Number(item.sku.specialPrice) : Number(item.sku.price)) * item.quantity).toLocaleString()}
                          </span>
                          <button onClick={() => removeFromCart(item.sku.skuId)} className="text-[#D94040] text-xs hover:underline">
                            删除
                          </button>
                        </div>
                      </div>
                    ))}
                    <div className="text-right font-bold text-lg pt-2">
                      合计: ¥{totalAmount.toLocaleString()}
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-[#999999] text-center py-4">请从上方添加商品</p>
                )}
              </CardContent>
            </Card>

            <div className="flex justify-between">
              <Button variant="outline" onClick={() => setStep(0)}>上一步</Button>
              <Button onClick={() => setStep(2)} disabled={cart.length === 0}>下一步</Button>
            </div>
          </div>
        </div>
      )}

      {/* Step 3: 确认订单 */}
      {step === 2 && (
        <Card>
          <CardContent className="p-6 space-y-6">
            <h2 className="text-base font-semibold">确认订单</h2>

            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <div>
                <label className="text-sm text-[#999999]">顾客</label>
                <p className="font-medium">{selectedCustomer?.name || phone}</p>
              </div>
              <div>
                <label className="text-sm text-[#999999]">订单类型</label>
                <Select className="mt-1" value={orderType} onChange={(e) => setOrderType(e.target.value as '普通' | '体验' | '内部' | '福利活动')}>
                  <option value="普通">普通</option>
                  <option value="体验">体验</option>
                  <option value="内部">内部</option>
                  <option value="福利活动">福利活动</option>
                </Select>
              </div>
              <div>
                <label className="text-sm text-[#999999]">支付方式</label>
                <Select className="mt-1" value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)}>
                  <option value="wechat">微信支付</option>
                  <option value="alipay">支付宝</option>
                  <option value="offline">线下支付</option>
                </Select>
              </div>
              <div>
                <label className="text-sm text-[#999999]">门店</label>
                <Select className="mt-1" value={selectedStoreId} onChange={(e) => setSelectedStoreId(e.target.value)}>
                  {stores.map((s) => (
                    <option key={s.storeId} value={s.storeId}>{s.storeName}</option>
                  ))}
                </Select>
              </div>
              <div>
                <label className="text-sm text-[#999999]">指定美容师（可选）</label>
                <Select className="mt-1" value={selectedEmployeeId} onChange={(e) => setSelectedEmployeeId(e.target.value)}>
                  <option value="">不指定</option>
                  {employees.filter((e) => !e.isResigned && (!selectedStoreId || e.storeId === selectedStoreId)).map((e) => (
                    <option key={e.employeeId} value={e.employeeId}>{e.name} ({e.positionName})</option>
                  ))}
                </Select>
              </div>
              <div className="col-span-2 md:col-span-3">
                <label className="text-sm text-[#999999]">备注（可选）</label>
                <Input
                  className="mt-1"
                  placeholder="订单备注"
                  value={remark}
                  onChange={(e) => setRemark(e.target.value)}
                />
              </div>
            </div>

            <Separator />

            <div>
              <h3 className="text-sm font-semibold mb-3">商品清单</h3>
              <div className="space-y-2">
                {cart.map((item) => (
                  <div key={item.sku.skuId} className="flex justify-between text-sm bg-[#FAFAFA] rounded px-3 py-2">
                    <span>{item.product.name} - {item.sku.specName} x{item.quantity}</span>
                    <span className="font-medium">
                      ¥{((item.sku.specialPrice ? Number(item.sku.specialPrice) : Number(item.sku.price)) * item.quantity).toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>
              <div className="text-right font-bold text-xl pt-4 text-[var(--primary)]">
                合计: ¥{totalAmount.toLocaleString()}
              </div>
            </div>

            <div className="flex justify-between">
              <Button variant="outline" onClick={() => setStep(1)}>上一步</Button>
              <Button loading={submitting} onClick={async () => {
                if (!selectedStoreId) { toast.error("请选择门店"); return }
                setSubmitting(true)
                try {
                  const store = stores.find((s) => s.storeId === selectedStoreId)
                  const res = await createOrder({
                    storeId: selectedStoreId,
                    marketName: store?.marketName || "未知市场",
                    clientUserId: selectedCustomer?.userId || null,
                    clientPhone: selectedCustomer?.phone || phone,
                    customerName: selectedCustomer?.name || phone,
                    paymentMethod: paymentMethod as 'wechat' | 'alipay' | 'offline',
                    saleOrderType: orderType,
                    preferredEmployeeId: selectedEmployeeId || undefined,
                    remark: remark.trim() || null,
                    items: cart.map((item) => ({
                      skuId: item.sku.skuId,
                      productName: item.product.name,
                      skuSpecName: item.sku.specName,
                      productType: item.sku.productType as '疗程卡' | '单品' | '院装产品',
                      sessionCount: item.sku.sessionCount,
                      unitPrice: item.sku.price,
                      unitRealPrice: item.sku.specialPrice || item.sku.price,
                      quantity: item.quantity,
                    })),
                  })
                  if (res.success) {
                    toast.success(res.message)
                    setCreatedOrderId(res.saleOrderId || "")
                    setStep(3)
                  } else {
                    toast.error(res.message)
                  }
                } catch {
                  toast.error("创建订单失败，请稍后重试")
                } finally {
                  setSubmitting(false)
                }
              }}>提交订单</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step 4: 完成 */}
      {step === 3 && (
        <Card>
          <CardContent className="p-6 text-center space-y-4">
            <div className="flex justify-center">
              <div className="h-16 w-16 rounded-full bg-[#F0F9F2] flex items-center justify-center">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#3D8A5A" strokeWidth="2"><polyline points="20 6 9 17 4 12" /></svg>
              </div>
            </div>
            <h2 className="text-xl font-bold text-[var(--foreground)]">订单创建成功</h2>
            {createdOrderId && (
              <p className="text-sm font-mono text-[var(--primary)]">{createdOrderId}</p>
            )}
            <p className="text-sm text-[#999999]">
              {paymentMethod === 'offline' ? '线下支付订单，请到订单列表确认收款' : '订单已提交，等待顾客支付'}
            </p>
            <div className="flex justify-center gap-3 pt-4">
              {createdOrderId ? (
                <Link href={`/orders/${createdOrderId}`}>
                  <Button variant="outline">查看订单</Button>
                </Link>
              ) : (
                <Link href="/orders">
                  <Button variant="outline">返回订单列表</Button>
                </Link>
              )}
              <Button onClick={() => { setStep(0); setCart([]); setSelectedCustomer(null); setPhone(""); setCreatedOrderId(""); setSearchDone(false) }}>
                继续开单
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
