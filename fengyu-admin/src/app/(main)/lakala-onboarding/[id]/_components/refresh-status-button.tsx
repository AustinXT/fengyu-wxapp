'use client'

/**
 * 「从拉卡拉反查开户状态」按钮（client component）
 *
 * 调 `refreshMerchantStatusFromLakala` action，调拉卡拉 queryWxConfig × 2（WECHAT + ALIPAY）
 * 回写 lakala_merchants.wx_realname_status / alipay_realname_status。
 *
 * 适用：legacy 行也能跑（不需要 outOrgCode / contractId）。
 *
 * UI 行为：
 *   - 点击 → 调 action → toast 反馈拉卡拉返回的 code+raw status
 *   - 若网关返 GW0004（IP 白名单未通），按钮看似成功但提示"IP 白名单"建议
 *   - 调用后 server component 自动 revalidate，wxRealnameStatus / alipayRealnameStatus 显示同步刷新
 */

import { useState, useTransition } from 'react'
import { Button } from '@/components/ui/button'
import { refreshMerchantStatusFromLakala } from '@/actions/lakala-onboarding'

type RefreshResult = Awaited<ReturnType<typeof refreshMerchantStatusFromLakala>>

export function RefreshStatusButton({ merchantId }: { merchantId: string }) {
  const [pending, startTransition] = useTransition()
  const [lastResult, setLastResult] = useState<RefreshResult | null>(null)

  function onClick() {
    startTransition(async () => {
      const r = await refreshMerchantStatusFromLakala(merchantId)
      setLastResult(r)
    })
  }

  return (
    <div className="space-y-3">
      <Button onClick={onClick} disabled={pending} variant="outline" size="sm">
        {pending ? '反查中…' : '从拉卡拉反查开户状态'}
      </Button>

      {lastResult ? (
        <div className="text-xs space-y-1">
          {!lastResult.success ? (
            <div className="text-[#D94040]">{lastResult.message}</div>
          ) : (
            <>
              <StatusLine label="微信" detail={lastResult.wx} />
              <StatusLine label="支付宝" detail={lastResult.alipay} />
              {(lastResult.wx?.code === 'GW0004' || lastResult.alipay?.code === 'GW0004') ? (
                <div className="text-[#D4820A] mt-2">
                  ⚠️ 拉卡拉网关返 GW0004（IP 白名单未通）。代码层、签名层都对，需业务方联系拉卡拉客户经理把出口 IP 加入白名单。
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}

function StatusLine({
  label,
  detail,
}: {
  label: string
  detail?: { code: string; msg: string; raw?: string | null; mapped?: string }
}) {
  if (!detail) return null
  const isOK = detail.code === '000000'
  return (
    <div className={isOK ? 'text-[#3D8A5A]' : 'text-[var(--muted-foreground)]'}>
      <span className="font-medium">{label}：</span>
      code={detail.code}, msg={detail.msg}
      {detail.raw ? <>, 拉卡拉 raw={detail.raw}</> : null}
      {detail.mapped ? <>, 映射={detail.mapped}</> : null}
    </div>
  )
}
