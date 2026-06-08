"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { saveDraft, applyContract, submitMerchant } from "@/actions/lakala-onboarding"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Select } from "@/components/ui/select"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { useUnsavedChanges } from "@/lib/hooks/use-unsaved-changes"
import {
  MER_BUSI_CONTENTS,
  POS_TYPES,
  SETTLE_PERIODS,
  CERT_TYPES,
  EC_TYPES,
  MCC_CODES,
  ACCT_TYPES,
  DIST_CODES,
  ATTACHMENT_TYPES,
  CLEAR_DTS,
  LAR_ID_TYPE_TO_EC_CERT_TYPE,
} from "@/lib/lakala-dicts"

/**
 * 草稿态完整表单字段（plan §4 6 分组：基本/法人/经营/结算/附件/实名报备）。
 * 禁止任何费率类字段（plan §0★ 守护，lakala-no-rate-leak.test.ts CI 扫描）。
 */
interface FormState {
  // 基本
  merchantName: string
  merBizName: string
  posType: string
  ecTypeCode: string
  contactName: string
  contactMobile: string
  // 法人
  larName: string
  larIdType: string
  larIdcard: string
  larIdcardStDt: string
  larIdcardExpDt: string
  // 经营
  merBizContent: string
  mccCode: string
  merBlisName: string
  merBlisNo: string
  merBlisStDt: string
  merBlisExpDt: string
  merRegDistCode: string
  merRegAddr: string
  // 结算
  acctTypeCode: string
  acctName: string
  acctNo: string
  openningBankCode: string
  openningBankName: string
  clearingBankCode: string
  settlePeriod: string
  clearDt: string
  // 实名报备（提交后由实名子页推进；这里仅做联系信息）
  realnameContactName: string
  realnameContactMobile: string
}

export default function LakalaEditForm({
  id,
  merchant,
}: {
  id: string
  merchant: Record<string, unknown>
}) {
  const router = useRouter()
  const formData = (merchant.formData ?? {}) as Partial<FormState>
  const onboardingStatus = (merchant.onboardingStatus as string) ?? "draft"
  const expectedUpdatedAt = (merchant.updatedAt as string) ?? ""
  const editable = onboardingStatus === "draft"

  const [state, setState] = useState<FormState>({
    merchantName: ((merchant.merchantName as string) ?? "") || "",
    merBizName: formData.merBizName ?? "",
    posType: formData.posType ?? "WECHAT_PAY",
    ecTypeCode: formData.ecTypeCode ?? "EC015",
    contactName: formData.contactName ?? "",
    contactMobile: formData.contactMobile ?? "",
    larName: formData.larName ?? "",
    larIdType: formData.larIdType ?? "01",
    larIdcard: formData.larIdcard ?? "",
    larIdcardStDt: formData.larIdcardStDt ?? "",
    larIdcardExpDt: formData.larIdcardExpDt ?? "",
    merBizContent: formData.merBizContent ?? "640",
    mccCode: formData.mccCode ?? "7298",
    merBlisName: formData.merBlisName ?? "",
    merBlisNo: formData.merBlisNo ?? "",
    merBlisStDt: formData.merBlisStDt ?? "",
    merBlisExpDt: formData.merBlisExpDt ?? "",
    merRegDistCode: formData.merRegDistCode ?? "430800",
    merRegAddr: formData.merRegAddr ?? "",
    acctTypeCode: formData.acctTypeCode ?? "58",
    acctName: formData.acctName ?? "",
    acctNo: formData.acctNo ?? "",
    openningBankCode: formData.openningBankCode ?? "",
    openningBankName: formData.openningBankName ?? "",
    clearingBankCode: formData.clearingBankCode ?? "",
    settlePeriod: formData.settlePeriod ?? "T+1",
    clearDt: formData.clearDt ?? "TWENTY_THREE",
    realnameContactName: formData.realnameContactName ?? "",
    realnameContactMobile: formData.realnameContactMobile ?? "",
  })

  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  useUnsavedChanges(dirty)

  const upd = <K extends keyof FormState>(k: K, v: FormState[K]) => {
    setState((s) => ({ ...s, [k]: v }))
    setDirty(true)
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      // Phase 2D saveDraft 签名：saveDraft(merchantId, data, expectedUpdatedAt)
      const result = await saveDraft(
        id,
        { merchantName: state.merchantName, formData: state as unknown as Record<string, unknown> },
        expectedUpdatedAt,
      )
      if (!result?.success) {
        toast.error(result?.message ?? "保存失败")
        if (result?.message?.includes("已被其他人修改")) router.refresh()
        return
      }
      setDirty(false)
      toast.success("保存成功")
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "保存失败")
    } finally {
      setSaving(false)
    }
  }

  const handleApplyContract = async () => {
    if (dirty) {
      toast.error("有未保存的修改，请先保存")
      return
    }
    if (!state.larName || !state.larIdcard || !state.acctNo || !state.acctName || !state.contactMobile) {
      toast.error("请先在草稿中填齐法人 / 结算账户 / 联系人信息")
      return
    }
    setSaving(true)
    try {
      const orderNo = `LK${Date.now()}${Math.random().toString(36).slice(2, 10)}`
      const result = await applyContract(id, {
        orderNo,
        orgId: 0, // 由 action / env 注入实际机构号
        ecTypeCode: state.ecTypeCode,
        certType: LAR_ID_TYPE_TO_EC_CERT_TYPE[state.larIdType] ?? "RESIDENT_ID",
        certName: state.larName,
        certNo: state.larIdcard,
        mobile: state.contactMobile,
        businessLicenseNo: state.merBlisNo || undefined,
        businessLicenseName: state.merBlisName || undefined,
        openningBankCode: state.openningBankCode,
        openningBankName: state.openningBankName,
        acctTypeCode: state.acctTypeCode,
        acctNo: state.acctNo,
        acctName: state.acctName,
        ecContentParameters: JSON.stringify({}),
      })
      if (!result?.success) {
        toast.error(result?.message ?? "申请合同失败")
        return
      }
      toast.success("已申请电子合同，等待法人签署")
      router.push(`/lakala-onboarding/${id}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "申请合同失败")
    } finally {
      setSaving(false)
    }
  }

  const handleSubmit = async () => {
    if (dirty) {
      toast.error("有未保存的修改，请先保存")
      return
    }
    setSaving(true)
    try {
      // submitMerchant payload 字段名按 endpoints §6 wire 命名
      const result = await submitMerchant(id, {
        posType: state.posType,
        merRegName: state.merchantName,
        merBizName: state.merBizName || undefined,
        merRegDistCode: state.merRegDistCode,
        merRegAddr: state.merRegAddr,
        mccCode: state.mccCode,
        merBlisName: state.merBlisName || undefined,
        merBlis: state.merBlisNo || undefined,
        merBlisStDt: state.merBlisStDt || undefined,
        merBlisExpDt: state.merBlisExpDt || undefined,
        merBusiContent: state.merBizContent,
        larName: state.larName,
        larIdType: state.larIdType,
        larIdcard: state.larIdcard,
        larIdcardStDt: state.larIdcardStDt,
        larIdcardExpDt: state.larIdcardExpDt,
        merContactMobile: state.contactMobile,
        merContactName: state.contactName,
        openningBankCode: state.openningBankCode,
        openningBankName: state.openningBankName,
        clearingBankCode: state.clearingBankCode,
        acctNo: state.acctNo,
        acctName: state.acctName,
        acctTypeCode: state.acctTypeCode,
        settlePeriod: state.settlePeriod,
        clearDt: state.clearDt,
      } as Parameters<typeof submitMerchant>[1])
      if (!result?.success) {
        toast.error(result?.message ?? "提交进件失败")
        return
      }
      toast.success("进件已提交，等待拉卡拉审核回调")
      router.push(`/lakala-onboarding/${id}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "提交进件失败")
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={(e) => e.preventDefault()} className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-[var(--foreground)]">编辑商户入网信息</h1>
        <div className="text-sm text-[var(--muted-foreground)]">
          当前状态：<span className="font-medium">{onboardingStatus}</span>
        </div>
      </div>

      {!editable && (
        <div className="rounded border border-[#D4820A] bg-[#FFF8E6] text-[#D4820A] text-sm px-3 py-2">
          当前状态不可编辑表单。如需修改资料请走「商户信息变更」流程。
        </div>
      )}

      {/* 1. 基本 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">1. 基本</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4">
            <Labeled label="商户注册名">
              <Input
                value={state.merchantName}
                onChange={(e) => upd("merchantName", e.target.value)}
                disabled={!editable}
                maxLength={80}
              />
            </Labeled>
            <Labeled label="商户经营名（可空，默认同注册名）">
              <Input
                value={state.merBizName}
                onChange={(e) => upd("merBizName", e.target.value)}
                disabled={!editable}
                maxLength={64}
              />
            </Labeled>
            <Labeled label="POS 类型">
              <Select value={state.posType} onChange={(e) => upd("posType", e.target.value)} disabled={!editable}>
                {POS_TYPES.map((o) => (
                  <option key={o.code} value={o.code}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Labeled>
            <Labeled label="电子合同类型">
              <Select value={state.ecTypeCode} onChange={(e) => upd("ecTypeCode", e.target.value)} disabled={!editable}>
                {EC_TYPES.map((o) => (
                  <option key={o.code} value={o.code}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Labeled>
            <Labeled label="联系人">
              <Input value={state.contactName} onChange={(e) => upd("contactName", e.target.value)} disabled={!editable} maxLength={32} />
            </Labeled>
            <Labeled label="联系手机">
              <Input value={state.contactMobile} onChange={(e) => upd("contactMobile", e.target.value)} disabled={!editable} maxLength={20} />
            </Labeled>
          </div>
        </CardContent>
      </Card>

      {/* 2. 法人 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">2. 法人</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4">
            <Labeled label="法人姓名">
              <Input value={state.larName} onChange={(e) => upd("larName", e.target.value)} disabled={!editable} maxLength={20} />
            </Labeled>
            <Labeled label="证件类型">
              <Select value={state.larIdType} onChange={(e) => upd("larIdType", e.target.value)} disabled={!editable}>
                {CERT_TYPES.map((o) => (
                  <option key={o.code} value={o.code}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Labeled>
            <Labeled label="证件号">
              <Input value={state.larIdcard} onChange={(e) => upd("larIdcard", e.target.value)} disabled={!editable} maxLength={40} />
            </Labeled>
            <Labeled label="证件开始日期">
              <Input type="date" value={state.larIdcardStDt} onChange={(e) => upd("larIdcardStDt", e.target.value)} disabled={!editable} />
            </Labeled>
            <Labeled label="证件有效期">
              <Input type="date" value={state.larIdcardExpDt} onChange={(e) => upd("larIdcardExpDt", e.target.value)} disabled={!editable} />
            </Labeled>
          </div>
        </CardContent>
      </Card>

      {/* 3. 经营 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">3. 经营</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4">
            <Labeled label="经营内容">
              <Select value={state.merBizContent} onChange={(e) => upd("merBizContent", e.target.value)} disabled={!editable}>
                {MER_BUSI_CONTENTS.map((o) => (
                  <option key={o.code} value={o.code}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Labeled>
            <Labeled label="MCC 编码">
              <Select value={state.mccCode} onChange={(e) => upd("mccCode", e.target.value)} disabled={!editable}>
                {MCC_CODES.map((o) => (
                  <option key={o.code} value={o.code}>
                    {o.code} {o.label}
                  </option>
                ))}
              </Select>
            </Labeled>
            <Labeled label="营业执照名称">
              <Input value={state.merBlisName} onChange={(e) => upd("merBlisName", e.target.value)} disabled={!editable} maxLength={80} />
            </Labeled>
            <Labeled label="营业执照号">
              <Input value={state.merBlisNo} onChange={(e) => upd("merBlisNo", e.target.value)} disabled={!editable} maxLength={40} />
            </Labeled>
            <Labeled label="执照开始日期">
              <Input type="date" value={state.merBlisStDt} onChange={(e) => upd("merBlisStDt", e.target.value)} disabled={!editable} />
            </Labeled>
            <Labeled label="执照有效期">
              <Input type="date" value={state.merBlisExpDt} onChange={(e) => upd("merBlisExpDt", e.target.value)} disabled={!editable} />
            </Labeled>
            <Labeled label="商户地区码">
              <Select value={state.merRegDistCode} onChange={(e) => upd("merRegDistCode", e.target.value)} disabled={!editable}>
                {DIST_CODES.map((o) => (
                  <option key={o.code} value={o.code}>
                    {o.code} {o.label}
                  </option>
                ))}
              </Select>
            </Labeled>
            <div className="col-span-2">
              <Labeled label="商户详细地址（去省市区）">
                <Textarea value={state.merRegAddr} onChange={(e) => upd("merRegAddr", e.target.value)} disabled={!editable} maxLength={200} />
              </Labeled>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 4. 结算 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">4. 结算</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4">
            <Labeled label="结算账户性质">
              <Select value={state.acctTypeCode} onChange={(e) => upd("acctTypeCode", e.target.value)} disabled={!editable}>
                {ACCT_TYPES.map((o) => (
                  <option key={o.code} value={o.code}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Labeled>
            <Labeled label="结算账户名">
              <Input value={state.acctName} onChange={(e) => upd("acctName", e.target.value)} disabled={!editable} maxLength={40} />
            </Labeled>
            <Labeled label="结算账号">
              <Input value={state.acctNo} onChange={(e) => upd("acctNo", e.target.value)} disabled={!editable} maxLength={40} />
            </Labeled>
            <Labeled label="结算开户行号">
              <Input value={state.openningBankCode} onChange={(e) => upd("openningBankCode", e.target.value)} disabled={!editable} maxLength={20} />
            </Labeled>
            <Labeled label="开户行名称">
              <Input value={state.openningBankName} onChange={(e) => upd("openningBankName", e.target.value)} disabled={!editable} maxLength={40} />
            </Labeled>
            <Labeled label="结算清算行号">
              <Input value={state.clearingBankCode} onChange={(e) => upd("clearingBankCode", e.target.value)} disabled={!editable} maxLength={20} />
            </Labeled>
            <Labeled label="结算周期">
              <Select value={state.settlePeriod} onChange={(e) => upd("settlePeriod", e.target.value)} disabled={!editable}>
                {SETTLE_PERIODS.map((o) => (
                  <option key={o.code} value={o.code}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Labeled>
            <Labeled label="日切时间">
              <Select value={state.clearDt} onChange={(e) => upd("clearDt", e.target.value)} disabled={!editable}>
                {CLEAR_DTS.map((o) => (
                  <option key={o.code} value={o.code}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Labeled>
          </div>
        </CardContent>
      </Card>

      {/* 5. 附件 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">5. 附件</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-[var(--muted-foreground)] mb-3">
            必传附件：法人身份证正反面 / 银行卡 / 营业执照 / 门头照 / 内景照；详细管理见{" "}
            <a className="text-[var(--primary)] hover:underline" href={`/lakala-onboarding/${id}/attachments`}>
              附件管理子页
            </a>
          </div>
          <div className="grid grid-cols-3 gap-2 text-xs">
            {ATTACHMENT_TYPES.slice(0, 6).map((a) => (
              <div key={a.code} className="border border-[var(--border)] rounded px-2 py-1.5">
                {a.label}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* 6. 实名报备 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">6. 实名报备</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-[var(--muted-foreground)] mb-3">
            进件审核通过后，由法人本人扫码完成微信 / 支付宝实名授权；详细步骤见{" "}
            <a className="text-[var(--primary)] hover:underline" href={`/lakala-onboarding/${id}/realname`}>
              实名报备子页
            </a>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Labeled label="实名联系人">
              <Input value={state.realnameContactName} onChange={(e) => upd("realnameContactName", e.target.value)} disabled={!editable} maxLength={32} />
            </Labeled>
            <Labeled label="实名联系人手机">
              <Input value={state.realnameContactMobile} onChange={(e) => upd("realnameContactMobile", e.target.value)} disabled={!editable} maxLength={20} />
            </Labeled>
          </div>
        </CardContent>
      </Card>

      <Separator />

      <div className="flex justify-end gap-3">
        <Button type="button" variant="outline" onClick={() => router.back()}>
          取消
        </Button>
        <Button type="button" variant="outline" onClick={handleSave} disabled={!editable || saving}>
          {saving ? "保存中..." : "保存草稿"}
        </Button>
        {onboardingStatus === "draft" && (
          <Button type="button" onClick={handleApplyContract} disabled={saving}>
            申请电子合同
          </Button>
        )}
        {onboardingStatus === "attachments_uploading" && (
          <Button type="button" onClick={handleSubmit} disabled={saving}>
            提交进件
          </Button>
        )}
      </div>
    </form>
  )
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <label className="text-sm font-medium">{label}</label>
      {children}
    </div>
  )
}
