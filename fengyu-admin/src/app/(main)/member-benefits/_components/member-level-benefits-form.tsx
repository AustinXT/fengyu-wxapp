"use client"

import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Separator } from "@/components/ui/separator"
import type { MemberLevelBenefit, MemberLevelBenefitsMap } from "@/actions/settings"

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
    const next = current.includes(templateId)
      ? current.filter((id) => id !== templateId)
      : [...current, templateId]
    onChange({ ...value, [level]: { ...value[level], couponTemplateIds: next } })
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
                    <span className="ml-2 text-xs text-[var(--primary)]">已选 {b.couponTemplateIds.length} 张</span>
                  )}
                </label>
                {couponTemplates.length === 0 ? (
                  <p className="text-xs text-[#999999]">暂无可用优惠券模板，请先到 <a href="/coupons" className="text-[var(--primary)] underline">优惠券</a> 页面创建</p>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-48 overflow-y-auto border border-[var(--border)] rounded-md p-3">
                    {couponTemplates.map((tpl) => {
                      const checked = b.couponTemplateIds.includes(tpl.templateId)
                      return (
                        <label
                          key={tpl.templateId}
                          className="flex items-center gap-2 text-sm cursor-pointer hover:bg-[var(--accent)] px-2 py-1 rounded"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleCouponTemplate(level, tpl.templateId)}
                            className="h-4 w-4 accent-[var(--primary)]"
                          />
                          <span className="truncate" title={tpl.name}>{tpl.name}</span>
                        </label>
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
