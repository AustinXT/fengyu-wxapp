'use client'

import { useState, useMemo, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { matchTier, type RechargeConfig } from '@/lib/recharge'
import { createRechargeOrder } from '@/actions/cards'
import type { Customer, Store } from '@/lib/types'
import { formatCurrency } from '@/lib/utils'

interface RechargeFormProps {
  customer: Customer
  config: RechargeConfig
  stores: Store[]
}

export default function RechargeForm({ customer, config, stores }: RechargeFormProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const defaultStoreId = customer.boundStoreId || stores[0]?.storeId || ''
  const [storeId, setStoreId] = useState<string>(defaultStoreId)
  const [selectedFace, setSelectedFace] = useState<number>(0)
  const [customInput, setCustomInput] = useState<string>('')
  const [remark, setRemark] = useState<string>('')

  // 自定义输入实时预览（错误 / 折扣 / 实付）
  const preview = useMemo(() => {
    const raw = customInput.trim()
    if (!raw) return { error: null as string | null, payAmount: 0, discount: 1, bonus: 0 }
    const amount = Number(raw)
    if (!Number.isFinite(amount)) return { error: '金额格式错误', payAmount: 0, discount: 1, bonus: 0 }
    try {
      const { discount, payAmount } = matchTier(amount, config)
      const bonus = Math.round((amount - payAmount) * 100) / 100
      return { error: null, payAmount, discount, bonus }
    } catch (e: unknown) {
      const msg = (e instanceof Error ? e.message : '金额无效').replace(/^[A-Z_]+:\s*/, '')
      return { error: msg, payAmount: 0, discount: 1, bonus: 0 }
    }
  }, [customInput, config])

  const faceValue = customInput.trim() ? Number(customInput) : selectedFace
  const payAmount = customInput.trim()
    ? preview.payAmount
    : config.tiers.find((t) => t.faceValue === selectedFace)?.payAmount || 0
  const canSubmit =
    !!storeId &&
    !!customer.userId &&
    faceValue > 0 &&
    payAmount > 0 &&
    !preview.error &&
    !isPending

  function handleTierClick(tierFace: number) {
    setSelectedFace(tierFace)
    setCustomInput('')
  }

  function handleCustomChange(e: React.ChangeEvent<HTMLInputElement>) {
    setCustomInput(e.target.value)
    setSelectedFace(0)
  }

  function handleSubmit() {
    if (!canSubmit) return
    startTransition(async () => {
      const res = await createRechargeOrder({
        clientUserId: customer.userId,
        storeId,
        faceValue,
        remark: remark || null,
      })
      if (res.success && res.saleOrderId) {
        toast.success(`充值订单已创建：${res.saleOrderId}（实付 ¥${res.payAmount}）`)
        router.push(`/orders/${res.saleOrderId}`)
      } else {
        toast.error(res.message)
      }
    })
  }

  const ctaLabel = customInput.trim()
    ? preview.error
      ? preview.error
      : `创建充值订单 · 面值 ¥${formatAmount(faceValue)} · 实付 ¥${formatAmount(payAmount)}`
    : selectedFace
      ? `创建充值订单 · 面值 ¥${formatAmount(selectedFace)} · 实付 ¥${formatAmount(payAmount)}`
      : '请选择充值金额'

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={() => router.back()}>
          &larr; 返回
        </Button>
        <h1 className="text-2xl font-bold text-[var(--foreground)]">为顾客充值</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>顾客信息</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm space-y-1">
            <div>
              <span className="text-[var(--muted-foreground)]">姓名：</span>
              <span className="font-medium">{customer.name || '—'}</span>
            </div>
            <div>
              <span className="text-[var(--muted-foreground)]">手机号：</span>
              <span>{customer.phone || '—'}</span>
            </div>
            {customer.memberLevel && (
              <div>
                <span className="text-[var(--muted-foreground)]">会员等级：</span>
                <span>{customer.memberLevel}</span>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>入账门店</CardTitle>
        </CardHeader>
        <CardContent>
          <Select value={storeId} onChange={(e) => setStoreId(e.target.value)}>
            <option value="">请选择门店</option>
            {stores.map((s) => (
              <option key={s.storeId} value={s.storeId}>
                {s.storeName}
              </option>
            ))}
          </Select>
          <p className="text-xs text-[var(--muted-foreground)] mt-2">
            储值卡余额跨店统一（一户一账户），入账门店仅作为本张订单的归属门店。
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>充值档位</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {config.tiers.map((t) => {
              const bonus = Math.round((t.faceValue - t.payAmount) * 100) / 100
              const discount = t.faceValue > 0 ? Math.round((t.payAmount / t.faceValue) * 100) / 100 : 1
              const active = selectedFace === t.faceValue && !customInput.trim()
              return (
                <button
                  key={t.faceValue}
                  type="button"
                  onClick={() => handleTierClick(t.faceValue)}
                  className={[
                    'rounded-lg border p-3 text-left transition',
                    active
                      ? 'border-[#C0322A] bg-[#FFF0EE]'
                      : 'border-[var(--border)] hover:border-[#C0322A]/60',
                  ].join(' ')}
                >
                  <div className="text-lg font-bold">¥{formatAmount(t.faceValue)}</div>
                  {bonus > 0 ? (
                    <>
                      <div className="text-sm text-[#C0322A]">{formatDiscountLabel(discount)}</div>
                      <div className="text-xs text-[var(--muted-foreground)]">
                        实付 ¥{formatAmount(t.payAmount)}
                      </div>
                      <div className="text-xs text-[#3D8A5A]">送 ¥{formatAmount(bonus)}</div>
                    </>
                  ) : (
                    <div className="text-xs text-[var(--muted-foreground)]">原价</div>
                  )}
                </button>
              )
            })}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>自定义金额</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2">
            <span className="text-lg">¥</span>
            <Input
              type="number"
              inputMode="decimal"
              placeholder={`最低 ${config.minAmount}，最高 ${config.maxAmount}`}
              value={customInput}
              onChange={handleCustomChange}
              className="text-lg"
            />
          </div>
          {customInput.trim() && (
            preview.error ? (
              <p className="text-sm text-[#D94040] mt-2">{preview.error}</p>
            ) : (
              <p className="text-sm text-[var(--muted-foreground)] mt-2">
                匹配 <span className="text-[#C0322A] font-medium">{formatDiscountLabel(preview.discount)}</span>
                ｜实付 <span className="font-medium">¥{formatAmount(preview.payAmount)}</span>
                {preview.bonus > 0 && (
                  <span className="text-[#3D8A5A]">（送 ¥{formatAmount(preview.bonus)}）</span>
                )}
              </p>
            )
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>备注（可选）</CardTitle>
        </CardHeader>
        <CardContent>
          <Input
            placeholder="例如：现金充值 / 微信 H5 转账"
            value={remark}
            onChange={(e) => setRemark(e.target.value)}
            maxLength={200}
          />
        </CardContent>
      </Card>

      <div className="text-xs text-[var(--muted-foreground)] space-y-1">
        <div>· 支付方式仅支持&ldquo;线下收款&rdquo;（admin 端无微信扫码上下文）；订单创建后由店长在小程序 confirmOffline 入账</div>
        <div>· 充值后不支持退款，请与顾客确认金额</div>
      </div>

      <div className="sticky bottom-0 bg-[var(--background)] py-3 border-t border-[var(--border)] flex justify-end">
        <Button
          size="lg"
          loading={isPending}
          disabled={!canSubmit}
          onClick={handleSubmit}
        >
          {ctaLabel}
        </Button>
      </div>
    </div>
  )
}

function formatAmount(n: number): string {
  if (!Number.isFinite(n)) return '0'
  const r = Math.round(n * 100) / 100
  return r % 1 === 0 ? String(r) : r.toFixed(2)
}

function formatDiscountLabel(d: number): string {
  return (d * 10).toFixed(1).replace(/\.0$/, '') + ' 折'
}
