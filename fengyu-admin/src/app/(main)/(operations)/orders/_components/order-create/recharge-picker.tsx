"use client"

import { useMemo } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { matchTier, type RechargeConfig } from "@/lib/recharge-tier"

/**
 * 充值卡档位选择器（admin 开单页「充值卡」Tab 专用）
 *
 * 2026-05-21 充值入口收敛到开单页：逻辑迁自原 customers/[id]/recharge/recharge-form.tsx
 * （该页同步删除），档位计算复用 lib/recharge.ts:matchTier，配置同源 system_configs.recharge.*。
 *
 * 受控组件：父组件持有 selectedFace / customInput 两个 state；本组件仅渲染 + 即时预览，
 * 解析后的 {faceValue, payAmount, error} 由父组件统一通过 resolveRecharge() 计算（单一来源）。
 */

export interface RechargeResolved {
  faceValue: number
  payAmount: number
  discount: number
  error: string | null
}

/**
 * 按当前选择（档位优先级低于自定义输入）解析面值/实付/折扣。
 * - 自定义输入非空 → 走 matchTier（含 min/max 边界与 2 位小数校验）
 * - 否则取选中档位
 * - 都没有 → faceValue=0（父组件据此禁用「下一步」）
 */
export function resolveRecharge(
  config: RechargeConfig | null,
  selectedFace: number,
  customInput: string,
): RechargeResolved {
  if (!config) return { faceValue: 0, payAmount: 0, discount: 1, error: null }
  const raw = customInput.trim()
  if (raw) {
    const amount = Number(raw)
    if (!Number.isFinite(amount)) {
      return { faceValue: 0, payAmount: 0, discount: 1, error: "金额格式错误" }
    }
    try {
      const { discount, payAmount } = matchTier(amount, config)
      return { faceValue: amount, payAmount, discount, error: null }
    } catch (e: unknown) {
      const msg = (e instanceof Error ? e.message : "金额无效").replace(/^[A-Z_]+:\s*/, "")
      return { faceValue: 0, payAmount: 0, discount: 1, error: msg }
    }
  }
  if (selectedFace > 0) {
    const hit = config.tiers.find((t) => t.faceValue === selectedFace)
    const payAmount = hit?.payAmount ?? 0
    const discount = selectedFace > 0 ? Math.round((payAmount / selectedFace) * 100) / 100 : 1
    return { faceValue: selectedFace, payAmount, discount, error: null }
  }
  return { faceValue: 0, payAmount: 0, discount: 1, error: null }
}

export function formatAmount(n: number): string {
  if (!Number.isFinite(n)) return "0"
  const r = Math.round(n * 100) / 100
  return r % 1 === 0 ? String(r) : r.toFixed(2)
}

export function formatDiscountLabel(d: number): string {
  return (d * 10).toFixed(1).replace(/\.0$/, "") + " 折"
}

interface RechargePickerProps {
  config: RechargeConfig | null
  selectedFace: number
  customInput: string
  onSelectFace: (face: number) => void
  onCustomChange: (value: string) => void
}

export function RechargePicker({
  config,
  selectedFace,
  customInput,
  onSelectFace,
  onCustomChange,
}: RechargePickerProps) {
  const preview = useMemo(
    () => resolveRecharge(config, selectedFace, customInput),
    [config, selectedFace, customInput],
  )
  const hasCustom = customInput.trim() !== ""

  if (!config) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-[#999999]">
          管理员尚未配置充值档位，请前往 <span className="font-medium">系统配置 → 充值卡配置</span> 完成设置后再开充值单。
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-4">
          <h3 className="text-sm font-semibold mb-3">充值档位</h3>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {config.tiers.map((t) => {
              const bonus = Math.round((t.faceValue - t.payAmount) * 100) / 100
              const discount = t.faceValue > 0 ? Math.round((t.payAmount / t.faceValue) * 100) / 100 : 1
              const active = selectedFace === t.faceValue && !hasCustom
              return (
                <button
                  key={t.faceValue}
                  type="button"
                  onClick={() => onSelectFace(t.faceValue)}
                  className={`rounded-lg border p-3 text-left transition ${
                    active
                      ? "border-[var(--primary)] bg-[#FFF0EE]"
                      : "border-[var(--border)] hover:border-[var(--primary)]/60"
                  }`}
                >
                  <div className="text-lg font-bold">¥{formatAmount(t.faceValue)}</div>
                  {bonus > 0 ? (
                    <>
                      <div className="text-sm text-[var(--primary)]">{formatDiscountLabel(discount)}</div>
                      <div className="text-xs text-[#999999]">实付 ¥{formatAmount(t.payAmount)}</div>
                      <div className="text-xs text-[#3D8A5A]">送 ¥{formatAmount(bonus)}</div>
                    </>
                  ) : (
                    <div className="text-xs text-[#999999]">原价</div>
                  )}
                </button>
              )
            })}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4">
          <h3 className="text-sm font-semibold mb-3">自定义金额</h3>
          <div className="flex items-center gap-2">
            <span className="text-lg">¥</span>
            <Input
              type="number"
              inputMode="decimal"
              placeholder={`最低 ${config.minAmount}，最高 ${config.maxAmount}`}
              value={customInput}
              onChange={(e) => onCustomChange(e.target.value)}
              className="text-lg w-48"
            />
          </div>
          {hasCustom &&
            (preview.error ? (
              <p className="text-sm text-[#D94040] mt-2">{preview.error}</p>
            ) : (
              <p className="text-sm text-[#999999] mt-2">
                匹配 <span className="text-[var(--primary)] font-medium">{formatDiscountLabel(preview.discount)}</span>
                ｜实付 <span className="font-medium">¥{formatAmount(preview.payAmount)}</span>
                {preview.faceValue - preview.payAmount > 0 && (
                  <span className="text-[#3D8A5A]">（送 ¥{formatAmount(preview.faceValue - preview.payAmount)}）</span>
                )}
              </p>
            ))}
        </CardContent>
      </Card>
    </div>
  )
}
