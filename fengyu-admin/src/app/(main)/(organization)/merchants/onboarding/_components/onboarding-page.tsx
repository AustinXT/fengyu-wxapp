"use client"

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  ArrowLeft,
  Building2,
  CheckCircle2,
  ClipboardCheck,
  FileText,
  FileWarning,
  Landmark,
  Plus,
  RefreshCw,
  Save,
  Send,
  Store,
  Upload,
  XCircle,
} from "lucide-react"
import {
  cancelOnboardingApplication,
  confirmOnboardingExternalCertification,
  createOnboardingApplication,
  initiateElectronicContract,
  queryOnboardingApplication,
  reconsiderOnboardingApplication,
  refreshElectronicContractStatus,
  refreshOnboardingCertificationStatus,
  refreshOnboardingSubMerchants,
  saveOnboardingApplication,
  searchOnboardingBanks,
  submitOnboardingApplication,
  type OnboardingApplicationInput,
  type OnboardingBankOption,
  type OnboardingDetail,
  type OnboardingListItem,
  type OnboardingStatus,
  type OnboardingStoreOption,
} from "@/actions/lakala-onboarding"
import {
  ATTACHMENT_REQUIREMENTS,
  ELECTRONIC_CONTRACT_PDF_ATTACHMENT,
  MAX_ONBOARDING_ATTACHMENT_BYTES,
} from "@/lib/lakala-onboarding-constants"
import { actionErrorMessage } from "@/lib/action-error"
import { useRefreshSafeDraft } from "@/lib/hooks/use-refresh-safe-draft"
import { useUnsavedChanges } from "@/lib/hooks/use-unsaved-changes"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { DataTable, type Column } from "@/components/ui/data-table"
import { Input } from "@/components/ui/input"
import { cn, formatDateTime } from "@/lib/utils"
import {
  buildLakalaMerchantAreaDirectory,
  parseLakalaMerchantAreas,
  type LakalaMerchantAreaRow,
} from "@/lib/lakala-merchant-area-client"
import {
  channelMerchantNumbers,
  onboardingBusinessStatus,
  onboardingMetricCounts,
  onboardingStatusText,
} from "@/lib/lakala-onboarding-presentation"

type StringRecord = Record<string, string>

type ActionResult = {
  success: boolean
  message: string
  id?: string
  applicationId?: string
  resultUrl?: string
  updatedAt?: string
}

let areaRowsPromise: Promise<LakalaMerchantAreaRow[]> | null = null
const PDF_ATTACHMENT_TYPES = new Set(["BUSINESS_LICENCE", "OPENING_PERMIT"])

function allowsPdfAttachment(attachmentType: string): boolean {
  return PDF_ATTACHMENT_TYPES.has(attachmentType)
}

function loadLakalaAreas(): Promise<LakalaMerchantAreaRow[]> {
  if (!areaRowsPromise) {
    areaRowsPromise = fetch("/data/lakala-merchant-areas.tsv")
      .then(async (response) => {
        if (!response.ok) throw new Error("无法加载拉卡拉地区码")
        return parseLakalaMerchantAreas(await response.text())
      })
      .catch(() => [])
  }
  return areaRowsPromise
}

function toStringRecord(value: unknown): StringRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
      typeof item === "string" || typeof item === "number" || typeof item === "boolean"
        ? [[key, String(item)]]
        : [],
    ),
  )
}

function formFromApplication(application: OnboardingDetail): OnboardingApplicationInput {
  return {
    merchantData: toStringRecord(application.merchantData),
    legalPersonData: toStringRecord(application.legalPersonData),
    contactData: toStringRecord(application.contactData),
    settlementData: toStringRecord(application.settlementData),
    shopData: toStringRecord(application.shopData),
    terminalData: toStringRecord(application.terminalData),
  }
}

function getGroup(
  form: OnboardingApplicationInput,
  group: keyof OnboardingApplicationInput,
): StringRecord {
  return toStringRecord(form[group])
}

function setFormField(
  form: OnboardingApplicationInput,
  group: keyof OnboardingApplicationInput,
  field: string,
  value: string,
): OnboardingApplicationInput {
  return {
    ...form,
    [group]: { ...getGroup(form, group), [field]: value },
  }
}

function StatusBadge({ status, label }: { status: OnboardingStatus; label?: string }) {
  const completed = label === "办理完成"
  const warning = ["待渠道报备", "待终端号", "待外部认证", "待启用"].includes(label ?? "")
  const className = completed
    ? "border-[#3D8A5A] bg-[#F0F9F2] text-[#287342]"
    : status === "FAILED" || status === "CANCELLED"
      ? "border-[#D94040] bg-[#FFF5F4] text-[#B42318]"
      : warning || status === "DRAFT" || status === "FILES_UPLOADING"
        ? "border-[#D4820A] bg-[#FFF8E6] text-[#A45D00]"
        : "border-[#7A67A8] bg-[#F5F1FA] text-[#62508B]"
  return <Badge variant="outline" className={className}>{label ?? onboardingStatusText[status]}</Badge>
}

function formatFileSize(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1) + " MB"
}

function Field({
  form,
  setForm,
  group,
  field,
  label,
  hint,
  type = "text",
  required = false,
  maxLength,
}: {
  form: OnboardingApplicationInput
  setForm: (next: OnboardingApplicationInput) => void
  group: keyof OnboardingApplicationInput
  field: string
  label: string
  hint?: string
  type?: string
  required?: boolean
  maxLength?: number
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-[var(--foreground)]">
        {label}
        {required && <span className="text-[#D94040]"> *</span>}
      </span>
      <Input
        type={type}
        value={getGroup(form, group)[field] ?? ""}
        onChange={(event) => setForm(setFormField(form, group, field, event.target.value))}
        maxLength={maxLength}
        className="mt-1.5"
      />
      {hint && <span className="mt-1 block text-xs text-[#999999]">{hint}</span>}
    </label>
  )
}

function BooleanField({
  form,
  setForm,
  group,
  field,
  label,
}: {
  form: OnboardingApplicationInput
  setForm: (next: OnboardingApplicationInput) => void
  group: keyof OnboardingApplicationInput
  field: string
  label: string
}) {
  const checked = getGroup(form, group)[field] === "true"
  return (
    <label className="flex min-h-10 items-center gap-2 pt-6 text-sm">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => setForm(setFormField(form, group, field, String(event.target.checked)))}
        className="size-4"
      />
      {label}
    </label>
  )
}

function LakalaAreaCodeField({
  form,
  setForm,
  group,
  field,
  label,
  hint,
}: {
  form: OnboardingApplicationInput
  setForm: (next: OnboardingApplicationInput) => void
  group: keyof OnboardingApplicationInput
  field: string
  label: string
  hint: string
}) {
  const [areas, setAreas] = useState<LakalaMerchantAreaRow[]>([])
  const value = getGroup(form, group)[field] ?? ""

  useEffect(() => {
    let mounted = true
    void loadLakalaAreas().then((rows) => {
      if (mounted) setAreas(rows)
    })
    return () => {
      mounted = false
    }
  }, [])

  const directory = useMemo(() => buildLakalaMerchantAreaDirectory(areas), [areas])
  const valuePath = useMemo(() => directory.getPathByCode(value), [directory, value])
  const [provinceCode, setProvinceCode] = useState("")
  const [cityCode, setCityCode] = useState("")
  const [countyCode, setCountyCode] = useState("")

  useEffect(() => {
    setProvinceCode(valuePath.provinceCode)
    setCityCode(valuePath.cityCode)
    setCountyCode(valuePath.countyCode)
  }, [valuePath])

  const cityOptions = directory.getCityOptions(provinceCode)
  const countyOptions = directory.getCountyOptions(cityCode)
  return (
    <div className="block sm:col-span-2">
      <span className="text-sm font-medium text-[var(--foreground)]">
        {label} <span className="text-[#D94040]">*</span>
      </span>
      <div className="mt-1.5 grid gap-2 sm:grid-cols-3">
        <select
          aria-label={label + "省份"}
          value={provinceCode}
          onChange={(event) => {
            setProvinceCode(event.target.value)
            setCityCode("")
            setCountyCode("")
            setForm(setFormField(form, group, field, ""))
          }}
          className="h-9 w-full rounded-[var(--radius)] border border-[var(--input)] bg-white px-3 text-sm"
        >
          <option value="">请选择省</option>
          {directory.provinceOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <select
          aria-label={label + "城市"}
          value={cityCode}
          disabled={!provinceCode}
          onChange={(event) => {
            setCityCode(event.target.value)
            setCountyCode("")
            setForm(setFormField(form, group, field, ""))
          }}
          className="h-9 w-full rounded-[var(--radius)] border border-[var(--input)] bg-white px-3 text-sm disabled:bg-[var(--muted)]"
        >
          <option value="">请选择市</option>
          {cityOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <select
          aria-label={label + "区县"}
          value={countyCode}
          disabled={!cityCode}
          onChange={(event) => {
            const code = event.target.value
            setCountyCode(code)
            setForm(setFormField(form, group, field, code))
          }}
          className="h-9 w-full rounded-[var(--radius)] border border-[var(--input)] bg-white px-3 text-sm disabled:bg-[var(--muted)]"
        >
          <option value="">请选择区县</option>
          {countyOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </div>
      <span className="mt-1 block text-xs text-[#999999]">
        {valuePath.label ? "已选择：" + valuePath.label + "（" + value + "）" : hint}
      </span>
    </div>
  )
}

export function OpeningBankField({
  form,
  setForm,
  applicationId,
}: {
  form: OnboardingApplicationInput
  setForm: (next: OnboardingApplicationInput) => void
  applicationId: string
}) {
  const settlement = getGroup(form, "settlementData")
  const [areas, setAreas] = useState<LakalaMerchantAreaRow[]>([])
  const [bankKeyword, setBankKeyword] = useState(settlement.openningBankName ?? "")
  const [bankOptions, setBankOptions] = useState<OnboardingBankOption[]>([])
  const [searching, startSearch] = useTransition()
  const directory = useMemo(() => buildLakalaMerchantAreaDirectory(areas), [areas])
  const valuePath = useMemo(() => directory.getPathByCode(settlement.bankDistCode), [directory, settlement.bankDistCode])
  const [provinceCode, setProvinceCode] = useState("")
  const [cityCode, setCityCode] = useState("")
  const [countyCode, setCountyCode] = useState("")
  const hasSelectedBank = Boolean(
    settlement.openningBankName
      && settlement.openningBankCode
      && settlement.clearingBankCode
      && settlement.bankAreaCode,
  )

  useEffect(() => {
    let mounted = true
    void loadLakalaAreas().then((rows) => {
      if (mounted) setAreas(rows)
    })
    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    setProvinceCode(valuePath.provinceCode)
    setCityCode(valuePath.cityCode)
    setCountyCode(valuePath.countyCode)
  }, [valuePath])

  useEffect(() => {
    if (!hasSelectedBank) setBankKeyword(settlement.openningBankName ?? "")
  }, [hasSelectedBank, settlement.openningBankName])

  const clearBankSelection = (nextBankDistCode: string, nextKeyword = "") => {
    setBankKeyword(nextKeyword)
    setBankOptions([])
    setForm({
      ...form,
      settlementData: {
        ...settlement,
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
  }

  const selectBank = (bank: OnboardingBankOption) => {
    setBankKeyword(bank.branchBankName)
    setBankOptions([])
    setForm({
      ...form,
      settlementData: {
        ...settlement,
        bankDistCode: countyCode,
        bankAreaCode: bank.areaCode,
        openningBankCode: bank.branchBankNo,
        openningBankName: bank.branchBankName,
        clearingBankCode: bank.clearNo,
        settleProvinceCode: "",
        settleProvinceName: "",
        settleCityCode: "",
        settleCityName: "",
      },
    })
    toast.success("已选择拉卡拉标准开户支行")
  }

  const searchBanks = () => {
    if (!countyCode) {
      toast.error("请先选择开户行所在地")
      return
    }
    startSearch(async () => {
      try {
        const result = await searchOnboardingBanks(applicationId, bankKeyword, countyCode)
        if (!result.success) {
          setBankOptions([])
          toast.error(result.message || "开户行查询失败")
          return
        }
        setBankOptions(result.banks ?? [])
        if (!result.banks?.length) toast.info(result.message || "未找到匹配开户行")
      } catch (error) {
        setBankOptions([])
        toast.error(actionErrorMessage(error, "开户行查询失败"))
      }
    })
  }

  const cityOptions = directory.getCityOptions(provinceCode)
  const countyOptions = directory.getCountyOptions(cityCode)
  return (
    <div className="space-y-2 sm:col-span-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-[var(--foreground)]">开户支行 <span className="text-[#D94040]">*</span></span>
        <span className="text-xs text-[#999999]">必须从查询结果中选择</span>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        <select
          aria-label="开户行省份"
          value={provinceCode}
          onChange={(event) => {
            setProvinceCode(event.target.value)
            setCityCode("")
            setCountyCode("")
            clearBankSelection("")
          }}
          className="h-9 w-full rounded-[var(--radius)] border border-[var(--input)] bg-white px-3 text-sm"
        >
          <option value="">请选择省</option>
          {directory.provinceOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <select
          aria-label="开户行城市"
          value={cityCode}
          disabled={!provinceCode}
          onChange={(event) => {
            setCityCode(event.target.value)
            setCountyCode("")
            clearBankSelection("")
          }}
          className="h-9 w-full rounded-[var(--radius)] border border-[var(--input)] bg-white px-3 text-sm disabled:bg-[var(--muted)]"
        >
          <option value="">请选择市</option>
          {cityOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <select
          aria-label="开户行区县"
          value={countyCode}
          disabled={!cityCode}
          onChange={(event) => {
            const code = event.target.value
            setCountyCode(code)
            clearBankSelection(code)
          }}
          className="h-9 w-full rounded-[var(--radius)] border border-[var(--input)] bg-white px-3 text-sm disabled:bg-[var(--muted)]"
        >
          <option value="">请选择区县</option>
          {countyOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </div>
      {hasSelectedBank ? (
        <div className="flex flex-col gap-2 rounded-[var(--radius)] border border-[#D7EBDD] bg-[#F6FBF7] p-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium">{settlement.openningBankName}</p>
            <p className="mt-1 text-xs text-[#6B8F76]">系统已保存标准支行、行号和清算行号。</p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => clearBankSelection(countyCode)}>重新选择</Button>
        </div>
      ) : (
        <>
          <div className="flex gap-2">
            <Input
              aria-label="开户支行关键字"
              value={bankKeyword}
              onChange={(event) => {
                const nextKeyword = event.target.value
                if (settlement.bankAreaCode || settlement.openningBankCode || settlement.clearingBankCode) {
                  clearBankSelection(countyCode, nextKeyword)
                } else {
                  setBankKeyword(nextKeyword)
                  setBankOptions([])
                }
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault()
                  searchBanks()
                }
              }}
              placeholder="输入关键词，例如：招商银行南昌分行"
            />
            <Button type="button" variant="outline" disabled={searching || !bankKeyword.trim()} onClick={searchBanks}>
              {searching ? "查询中" : "查询支行"}
            </Button>
          </div>
          {bankOptions.length > 0 && (
            <div className="max-h-56 overflow-y-auto rounded-[var(--radius)] border border-[var(--border)] bg-white py-1">
              {bankOptions.map((bank) => (
                <button
                  key={bank.branchBankNo}
                  type="button"
                  onClick={() => selectBank(bank)}
                  className="block w-full px-3 py-2 text-left text-sm hover:bg-[var(--muted)]"
                >
                  {bank.branchBankName + "（" + bank.branchBankNo + "）"}
                </button>
              ))}
            </div>
          )}
          <p className="text-xs text-[#999999]">更改地区或关键词后，旧的支行编码会被清空。</p>
        </>
      )}
    </div>
  )
}

function OnboardingForm({
  form,
  setForm,
  pending,
  applicationId,
}: {
  form: OnboardingApplicationInput
  setForm: (next: OnboardingApplicationInput) => void
  pending: boolean
  applicationId: string
}) {
  return (
    <fieldset disabled={pending} className="grid min-w-0 gap-4 border-0 p-0 xl:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Building2 className="size-4 text-[var(--primary)]" />
            主体、法人和联系人
          </CardTitle>
          <p className="text-xs text-[#999999]">营业执照和身份证 OCR 仅用于预填，提交前请逐项核对。</p>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field form={form} setForm={setForm} group="merchantData" field="merRegName" label="商户注册名称" required />
          <Field form={form} setForm={setForm} group="merchantData" field="merBlis" label="统一社会信用代码" required />
          <LakalaAreaCodeField
            form={form}
            setForm={setForm}
            group="merchantData"
            field="merRegDistCode"
            label="注册地址地区码"
            hint="请选择拉卡拉地区码，保存时会自动补齐省、市编码。"
          />
          <Field
            form={form}
            setForm={setForm}
            group="merchantData"
            field="merRegAddr"
            label="注册地址详细地址"
            hint="仅填写省市区之后的门牌信息，最多 29 个字符。"
            maxLength={29}
            required
          />
          <Field form={form} setForm={setForm} group="merchantData" field="merBlisStDt" type="date" label="营业执照开始日期" required />
          <Field form={form} setForm={setForm} group="merchantData" field="merBlisExpDt" type="date" label="营业执照到期日期" />
          <BooleanField form={form} setForm={setForm} group="merchantData" field="merBlisLongTerm" label="营业执照长期有效" />
          <Field form={form} setForm={setForm} group="legalPersonData" field="larName" label="法人姓名" required />
          <Field form={form} setForm={setForm} group="legalPersonData" field="larIdcard" label="法人身份证号" required />
          <Field form={form} setForm={setForm} group="legalPersonData" field="larIdcardStDt" type="date" label="身份证开始日期" required />
          <Field form={form} setForm={setForm} group="legalPersonData" field="larIdcardExpDt" type="date" label="身份证到期日期" />
          <BooleanField form={form} setForm={setForm} group="legalPersonData" field="larIdcardLongTerm" label="身份证长期有效" />
          <Field form={form} setForm={setForm} group="contactData" field="merContactName" label="联系人姓名" required />
          <Field form={form} setForm={setForm} group="contactData" field="merContactMobile" label="联系人手机号" required />
          <Field form={form} setForm={setForm} group="contactData" field="email" label="联系人邮箱" />
        </CardContent>
      </Card>

      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Landmark className="size-4 text-[var(--primary)]" />
              结算账户
            </CardTitle>
            <p className="text-xs text-[#999999]">账户资料仅在有权限的服务端保存和提交，不会出现在外部请求记录中。</p>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <Field form={form} setForm={setForm} group="settlementData" field="acctName" label="结算户名" required />
            <Field form={form} setForm={setForm} group="settlementData" field="acctNo" label="结算账号" required />
            <OpeningBankField form={form} setForm={setForm} applicationId={applicationId} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Store className="size-4 text-[var(--primary)]" />
              门店与终端资料
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <Field form={form} setForm={setForm} group="shopData" field="shopName" label="门店名称" required />
            <Field form={form} setForm={setForm} group="shopData" field="shopContactMobile" label="门店联系电话" />
            <Field form={form} setForm={setForm} group="shopData" field="shopAddr" label="门店详细地址" required />
            <Field form={form} setForm={setForm} group="terminalData" field="termNum" label="申请终端数量" type="number" />
          </CardContent>
        </Card>
      </div>
    </fieldset>
  )
}

type OnboardingListRow = OnboardingListItem & Record<string, unknown>

export function OnboardingList({
  applications,
  canCreate,
  embedded = false,
}: {
  applications: OnboardingListItem[]
  canCreate: boolean
  embedded?: boolean
}) {
  const rows = applications as OnboardingListRow[]
  const counts = useMemo(() => onboardingMetricCounts(applications), [applications])

  const columns: Column<OnboardingListRow>[] = [
    {
      key: "applicationNo",
      header: "申请编号",
      cell: (row) => <span className="font-mono text-xs">{row.applicationNo}</span>,
    },
    {
      key: "storeName",
      header: "门店",
      cell: (row) => <span className="font-medium">{row.storeName}</span>,
    },
    {
      key: "marketName",
      header: "所属市场",
      cell: (row) => row.marketName ?? "—",
    },
    { key: "subjectName", header: "主体名称" },
    {
      key: "status",
      header: "状态",
      cell: (row) => <StatusBadge status={row.status} label={onboardingBusinessStatus(row).label} />,
    },
    {
      key: "todo",
      header: "当前待办",
      cell: (row) => <span className="text-[#666666]">{onboardingBusinessStatus(row).todo}</span>,
    },
    {
      key: "owner",
      header: "负责人",
      cell: (row) => row.owner ?? "—",
    },
    {
      key: "updatedAt",
      header: "更新时间",
      cell: (row) => <span className="text-xs text-[#999999]">{formatDateTime(row.updatedAt)}</span>,
    },
    {
      key: "action",
      header: "",
      className: "text-right",
      cell: (row) => (
        <Link href={"/merchants/onboarding/" + row.id}>
          <Button size="sm" variant="outline">查看</Button>
        </Link>
      ),
    },
  ]

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className={embedded ? "text-lg font-semibold" : "text-2xl font-bold"}>门店拉卡拉入网</h1>
          <p className="mt-1 text-xs text-[#999999]">
            记录门店资料、电子合同、拉卡拉审核、渠道认证及收款商户关联。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {!embedded && (
            <Link href="/merchants">
              <Button variant="outline"><ArrowLeft />收款商户</Button>
            </Link>
          )}
          {canCreate && (
            <Link href="/merchants/onboarding/new">
              <Button><Plus />发起入网申请</Button>
            </Link>
          )}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="待补资料" value={counts.drafts} icon={<FileWarning className="size-6 text-[#D4820A]" />} tone="text-[#A45D00]" />
        <Metric label="待提交" value={counts.ready} icon={<ClipboardCheck className="size-6 text-[#386987]" />} tone="text-[#386987]" />
        <Metric label="办理中" value={counts.reviewing} icon={<RefreshCw className="size-6 text-[#62508B]" />} tone="text-[#62508B]" />
        <Metric label="办理完成" value={counts.completed} icon={<CheckCircle2 className="size-6 text-[#3D8A5A]" />} tone="text-[#287342]" />
      </div>

      <DataTable columns={columns} data={rows} emptyText="暂无入网申请" />
    </div>
  )
}

function Metric({
  label,
  value,
  icon,
  tone,
}: {
  label: string
  value: number
  icon: ReactNode
  tone: string
}) {
  return (
    <Card>
      <CardContent className="flex items-center justify-between p-4">
        <div>
          <p className="text-xs text-[#999999]">{label}</p>
          <p className={cn("mt-1 text-2xl font-semibold", tone)}>{value}</p>
        </div>
        {icon}
      </CardContent>
    </Card>
  )
}

type OnboardingStoreRow = OnboardingStoreOption & Record<string, unknown>

export function NewOnboardingApplication({ stores }: { stores: OnboardingStoreOption[] }) {
  const router = useRouter()
  const options = stores as OnboardingStoreRow[]
  const [storeId, setStoreId] = useState(
    options.find((item) => !item.hasCollectionMerchant && !item.activeApplicationId)?.storeId ?? "",
  )
  const [pending, startTransition] = useTransition()
  const selected = options.find((item) => item.storeId === storeId)
  const blocked = !selected || selected.hasCollectionMerchant || Boolean(selected.activeApplicationId)

  function create() {
    if (!selected) return
    startTransition(async () => {
      try {
        const result = await createOnboardingApplication(selected.storeId)
        const id = result.id
        if (!result.success || !id) {
          toast.error(result.message || "创建入网申请失败")
          return
        }
        toast.success(result.message)
        router.push("/merchants/onboarding/" + id)
      } catch (error) {
        toast.error(actionErrorMessage(error, "创建入网申请失败"))
      }
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">发起门店入网申请</h1>
          <p className="mt-1 text-xs text-[#999999]">只能选择未关联收款商户、且没有进行中申请的门店。</p>
        </div>
        <Link href="/merchants/onboarding">
          <Button variant="outline"><ArrowLeft />返回入网列表</Button>
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Store className="size-4 text-[var(--primary)]" />
            选择门店
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className="block">
            <span className="text-sm font-medium">门店</span>
            <select
              value={storeId}
              onChange={(event) => setStoreId(event.target.value)}
              className="mt-1.5 h-10 w-full rounded-[var(--radius)] border border-[var(--input)] bg-white px-3 text-sm"
            >
              <option value="">请选择门店</option>
              {options.map((item) => (
                <option key={item.storeId} value={item.storeId}>
                  {[item.marketName, item.storeName].filter(Boolean).join(" / ")}
                </option>
              ))}
            </select>
          </label>
          {selected && (
            <div className="grid gap-3 md:grid-cols-3">
              <InfoBox
                label="收款商户"
                value={selected.hasCollectionMerchant ? "已绑定，不能重复申请" : "未绑定"}
                warning={selected.hasCollectionMerchant}
              />
              <InfoBox
                label="进行中申请"
                value={selected.activeApplicationId ? "已有进行中申请" : "无"}
                warning={Boolean(selected.activeApplicationId)}
              />
              <InfoBox label="可发起状态" value={blocked ? "不可创建" : "可创建草稿"} warning={blocked} />
            </div>
          )}
          <div className="flex justify-end">
            <Button disabled={blocked || pending} onClick={create}>
              <Plus />
              {pending ? "创建中..." : "创建并填写资料"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function InfoBox({
  label,
  value,
  warning,
}: {
  label: string
  value: string
  warning: boolean
}) {
  return (
    <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--muted)] p-3">
      <p className="text-xs text-[#999999]">{label}</p>
      <p className={cn("mt-1 text-sm font-medium", warning ? "text-[#A45D00]" : "text-[#287342]")}>{value}</p>
    </div>
  )
}

type RequestLogRow = OnboardingDetail["requestLogs"][number] & Record<string, unknown>

export function OnboardingEditor({
  application,
  canEdit,
  canFinalizeMerchant,
}: {
  application: OnboardingDetail
  canEdit: boolean
  canFinalizeMerchant: boolean
}) {
  const router = useRouter()
  const serverForm = useMemo(() => formFromApplication(application), [application])
  const {
    draft: form,
    setDraft: updateForm,
    dirty: formDirty,
    markClean: markFormClean,
  } = useRefreshSafeDraft({
    identity: application.id,
    version: application.updatedAt,
    serverValue: serverForm,
  })
  const [expectedUpdatedAt, setExpectedUpdatedAt] = useState(application.updatedAt)
  const [pending, startTransition] = useTransition()
  const [ocrStatus, setOcrStatus] = useState<Record<string, string>>({})
  const [localPreviewUrls, setLocalPreviewUrls] = useState<Record<string, string>>({})
  const localPreviewUrlsRef = useRef<Record<string, string>>({})
  useUnsavedChanges(formDirty)

  useEffect(() => {
    setExpectedUpdatedAt(application.updatedAt)
  }, [application.updatedAt])

  useEffect(() => {
    localPreviewUrlsRef.current = localPreviewUrls
  }, [localPreviewUrls])

  useEffect(() => () => {
    Object.values(localPreviewUrlsRef.current).forEach((url) => URL.revokeObjectURL(url))
  }, [])

  const attachments = useMemo(() => {
    const byType = new Map<string, OnboardingDetail["attachments"][number]>()
    for (const attachment of application.attachments) {
      if (!byType.has(attachment.attachmentType)) byType.set(attachment.attachmentType, attachment)
    }
    return byType
  }, [application.attachments])

  const wechatSubMerchant = channelMerchantNumbers(application.channelData, "wechat")
  const alipaySubMerchant = channelMerchantNumbers(application.channelData, "alipay")
  const waitingForAudit = ["SUBMITTING", "SUBMITTED", "REGISTERING"].includes(application.status)
  const needsReconsider = application.status === "FAILED" && Boolean(application.merInnerNo || application.merCupNo)
  const missingCollectionNumbers = [
    application.merCupNo ? "" : "银联商户号",
    application.terminalNo ? "" : "终端号",
    wechatSubMerchant ? "" : "微信子商户号",
    alipaySubMerchant ? "" : "支付宝子商户号",
  ].filter(Boolean)
  const canConfirmMerchant = application.status === "SUCCESS"
    && !application.lakalaMerchantId
    && missingCollectionNumbers.length === 0
  const businessStatus = onboardingBusinessStatus(application)
  const contractPdf = attachments.get(ELECTRONIC_CONTRACT_PDF_ATTACHMENT.attachmentType)
  const canCancelApplication = ["DRAFT", "FILES_UPLOADING", "FILES_READY", "FAILED"].includes(application.status)
    && !application.eContractOrderNo

  async function persistDraft(): Promise<string | null> {
    const result = await saveOnboardingApplication(application.id, form, expectedUpdatedAt)
    if (!result.success) {
      toast.error(result.message || "保存草稿失败")
      return null
    }
    const updatedAt = result.updatedAt ?? expectedUpdatedAt
    setExpectedUpdatedAt(updatedAt)
    markFormClean()
    toast.success(result.message)
    router.refresh()
    return updatedAt
  }

  function runAction(
    action: () => Promise<ActionResult>,
    fallback: string,
    options: { saveFirst?: boolean; confirmText?: string } = {},
  ) {
    if (options.confirmText && !window.confirm(options.confirmText)) return
    startTransition(async () => {
      try {
        if (options.saveFirst && !(await persistDraft())) return
        const result = await action()
        if (result.success) {
          toast.success(result.message)
        } else {
          toast.error(result.message || fallback)
        }
        router.refresh()
      } catch (error) {
        toast.error(actionErrorMessage(error, fallback))
      }
    })
  }

  function beginContract() {
    const contractWindow = window.open("about:blank", "_blank")
    if (contractWindow) contractWindow.opener = null
    startTransition(async () => {
      try {
        const updatedAt = await persistDraft()
        if (!updatedAt) {
          contractWindow?.close()
          return
        }
        const result = await initiateElectronicContract(application.id, updatedAt)
        if (!result.success || !result.resultUrl) {
          contractWindow?.close()
          toast.error(result.message || "发起电子合同失败")
          return
        }
        toast.success(result.message)
        if (contractWindow) {
          contractWindow.location.replace(result.resultUrl)
        } else {
          window.open(result.resultUrl, "_blank", "noopener,noreferrer")
        }
        router.refresh()
      } catch (error) {
        contractWindow?.close()
        toast.error(actionErrorMessage(error, "发起电子合同失败"))
      }
    })
  }

  async function runOcr(
    definition: (typeof ATTACHMENT_REQUIREMENTS)[number],
    file: File,
  ) {
    const isBusinessLicense = definition.attachmentType === "BUSINESS_LICENCE"
    const isIdCard = definition.attachmentType === "ID_CARD_FRONT" || definition.attachmentType === "ID_CARD_BEHIND"
    if (!isBusinessLicense && !isIdCard) return

    setOcrStatus((current) => ({ ...current, [definition.attachmentType]: "OCR 识别中..." }))
    const body = new FormData()
    body.set("file", file)
    if (definition.attachmentType === "ID_CARD_BEHIND") body.set("side", "back")

    try {
      const response = await fetch(
        isBusinessLicense ? "/api/ocr/business-license" : "/api/ocr/id-card",
        { method: "POST", body },
      )
      const payload = await response.json().catch(() => ({})) as {
        ok?: boolean
        data?: Record<string, string>
        error?: string
      }
      if (!payload.ok || !payload.data) {
        setOcrStatus((current) => ({
          ...current,
          [definition.attachmentType]: payload.error || "OCR 未识别，请手动填写",
        }))
        return
      }

      const data = payload.data
      if (isBusinessLicense) {
        const subjectName = data.merRegName || data.merBlisName || ""
        updateForm((current) => {
          const settlementData = getGroup(current, "settlementData")
          return {
            ...current,
            merchantData: {
              ...getGroup(current, "merchantData"),
              ...(subjectName ? { merRegName: subjectName, merBlisName: subjectName } : {}),
              ...(data.merBlis ? { merBlis: data.merBlis } : {}),
              ...(data.merRegAddr ? { merRegAddr: data.merRegAddr } : {}),
              ...(data.merRegDistCode ? { merRegDistCode: data.merRegDistCode } : {}),
              ...(data.merBlisStDt ? { merBlisStDt: data.merBlisStDt } : {}),
              ...(data.merBlisExpDt ? { merBlisExpDt: data.merBlisExpDt } : {}),
            },
            legalPersonData: {
              ...getGroup(current, "legalPersonData"),
              ...(data.larName ? { larName: data.larName } : {}),
            },
            settlementData: {
              ...settlementData,
              ...(subjectName && !settlementData.acctName ? { acctName: subjectName } : {}),
            },
          }
        })
      } else {
        updateForm((current) => ({
          ...current,
          legalPersonData: {
            ...getGroup(current, "legalPersonData"),
            ...(data.larName ? { larName: data.larName } : {}),
            ...(data.larIdcard ? { larIdcard: data.larIdcard } : {}),
            ...(data.larIdcardStDt ? { larIdcardStDt: data.larIdcardStDt } : {}),
            ...(data.larIdcardExpDt ? { larIdcardExpDt: data.larIdcardExpDt } : {}),
          },
        }))
      }
      setOcrStatus((current) => ({
        ...current,
        [definition.attachmentType]: "OCR 已识别，请确认下方字段",
      }))
    } catch {
      setOcrStatus((current) => ({
        ...current,
        [definition.attachmentType]: "OCR 未识别，请手动填写",
      }))
    }
  }

  async function upload(
    definition: (typeof ATTACHMENT_REQUIREMENTS)[number],
    file?: File,
  ) {
    if (!file || !canEdit) return
    if (file.size <= 0 || file.size > MAX_ONBOARDING_ATTACHMENT_BYTES) {
      toast.error(definition.label + "文件大小需在 " + formatFileSize(MAX_ONBOARDING_ATTACHMENT_BYTES) + " 以内")
      return
    }
    const acceptsPdf = allowsPdfAttachment(definition.attachmentType)
    if (!["image/jpeg", "image/png", ...(acceptsPdf ? ["application/pdf"] : [])].includes(file.type)) {
      toast.error(definition.label + (acceptsPdf ? "仅支持 JPG、PNG 图片或 PDF" : "仅支持 JPG 或 PNG 图片"))
      return
    }

    if (file.type.startsWith("image/")) {
      const nextUrl = URL.createObjectURL(file)
      setLocalPreviewUrls((current) => {
        if (current[definition.attachmentType]) URL.revokeObjectURL(current[definition.attachmentType])
        return { ...current, [definition.attachmentType]: nextUrl }
      })
    }
    await runOcr(definition, file)

    const body = new FormData()
    body.set("file", file)
    body.set("attachmentType", definition.attachmentType)
    body.set("expectedUpdatedAt", expectedUpdatedAt)
    try {
      const response = await fetch("/api/merchants/onboarding/" + application.id + "/files", {
        method: "POST",
        body,
      })
      const payload = await response.json().catch(() => ({})) as {
        ok?: boolean
        error?: string
        data?: { updatedAt?: string }
      }
      const updatedAt = typeof payload.data?.updatedAt === "string" ? payload.data.updatedAt : null
      if (updatedAt) setExpectedUpdatedAt(updatedAt)
      if (!payload.ok) {
        toast.error(payload.error || "资料上传失败")
        if (updatedAt) router.refresh()
        return
      }
      toast.success(definition.label + "已私有保存")
      router.refresh()
    } catch {
      toast.error("资料上传失败，请稍后重试")
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <Link href="/merchants/onboarding">
            <Button variant="outline" size="sm" aria-label="返回入网列表"><ArrowLeft /></Button>
          </Link>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-bold">门店拉卡拉入网申请</h1>
              <StatusBadge status={application.status} label={businessStatus.label} />
            </div>
            <p className="mt-1 text-xs text-[#999999]">
              {application.storeName + " · " + application.applicationNo + " · 最近更新 " + formatDateTime(application.updatedAt)}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {canFinalizeMerchant && (
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => runAction(
                () => queryOnboardingApplication(application.id),
                "查询审核状态失败",
              )}
            >
              <RefreshCw />查询审核状态
            </Button>
          )}
          {!waitingForAudit && application.status !== "SUCCESS" && application.status !== "CANCELLED" && (
            <Button
              disabled={pending || !canEdit}
              onClick={() => runAction(
                () => needsReconsider
                  ? reconsiderOnboardingApplication(application.id)
                  : submitOnboardingApplication(application.id),
                needsReconsider ? "重新提交失败" : "提交失败",
                { saveFirst: true },
              )}
            >
              <Send />{needsReconsider ? "修正后重新提交" : "提交拉卡拉"}
            </Button>
          )}
        </div>
      </div>

      {application.lastErrorMessage && (
        <div className="rounded-[var(--radius)] border border-[#F3B8B2] bg-[#FFF8F7] px-4 py-3 text-sm text-[#B42318]">
          {application.lastErrorMessage}
        </div>
      )}

      <Card className="border-[#F6D8A8]">
        <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div>
            <p className="text-sm font-medium">当前待办：{businessStatus.todo}</p>
            <p className="mt-1 text-xs text-[#999999]">
              市场：{application.marketName ?? "—"} · 负责人：{application.owner ?? "—"}
            </p>
          </div>
          {canEdit && (
            <div className="flex flex-wrap gap-2">
              {["DRAFT", "FILES_UPLOADING", "FILES_READY", "FAILED"].includes(application.status) && (
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={() => startTransition(() => void persistDraft())}
                >
                  <Save />保存草稿
                </Button>
              )}
              {canCancelApplication && (
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={() => runAction(
                    () => cancelOnboardingApplication(application.id, expectedUpdatedAt),
                    "取消申请失败",
                    { confirmText: "确定取消这份入网申请吗？私有资料将按留存策略保留。" },
                  )}
                >
                  <XCircle />取消申请
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Upload className="size-4 text-[var(--primary)]" />
            资料上传
          </CardTitle>
          <p className="text-xs text-[#999999]">
            附件只保存到私有目录，单个文件不超过 5 MB。营业执照和身份证图片上传后会尝试 OCR 预填。
          </p>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {ATTACHMENT_REQUIREMENTS.map((definition) => {
              const attachment = attachments.get(definition.attachmentType)
              const previewUrl = localPreviewUrls[definition.attachmentType] || attachment?.previewUrl
              const uploaded = Boolean(attachment && !["FAILED", "DELETED", "EXPIRED"].includes(attachment.status))
              const previewIsImage = attachment?.mimeType?.startsWith("image/") || Boolean(localPreviewUrls[definition.attachmentType])
              return (
                <div
                  key={definition.attachmentType}
                  className={cn(
                    "min-h-36 rounded-[var(--radius)] border p-3",
                    uploaded ? "border-[#B7E4C7] bg-[#F0F9F2]" : "border-dashed border-[#B8C4D2]",
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-medium">{definition.label}</p>
                    {uploaded
                      ? <CheckCircle2 className="size-4 text-[#3D8A5A]" />
                      : <FileWarning className="size-4 text-[#999999]" />}
                  </div>
                  <p className="mt-1 truncate text-xs text-[#999999]">{attachment?.fileName ?? "未上传"}</p>
                  {previewUrl && (
                    <a
                      href={previewUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-2 block overflow-hidden rounded border border-[var(--border)] text-xs text-[var(--primary)] hover:underline"
                    >
                      {previewIsImage ? (
                        <>
                          {/* Private image URLs use the current session cookie and cannot use Next image optimization. */}
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={previewUrl} alt={definition.label + "预览"} className="h-24 w-full bg-white object-contain" />
                        </>
                      ) : "查看已上传文件"}
                    </a>
                  )}
                  {attachment?.lastErrorMessage && (
                    <p className="mt-1 text-xs text-[#B42318]">{attachment.lastErrorMessage}</p>
                  )}
                  {ocrStatus[definition.attachmentType] && (
                    <p className="mt-1 text-xs text-[#386987]">{ocrStatus[definition.attachmentType]}</p>
                  )}
                  {canEdit && (
                    <label className="mt-2 inline-flex h-8 cursor-pointer items-center gap-1 rounded-[var(--radius)] border border-[var(--border)] bg-white px-2 text-xs hover:bg-[var(--muted)]">
                      <Upload className="size-3" />{uploaded ? "重新上传" : "选择文件"}
                      <input
                        hidden
                        type="file"
                        accept={allowsPdfAttachment(definition.attachmentType)
                          ? "image/jpeg,image/png,application/pdf"
                          : "image/jpeg,image/png"}
                        onChange={(event) => void upload(definition, event.target.files?.[0])}
                      />
                    </label>
                  )}
                </div>
              )
            })}
          </div>
        </CardContent>
      </Card>

      <OnboardingForm
        form={form}
        setForm={updateForm}
        pending={pending || !canEdit}
        applicationId={application.id}
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <FileText className="size-4 text-[var(--primary)]" />
            电子合同与提交
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col justify-between gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--muted)] p-4 sm:flex-row sm:items-center">
            <div>
              <p className="text-sm font-medium">拉卡拉电子合同</p>
              <p className="mt-1 text-xs text-[#999999]">
                {application.eContractStatus === "COMPLETED"
                  ? "已完成签约" + (application.eContractNo ? "，合同号：" + application.eContractNo : "")
                  : "保存资料后从拉卡拉正式电子合同服务发起签约；系统通过主动查询确认签约结果。"}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {application.eContractOrderNo && application.eContractStatus !== "COMPLETED" && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending || !canEdit}
                  onClick={() => runAction(
                    () => refreshElectronicContractStatus(application.id),
                    "查询电子合同状态失败",
                  )}
                >
                  <RefreshCw />查询签约状态
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                disabled={pending || !canEdit || application.eContractStatus === "COMPLETED"}
                onClick={beginContract}
              >
                <FileText />发起电子合同
              </Button>
            </div>
          </div>
          {contractPdf?.previewUrl && (
            <a
              href={contractPdf.previewUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 text-sm text-[var(--primary)] hover:underline"
            >
              <FileText className="size-4" />查看已私有保存的签约合同
            </a>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            {canEdit && (
              <Button
                variant="outline"
                disabled={pending}
                onClick={() => startTransition(() => void persistDraft())}
              >
                <Save />保存草稿
              </Button>
            )}
            {!waitingForAudit && application.status !== "SUCCESS" && application.status !== "CANCELLED" && (
              <Button
                disabled={pending || !canEdit}
                onClick={() => runAction(
                  () => needsReconsider
                    ? reconsiderOnboardingApplication(application.id)
                    : submitOnboardingApplication(application.id),
                  needsReconsider ? "重新提交失败" : "提交失败",
                  { saveFirst: true },
                )}
              >
                <Send />{needsReconsider ? "修正后重新提交" : "提交拉卡拉"}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {application.status === "SUCCESS" && (
        <Card>
          <CardHeader className="flex-row flex-wrap items-start justify-between gap-3 space-y-0">
            <div>
              <CardTitle className="text-base">渠道认证与收款商户</CardTitle>
              <p className="mt-1 text-xs text-[#999999]">
                审核通过后完成渠道认证；刷新到微信认证通过且已有终端号时，系统会自动绑定并启用收款商户。
              </p>
            </div>
            {canEdit && (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() => runAction(
                    () => refreshOnboardingSubMerchants(application.id),
                    "查询子商户号失败",
                  )}
                >
                  <RefreshCw />查询子商户号
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() => runAction(
                    () => refreshOnboardingCertificationStatus(application.id),
                    "查询认证状态失败",
                  )}
                >
                  <RefreshCw />查询认证状态
                </Button>
              </div>
            )}
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 md:grid-cols-4">
              <InfoBox label="银联商户号" value={application.merCupNo || "等待返回"} warning={!application.merCupNo} />
              <InfoBox label="终端号" value={application.terminalNo || "等待返回"} warning={!application.terminalNo} />
              <InfoBox label="微信子商户号" value={wechatSubMerchant || "等待报备"} warning={!wechatSubMerchant} />
              <InfoBox label="支付宝子商户号" value={alipaySubMerchant || "等待报备"} warning={!alipaySubMerchant} />
            </div>
            <div className="flex flex-col justify-between gap-3 rounded-[var(--radius)] border border-[#D9D2F0] bg-[#F7F4FC] p-4 sm:flex-row sm:items-center">
              <div>
                <p className="text-sm font-medium">法人完成微信认证后刷新状态</p>
                <p className="mt-1 text-xs text-[#62508B]">刷新认证可自动启用收款；“人工确认”仅用于需要操作员核验的情况，绑定后仍保持未启用。</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Link href="/merchants/lakala-guides/wechat" target="_blank">
                  <Button variant="outline" size="sm">微信认证指南</Button>
                </Link>
                <Link href="/merchants/lakala-guides/alipay" target="_blank">
                  <Button variant="outline" size="sm">支付宝认证指南</Button>
                </Link>
                {canEdit && (
                  <Button
                    disabled={pending || !canConfirmMerchant}
                    onClick={() => runAction(
                      () => confirmOnboardingExternalCertification(application.id),
                      "确认外部认证失败",
                      { confirmText: "请确认已人工核验微信和支付宝认证。此操作只关联商户，不会启用收款。" },
                    )}
                  >
                    <ClipboardCheck />人工确认
                  </Button>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle className="text-base">外部请求记录</CardTitle></CardHeader>
        <CardContent>
          <DataTable
            columns={[
              {
                key: "createdAt",
                header: "时间",
                cell: (log) => <span className="text-xs text-[#999999]">{formatDateTime(log.createdAt)}</span>,
              },
              { key: "apiName", header: "接口" },
              {
                key: "status",
                header: "结果",
                cell: (log) => (
                  <span className={
                    log.status === "SUCCEEDED"
                      ? "text-[#287342]"
                      : log.status === "FAILED"
                        ? "text-[#B42318]"
                        : "text-[#62508B]"
                  }>
                    {log.status}
                  </span>
                ),
              },
              { key: "errorMessage", header: "说明", cell: (log) => log.errorMessage ?? "—" },
            ] satisfies Column<RequestLogRow>[]}
            data={application.requestLogs as RequestLogRow[]}
            emptyText="暂无外部请求记录"
          />
        </CardContent>
      </Card>
    </div>
  )
}
