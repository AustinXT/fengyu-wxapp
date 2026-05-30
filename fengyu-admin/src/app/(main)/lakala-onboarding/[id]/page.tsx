/**
 * 拉卡拉商户入网 · 详情页（plan §4）
 *
 * 顶部 14 步 StepProgress + 4 个子模块入口 + 已绑定门店列表
 *
 * **费率全不可见 plan §0★**：不渲染任何费率字段
 */
import Link from "next/link"
import { notFound } from "next/navigation"
import { getLakalaMerchant } from "@/actions/lakala-onboarding"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import StepProgress from "@/components/lakala/StepProgress"
import { RefreshStatusButton } from "./_components/refresh-status-button"
import type { LakalaOnboardingStatus } from "@/lib/lakala-onboarding-state"

export const dynamic = "force-dynamic"

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const detail = await getLakalaMerchant(id).catch(() => null)
  if (!detail) notFound()

  const m = detail.merchant as {
    merchantName: string
    outOrgCode: string
    contractNo: string | null
    merchantNo: string | null
    termNo: string | null
    wxSubMchid: string | null
    wxSubAppid: string | null
    alipaySubMchid: string | null
    wxRealnameStatus: string
    alipayRealnameStatus: string
    onboardingStatus: LakalaOnboardingStatus
    contractStatus: string
    lastErrorCode: string | null
    lastErrorMsg: string | null
    lastCallbackAt: string | null
    lastQueryAt: string | null
    applicantUserId: number | null
    createdAt: string
    updatedAt: string
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link href="/lakala-onboarding">
          <Button variant="outline" size="sm">
            &larr; 返回列表
          </Button>
        </Link>
        <h1 className="text-2xl font-bold text-[var(--foreground)]">
          {m.merchantName}
          {m.applicantUserId === null ? (
            <span className="ml-3 text-sm text-[#D4820A] border border-[#D4820A] rounded px-2 py-0.5">
              legacy 入库
            </span>
          ) : null}
        </h1>
      </div>

      {/* 顶部 14 步状态条 */}
      <Card>
        <CardContent className="pt-4">
          <StepProgress status={m.onboardingStatus} errorMsg={m.lastErrorMsg} />
        </CardContent>
      </Card>

      {/* 子模块入口 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Link href={`/lakala-onboarding/${id}/edit`}>
          <Card className="hover:border-[var(--primary)] cursor-pointer transition-colors">
            <CardContent className="pt-4 pb-4 text-center">
              <div className="text-sm font-medium">编辑资料</div>
              <div className="text-xs text-[var(--muted-foreground)] mt-1">基本/法人/经营/结算</div>
            </CardContent>
          </Card>
        </Link>
        <Link href={`/lakala-onboarding/${id}/attachments`}>
          <Card className="hover:border-[var(--primary)] cursor-pointer transition-colors">
            <CardContent className="pt-4 pb-4 text-center">
              <div className="text-sm font-medium">附件管理</div>
              <div className="text-xs text-[var(--muted-foreground)] mt-1">身份证 / 银行卡 / 门头照</div>
            </CardContent>
          </Card>
        </Link>
        <Link href={`/lakala-onboarding/${id}/realname`}>
          <Card className="hover:border-[var(--primary)] cursor-pointer transition-colors">
            <CardContent className="pt-4 pb-4 text-center">
              <div className="text-sm font-medium">实名报备</div>
              <div className="text-xs text-[var(--muted-foreground)] mt-1">微信 / 支付宝法人扫码</div>
            </CardContent>
          </Card>
        </Link>
        <Link href={`/lakala-onboarding/${id}/logs`}>
          <Card className="hover:border-[var(--primary)] cursor-pointer transition-colors">
            <CardContent className="pt-4 pb-4 text-center">
              <div className="text-sm font-medium">API/操作日志</div>
              <div className="text-xs text-[var(--muted-foreground)] mt-1">已脱敏审计流水</div>
            </CardContent>
          </Card>
        </Link>
      </div>

      {/* 核心信息卡片 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">交付物信息</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <Field label="进件流水号 (out_org_code)" value={m.outOrgCode} mono />
            <Field label="电子合同号 (contract_no)" value={m.contractNo} mono />
            <Field label="拉卡拉商户号 (merchant_no)" value={m.merchantNo} mono />
            <Field label="终端号 (term_no)" value={m.termNo} mono />
            <Field label="微信子商户号" value={m.wxSubMchid} mono />
            <Field label="微信子 AppId" value={m.wxSubAppid} mono />
            <Field label="支付宝子商户号" value={m.alipaySubMchid} mono />
            <Field label="申请人 (user_id)" value={m.applicantUserId == null ? "—" : String(m.applicantUserId)} />
            <Field label="创建时间" value={m.createdAt?.slice(0, 19).replace("T", " ")} />
            <Field label="更新时间" value={m.updatedAt?.slice(0, 19).replace("T", " ")} />
            <Field label="最近回调时间" value={m.lastCallbackAt?.slice(0, 19).replace("T", " ") ?? "—"} />
            <Field label="最近主动查询时间" value={m.lastQueryAt?.slice(0, 19).replace("T", " ") ?? "—"} />
          </div>
        </CardContent>
      </Card>

      {/* 开户状态反查（legacy 行也能跑，不依赖 outOrgCode/contractId） */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">开户状态</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4 text-sm mb-4">
            <Field label="微信实名状态 (wx_realname_status)" value={m.wxRealnameStatus} />
            <Field label="支付宝实名状态 (alipay_realname_status)" value={m.alipayRealnameStatus} />
          </div>
          <RefreshStatusButton merchantId={id} />
        </CardContent>
      </Card>

      {/* 已绑定门店 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">绑定门店 ({detail.linkedStores.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {detail.linkedStores.length === 0 ? (
            <div className="text-sm text-[var(--muted-foreground)] py-4 text-center">
              暂无门店选用该商户。商户审核通过后，可在「门店管理 - 编辑门店」中关联。
            </div>
          ) : (
            <div className="space-y-2">
              {detail.linkedStores.map((s) => (
                <div
                  key={s.storeId}
                  className="flex items-center justify-between border border-[var(--border)] rounded p-3 text-sm"
                >
                  <div className="font-medium">{s.storeName}</div>
                  <Link href={`/stores/${s.storeId}/edit`}>
                    <Button variant="link" size="sm" className="h-auto p-0">
                      编辑门店
                    </Button>
                  </Link>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function Field({ label, value, mono }: { label: string; value: string | null | undefined; mono?: boolean }) {
  return (
    <div>
      <div className="text-xs text-[var(--muted-foreground)] mb-1">{label}</div>
      <div className={mono ? "font-mono text-xs break-all" : ""}>{value ?? "—"}</div>
    </div>
  )
}
