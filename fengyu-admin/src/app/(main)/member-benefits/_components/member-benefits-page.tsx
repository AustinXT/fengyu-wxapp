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
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import {
  saveMemberBenefits,
  saveShareGiftConfig,
  type MemberBenefitsBundle,
  type MemberLevelBenefitsMap,
  type ShareGiftConfig,
} from "@/actions/settings"
import { MemberLevelBenefitsForm, type MemberLevel } from "./member-level-benefits-form"

interface MemberBenefitsPageProps {
  initialBundle: MemberBenefitsBundle
  initialShareConfig: ShareGiftConfig
  couponTemplates: Array<{ templateId: string; name: string }>
}

const SHARE_PREVIEW_SAMPLE = {
  paidAmount: 99,
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

export default function MemberBenefitsPageClient({
  initialBundle,
  initialShareConfig,
  couponTemplates,
}: MemberBenefitsPageProps) {
  const [bundle, setBundle] = useState<MemberBenefitsBundle>(initialBundle)
  const [shareConfig, setShareConfig] = useState<ShareGiftConfig>(initialShareConfig)
  const [saving, setSaving] = useState(false)
  const [memberDirty, setMemberDirty] = useState(false)
  const [shareDirty, setShareDirty] = useState(false)
  useUnsavedChanges(memberDirty || shareDirty)

  const updateScenario = (scenario: keyof MemberBenefitsBundle) =>
    (next: MemberLevelBenefitsMap) => {
      setBundle((prev) => ({ ...prev, [scenario]: next }))
      setMemberDirty(true)
    }

  const updateShare = <K extends keyof ShareGiftConfig>(key: K, value: ShareGiftConfig[K]) => {
    setShareConfig((prev) => ({ ...prev, [key]: value }))
    setShareDirty(true)
  }

  const selectedTemplate = useMemo(
    () => couponTemplates.find((t) => t.templateId === shareConfig.couponTemplateId),
    [couponTemplates, shareConfig.couponTemplateId],
  )

  // 预览区：以 paidAmount=99.00 示例计算券面值
  const previewValue = useMemo(() => {
    const raw = SHARE_PREVIEW_SAMPLE.paidAmount * (shareConfig.percent || 0)
    const rounded = Math.round(raw * 100) / 100
    return Math.max(
      shareConfig.minFaceValue || 0,
      Math.min(shareConfig.maxFaceValue || Infinity, rounded),
    )
  }, [shareConfig.percent, shareConfig.minFaceValue, shareConfig.maxFaceValue])

  const previewVars = {
    paidAmount: SHARE_PREVIEW_SAMPLE.paidAmount.toFixed(2),
    couponValue: previewValue.toFixed(2),
    validityDays: shareConfig.validityDays,
  }

  const handleSave = async () => {
    if (shareDirty && shareConfig.enabled && !shareConfig.couponTemplateId) {
      toast.error('开启分享礼后，必须选一张代金券模板才能保存')
      return
    }
    if (!memberDirty && !shareDirty) {
      toast.info('没有需要保存的修改')
      return
    }
    setSaving(true)
    try {
      if (memberDirty) {
        const res = await saveMemberBenefits(bundle)
        if (!res.success) {
          toast.error(res.message)
          return
        }
        setMemberDirty(false)
      }
      if (shareDirty) {
        const res = await saveShareGiftConfig(shareConfig)
        if (!res.success) {
          toast.error(res.message)
          return
        }
        setShareDirty(false)
      }
      toast.success('保存成功')
    } catch {
      toast.error("保存失败，请稍后重试")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-[var(--foreground)]">会员权益</h1>
        <Button onClick={handleSave} loading={saving}>保存</Button>
      </div>

      <Tabs defaultValue="upgrade" className="w-full">
        <TabsList>
          <TabsTrigger value="upgrade">升级权益</TabsTrigger>
          <TabsTrigger value="birthday">生日权益</TabsTrigger>
          <TabsTrigger value="thanksgiving">感恩日</TabsTrigger>
          <TabsTrigger value="share-gift">分享礼</TabsTrigger>
        </TabsList>

        <TabsContent value="upgrade" className="space-y-6">
          <Card className="max-w-3xl">
            <CardHeader>
              <CardTitle>升级权益规则</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-xs text-[#999999]">
              <p>会员等级根据顾客滚动 12 个月累计消费额自动跳档（每日凌晨 3:00 由 cronTask 重算）。</p>
              <p>当顾客等级<strong className="text-[var(--foreground)]">升级</strong>时，系统会自动发放对应等级的<strong className="text-[var(--foreground)]">消息 + 积分 + 优惠券</strong>三件套权益。降级仅记录日志，不发权益。</p>
              <p>所有字段均可留空：积分填 0 表示不发积分，优惠券不勾选表示不发券，消息标题留空表示不发消息。</p>
            </CardContent>
          </Card>
          <MemberLevelBenefitsForm
            value={bundle.upgrade}
            onChange={updateScenario('upgrade')}
            couponTemplates={couponTemplates}
            messageTitlePlaceholder={(level: MemberLevel) => `🎉 恭喜升级为${level}会员`}
            pointsHelperText="升级到此等级时一次性奖励的积分数"
          />
        </TabsContent>

        <TabsContent value="birthday" className="space-y-6">
          <Card className="max-w-3xl">
            <CardHeader>
              <CardTitle>生日权益规则</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-xs text-[#999999]">
              <p>生日当天<strong className="text-[var(--foreground)]">凌晨 3:00</strong> 由每日定时任务按顾客当前会员等级发放<strong className="text-[var(--foreground)]">消息 + 积分 + 优惠券</strong>。</p>
              <p>一年仅发送一次，cron 重跑不会重复发放。</p>
              <p>没有生日的顾客、没有会员等级的顾客（流量/体验/小美客）不发放。</p>
              <p>2/29 出生的顾客仅在闰年当日发放，非闰年跳过。</p>
            </CardContent>
          </Card>
          <MemberLevelBenefitsForm
            value={bundle.birthday}
            onChange={updateScenario('birthday')}
            couponTemplates={couponTemplates}
            messageTitlePlaceholder={(level: MemberLevel) => `🎂 ${level}会员生日快乐`}
            pointsHelperText="生日当天一次性赠送的积分数"
          />
        </TabsContent>

        <TabsContent value="thanksgiving" className="space-y-6">
          <Card className="max-w-3xl">
            <CardHeader>
              <CardTitle>感恩日权益规则</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-xs text-[#999999]">
              <p>每月 <strong className="text-[var(--foreground)]">20 号</strong> 下服务单的顾客（即当日存在已完成或进行中服务单），按当前会员等级自动发放<strong className="text-[var(--foreground)]">消息 + 积分 + 优惠券</strong>。</p>
              <p>本次发放的优惠券<strong className="text-[var(--foreground)]">有效期为 10 天</strong>。同一顾客同一月仅发放一次。</p>
            </CardContent>
          </Card>
          <MemberLevelBenefitsForm
            value={bundle.thanksgiving}
            onChange={updateScenario('thanksgiving')}
            couponTemplates={couponTemplates}
            messageTitlePlaceholder={(level: MemberLevel) => `💝 感恩回馈 · ${level}专享`}
            pointsHelperText="感恩日一次性赠送的积分数"
          />
        </TabsContent>

        <TabsContent value="share-gift" className="space-y-6">
          <Card className="max-w-3xl">
            <CardHeader>
              <CardTitle>分享礼规则</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-xs text-[#999999]">
              <p>老顾客通过小程序分享，把<strong className="text-[var(--foreground)]">新顾客</strong>邀请进来并完成<strong className="text-[var(--foreground)]">首笔订单付款</strong>之后，系统会给邀请人和新顾客<strong className="text-[var(--foreground)]">各发一张代金券，并各自收到一条站内消息提醒</strong>。</p>
              <p>代金券的金额按"本单实付金额 × 下方设置的比例"算出来，并保证不低于"面值下限"、不高于"面值上限"。</p>
              <p>如果这笔单子是<strong className="text-[var(--foreground)]">储值卡全额抵扣（实付 0 元）</strong>，不发分享礼。同一笔订单<strong className="text-[var(--foreground)]">只会发一次</strong>，重复触发不会重复发券。</p>
              <p>下方"启用分享礼"关闭、或者没选券模板时，系统不会发放任何分享礼。</p>
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
                  <div className="text-xs text-[#999999]">关闭后系统不再发放分享礼，已经发出去的代金券不受影响</div>
                </div>
                <Switch
                  checked={shareConfig.enabled}
                  onCheckedChange={(v) => updateShare('enabled', v)}
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="space-y-1">
                  <label className="text-sm font-medium text-[var(--foreground)]">代金券比例</label>
                  <div className="flex items-center gap-2">
                    <Input
                      type="number"
                      min={0.01}
                      max={0.5}
                      step={0.01}
                      value={shareConfig.percent}
                      onChange={(e) => updateShare('percent', Number(e.target.value) || 0)}
                    />
                    <span className="text-sm text-[#999999] shrink-0">
                      相当于 {(shareConfig.percent * 100).toFixed(1)}%
                    </span>
                  </div>
                  <div className="text-xs text-[#999999]">本单实付金额的多少比例发给顾客，最低 1%、最高 50%，建议 15%</div>
                </div>

                <div className="space-y-1">
                  <label className="text-sm font-medium text-[var(--foreground)]">面值下限（元）</label>
                  <Input
                    type="number"
                    min={0}
                    step={0.01}
                    value={shareConfig.minFaceValue}
                    onChange={(e) => updateShare('minFaceValue', Number(e.target.value) || 0)}
                  />
                  <div className="text-xs text-[#999999]">算出来的金额比这个低，就按这个金额发（避免发出太小的券）</div>
                </div>

                <div className="space-y-1">
                  <label className="text-sm font-medium text-[var(--foreground)]">面值上限（元）</label>
                  <Input
                    type="number"
                    min={0}
                    step={0.01}
                    value={shareConfig.maxFaceValue}
                    onChange={(e) => updateShare('maxFaceValue', Number(e.target.value) || 0)}
                  />
                  <div className="text-xs text-[#999999]">算出来的金额比这个高，就按这个金额发（避免发出过大的券）</div>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-sm font-medium text-[var(--foreground)]">使用的代金券模板</label>
                  <Select
                    value={shareConfig.couponTemplateId}
                    onChange={(e) => updateShare('couponTemplateId', e.target.value)}
                  >
                    <option value="">请选择一张代金券模板</option>
                    {couponTemplates.map((t) => (
                      <SelectOption key={t.templateId} value={t.templateId}>
                        {t.name}
                      </SelectOption>
                    ))}
                  </Select>
                  {shareConfig.enabled && !shareConfig.couponTemplateId ? (
                    <div className="text-xs text-[#D94040]">开启分享礼后必须选一张模板</div>
                  ) : selectedTemplate ? (
                    <div className="text-xs text-[#999999]">
                      已选：{selectedTemplate.name}（券的使用门槛、品类限制等按模板里的设置走，金额按上方比例覆盖）
                    </div>
                  ) : (
                    <div className="text-xs text-[#999999]">
                      代金券的使用门槛、可用品类等按模板里的设置走；金额则按上面"比例"重新算出来
                    </div>
                  )}
                </div>

                <div className="space-y-1">
                  <label className="text-sm font-medium text-[var(--foreground)]">默认有效期（天）</label>
                  <Input
                    type="number"
                    min={1}
                    max={3650}
                    step={1}
                    value={shareConfig.validityDays}
                    onChange={(e) => updateShare('validityDays', Math.floor(Number(e.target.value)) || 0)}
                  />
                  <div className="text-xs text-[#999999]">
                    只有在所选模板没有设置有效期时，才会用这里的天数兜底（一般保持 90 天即可）
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium text-[var(--foreground)]">要求邀请人本人也有过付款订单</div>
                  <div className="text-xs text-[#999999]">关闭：任何注册过的老顾客都可以邀请；开启：邀请人本人必须至少有一笔已付款的订单才能享受分享礼</div>
                </div>
                <Switch
                  checked={shareConfig.inviterMustHavePaidOrder}
                  onCheckedChange={(v) => updateShare('inviterMustHavePaidOrder', v)}
                />
              </div>
            </CardContent>
          </Card>

          <Card className="max-w-3xl">
            <CardHeader>
              <CardTitle>站内消息文案</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="text-xs text-[#999999] space-y-1">
                <div>正文里可以使用下面三个"自动替换符"，发送时会被换成实际金额和天数：</div>
                <div className="pl-2 leading-6">
                  <code className="mx-1">{'{paidAmount}'}</code> — 新顾客本单实付金额（元）<br />
                  <code className="mx-1">{'{couponValue}'}</code> — 本次发出的代金券金额（元）<br />
                  <code className="mx-1">{'{validityDays}'}</code> — 代金券有效期（天）
                </div>
                <div>某一边的"标题"留空时，这一边就不发消息，另一边照常发。</div>
              </div>

              <div className="space-y-2">
                <div className="text-sm font-semibold text-[var(--foreground)]">发给邀请人（老顾客）的消息</div>
                <div className="space-y-1">
                  <label className="text-xs text-[#999999]">标题</label>
                  <Input
                    value={shareConfig.messageInviterTitle}
                    onChange={(e) => updateShare('messageInviterTitle', e.target.value)}
                    placeholder="🎁 分享礼到账"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-[#999999]">正文</label>
                  <Textarea
                    rows={3}
                    value={shareConfig.messageInviterBody}
                    onChange={(e) => updateShare('messageInviterBody', e.target.value)}
                    placeholder="您邀请的新顾客首单已付款（¥{paidAmount}），送您一张 ¥{couponValue} 代金券，{validityDays} 天内有效。"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <div className="text-sm font-semibold text-[var(--foreground)]">发给新顾客的消息</div>
                <div className="space-y-1">
                  <label className="text-xs text-[#999999]">标题</label>
                  <Input
                    value={shareConfig.messageInviteeTitle}
                    onChange={(e) => updateShare('messageInviteeTitle', e.target.value)}
                    placeholder="🎁 新客首单回馈"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-[#999999]">正文</label>
                  <Textarea
                    rows={3}
                    value={shareConfig.messageInviteeBody}
                    onChange={(e) => updateShare('messageInviteeBody', e.target.value)}
                    placeholder="欢迎首次下单！感谢好友分享，送您一张 ¥{couponValue} 代金券，{validityDays} 天内有效。"
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
                假设新顾客首单实付 ¥{previewVars.paidAmount}，按当前设置算出来的代金券金额是 ¥{previewVars.couponValue}，有效期 {previewVars.validityDays} 天，效果如下：
              </div>

              <div className="rounded-md border border-[var(--border)] p-3 space-y-1 bg-[var(--muted)]/30">
                <div className="text-xs text-[#999999]">发给邀请人（老顾客）</div>
                <div className="text-sm font-medium text-[var(--foreground)]">
                  {renderMessage(shareConfig.messageInviterTitle, previewVars) || <span className="text-[#D94040]">（标题为空，不会发这条消息）</span>}
                </div>
                <div className="text-sm text-[var(--foreground)] whitespace-pre-wrap">
                  {renderMessage(shareConfig.messageInviterBody, previewVars)}
                </div>
              </div>

              <div className="rounded-md border border-[var(--border)] p-3 space-y-1 bg-[var(--muted)]/30">
                <div className="text-xs text-[#999999]">发给新顾客</div>
                <div className="text-sm font-medium text-[var(--foreground)]">
                  {renderMessage(shareConfig.messageInviteeTitle, previewVars) || <span className="text-[#D94040]">（标题为空，不会发这条消息）</span>}
                </div>
                <div className="text-sm text-[var(--foreground)] whitespace-pre-wrap">
                  {renderMessage(shareConfig.messageInviteeBody, previewVars)}
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
