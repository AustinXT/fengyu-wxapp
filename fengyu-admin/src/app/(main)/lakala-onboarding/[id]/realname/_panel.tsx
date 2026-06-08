"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { submitWxRealname, submitAlipayRealname } from "@/actions/lakala-onboarding"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

const SUCCESS_HINT = "法人扫码授权完成"

interface MerchantSlice {
  wxRealnameStatus: string
  wxRealnameQrcodeUrl: string | null
  wxSubMchid: string | null
  alipayRealnameStatus: string
  alipayRealnameQrcodeUrl: string | null
  alipaySubMchid: string | null
}

export default function RealnamePanel({ id, merchant }: { id: string; merchant: MerchantSlice }) {
  return (
    <Tabs defaultValue="wx" className="space-y-4">
      <TabsList>
        <TabsTrigger value="wx">微信实名</TabsTrigger>
        <TabsTrigger value="alipay">支付宝实名</TabsTrigger>
      </TabsList>
      <TabsContent value="wx">
        <RealnameTab
          id={id}
          channel="wx"
          status={merchant.wxRealnameStatus}
          qrcodeUrl={merchant.wxRealnameQrcodeUrl}
          subMchid={merchant.wxSubMchid}
        />
      </TabsContent>
      <TabsContent value="alipay">
        <RealnameTab
          id={id}
          channel="alipay"
          status={merchant.alipayRealnameStatus}
          qrcodeUrl={merchant.alipayRealnameQrcodeUrl}
          subMchid={merchant.alipaySubMchid}
        />
      </TabsContent>
    </Tabs>
  )
}

function RealnameTab({
  id,
  channel,
  status,
  qrcodeUrl,
  subMchid,
}: {
  id: string
  channel: "wx" | "alipay"
  status: string
  qrcodeUrl: string | null
  subMchid: string | null
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [receOrgNo, setReceOrgNo] = useState("")
  const [submchInput, setSubmchInput] = useState(subMchid ?? "")
  const [channelId, setChannelId] = useState("")
  const isSuccess = status === "success"

  // 每 5 秒 router.refresh() 重新 SSR 拉详情 — 状态由 cron 兜底 query{Wx/Alipay}Realname 推进
  useEffect(() => {
    if (isSuccess) return
    const t = setInterval(() => router.refresh(), 5000)
    return () => clearInterval(t)
  }, [router, isSuccess])

  // 进入"成功"那一刻给出 toast
  useEffect(() => {
    if (isSuccess) toast.success(SUCCESS_HINT)
  }, [isSuccess])

  const handleSubmit = async () => {
    if (!submchInput || !channelId || !receOrgNo) {
      toast.error("请填写受理机构号 / 子商户号 / 渠道号")
      return
    }
    setBusy(true)
    try {
      const submit = channel === "wx" ? submitWxRealname : submitAlipayRealname
      const result = await submit(id, {
        receOrgNo,
        subMchId: submchInput,
        channelId,
      })
      if (!result?.success) {
        toast.error(result?.message ?? "提交实名失败")
        return
      }
      toast.success("已发起实名报备，请法人扫码授权")
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "提交实名失败")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardContent className="pt-4 space-y-4">
        <div className="flex items-center gap-3 text-sm">
          <span className="text-[var(--muted-foreground)]">报备状态：</span>
          <span
            className={
              isSuccess
                ? "font-medium text-[#3D8A5A]"
                : status === "submitted"
                ? "font-medium text-[#D4820A]"
                : status === "fail"
                ? "font-medium text-[#D94040]"
                : "font-medium text-[#888888]"
            }
          >
            {status}
          </span>
          {subMchid && (
            <span className="ml-3 text-[var(--muted-foreground)]">
              子商户号：<span className="font-mono">{subMchid}</span>
            </span>
          )}
        </div>

        {qrcodeUrl ? (
          <div className="flex flex-col items-center py-4">
            {/* base64 / https / data: 三种来源都能直接当 img src */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={qrcodeUrl.startsWith("data:") || qrcodeUrl.startsWith("http") ? qrcodeUrl : `data:image/png;base64,${qrcodeUrl}`}
              alt="法人扫码授权"
              className="w-56 h-56 border border-[var(--border)] rounded"
            />
            <div className="mt-3 text-sm text-[var(--muted-foreground)]">
              请法人使用{channel === "wx" ? "微信" : "支付宝"}扫码完成实名授权。每 5 秒自动刷新状态。
            </div>
          </div>
        ) : (
          <div className="space-y-3 text-sm">
            <div className="text-[var(--muted-foreground)] py-2 text-center">
              暂未发起实名报备。填齐下方参数后发起，会生成法人扫码授权二维码。
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1">
                <label className="text-xs">受理机构号 (receOrgNo)</label>
                <Input value={receOrgNo} onChange={(e) => setReceOrgNo(e.target.value)} placeholder="如 12345678" />
              </div>
              <div className="space-y-1">
                <label className="text-xs">子商户号 (subMchId)</label>
                <Input value={submchInput} onChange={(e) => setSubmchInput(e.target.value)} placeholder="拉卡拉报备结果查询" />
              </div>
              <div className="space-y-1">
                <label className="text-xs">渠道号 (channelId)</label>
                <Input value={channelId} onChange={(e) => setChannelId(e.target.value)} placeholder="如 LKLAPI" />
              </div>
            </div>
          </div>
        )}

        <div className="flex justify-end gap-3">
          <Button variant="outline" onClick={() => router.refresh()} disabled={busy}>
            手动刷新
          </Button>
          {!isSuccess && (
            <Button onClick={handleSubmit} disabled={busy}>
              {qrcodeUrl ? "重新发起实名" : "发起实名报备"}
            </Button>
          )}
          {isSuccess && (
            <span className="text-sm font-medium text-[#3D8A5A] flex items-center px-3">
              {SUCCESS_HINT}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
