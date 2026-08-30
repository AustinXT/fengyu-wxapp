"use client"

import { useEffect, useMemo, useState, useTransition } from "react"
import Link from "next/link"
import { PreserveListContextLink, ReturnContextLink } from "@/components/return-context"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  ArrowLeft,
  Building2,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  CreditCard,
  FileCheck2,
  FileText,
  FileWarning,
  Plus,
  RefreshCw,
  Save,
  Send,
  Store,
  Trash2,
  Upload,
  UserRound,
} from "lucide-react"
import {
  createOnboardingApplication,
  confirmOnboardingExternalCertification,
  initiateElectronicContract,
  deleteOnboardingApplication,
  queryOnboardingApplication,
  refreshOnboardingSubMerchants,
  reconsiderOnboardingApplication,
  searchOnboardingBanks,
  saveOnboardingApplication,
  submitOnboardingApplication,
  type OnboardingApplicationInput,
  type OnboardingBankOption,
  type OnboardingDetail,
  type OnboardingListItem,
  type OnboardingStatus,
  type OnboardingStoreOption,
} from "@/actions/lakala-onboarding"
import { ATTACHMENT_REQUIREMENTS, MAX_ONBOARDING_ATTACHMENT_BYTES } from "@/lib/lakala-onboarding-constants"
import { actionErrorMessage } from "@/lib/action-error"
import { areaCodeFromAddress, getAreaPathByCode, getCityOptions, getCountyOptions, getProvinceOptions } from "@/lib/china-area"
import {
  getLakalaMerchantAreaPathByCode,
  getLakalaMerchantCityOptions,
  getLakalaMerchantCountyOptions,
  getLakalaMerchantProvinceOptions,
  lakalaMerchantAreaCodeFromAddress,
} from "@/lib/lakala-merchant-area"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { DatePicker } from "@/components/ui/date-picker"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { cn, formatDateTime } from "@/lib/utils"

const statusText: Record<OnboardingStatus, string> = {
  DRAFT: "草稿",
  FILES_UPLOADING: "资料保存中",
  FILES_READY: "资料已保存",
  SUBMITTING: "提交中",
  SUBMITTED: "已提交",
  REGISTERING: "报备中",
  SUCCESS: "成功",
  FAILED: "失败",
  CANCELLED: "已取消",
}

function StatusBadge({ status, label }: { status: OnboardingStatus; label?: string }) {
  const done = label === "办理完成"
  const warning = label === "待渠道报备" || label === "待终端号" || label === "待外部认证" || label === "待启用"
  const danger = label === "失败"
  const warm = danger || warning || ["DRAFT", "FILES_UPLOADING", "FAILED"].includes(status)
  const ok = done || (!label && ["FILES_READY", "SUCCESS", "SUBMITTED"].includes(status))
  return (
    <Badge
      variant="outline"
      className={cn(
        warm && "border-[#D4820A] bg-[#FFF8E6] text-[#A45D00]",
        ok && "border-[#3D8A5A] bg-[#F0F9F2] text-[#287342]",
        !warm && !ok && "border-[#7A67A8] bg-[#F5F1FA] text-[#62508B]",
      )}
    >
      {label ?? statusText[status] ?? status}
    </Badge>
  )
}

function getChannelSubMerchantText(channelData: Record<string, unknown>, key: "wechat" | "alipay") {
  const value = channelData[key]
  if (!Array.isArray(value)) return ""
  return value.map((item) => {
    if (!item || typeof item !== "object") return ""
    const subMerchantNo = (item as Record<string, unknown>).subMerchantNo
    return typeof subMerchantNo === "string" ? subMerchantNo : ""
  }).filter(Boolean).join("、")
}

function getTerminalNo(application: Pick<OnboardingListItem, "terminalNo"> | OnboardingDetail) {
  if (application.terminalNo) return application.terminalNo
  const terminalData = "terminalData" in application ? application.terminalData : null
  const value = terminalData?.termNo || terminalData?.terminalNo || terminalData?.term_no
  return typeof value === "string" ? value.trim() : ""
}

function applicationBusinessStatus(application: Pick<OnboardingListItem, "status" | "lakalaMerchantId" | "lakalaMerchantEnabled" | "channelData" | "merCupNo" | "terminalNo">) {
  if (application.status !== "SUCCESS") return { label: statusText[application.status] ?? application.status, todo: application.status === "REGISTERING" ? "等待拉卡拉审核" : null }
  const wechatSubMerchant = getChannelSubMerchantText(application.channelData, "wechat")
  const alipaySubMerchant = getChannelSubMerchantText(application.channelData, "alipay")
  const terminalNo = getTerminalNo(application)
  if (!application.merCupNo) return { label: "待渠道报备", todo: "等待银联商户号" }
  if (!terminalNo) return { label: "待终端号", todo: "请查询状态获取终端号" }
  if (!wechatSubMerchant) return { label: "待渠道报备", todo: "等待微信子商户号" }
  if (!alipaySubMerchant) return { label: "待渠道报备", todo: "等待支付宝子商户号" }
  if (application.lakalaMerchantId) {
    return application.lakalaMerchantEnabled
      ? { label: "办理完成", todo: "收款商户已启用并绑定门店" }
      : { label: "待启用", todo: "已关联收款商户，请到收款商户页手动启用" }
  }
  return { label: "待外部认证", todo: "请法人按指南完成微信/支付宝认证后关联收款商户" }
}

function setGroupValue(
  form: OnboardingApplicationInput,
  group: keyof OnboardingApplicationInput,
  name: string,
  value: string,
): OnboardingApplicationInput {
  return { ...form, [group]: { ...(form[group] ?? {}), [name]: value } }
}

function removeAreaPrefix(address?: string, countyCode?: string) {
  let result = (address || "").trim()
  if (!result) return result

  const labels = new Set<string>()
  const selectedArea = getAreaPathByCode(countyCode)
  if (selectedArea.label) labels.add(selectedArea.label)
  const selectedLakalaArea = getLakalaMerchantAreaPathByCode(countyCode)
  if (selectedLakalaArea.label) labels.add(selectedLakalaArea.label)

  const ocrAreaCode = areaCodeFromAddress(result)
  const ocrArea = getAreaPathByCode(ocrAreaCode)
  if (ocrArea.label) labels.add(ocrArea.label)
  const ocrLakalaAreaCode = lakalaMerchantAreaCodeFromAddress(result)
  const ocrLakalaArea = getLakalaMerchantAreaPathByCode(ocrLakalaAreaCode)
  if (ocrLakalaArea.label) labels.add(ocrLakalaArea.label)

  for (const label of labels) {
    const parts = [
      label.match(/^.+?(省|自治区|市)/)?.[0] ?? "",
      label.replace(/^.+?(省|自治区|市)/, "").match(/^.+?(市|自治州|地区|盟)/)?.[0] ?? "",
      label.replace(/^.+?(省|自治区|市)/, "").replace(/^.+?(市|自治州|地区|盟)/, ""),
    ].filter(Boolean)
    for (const part of parts) {
      if (part && result.startsWith(part)) result = result.slice(part.length).trim()
    }
  }

  return result
}

function shortLakalaAddress(address?: string, countyCode?: string) {
  const withoutArea = removeAreaPrefix(address, countyCode)
  const firstSegment = withoutArea.split(/[、，,；;]/)[0]?.trim()
  return firstSegment || withoutArea
}

function normalizeOnboardingFormForDisplay(form: OnboardingApplicationInput): OnboardingApplicationInput {
  const merRegAddr = shortLakalaAddress(form.merchantData.merRegAddr, form.merchantData.merRegDistCode)
  return {
    ...form,
    merchantData: {
      ...form.merchantData,
      ...(merRegAddr ? { merRegAddr } : {}),
    },
  }
}

function Field({
  form,
  setForm,
  group,
  name,
  label,
  hint,
  inputType = "text",
  date = false,
  maxLength,
}: {
  form: OnboardingApplicationInput
  setForm: (form: OnboardingApplicationInput) => void
  group: keyof OnboardingApplicationInput
  name: string
  label: string
  hint?: string
  inputType?: string
  date?: boolean
  maxLength?: number
}) {
  const value = (form[group] ?? {})[name] ?? ""
  return (
    <label className="block">
      <span className="text-sm font-medium text-[var(--foreground)]">{label}</span>
      {date ? (
        <DatePicker
          value={value}
          onValueChange={(nextValue) => setForm(setGroupValue(form, group, name, nextValue))}
          className="mt-1.5 w-full"
        />
      ) : (
        <input
          type={inputType}
          value={value}
          maxLength={maxLength}
          onChange={(event) => setForm(setGroupValue(form, group, name, event.target.value))}
          className="mt-1.5 h-9 w-full rounded-[var(--radius)] border border-[var(--input)] bg-white px-3 text-sm outline-none focus:border-[var(--ring)] focus:ring-1 focus:ring-[var(--ring)]"
        />
      )}
      {hint && <span className="mt-1 block text-xs text-[#999999]">{hint}</span>}
    </label>
  )
}

function SelectField({
  form,
  setForm,
  group,
  name,
  label,
  options,
  hint,
}: {
  form: OnboardingApplicationInput
  setForm: (form: OnboardingApplicationInput) => void
  group: keyof OnboardingApplicationInput
  name: string
  label: string
  options: Array<{ label: string; value: string }>
  hint?: string
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-[var(--foreground)]">{label}</span>
      <select
        value={(form[group] ?? {})[name] ?? ""}
        onChange={(event) => setForm(setGroupValue(form, group, name, event.target.value))}
        className="mt-1.5 h-9 w-full rounded-[var(--radius)] border border-[var(--input)] bg-white px-3 text-sm outline-none focus:border-[var(--ring)] focus:ring-1 focus:ring-[var(--ring)]"
      >
        <option value="">请选择</option>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      {hint && <span className="mt-1 block text-xs text-[#999999]">{hint}</span>}
    </label>
  )
}

function OpeningBankField({
  form,
  setForm,
  applicationId,
}: {
  form: OnboardingApplicationInput
  setForm: (form: OnboardingApplicationInput) => void
  applicationId: string
}) {
  const [bankName, setBankName] = useState(form.settlementData.openningBankName ?? "")
  const [options, setOptions] = useState<OnboardingBankOption[]>([])
  const [pending, startTransition] = useTransition()
  const effectiveBankDistCode = form.settlementData.bankDistCode || form.merchantData.merRegDistCode || ""
  const bankAreaPath = getAreaPathByCode(effectiveBankDistCode)
  const [provinceCode, setProvinceCode] = useState(bankAreaPath.provinceCode)
  const [cityCode, setCityCode] = useState(bankAreaPath.cityCode)
  const [countyCode, setCountyCode] = useState(bankAreaPath.countyCode)
  const selectedBankName = form.settlementData.openningBankName ?? ""
  const hasSelectedBank = Boolean(selectedBankName && form.settlementData.openningBankCode && form.settlementData.bankAreaCode)
  const storedBankDistCode = form.settlementData.bankDistCode ?? ""

  useEffect(() => {
    // bankDistCode 只允许保存区县码。清空旧支行时不能再以注册地址回填，
    // 否则会覆盖用户刚在省/市下拉框中的选择。
    if (!storedBankDistCode) return
    const nextPath = getAreaPathByCode(storedBankDistCode)
    setProvinceCode(nextPath.provinceCode)
    setCityCode(nextPath.cityCode)
    setCountyCode(nextPath.countyCode)
    if (!hasSelectedBank) setBankName(form.settlementData.openningBankName ?? "")
  }, [storedBankDistCode, form.settlementData.openningBankName, hasSelectedBank])

  const provinceOptions = getProvinceOptions()
  const cityOptions = getCityOptions(provinceCode)
  const countyOptions = getCountyOptions(cityCode)

  const clearBankSelection = (nextBankName = bankName, nextBankDistCode = countyCode || "") => {
    setOptions([])
    setForm({
      ...form,
      settlementData: {
        ...form.settlementData,
        bankDistCode: nextBankDistCode,
        bankAreaCode: "",
        openningBankCode: "",
        openningBankName: "",
        clearingBankCode: "",
        settleProvinceCode: "",
        settleProvinceName: "",
        settleCityCode: "",
        settleCityName: "",
      },
    })
    setBankName(nextBankName)
  }

  const selectBank = (option: OnboardingBankOption) => {
    setBankName(option.branchBankName)
    setOptions([])
    const selectedBankDistCode = countyCode || effectiveBankDistCode
    setForm({
      ...form,
      settlementData: {
        ...form.settlementData,
        bankDistCode: selectedBankDistCode,
        bankAreaCode: option.areaCode ?? "",
        openningBankCode: option.branchBankNo,
        openningBankName: option.branchBankName,
        clearingBankCode: option.clearNo,
      },
    })
  }

  const resetBank = () => {
    setBankName("")
    setOptions([])
    setForm({
      ...form,
      settlementData: {
        ...form.settlementData,
        bankAreaCode: "",
        openningBankCode: "",
        openningBankName: "",
        clearingBankCode: "",
        settleProvinceCode: "",
        settleProvinceName: "",
        settleCityCode: "",
        settleCityName: "",
      },
    })
  }

  const search = () => startTransition(async () => {
    const selectedBankDistCode = countyCode || effectiveBankDistCode
    if (!selectedBankDistCode) {
      toast.error("请先选择开户行所在地")
      return
    }
    const result = await searchOnboardingBanks(applicationId, bankName, selectedBankDistCode)
    if (!result.success) {
      setOptions([])
      toast.error(result.message)
      return
    }
    setOptions(result.banks)
    toast.success(result.message)
  })

  return (
    <div className="space-y-2 sm:col-span-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="block text-sm font-medium text-[var(--foreground)]">开户支行</span>
        <span className="text-xs text-[#999999]">示例：招商银行股份有限公司南昌分行</span>
      </div>
      <div>
        <span className="text-xs text-[#999999]">开户行所在地</span>
        <div className="mt-1 grid gap-2 sm:grid-cols-3">
          <select
            value={provinceCode}
            onChange={(event) => {
              const nextProvinceCode = event.target.value
              setProvinceCode(nextProvinceCode)
              setCityCode("")
              setCountyCode("")
              clearBankSelection("", "")
            }}
            className="h-9 w-full rounded-[var(--radius)] border border-[var(--input)] bg-white px-3 text-sm outline-none focus:border-[var(--ring)] focus:ring-1 focus:ring-[var(--ring)]"
          >
            <option value="">请选择省</option>
            {provinceOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <select
            value={cityCode}
            onChange={(event) => {
              const nextCityCode = event.target.value
              setCityCode(nextCityCode)
              setCountyCode("")
              clearBankSelection("", "")
            }}
            disabled={!provinceCode}
            className="h-9 w-full rounded-[var(--radius)] border border-[var(--input)] bg-white px-3 text-sm outline-none focus:border-[var(--ring)] focus:ring-1 focus:ring-[var(--ring)] disabled:bg-[var(--muted)]"
          >
            <option value="">请选择市</option>
            {cityOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <select
            value={countyCode}
            onChange={(event) => {
              const nextCountyCode = event.target.value
              setCountyCode(nextCountyCode)
              clearBankSelection("", nextCountyCode)
            }}
            disabled={!cityCode}
            className="h-9 w-full rounded-[var(--radius)] border border-[var(--input)] bg-white px-3 text-sm outline-none focus:border-[var(--ring)] focus:ring-1 focus:ring-[var(--ring)] disabled:bg-[var(--muted)]"
          >
            <option value="">请选择区县</option>
            {countyOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </div>
      </div>
      {hasSelectedBank ? (
        <div className="flex flex-col gap-2 rounded-[var(--radius)] border border-[#D7EBDD] bg-[#F6FBF7] p-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium text-[var(--foreground)]">{selectedBankName}</p>
            <p className="mt-1 text-xs text-[#6B8F76]">系统已保存拉卡拉标准支行信息。</p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={resetBank}>重新选择</Button>
        </div>
      ) : (
        <>
          <div className="flex gap-2">
            <input
              value={bankName}
              onChange={(event) => {
                const nextValue = event.target.value
                if (form.settlementData.openningBankCode || form.settlementData.clearingBankCode || form.settlementData.bankAreaCode) clearBankSelection(nextValue, countyCode || effectiveBankDistCode)
                else {
                  setBankName(nextValue)
                  setOptions([])
                }
              }}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); search() } }}
              placeholder="输入关键词，例如：工商、工商 丰城、南昌分行"
              className="h-9 min-w-0 flex-1 rounded-[var(--radius)] border border-[var(--input)] bg-white px-3 text-sm outline-none focus:border-[var(--ring)] focus:ring-1 focus:ring-[var(--ring)]"
            />
            <Button type="button" variant="outline" size="sm" onClick={search} disabled={pending}>{pending ? "查询中" : "查询支行"}</Button>
          </div>
          {options.length > 0 && (
            <div className="rounded-[var(--radius)] border border-[var(--border)] bg-white">
              <p className="border-b border-[var(--border)] px-3 py-2 text-xs text-[#999999]">请选择开户支行</p>
              <div className="max-h-56 overflow-y-auto py-1">
                {options.map((option) => (
                  <button
                    key={option.branchBankNo}
                    type="button"
                    onClick={() => selectBank(option)}
                    className="block w-full px-3 py-2 text-left text-sm hover:bg-[var(--muted)]"
                  >
                    {option.branchBankName}
                  </button>
                ))}
              </div>
            </div>
          )}
          <p className="text-xs text-[#999999]">必须从查询结果中选择一条支行；行号和清算号会隐藏保存并用于提交。</p>
        </>
      )}
    </div>
  )
}

function ReadOnlyField({ label, value }: { label: string; value: string }) {
  return <label className="block"><span className="text-sm font-medium text-[var(--foreground)]">{label}</span><input value={value} readOnly className="mt-1.5 h-9 w-full rounded-[var(--radius)] border border-[var(--input)] bg-[var(--muted)] px-3 text-sm text-[#666666] outline-none" /></label>
}

function nextHourlyPollText() {
  const next = new Date()
  next.setHours(next.getHours() + 1, 0, 0, 0)
  return formatDateTime(next.toISOString())
}

function formatFileSize(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

function AreaCodeField({
  form,
  setForm,
  group,
  name,
  label,
  hint,
}: {
  form: OnboardingApplicationInput
  setForm: (form: OnboardingApplicationInput) => void
  group: keyof OnboardingApplicationInput
  name: string
  label: string
  hint?: string
}) {
  const value = (form[group] ?? {})[name] ?? ""
  const valuePath = getLakalaMerchantAreaPathByCode(value)
  const [provinceCode, setProvinceCode] = useState(valuePath.provinceCode)
  const [cityCode, setCityCode] = useState(valuePath.cityCode)
  const [countyCode, setCountyCode] = useState(valuePath.countyCode)

  useEffect(() => {
    const nextPath = getLakalaMerchantAreaPathByCode(value)
    setProvinceCode(nextPath.provinceCode)
    setCityCode(nextPath.cityCode)
    setCountyCode(nextPath.countyCode)
  }, [value])

  const provinceOptions = getLakalaMerchantProvinceOptions()
  const cityOptions = getLakalaMerchantCityOptions(provinceCode)
  const countyOptions = getLakalaMerchantCountyOptions(cityCode)
  return (
    <label className="block">
      <span className="text-sm font-medium text-[var(--foreground)]">{label}</span>
      <div className="mt-1.5 grid gap-2 sm:grid-cols-3">
        <select
          value={provinceCode}
          onChange={(event) => {
            setProvinceCode(event.target.value)
            setCityCode("")
            setCountyCode("")
            setForm(setGroupValue(form, group, name, ""))
          }}
          className="h-9 w-full rounded-[var(--radius)] border border-[var(--input)] bg-white px-3 text-sm outline-none focus:border-[var(--ring)] focus:ring-1 focus:ring-[var(--ring)]"
        >
          <option value="">请选择省</option>
          {provinceOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <select
          value={cityCode}
          disabled={!provinceCode}
          onChange={(event) => {
            setCityCode(event.target.value)
            setCountyCode("")
            setForm(setGroupValue(form, group, name, ""))
          }}
          className="h-9 w-full rounded-[var(--radius)] border border-[var(--input)] bg-white px-3 text-sm outline-none focus:border-[var(--ring)] focus:ring-1 focus:ring-[var(--ring)] disabled:bg-[var(--muted)] disabled:text-[#999999]"
        >
          <option value="">请选择市</option>
          {cityOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <select
          value={countyCode}
          disabled={!cityCode}
          onChange={(event) => {
            setCountyCode(event.target.value)
            setForm(setGroupValue(form, group, name, event.target.value))
          }}
          className="h-9 w-full rounded-[var(--radius)] border border-[var(--input)] bg-white px-3 text-sm outline-none focus:border-[var(--ring)] focus:ring-1 focus:ring-[var(--ring)] disabled:bg-[var(--muted)] disabled:text-[#999999]"
        >
          <option value="">请选择区县</option>
          {countyOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </div>
      {hint && <span className="mt-1 block text-xs text-[#999999]">{hint}</span>}
    </label>
  )
}

function LicenseExpiryField({
  form,
  setForm,
}: {
  form: OnboardingApplicationInput
  setForm: (form: OnboardingApplicationInput) => void
}) {
  const longTerm = form.merchantData.merBlisLongTerm === "true"
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-[var(--foreground)]">执照截止日期</span>
        <label className="inline-flex items-center gap-1.5 text-xs text-[#666666]">
          <input
            type="checkbox"
            checked={longTerm}
            onChange={(event) => {
              let next = setGroupValue(form, "merchantData", "merBlisLongTerm", event.target.checked ? "true" : "")
              if (event.target.checked) next = setGroupValue(next, "merchantData", "merBlisExpDt", "")
              setForm(next)
            }}
            className="size-4 rounded border-[var(--input)]"
          />
          长期有效
        </label>
      </div>
      <DatePicker
        value={longTerm ? "" : (form.merchantData.merBlisExpDt ?? "")}
        disabled={longTerm}
        onValueChange={(nextValue) => setForm(setGroupValue(form, "merchantData", "merBlisExpDt", nextValue))}
        className="mt-1.5 w-full"
      />
      <span className="mt-1 block text-xs text-[#999999]">{longTerm ? "长期有效时可不填截止日期" : "营业执照有截止日期时填写"}</span>
    </div>
  )
}

function IdCardExpiryField({
  form,
  setForm,
}: {
  form: OnboardingApplicationInput
  setForm: (form: OnboardingApplicationInput) => void
}) {
  const longTerm = form.legalPersonData.larIdcardLongTerm === "true"
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-[var(--foreground)]">证件截止日期</span>
        <label className="inline-flex items-center gap-1.5 text-xs text-[#666666]">
          <input
            type="checkbox"
            checked={longTerm}
            onChange={(event) => {
              let next = setGroupValue(form, "legalPersonData", "larIdcardLongTerm", event.target.checked ? "true" : "")
              if (event.target.checked) next = setGroupValue(next, "legalPersonData", "larIdcardExpDt", "")
              setForm(next)
            }}
            className="size-4 rounded border-[var(--input)]"
          />
          长期有效
        </label>
      </div>
      <DatePicker
        value={longTerm ? "" : (form.legalPersonData.larIdcardExpDt ?? "")}
        disabled={longTerm}
        onValueChange={(nextValue) => setForm(setGroupValue(form, "legalPersonData", "larIdcardExpDt", nextValue))}
        className="mt-1.5 w-full"
      />
      <span className="mt-1 block text-xs text-[#999999]">{longTerm ? "长期有效时可不填截止日期" : "身份证背面有截止日期时填写"}</span>
    </div>
  )
}

export function OnboardingList({
  applications,
  embedded = false,
  canCreate = true,
}: {
  applications: OnboardingListItem[]
  embedded?: boolean
  canCreate?: boolean
}) {
  const router = useRouter()
  const [deleteTarget, setDeleteTarget] = useState<OnboardingListItem | null>(null)
  const [deleting, setDeleting] = useState(false)
  const counts = useMemo(() => ({
    missing: applications.filter((item) => item.status === "DRAFT" || item.status === "FAILED").length,
    ready: applications.filter((item) => item.status === "FILES_READY").length,
    reviewing: applications.filter((item) => item.status === "SUBMITTED" || item.status === "REGISTERING" || applicationBusinessStatus(item).label !== "办理完成" && item.status === "SUCCESS").length,
    completed: applications.filter((item) => applicationBusinessStatus(item).label === "办理完成").length,
  }), [applications])

  const handleDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      const result = await deleteOnboardingApplication(deleteTarget.id)
      if (!result.success) {
        toast.error(result.message)
        return
      }
      toast.success(result.message)
      setDeleteTarget(null)
      router.refresh()
    } catch (error) {
      toast.error(actionErrorMessage(error, "删除失败"))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2"><h1 className={embedded ? "text-lg font-semibold" : "text-2xl font-bold"}>门店拉卡拉入网申请</h1></div>
          <p className="mt-1 text-xs text-[#999999]">从凤御门店发起申请，一次补齐主体、结算、门店和附件资料；审核成功后系统自动生成/绑定收款商户。</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {!embedded && <Link href="/merchants"><Button variant="outline"><ArrowLeft />返回商户管理</Button></Link>}
          {canCreate && <Link href="/merchants/onboarding/new"><Button><Plus />为门店发起入网</Button></Link>}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card><CardContent className="flex items-center justify-between p-4"><div><p className="text-xs text-[#999999]">待补资料</p><p className="mt-1 text-2xl font-semibold text-[#A45D00]">{counts.missing}</p></div><FileWarning className="size-7 text-[#D4820A]" /></CardContent></Card>
        <Card><CardContent className="flex items-center justify-between p-4"><div><p className="text-xs text-[#999999]">待提交</p><p className="mt-1 text-2xl font-semibold text-[#386987]">{counts.ready}</p></div><ClipboardCheck className="size-7 text-[#5E8BB3]" /></CardContent></Card>
        <Card><CardContent className="flex items-center justify-between p-4"><div><p className="text-xs text-[#999999]">拉卡拉审核中</p><p className="mt-1 text-2xl font-semibold text-[#62508B]">{counts.reviewing}</p></div><Building2 className="size-7 text-[#7A67A8]" /></CardContent></Card>
        <Card><CardContent className="flex items-center justify-between p-4"><div><p className="text-xs text-[#999999]">办理完成</p><p className="mt-1 text-2xl font-semibold text-[#2E7D4F]">{counts.completed}</p></div><CheckCircle2 className="size-7 text-[#3A9B66]" /></CardContent></Card>
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0"><div><CardTitle className="text-base">门店入网申请列表</CardTitle><p className="mt-1 text-xs font-normal text-[#999999]">列表负责查找待办；点进一条申请后，所有资料、协议、提交和记录都在同一详情页完成。</p></div><Button variant="outline" size="sm" onClick={() => location.reload()}><RefreshCw />刷新状态</Button></CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[940px] text-sm">
              <thead className="border-b border-[var(--border)] text-xs text-[#999999]">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">申请编号</th>
                  <th className="px-3 py-2 text-left font-medium">门店</th>
                  <th className="px-3 py-2 text-left font-medium">市场</th>
                  <th className="px-3 py-2 text-left font-medium">主体名称</th>
                  <th className="px-3 py-2 text-left font-medium">状态</th>
                  <th className="px-3 py-2 text-left font-medium">当前待办</th>
                  <th className="px-3 py-2 text-left font-medium">负责人</th>
                  <th className="px-3 py-2 text-left font-medium">更新时间</th>
                  <th className="px-3 py-2 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {applications.length === 0 ? (
                  <tr><td colSpan={9} className="px-3 py-10 text-center text-[#999999]">暂无入网申请</td></tr>
                ) : applications.map((application) => {
                  const businessStatus = applicationBusinessStatus(application)
                  return (
                    <tr key={application.id} className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--muted)]">
                      <td className="px-3 py-3 font-mono text-xs text-[#666666]">{application.orderNo}</td>
                      <td className="px-3 py-3 font-medium">{application.storeName}</td>
                      <td className="px-3 py-3 text-[#666666]">{application.marketName ?? "—"}</td>
                      <td className="px-3 py-3 text-[#666666]">{application.subjectName}</td>
                      <td className="px-3 py-3"><StatusBadge status={application.status} label={businessStatus.label} /></td>
                      <td className="px-3 py-3 text-[#666666]">{businessStatus.todo ?? application.missing ?? "资料齐全，可确认提交"}</td>
                      <td className="px-3 py-3">{application.owner ?? "—"}</td>
                      <td className="px-3 py-3 text-[#666666]">{formatDateTime(application.updatedAt)}</td>
                      <td className="px-3 py-3">
                        <div className="flex justify-end gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            className="text-[#D94040] hover:text-[#C0322A]"
                            onClick={() => setDeleteTarget(application)}
                          >
                            <Trash2 />删除
                          </Button>
                          <PreserveListContextLink href={`/merchants/onboarding/${application.id}`}><Button size="sm" variant="outline">办理<ChevronRight /></Button></PreserveListContextLink>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(open) => !open && !deleting && setDeleteTarget(null)}>
        <AlertDialogTitle>确认删除入网申请？</AlertDialogTitle>
        <AlertDialogDescription>
          删除「{deleteTarget?.orderNo}」后无法恢复，会同时删除申请资料、附件和本机私有文件。关联的收款商户及门店绑定不会被删除。
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting} onClick={() => setDeleteTarget(null)}>取消</AlertDialogCancel>
          <AlertDialogAction onClick={handleDelete} disabled={deleting}>
            {deleting ? "删除中..." : "确认删除"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialog>
    </div>
  )
}

export function NewOnboardingApplication({ stores }: { stores: OnboardingStoreOption[] }) {
  const router = useRouter()
  const [storeId, setStoreId] = useState(stores.find((item) => !item.hasCollectionMerchant && !item.activeApplicationId)?.storeId ?? stores[0]?.storeId ?? "")
  const [pending, startTransition] = useTransition()
  const selected = stores.find((item) => item.storeId === storeId)
  const blocked = Boolean(selected?.hasCollectionMerchant || selected?.activeApplicationId)

  function create() {
    if (!selected) return
    startTransition(async () => {
      try {
        const result = await createOnboardingApplication(selected.storeId)
        if (!result.success || !result.id) {
          toast.error(result.message)
          return
        }
        toast.success(result.message)
        router.push(`/merchants/onboarding/${result.id}`)
      } catch (error) {
        toast.error(actionErrorMessage(error, "创建失败"))
      }
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">新建门店入网申请</h1>
          <p className="mt-1 text-xs text-[#999999]">先选择要办理拉卡拉入网的凤御门店；创建后进入资料填写和提交。</p>
        </div>
        <Link href="/merchants"><Button variant="outline"><ArrowLeft />返回商户管理</Button></Link>
      </div>

      <Card className="border-[#F6D8A8] bg-[#FFFCF5]">
        <CardHeader className="flex-row items-center gap-2 space-y-0"><Store className="size-4 text-[#A45D00]" /><div><CardTitle className="text-base">1. 选择门店</CardTitle><p className="mt-1 text-xs font-normal text-[#8B6B32]">系统会检查该门店是否已有收款商户或进行中的入网申请。</p></div></CardHeader>
        <CardContent className="space-y-4">
          <label className="block">
            <span className="text-sm font-medium">门店</span>
            <select value={storeId} onChange={(event) => setStoreId(event.target.value)} className="mt-1.5 h-9 w-full rounded-[var(--radius)] border border-[var(--input)] bg-white px-3 text-sm">
              {stores.map((item) => <option key={item.storeId} value={item.storeId}>{[item.marketName, item.storeName].filter(Boolean).join(" / ")}</option>)}
            </select>
          </label>
          {selected && (
            <div className="grid gap-3 md:grid-cols-3">
              <div className="rounded-[var(--radius)] border border-[var(--border)] bg-white p-3"><p className="text-xs text-[#999999]">收款商户</p><p className={cn("mt-1 text-sm font-medium", selected.hasCollectionMerchant ? "text-[#3D8A5A]" : "text-[#666666]")}>{selected.hasCollectionMerchant ? "已有绑定" : "未绑定"}</p></div>
              <div className="rounded-[var(--radius)] border border-[var(--border)] bg-white p-3"><p className="text-xs text-[#999999]">进行中申请</p><p className={cn("mt-1 text-sm font-medium", selected.activeApplicationId ? "text-[#A45D00]" : "text-[#3D8A5A]")}>{selected.activeApplicationId || "无"}</p></div>
              <div className="rounded-[var(--radius)] border border-[var(--border)] bg-white p-3"><p className="text-xs text-[#999999]">创建结果</p><p className="mt-1 text-sm font-medium">{blocked ? "不可重复创建" : "可创建草稿"}</p></div>
            </div>
          )}
          <div className="flex justify-end">
            <Button disabled={blocked || !selected || pending} onClick={create}><Plus />{pending ? "创建中..." : "创建并进入详情"}</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

export function OnboardingEditor({
  application,
  canEdit: _canEdit = true,
  canFinalizeMerchant: _canFinalizeMerchant = true,
}: {
  application: OnboardingDetail
  canEdit?: boolean
  canFinalizeMerchant?: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [form, setForm] = useState<OnboardingApplicationInput>(() => normalizeOnboardingFormForDisplay({
    merchantData: application.merchantData,
    legalPersonData: application.legalPersonData,
    contactData: application.contactData,
    settlementData: application.settlementData,
    shopData: application.shopData,
    terminalData: application.terminalData,
  }))
  const [localPreviewUrls, setLocalPreviewUrls] = useState<Record<string, string>>({})
  const [ocrStatus, setOcrStatus] = useState<Record<string, string>>({})
  const hasLakalaCustomer = Boolean(application.merInnerNo || application.merCupNo)
  const needsReconsider = hasLakalaCustomer && application.status === "FAILED"
  const waitingForAudit = hasLakalaCustomer && !needsReconsider && application.status !== "SUCCESS"
  const businessStatus = applicationBusinessStatus(application)
  const wechatSubMerchantText = getChannelSubMerchantText(application.channelData, "wechat")
  const alipaySubMerchantText = getChannelSubMerchantText(application.channelData, "alipay")
  const hasWechatSubMerchant = Boolean(wechatSubMerchantText)
  const hasAlipaySubMerchant = Boolean(alipaySubMerchantText)
  const lastSubMerchantCheckedAt = application.subMerchantCheckedAt ? formatDateTime(application.subMerchantCheckedAt) : null
  const subMerchantPolling = application.channelData.subMerchantPolling && typeof application.channelData.subMerchantPolling === "object"
    ? application.channelData.subMerchantPolling as { status?: string; reason?: string; stoppedAt?: string; lastCheckedAt?: string }
    : null
  const subMerchantPollingTimedOut = subMerchantPolling?.status === "TIMEOUT"
  const terminalNo = getTerminalNo(application)
  const requiredCollectionNumbers = [
    { label: "银联商户号", value: application.merCupNo },
    { label: "终端号", value: terminalNo },
    { label: "微信子商户号", value: wechatSubMerchantText },
    { label: "支付宝子商户号", value: alipaySubMerchantText },
  ]
  const missingCollectionNumbers = requiredCollectionNumbers.filter((item) => !item.value).map((item) => item.label)
  const canConfirmCollectionMerchant = application.status === "SUCCESS" && missingCollectionNumbers.length === 0 && !application.lakalaMerchantId
  const showTopError = Boolean(application.lastErrorMessage && application.status !== "SUCCESS")
  const attachments = new Map<string, OnboardingDetail["attachments"][number]>()
  for (const item of application.attachments) {
    if (!attachments.has(item.displayName)) attachments.set(item.displayName, item)
  }

  useEffect(() => {
    return () => {
      Object.values(localPreviewUrls).forEach((url) => URL.revokeObjectURL(url))
    }
  }, [localPreviewUrls])

  async function runOcr(displayName: string, file: File) {
    if (!["营业执照", "法人身份证正面", "法人身份证反面"].includes(displayName)) return
    const body = new FormData()
    body.set("file", file)
    const target =
      displayName === "营业执照"
        ? "/api/ocr/business-license"
        : "/api/ocr/id-card"
    if (displayName === "法人身份证反面") body.set("side", "back")
    setOcrStatus((current) => ({ ...current, [displayName]: "OCR 识别中..." }))
    const response = await fetch(target, { method: "POST", body })
    const payload = await response.json()
    if (!payload.ok) {
      setOcrStatus((current) => ({ ...current, [displayName]: payload.error || "OCR 识别失败" }))
      toast.error(payload.error || "OCR 识别失败")
      return
    }
    const data = payload.data ?? {}
    setForm((current) => {
      if (displayName === "营业执照") {
        const merRegDistCode = data.merRegDistCode || current.merchantData.merRegDistCode
        const subjectName = data.merRegName || data.merBlisName
        const businessLicenseName = data.merBlisName || subjectName
        const previousSubjectNames = [
          current.merchantData.subjectName,
          current.merchantData.merRegName,
          current.merchantData.merBlisName,
        ].filter(Boolean)
        const shouldSyncAcctName = Boolean(
          subjectName &&
          (!current.settlementData.acctName || previousSubjectNames.includes(current.settlementData.acctName)),
        )
        return {
          ...current,
          merchantData: {
            ...current.merchantData,
            ...(subjectName ? { subjectName, merRegName: subjectName } : {}),
            ...(businessLicenseName ? { merBlisName: businessLicenseName } : {}),
            ...(data.merBlis ? { merBlis: data.merBlis } : {}),
            ...(data.merRegAddr ? { merRegAddr: shortLakalaAddress(data.merRegAddr, merRegDistCode) } : {}),
            ...(merRegDistCode ? { merRegDistCode } : {}),
            ...(data.merBlisStDt ? { merBlisStDt: data.merBlisStDt } : {}),
            ...(data.merBlisExpDt ? { merBlisExpDt: data.merBlisExpDt } : {}),
            ...(data.merBlisLongTerm ? { merBlisLongTerm: data.merBlisLongTerm } : {}),
          },
          legalPersonData: {
            ...current.legalPersonData,
            ...(data.larName ? { larName: data.larName } : {}),
          },
          settlementData: {
            ...current.settlementData,
            ...(shouldSyncAcctName ? { acctName: subjectName } : {}),
          },
        }
      }
      return {
        ...current,
        legalPersonData: {
          ...current.legalPersonData,
          ...(data.larName ? { larName: data.larName } : {}),
          ...(data.larIdcard ? { larIdcard: data.larIdcard } : {}),
          ...(data.larIdcardStDt ? { larIdcardStDt: data.larIdcardStDt } : {}),
          ...(data.larIdcardExpDt ? { larIdcardExpDt: data.larIdcardExpDt } : {}),
          ...(data.larIdcardLongTerm ? { larIdcardLongTerm: data.larIdcardLongTerm } : {}),
        },
      }
    })
    setOcrStatus((current) => ({ ...current, [displayName]: "OCR 已识别并填入下方字段，可手动修改" }))
    toast.success(`${displayName} OCR 已填入`)
  }

  async function upload(displayName: string, attType: string, file?: File) {
    if (!file) return
    if (file.size > MAX_ONBOARDING_ATTACHMENT_BYTES) {
      toast.error(`${displayName} 文件过大（${formatFileSize(file.size)}），请压缩到 5MB 内后重新上传`)
      return
    }
    if (file.type.startsWith("image/")) {
      setLocalPreviewUrls((current) => {
        if (current[displayName]) URL.revokeObjectURL(current[displayName])
        return { ...current, [displayName]: URL.createObjectURL(file) }
      })
    }
    await runOcr(displayName, file)
    const body = new FormData()
    body.set("file", file)
    body.set("attType", attType)
    body.set("displayName", displayName)
    const response = await fetch(`/api/merchants/onboarding/${application.id}/files`, { method: "POST", body })
    const payload = await response.json()
    if (!payload.ok) {
      toast.error(payload.error || "上传失败")
      return
    }
    toast.success(`${displayName} 已保存，提交时上传拉卡拉`)
    router.refresh()
  }

  function save() {
    startTransition(async () => {
      try {
        const result = await saveOnboardingApplication(application.id, form)
        result.success ? toast.success(result.message) : toast.error(result.message)
        router.refresh()
      } catch (error) {
        toast.error(actionErrorMessage(error, "保存失败"))
      }
    })
  }

  async function saveCurrentDraftBeforeAction() {
    const result = await saveOnboardingApplication(application.id, form)
    if (!result.success) {
      toast.error(result.message || "保存当前资料失败")
      return false
    }
    return true
  }

  type OnboardingActionResult = { success: boolean; message: string; resultUrl?: string }

  function runAction(
    fn: (id: string) => Promise<OnboardingActionResult>,
    fallback: string,
    options?: { saveFirst?: boolean; onSuccess?: (result: OnboardingActionResult) => void; onAbort?: () => void },
  ) {
    startTransition(async () => {
      try {
        if (options?.saveFirst) {
          const saved = await saveCurrentDraftBeforeAction()
          if (!saved) {
            options.onAbort?.()
            return
          }
        }
        const result = await fn(application.id)
        result.success ? toast.success(result.message) : toast.error(result.message)
        if (result.success) options?.onSuccess?.(result)
        else options?.onAbort?.()
        router.refresh()
      } catch (error) {
        options?.onAbort?.()
        toast.error(actionErrorMessage(error, fallback))
      }
    })
  }

  function openContractPlaceholderWindow() {
    const contractWindow = window.open("about:blank", "_blank")
    if (!contractWindow) return null
    contractWindow.opener = null
    contractWindow.document.title = "拉卡拉在线签约"
    contractWindow.document.body.innerHTML = '<p style="font-family: system-ui, sans-serif; padding: 24px;">正在打开签约页面...</p>'
    return contractWindow
  }

  function startElectronicContract() {
    const contractWindow = openContractPlaceholderWindow()
    runAction(initiateElectronicContract, "发起签约失败", {
      saveFirst: true,
      onSuccess: (result) => {
        if (result.resultUrl) {
          if (contractWindow) contractWindow.location.href = result.resultUrl
          else window.open(result.resultUrl, "_blank", "noopener,noreferrer")
        } else {
          contractWindow?.close()
        }
      },
      onAbort: () => contractWindow?.close(),
    })
  }

  function confirmCollectionMerchant() {
    if (missingCollectionNumbers.length > 0) {
      toast.error(`请先取得：${missingCollectionNumbers.join("、")}`)
      return
    }
    const confirmed = window.confirm("请确认营业执照对应法人已按指南完成微信/支付宝实名认证。确认后系统会关联收款商户，但不会自动启用，仍需到“收款商户”页手动启用。")
    if (!confirmed) return
    runAction(confirmOnboardingExternalCertification, "关联收款商户失败")
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <ReturnContextLink href="/merchants"><Button variant="outline" size="sm"><ArrowLeft />返回商户管理</Button></ReturnContextLink>
        <div>
          <div className="flex flex-wrap items-center gap-2"><h1 className="text-2xl font-bold">门店拉卡拉入网申请</h1><StatusBadge status={application.status} label={businessStatus.label} /><span className="font-mono text-xs text-[#999999]">{application.orderNo}</span></div>
          <p className="mt-1 text-xs text-[#999999]">{application.storeName} · 补齐主体、法人、联系人、结算账户和附件；审核成功后系统自动生成/绑定收款商户。</p>
        </div>
      </div>

      {showTopError && <div className="rounded-[var(--radius)] border border-[#F3B8B2] bg-[#FFF8F7] px-4 py-3 text-sm text-[#D94040]">{application.lastErrorMessage}</div>}

      <Card className="border-[#F6D8A8]">
        <CardContent className="flex flex-col gap-4 p-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-3"><StatusBadge status={application.status} label={businessStatus.label} /><span className="text-sm font-medium">当前待办：{businessStatus.todo ?? application.missing ?? "资料齐全，可确认提交"}</span><span className="text-xs text-[#999999]">负责人：{application.owner ?? "—"} · 最近更新：{formatDateTime(application.updatedAt)}</span></div>
          <div className="flex shrink-0 flex-wrap gap-2"><Button variant="outline" size="sm" onClick={() => runAction(queryOnboardingApplication, "查询失败")} disabled={pending}><RefreshCw />查询状态</Button>{!waitingForAudit && application.status !== "SUCCESS" && <Button size="sm" disabled={pending} onClick={() => runAction(needsReconsider ? reconsiderOnboardingApplication : submitOnboardingApplication, needsReconsider ? "重新提交失败" : "提交失败", { saveFirst: true })}><Send />{needsReconsider ? "修正后重新提交" : "提交拉卡拉"}</Button>}</div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center gap-2 space-y-0"><Upload className="size-4 text-[var(--primary)]" /><div><CardTitle className="text-base">1. 资料上传</CardTitle><p className="mt-1 text-xs font-normal text-[#999999]">营业执照和身份证上传后可 OCR 预填；原件仅私有保存，单个文件不超过 5 MB。</p></div></CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {ATTACHMENT_REQUIREMENTS.map((item) => {
              const attachment = attachments.get(item.displayName)
              const uploaded = !!attachment && ["LOCAL_SAVED", "UPLOADING", "UPLOADED"].includes(attachment.status)
              const previewUrl = localPreviewUrls[item.displayName] || (attachment?.mimeType?.startsWith("image/") ? attachment.previewUrl : null)
              return <div key={item.key} className={cn("min-h-28 rounded-[var(--radius)] border p-3", uploaded ? "border-[#B7E4C7] bg-[#F0F9F2]" : "border-dashed border-[#B8C4D2]")}>
                <div className="flex items-start justify-between gap-2"><p className="text-sm font-medium">{item.label}</p>{uploaded ? <CheckCircle2 className="size-4 text-[#3D8A5A]" /> : <FileWarning className="size-4 text-[#999999]" />}</div>
                <p className="mt-1 text-xs text-[#999999]">{attachment?.fileName ?? "未上传"}</p>
                {attachment?.lastErrorMessage && <p className="mt-1 text-xs text-[#D94040]">{attachment.lastErrorMessage}</p>}
                <label className={cn("mt-3 block cursor-pointer overflow-hidden rounded-[var(--radius)] border bg-white", previewUrl ? "border-[var(--border)]" : "inline-flex h-7 w-fit items-center gap-1 px-2 text-xs hover:bg-[var(--muted)]")}>
                  {previewUrl ? (
                    <div>
                      <img src={previewUrl} alt={`${item.label}预览`} className="h-32 w-full object-contain bg-[#FAFAFA]" />
                      <div className="flex items-center gap-1 border-t border-[var(--border)] px-2 py-1.5 text-xs text-[#666666]"><Upload className="size-3" />点击图片重新上传</div>
                    </div>
                  ) : (
                    <><Upload className="size-3" />{uploaded ? "重新上传" : "选择文件"}</>
                  )}
                  <input type="file" hidden accept="image/png,image/jpeg,image/jpg,application/pdf" onChange={(event) => upload(item.displayName, item.attType, event.target.files?.[0])} />
                </label>
                {ocrStatus[item.displayName] && <p className={cn("mt-2 text-xs", ocrStatus[item.displayName].includes("失败") ? "text-[#D94040]" : "text-[#3D8A5A]")}>{ocrStatus[item.displayName]}</p>}
              </div>
            })}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader className="flex-row items-center gap-2 space-y-0"><Building2 className="size-4 text-[var(--primary)]" /><div><CardTitle className="text-base">2. 主体资料、法人和联系人</CardTitle><p className="mt-1 text-xs font-normal text-[#999999]">页面只让你确认营业执照上的主体信息；提交时后端会自动映射为拉卡拉需要的商户注册名称、营业执照名称等接口字段。</p></div></CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <Field form={form} setForm={setForm} group="merchantData" name="merRegName" label="主体名称" hint="营业执照 OCR 会预填；可按实际主体名称修改，提交时作为拉卡拉商户注册名称。" />
            <Field form={form} setForm={setForm} group="merchantData" name="merBlisName" label="营业执照名称" hint="营业执照 OCR 会预填；可单独修改，提交时作为拉卡拉营业执照名称。" />
            <Field form={form} setForm={setForm} group="merchantData" name="merBlis" label="统一社会信用代码 / 营业执照号" />
            <AreaCodeField form={form} setForm={setForm} group="merchantData" name="merRegDistCode" label="注册地址地区" />
            <Field
              form={form}
              setForm={setForm}
              group="merchantData"
              name="merRegAddr"
              label="详细地址（不含省市区）"
              maxLength={29}
            />
            <Field form={form} setForm={setForm} group="merchantData" name="merBlisStDt" date label="执照开始日期" />
            <LicenseExpiryField form={form} setForm={setForm} />
            <div className="mt-1 border-t border-[var(--border)] pt-4 sm:col-span-2"><p className="flex items-center gap-2 text-sm font-semibold"><UserRound className="size-4 text-[var(--primary)]" />法人和联系人</p></div>
            <Field form={form} setForm={setForm} group="legalPersonData" name="larName" label="法人姓名" />
            <Field form={form} setForm={setForm} group="legalPersonData" name="larIdcard" label="法人身份证号" />
            <Field form={form} setForm={setForm} group="legalPersonData" name="larIdcardStDt" date label="证件开始日期" />
            <IdCardExpiryField form={form} setForm={setForm} />
            <Field form={form} setForm={setForm} group="contactData" name="merContactName" label="联系人" />
            <Field form={form} setForm={setForm} group="contactData" name="merContactMobile" label="联系人手机号" />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center gap-2 space-y-0"><CreditCard className="size-4 text-[var(--primary)]" /><CardTitle className="text-base">3. 结算账户</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-[var(--radius)] border border-[#F6D8A8] bg-[#FFFCF5] px-3 py-2 text-xs text-[#8B6B32]">结算方式固定为对公，账户信息必须由经办人手动确认。</div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field form={form} setForm={setForm} group="settlementData" name="acctName" label="结算户名" />
              <Field form={form} setForm={setForm} group="settlementData" name="acctNo" label="银行账号" hint="实际接入时以加密方式保存" />
              <OpeningBankField form={form} setForm={setForm} applicationId={application.id} />
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex-row items-center gap-2 space-y-0"><FileText className="size-4 text-[var(--primary)]" /><div><CardTitle className="text-base">4. 提交前确认</CardTitle><p className="mt-1 text-xs font-normal text-[#999999]">保存草稿和提交进件在同一处完成；只有点击提交时才上传拉卡拉，缺资料时系统会提示。</p></div></CardHeader>
        <CardContent className="space-y-4"><div className="flex flex-col justify-between gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--muted)] p-4 sm:flex-row sm:items-center"><div><p className="text-sm font-medium">拉卡拉在线签约</p><p className="mt-1 text-xs text-[#999999]">{application.eContractStatus === "COMPLETED" ? `已签约，合同号：${application.eContractNo}` : application.eContractResultUrl ? "签约已发起，请由法人在拉卡拉页面完成签约" : "资料确认后发起签约；签约完成后系统自动取得合同号"}</p></div><div className="flex flex-wrap gap-2">{application.eContractResultUrl && application.eContractStatus !== "COMPLETED" && <Button variant="outline" size="sm" onClick={() => window.open(application.eContractResultUrl!, "_blank", "noopener,noreferrer")}>打开签约页面</Button>}<Button variant="outline" size="sm" disabled={pending || application.eContractStatus === "COMPLETED"} onClick={startElectronicContract}><FileCheck2 />{application.eContractResultUrl ? "重新发起签约" : "发起在线签约"}</Button></div></div>{needsReconsider && <p className="rounded-[var(--radius)] border border-[#F6D8A8] bg-[#FFFCF5] px-3 py-2 text-xs text-[#8B6B32]">审核已拒绝。修正资料后请先保存草稿，再重新提交资料；系统会重新上传附件并同步拉卡拉进件。</p>}{waitingForAudit && <p className="rounded-[var(--radius)] border border-[#D9D2F0] bg-[#F7F4FC] px-3 py-2 text-xs text-[#62508B]">该申请已提交拉卡拉，正在等待审核。请使用“查询状态”，不要重复提交。</p>}<div className="flex flex-wrap justify-end gap-2 border-t border-[var(--border)] pt-4"><Button variant="outline" onClick={save} disabled={pending}><Save />保存草稿</Button><Button variant="outline" onClick={() => runAction(queryOnboardingApplication, "查询失败")} disabled={pending}><RefreshCw />查询状态</Button>{!waitingForAudit && application.status !== "SUCCESS" && <Button onClick={() => runAction(needsReconsider ? reconsiderOnboardingApplication : submitOnboardingApplication, needsReconsider ? "重新提交失败" : "提交失败", { saveFirst: true })} disabled={pending}><Send />{needsReconsider ? "修正后重新提交" : "提交拉卡拉"}</Button>}</div></CardContent>
      </Card>

      {application.status === "SUCCESS" && (
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="text-base">5. 收款商户与渠道认证</CardTitle>
              <p className="mt-1 text-xs font-normal text-[#999999]">入网审核通过后展示收款编号；请法人按指南在微信/支付宝外部页面完成认证，再人工确认关联收款商户。</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {(!hasWechatSubMerchant || !hasAlipaySubMerchant) && <Button variant="outline" size="sm" disabled={pending} onClick={() => runAction(refreshOnboardingSubMerchants, "子商户号查询失败")}><RefreshCw />查询子商户号</Button>}
              <Link href="/merchants/lakala-guides/wechat" target="_blank"><Button variant="outline" size="sm">微信实名认证指南</Button></Link>
              <Link href="/merchants/lakala-guides/alipay" target="_blank"><Button variant="outline" size="sm">支付宝实名认证指南</Button></Link>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-4">
              <div className="rounded-[var(--radius)] border border-[#D9E8DF] bg-[#F6FBF8] p-4">
                <p className="text-xs text-[#6B8A76]">银联商户号</p>
                <p className="mt-1 break-all text-base font-semibold text-[#287342]">{application.merCupNo ?? "等待返回"}</p>
              </div>
              <div className={cn("rounded-[var(--radius)] border p-4", terminalNo ? "border-[#D9E8DF] bg-[#F6FBF8]" : "border-[#E7E1D0] bg-[#FFFCF5]")}>
                <p className="text-xs text-[#777777]">终端号</p>
                <p className={cn("mt-1 break-all text-base font-semibold", terminalNo ? "text-[#287342]" : "text-[#8B6B32]")}>{terminalNo || "等待拉卡拉返回"}</p>
              </div>
              <div className={cn("rounded-[var(--radius)] border p-4", hasWechatSubMerchant ? "border-[#D9E8DF] bg-[#F6FBF8]" : "border-[#E7E1D0] bg-[#FFFCF5]")}>
                <p className="text-xs text-[#777777]">微信子商户号</p>
                <p className={cn("mt-1 break-all text-base font-semibold", hasWechatSubMerchant ? "text-[#287342]" : "text-[#8B6B32]")}>{wechatSubMerchantText || "等待拉卡拉报备返回"}</p>
              </div>
              <div className={cn("rounded-[var(--radius)] border p-4", hasAlipaySubMerchant ? "border-[#D9E8DF] bg-[#F6FBF8]" : "border-[#E7E1D0] bg-[#FFFCF5]")}>
                <p className="text-xs text-[#777777]">支付宝子商户号</p>
                <p className={cn("mt-1 break-all text-base font-semibold", hasAlipaySubMerchant ? "text-[#287342]" : "text-[#8B6B32]")}>{alipaySubMerchantText || "等待拉卡拉报备返回"}</p>
              </div>
            </div>
            <div className="rounded-[var(--radius)] border border-[#D9D2F0] bg-[#F7F4FC] px-3 py-2 text-xs text-[#62508B]">
              {missingCollectionNumbers.length > 0
                ? subMerchantPollingTimedOut
                  ? `${subMerchantPolling?.reason || "子商户号 72 小时未全部返回"}${subMerchantPolling?.stoppedAt ? `，停止时间：${formatDateTime(subMerchantPolling.stoppedAt)}` : ""}。请联系拉卡拉确认渠道报备结果。`
                  : `还缺：${missingCollectionNumbers.join("、")}。${lastSubMerchantCheckedAt ? `上次查询：${lastSubMerchantCheckedAt}；` : ""}系统会每小时自动查询渠道报备，页面可以关闭。`
                : "请使用营业执照对应法人本人账号/身份，按微信和支付宝指南完成外部认证。完成后点击下方按钮关联收款商户。"}
            </div>
            <div className="flex flex-col justify-between gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--muted)] p-4 sm:flex-row sm:items-center">
              <div>
                <p className="text-sm font-medium">外部认证完成后关联收款商户</p>
                <p className="mt-1 text-xs text-[#999999]">
                  {application.lakalaMerchantId
                    ? "已关联收款商户；收款状态保持未启用/待启用，请到“收款商户”页手动启用。"
                    : missingCollectionNumbers.length
                      ? `编号未齐，暂不能关联：${missingCollectionNumbers.join("、")}`
                      : "确认后系统会生成/更新收款商户并绑定门店，但不会自动启用。"}
                </p>
              </div>
              <Button disabled={pending || !canConfirmCollectionMerchant} onClick={confirmCollectionMerchant}>
                <ClipboardCheck />我已完成认证，关联收款商户
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle className="text-base">拉卡拉提交记录</CardTitle></CardHeader>
        <CardContent><div className="overflow-x-auto"><table className="w-full text-sm"><thead className="border-b border-[var(--border)] text-xs text-[#999999]"><tr><th className="px-2 py-2 text-left font-medium">时间</th><th className="px-2 py-2 text-left font-medium">接口</th><th className="px-2 py-2 text-left font-medium">结果</th><th className="px-2 py-2 text-left font-medium">错误</th></tr></thead><tbody>{application.requestLogs.length === 0 ? <tr><td colSpan={4} className="px-2 py-6 text-center text-[#999999]">暂无请求记录</td></tr> : application.requestLogs.map((log) => <tr key={log.id} className="border-b border-[var(--border)] last:border-0"><td className="px-2 py-3 text-[#666666]">{formatDateTime(log.createdAt)}</td><td className="px-2 py-3">{log.apiName}</td><td className={cn("px-2 py-3", log.success ? "text-[#3D8A5A]" : "text-[#D94040]")}>{log.success ? "成功" : "失败"}</td><td className="px-2 py-3">{log.errorMessage ?? "—"}</td></tr>)}</tbody></table></div></CardContent>
      </Card>
    </div>
  )
}

export default OnboardingList
