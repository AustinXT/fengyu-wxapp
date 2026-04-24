"use client"

import { useMemo, useState } from "react"
import { toast } from "sonner"
import { useUnsavedChanges } from "@/lib/hooks/use-unsaved-changes"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectOption } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import {
  saveShareGiftConfig,
  type ShareGiftConfig,
} from "@/actions/settings"

interface ShareGiftPageProps {
  initialConfig: ShareGiftConfig
  couponTemplates: Array<{ templateId: string; name: string }>
}

const PREVIEW_SAMPLE = {
  paidAmount: 99,
  validityDays: 90,
}

function renderMessage(
  template: string,
  vars: { paidAmount: string; couponValue: string; validityDays: string | number },
): string {
  return String(template || '').replace(/\{(\w+)\}/g, (_, k) => {
    const v = (vars as Record<string, string | number | undefined>)[k]
    return v === undefined || v === null ? '' : String(v)
  })
}

export default function ShareGiftPageClient({
  initialConfig,
  couponTemplates,
}: ShareGiftPageProps) {
  const [config, setConfig] = useState<ShareGiftConfig>(initialConfig)
  const [saving, setSaving] = useState(false)
  const [formDirty, setFormDirty] = useState(false)
  useUnsavedChanges(formDirty)

  const update = <K extends keyof ShareGiftConfig>(key: K, value: ShareGiftConfig[K]) => {
    setConfig((prev) => ({ ...prev, [key]: value }))
    setFormDirty(true)
  }

  const selectedTemplate = useMemo(
    () => couponTemplates.find((t) => t.templateId === config.couponTemplateId),
    [couponTemplates, config.couponTemplateId],
  )

  // 预览区：以 paidAmount=99.00 示例计算券面值
  const previewValue = useMemo(() => {
    const raw = PREVIEW_SAMPLE.paidAmount * (config.percent || 0)
    const rounded = Math.round(raw * 100) / 100
    return Math.max(
      config.minFaceValue || 0,
      Math.min(config.maxFaceValue || Infinity, rounded),
    )
  }, [config.percent, config.minFaceValue, config.maxFaceValue])

  const previewVars = {
    paidAmount: PREVIEW_SAMPLE.paidAmount.toFixed(2),
    couponValue: previewValue.toFixed(2),
    validityDays: config.validityDays,
  }

  const handleSave = async () => {
    if (config.enabled && !config.couponTemplateId) {
      toast.error('启用后必须选择券模板')
      return
    }
    setSaving(true)
    try {
      const res = await saveShareGiftConfig(config)
      if (res.success) {
        setFormDirty(false)
        toast.success(res.message)
      } else {
        toast.error(res.message)
      }
    } catch {
      toast.error('保存失败，请稍后重试')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-[var(--foreground)]">分享礼</h1>
        <Button onClick={handleSave} loading={saving}>保存</Button>
      </div>

      <Card className="max-w-3xl">
        <CardHeader>
          <CardTitle>分享礼规则</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-xs text-[#999999]">
          <p>老用户通过小程序分享邀请<strong className="text-[var(--foreground)]">新客首单结清</strong>时，系统按下列比例向邀请人和新客<strong className="text-[var(--foreground)]">各发一张动态面值代金券 + 一条站内消息</strong>。</p>
          <p>面值 = <code>paid_amount × percent</code>，clamp 到 <code>[minFaceValue, maxFaceValue]</code>。储值卡全额抵扣（paid_amount=0）不触发。以 <code>sale_order_id</code> 为幂等键保证一单一礼。</p>
          <p>关闭开关或未选择券模板时，<code>grantShareGift</code> 直接跳过。</p>
        </CardContent>
      </Card>

      <Card className="max-w-3xl">
        <CardHeader>
          <CardTitle>基础配置</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium text-[var(--foreground)]">启用分享礼</div>
              <div className="text-xs text-[#999999]">关闭后云函数 grantShareGift 直接 return</div>
            </div>
            <Switch
              checked={config.enabled}
              onCheckedChange={(v) => update('enabled', v)}
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-1">
              <label className="text-sm font-medium text-[var(--foreground)]">分享礼比例</label>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={0.01}
                  max={0.5}
                  step={0.01}
                  value={config.percent}
                  onChange={(e) => update('percent', Number(e.target.value) || 0)}
                />
                <span className="text-sm text-[#999999] shrink-0">
                  ≈ {(config.percent * 100).toFixed(1)}%
                </span>
              </div>
              <div className="text-xs text-[#999999]">范围 0.01 ~ 0.50，默认 0.15</div>
            </div>

            <div className="space-y-1">
              <label className="text-sm font-medium text-[var(--foreground)]">面值下限（元）</label>
              <Input
                type="number"
                min={0}
                step={0.01}
                value={config.minFaceValue}
                onChange={(e) => update('minFaceValue', Number(e.target.value) || 0)}
              />
              <div className="text-xs text-[#999999]">计算结果 &lt; 该值时取该值</div>
            </div>

            <div className="space-y-1">
              <label className="text-sm font-medium text-[var(--foreground)]">面值上限（元）</label>
              <Input
                type="number"
                min={0}
                step={0.01}
                value={config.maxFaceValue}
                onChange={(e) => update('maxFaceValue', Number(e.target.value) || 0)}
              />
              <div className="text-xs text-[#999999]">计算结果 &gt; 该值时取该值</div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="text-sm font-medium text-[var(--foreground)]">券模板</label>
              <Select
                value={config.couponTemplateId}
                onChange={(e) => update('couponTemplateId', e.target.value)}
              >
                <option value="">请选择券模板</option>
                {couponTemplates.map((t) => (
                  <SelectOption key={t.templateId} value={t.templateId}>
                    {t.name}
                  </SelectOption>
                ))}
              </Select>
              {config.enabled && !config.couponTemplateId ? (
                <div className="text-xs text-[#D94040]">启用后必选</div>
              ) : selectedTemplate ? (
                <div className="text-xs text-[#999999]">
                  已选：{selectedTemplate.name}
                </div>
              ) : (
                <div className="text-xs text-[#999999]">
                  运行时券面值由 paid_amount × percent 动态计算（user_coupons.face_value_override）
                </div>
              )}
            </div>

            <div className="space-y-1">
              <label className="text-sm font-medium text-[var(--foreground)]">兜底有效期（天）</label>
              <Input
                type="number"
                min={1}
                max={3650}
                step={1}
                value={config.validityDays}
                onChange={(e) => update('validityDays', Math.floor(Number(e.target.value)) || 0)}
              />
              <div className="text-xs text-[#999999]">
                模板为 <code>days</code> 模式按模板 valid_days 发；<code>fixed</code> 模式按模板 valid_to；两者缺失时用此值
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium text-[var(--foreground)]">邀请人必须已有结清订单</div>
              <div className="text-xs text-[#999999]">关：新注册用户也可作为邀请人；开：仅老客户有效</div>
            </div>
            <Switch
              checked={config.inviterMustHavePaidOrder}
              onCheckedChange={(v) => update('inviterMustHavePaidOrder', v)}
            />
          </div>
        </CardContent>
      </Card>

      <Card className="max-w-3xl">
        <CardHeader>
          <CardTitle>站内消息文案</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="text-xs text-[#999999]">
            支持占位符：
            <code className="mx-1">{'{paidAmount}'}</code>
            <code className="mx-1">{'{couponValue}'}</code>
            <code className="mx-1">{'{validityDays}'}</code>
            。标题留空该条不发但另一条照发（云函数 console.warn 巡检）。
          </div>

          <div className="space-y-2">
            <div className="text-sm font-semibold text-[var(--foreground)]">给邀请人</div>
            <div className="space-y-1">
              <label className="text-xs text-[#999999]">标题</label>
              <Input
                value={config.messageInviterTitle}
                onChange={(e) => update('messageInviterTitle', e.target.value)}
                placeholder="🎁 分享礼到账"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-[#999999]">正文</label>
              <Textarea
                rows={3}
                value={config.messageInviterBody}
                onChange={(e) => update('messageInviterBody', e.target.value)}
                placeholder="您邀请的新客首单已结清（¥{paidAmount}），向您赠送一张 ¥{couponValue} 代金券，{validityDays} 天内有效。"
              />
            </div>
          </div>

          <div className="space-y-2">
            <div className="text-sm font-semibold text-[var(--foreground)]">给新客</div>
            <div className="space-y-1">
              <label className="text-xs text-[#999999]">标题</label>
              <Input
                value={config.messageInviteeTitle}
                onChange={(e) => update('messageInviteeTitle', e.target.value)}
                placeholder="🎁 新客首单回馈"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-[#999999]">正文</label>
              <Textarea
                rows={3}
                value={config.messageInviteeBody}
                onChange={(e) => update('messageInviteeBody', e.target.value)}
                placeholder="欢迎首次下单！感谢好友分享，赠送您一张 ¥{couponValue} 代金券，{validityDays} 天内有效。"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="max-w-3xl">
        <CardHeader>
          <CardTitle>文案预览</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="text-xs text-[#999999]">
            示例：新客首单 paid_amount = ¥{previewVars.paidAmount}，按当前配置计算券面值 ¥{previewVars.couponValue}，有效期 {previewVars.validityDays} 天
          </div>

          <div className="rounded-md border border-[var(--border)] p-3 space-y-1 bg-[var(--muted)]/30">
            <div className="text-xs text-[#999999]">给邀请人</div>
            <div className="text-sm font-medium text-[var(--foreground)]">
              {renderMessage(config.messageInviterTitle, previewVars) || <span className="text-[#D94040]">（标题为空，不发送）</span>}
            </div>
            <div className="text-sm text-[var(--foreground)] whitespace-pre-wrap">
              {renderMessage(config.messageInviterBody, previewVars)}
            </div>
          </div>

          <div className="rounded-md border border-[var(--border)] p-3 space-y-1 bg-[var(--muted)]/30">
            <div className="text-xs text-[#999999]">给新客</div>
            <div className="text-sm font-medium text-[var(--foreground)]">
              {renderMessage(config.messageInviteeTitle, previewVars) || <span className="text-[#D94040]">（标题为空，不发送）</span>}
            </div>
            <div className="text-sm text-[var(--foreground)] whitespace-pre-wrap">
              {renderMessage(config.messageInviteeBody, previewVars)}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
