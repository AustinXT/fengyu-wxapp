"use client"

import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Separator } from "@/components/ui/separator"
import type { MemberLevelBenefit, MemberLevelBenefitsMap } from "@/actions/settings"
import { MAX_COUPON_QUANTITY, clampCouponQuantity } from "@/lib/coupon-quantity"

export const MEMBER_LEVELS = ['初钻', '星钻', '粉钻', '金钻', '黑钻'] as const
export type MemberLevel = (typeof MEMBER_LEVELS)[number]

const LEVEL_THRESHOLDS: Record<MemberLevel, string> = {
  初钻: '滚动 12 个月消费 ¥1,990 ~ ¥9,999',
  星钻: '滚动 12 个月消费 ¥10,000 ~ ¥29,999',
  粉钻: '滚动 12 个月消费 ¥30,000 ~ ¥59,999',
  金钻: '滚动 12 个月消费 ¥60,000 ~ ¥99,999',
  黑钻: '滚动 12 个月消费 ¥100,000+',
}

interface MemberLevelBenefitsFormProps {
  value: MemberLevelBenefitsMap
  onChange: (next: MemberLevelBenefitsMap) => void
  couponTemplates: Array<{ templateId: string; name: string }>
  /** 消息标题 placeholder 生成函数，接收等级名，返回完整 placeholder 文本 */
  messageTitlePlaceholder: (level: MemberLevel) => string
  /** 积分字段提示文案 */
  pointsHelperText: string
}

export function MemberLevelBenefitsForm({
  value,
  onChange,
  couponTemplates,
  messageTitlePlaceholder,
  pointsHelperText,
}: MemberLevelBenefitsFormProps) {
  const updateBenefit = (level: MemberLevel, patch: Partial<MemberLevelBenefit>) => {
    onChange({ ...value, [level]: { ...value[level], ...patch } })
  }

  const toggleCouponTemplate = (level: MemberLevel, templateId: string) => {
    const current = value[level].couponTemplateIds
    const currentQty = value[level].couponQuantities
    if (current.includes(templateId)) {
      // 取消勾选：移除模板 + 清理其数量
      const { [templateId]: _removed, ...restQty } = currentQty
      onChange({
        ...value,
        [level]: { ...value[level], couponTemplateIds: current.filter((id) => id !== templateId), couponQuantities: restQty },
      })
    } else {
      // 勾选：加入模板 + 数量默认 1
      onChange({
        ...value,
        [level]: {
          ...value[level],
          couponTemplateIds: [...current, templateId],
          couponQuantities: { ...currentQty, [templateId]: 1 },
        },
      })
    }
  }

  const setCouponQuantity = (level: MemberLevel, templateId: string, raw: number) => {
    const qty = clampCouponQuantity(raw)
    onChange({
      ...value,
      [level]: {
        ...value[level],
        couponQuantities: { ...value[level].couponQuantities, [templateId]: qty },
      },
    })
  }

  return (
    <div className="space-y-6">
      {MEMBER_LEVELS.map((level) => {
        const b = value[level]
        return (
          <Card key={level} className="max-w-3xl">
            <CardHeader>
              <CardTitle className="flex items-baseline gap-3">
                <span>{level}</span>
                <span className="text-xs font-normal text-[#999999]">{LEVEL_THRESHOLDS[level]}</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium text-[var(--foreground)]">奖励积分</label>
                <Input
                  type="number"
                  min={0}
                  step={1}
                  value={b.points}
                  onChange={(e) => updateBenefit(level, { points: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
                  placeholder="0"
                  className="max-w-xs"
                />
                <p className="text-xs text-[#999999]">{pointsHelperText}</p>
              </div>

              <Separator />

              <div className="space-y-2">
                <label className="text-sm font-medium text-[var(--foreground)]">消息标题</label>
                <Input
                  value={b.messageTitle}
                  onChange={(e) => updateBenefit(level, { messageTitle: e.target.value })}
                  placeholder={messageTitlePlaceholder(level)}
                  maxLength={200}
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-[var(--foreground)]">消息正文</label>
                <Textarea
                  value={b.messageBody}
                  onChange={(e) => updateBenefit(level, { messageBody: e.target.value })}
                  placeholder="专属权益已为您解锁。"
                  rows={3}
                />
              </div>

              <Separator />

              <div className="space-y-2">
                <label className="text-sm font-medium text-[var(--foreground)]">
                  发放优惠券模板
                  {b.couponTemplateIds.length > 0 && (
                    <span className="ml-2 text-xs text-[var(--primary)]">
                      已选 {b.couponTemplateIds.length} 种，共{" "}
                      {b.couponTemplateIds.reduce((s, id) => s + (b.couponQuantities[id] ?? 1), 0)} 张
                    </span>
                  )}
                </label>
                {couponTemplates.length === 0 ? (
                  <p className="text-xs text-[#999999]">暂无可用优惠券模板，请先到 <a href="/coupons" className="text-[var(--primary)] underline">优惠券</a> 页面创建</p>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-60 overflow-y-auto border border-[var(--border)] rounded-md p-3">
                    {couponTemplates.map((tpl) => {
                      const checked = b.couponTemplateIds.includes(tpl.templateId)
                      return (
                        <div
                          key={tpl.templateId}
                          className="flex items-center gap-2 text-sm hover:bg-[var(--accent)] px-2 py-1 rounded"
                        >
                          <label className="flex items-center gap-2 cursor-pointer flex-1 min-w-0">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleCouponTemplate(level, tpl.templateId)}
                              className="h-4 w-4 accent-[var(--primary)]"
                            />
                            <span className="truncate" title={tpl.name}>{tpl.name}</span>
                          </label>
                          {checked && (
                            <div className="flex items-center gap-1 shrink-0">
                              <span className="text-xs text-[#999999]">数量</span>
                              <Input
                                type="number"
                                min={1}
                                max={MAX_COUPON_QUANTITY}
                                value={b.couponQuantities[tpl.templateId] ?? 1}
                                onChange={(e) => setCouponQuantity(level, tpl.templateId, Number(e.target.value))}
                                className="h-8 w-16"
                              />
                              <span className="text-xs text-[#999999]">张</span>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}
