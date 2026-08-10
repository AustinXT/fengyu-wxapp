"use client"

import {
  useEffect,
  useId,
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
import { useUnsavedChanges } from "@/lib/hooks/use-unsaved-changes"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { DataTable, type Column } from "@/components/ui/data-table"
import { Input } from "@/components/ui/input"
import { cn, formatDateTime } from "@/lib/utils"

type StringRecord = Record<string, string>

type ActionResult = {
  success: boolean
  message: string
  id?: string
  applicationId?: string
  resultUrl?: string
  updatedAt?: string
}

type LakalaArea = {
  code: string
  name: string
  parentCode: string
}

let areaRowsPromise: Promise<LakalaArea[]> | null = null
const PDF_ATTACHMENT_TYPES = new Set(["BUSINESS_LICENCE", "OPENING_PERMIT"])

function allowsPdfAttachment(attachmentType: string): boolean {
  return PDF_ATTACHMENT_TYPES.has(attachmentType)
}

function loadLakalaAreas(): Promise<LakalaArea[]> {
  if (!areaRowsPromise) {
    areaRowsPromise = fetch("/data/lakala-merchant-areas.tsv")
      .then(async (response) => {
        if (!response.ok) throw new Error("无法加载拉卡拉地区码")
        const text = await response.text()
        return text
          .split(/\r?\n/)
          .slice(1)
          .flatMap((line) => {
            const [code, name, parentCode] = line.split("\t")
            return code && name ? [{ code, name, parentCode: parentCode || "" }] : []
          })
      })
      .catch(() => [])
  }
  return areaRowsPromise
}

const statusText: Record<OnboardingStatus, string> = {
  DRAFT: "草稿",
  FILES_UPLOADING: "资料保存中",
  FILES_READY: "资料已就绪",
  SUBMITTING: "提交中",
  SUBMITTED: "已提交",
  REGISTERING: "审核中",
  SUCCESS: "审核通过",
  FAILED: "审核失败",
  CANCELLED: "已取消",
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

function StatusBadge({ status }: { status: OnboardingStatus }) {
  const className = status === "SUCCESS"
    ? "border-[#3D8A5A] bg-[#F0F9F2] text-[#287342]"
    : status === "FAILED" || status === "CANCELLED"
      ? "border-[#D94040] bg-[#FFF5F4] text-[#B42318]"
      : status === "DRAFT" || status === "FILES_UPLOADING"
        ? "border-[#D4820A] bg-[#FFF8E6] text-[#A45D00]"
        : "border-[#7A67A8] bg-[#F5F1FA] text-[#62508B]"
  return <Badge variant="outline" className={className}>{statusText[status]}</Badge>
}

function todoForApplication(application: OnboardingListItem): string {
  if (application.status === "SUCCESS") {
    if (!application.merCupNo || !application.terminalNo) return "等待拉卡拉返回收款编号"
    if (!application.lakalaMerchantId) return "待关联收款商户"
    return application.lakalaMerchantEnabled
      ? "收款已启用"
      : "完成渠道认证后，请在收款商户页人工启用"
  }
  if (application.status === "FAILED") return "修正资料后重新提交"
  if (application.status === "SUBMITTED" || application.status === "REGISTERING") return "等待拉卡拉审核"
  return application.missing || "补齐资料并提交拉卡拉"
}

function formatFileSize(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1) + " MB"
}

function channelMerchantNumbers(
  channelData: Record<string, unknown>,
  channel: "wechat" | "alipay",
): string {
  const values = channelData[channel]
  if (!Array.isArray(values)) return ""
  return values
    .flatMap((value) => {
      if (!value || typeof value !== "object") return []
      const number = (value as Record<string, unknown>).subMerchantNo
      return typeof number === "string" ? [number] : []
    })
    .join("、")
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
}: {
  form: OnboardingApplicationInput
  setForm: (next: OnboardingApplicationInput) => void
  group: keyof OnboardingApplicationInput
  field: string
  label: string
  hint?: string
  type?: string
  required?: boolean
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
  const listId = useId()
  const [areas, setAreas] = useState<LakalaArea[]>([])
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

  const selected = useMemo(() => areas.find((area) => area.code === value), [areas, value])
  return (
    <label className="block sm:col-span-2">
      <span className="text-sm font-medium text-[var(--foreground)]">
        {label} <span className="text-[#D94040]">*</span>
      </span>
      <Input
        list={listId}
        value={value}
        onChange={(event) => setForm(setFormField(form, group, field, event.target.value.trim()))}
        placeholder="输入或选择拉卡拉区县地区码"
        className="mt-1.5"
      />
      <datalist id={listId}>
        {areas.map((area) => (
          <option key={area.code} value={area.code} label={area.name} />
        ))}
      </datalist>
      <span className="mt-1 block text-xs text-[#999999]">
        {selected ? "已选择：" + selected.name + "（" + selected.code + "）" : hint}
      </span>
    </label>
  )
}

function OnboardingForm({
  form,
  setForm,
  pending,
  bankOptions,
  onSearchBanks,
  onSelectBank,
}: {
  form: OnboardingApplicationInput
  setForm: (next: OnboardingApplicationInput) => void
  pending: boolean
  bankOptions: OnboardingBankOption[]
  onSearchBanks: (keyword: string) => Promise<void>
  onSelectBank: (bank: OnboardingBankOption) => void
}) {
  const [bankKeyword, setBankKeyword] = useState(getGroup(form, "settlementData").openningBankName ?? "")

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
          <Field form={form} setForm={setForm} group="merchantData" field="merRegAddr" label="注册地址详细地址" required />
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
            <LakalaAreaCodeField
              form={form}
              setForm={setForm}
              group="settlementData"
              field="bankDistCode"
              label="开户地区码"
              hint="用于查询开户支行，并在保存时补齐结算省、市编码。"
            />
            <Field form={form} setForm={setForm} group="settlementData" field="openningBankCode" label="开户支行编码" required />
            <Field form={form} setForm={setForm} group="settlementData" field="clearingBankCode" label="清算行号" required />
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-[var(--foreground)]">
                开户支行名称 <span className="text-[#D94040]">*</span>
              </label>
              <div className="mt-1.5 flex gap-2">
                <Input
                  value={bankKeyword}
                  onChange={(event) => setBankKeyword(event.target.value)}
                  placeholder="输入支行关键字后查询"
                />
                <Button
                  type="button"
                  variant="outline"
                  disabled={!bankKeyword.trim()}
                  onClick={() => void onSearchBanks(bankKeyword)}
                >
                  查询
                </Button>
              </div>
              {bankOptions.length > 0 && (
                <select
                  className="mt-2 h-9 w-full rounded-[var(--radius)] border border-[var(--input)] bg-white px-3 text-sm"
                  defaultValue=""
                  onChange={(event) => {
                    const bank = bankOptions[Number(event.target.value)]
                    if (bank) onSelectBank(bank)
                    event.currentTarget.value = ""
                  }}
                >
                  <option value="">选择查询结果填入</option>
                  {bankOptions.map((bank, index) => (
                    <option key={bank.branchBankNo} value={index}>
                      {bank.branchBankName + "（" + bank.branchBankNo + "）"}
                    </option>
                  ))}
                </select>
              )}
              <Input
                value={getGroup(form, "settlementData").openningBankName ?? ""}
                onChange={(event) => setForm(setFormField(form, "settlementData", "openningBankName", event.target.value))}
                className="mt-2"
                placeholder="开户支行名称"
              />
            </div>
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
}: {
  applications: OnboardingListItem[]
  canCreate: boolean
}) {
  const rows = applications as OnboardingListRow[]
  const counts = useMemo(() => ({
    drafts: rows.filter((item) => ["DRAFT", "FILES_UPLOADING", "FAILED"].includes(item.status)).length,
    ready: rows.filter((item) => item.status === "FILES_READY").length,
    reviewing: rows.filter((item) => ["SUBMITTING", "SUBMITTED", "REGISTERING"].includes(item.status)).length,
    success: rows.filter((item) => item.status === "SUCCESS").length,
  }), [rows])

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
      cell: (row) => <StatusBadge status={row.status} />,
    },
    {
      key: "todo",
      header: "当前待办",
      cell: (row) => <span className="text-[#666666]">{todoForApplication(row)}</span>,
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
          <h1 className="text-2xl font-bold">门店拉卡拉入网</h1>
          <p className="mt-1 text-xs text-[#999999]">
            记录门店资料、电子合同、拉卡拉审核、渠道认证及收款商户关联。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/merchants">
            <Button variant="outline"><ArrowLeft />收款商户</Button>
          </Link>
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
        <Metric label="审核中" value={counts.reviewing} icon={<RefreshCw className="size-6 text-[#62508B]" />} tone="text-[#62508B]" />
        <Metric label="审核通过" value={counts.success} icon={<CheckCircle2 className="size-6 text-[#3D8A5A]" />} tone="text-[#287342]" />
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
  const [form, setForm] = useState(() => formFromApplication(application))
  const [expectedUpdatedAt, setExpectedUpdatedAt] = useState(application.updatedAt)
  const [pending, startTransition] = useTransition()
  const [formDirty, setFormDirty] = useState(false)
  const [ocrStatus, setOcrStatus] = useState<Record<string, string>>({})
  const [localPreviewUrls, setLocalPreviewUrls] = useState<Record<string, string>>({})
  const localPreviewUrlsRef = useRef<Record<string, string>>({})
  const [bankOptions, setBankOptions] = useState<OnboardingBankOption[]>([])
  useUnsavedChanges(formDirty)

  useEffect(() => {
    setForm(formFromApplication(application))
    setExpectedUpdatedAt(application.updatedAt)
    setFormDirty(false)
    setBankOptions([])
  }, [application])

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
  const canConfirmMerchant = application.status === "SUCCESS" && missingCollectionNumbers.length === 0
  const contractPdf = attachments.get(ELECTRONIC_CONTRACT_PDF_ATTACHMENT.attachmentType)
  const canCancelApplication = ["DRAFT", "FILES_UPLOADING", "FILES_READY", "FAILED"].includes(application.status)
    && !application.eContractOrderNo

  function updateForm(next: OnboardingApplicationInput) {
    setForm(next)
    setFormDirty(true)
  }

  async function persistDraft(): Promise<string | null> {
    const result = await saveOnboardingApplication(application.id, form, expectedUpdatedAt)
    if (!result.success) {
      toast.error(result.message || "保存草稿失败")
      return null
    }
    const updatedAt = result.updatedAt ?? expectedUpdatedAt
    setExpectedUpdatedAt(updatedAt)
    setFormDirty(false)
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
        updateForm({
          ...form,
          merchantData: {
            ...getGroup(form, "merchantData"),
            ...(subjectName ? { merRegName: subjectName, merBlisName: subjectName } : {}),
            ...(data.merBlis ? { merBlis: data.merBlis } : {}),
            ...(data.merRegAddr ? { merRegAddr: data.merRegAddr } : {}),
            ...(data.merRegDistCode ? { merRegDistCode: data.merRegDistCode } : {}),
            ...(data.merBlisStDt ? { merBlisStDt: data.merBlisStDt } : {}),
            ...(data.merBlisExpDt ? { merBlisExpDt: data.merBlisExpDt } : {}),
          },
          legalPersonData: {
            ...getGroup(form, "legalPersonData"),
            ...(data.larName ? { larName: data.larName } : {}),
          },
          settlementData: {
            ...getGroup(form, "settlementData"),
            ...(subjectName && !getGroup(form, "settlementData").acctName ? { acctName: subjectName } : {}),
          },
        })
      } else {
        updateForm({
          ...form,
          legalPersonData: {
            ...getGroup(form, "legalPersonData"),
            ...(data.larName ? { larName: data.larName } : {}),
            ...(data.larIdcard ? { larIdcard: data.larIdcard } : {}),
            ...(data.larIdcardStDt ? { larIdcardStDt: data.larIdcardStDt } : {}),
            ...(data.larIdcardExpDt ? { larIdcardExpDt: data.larIdcardExpDt } : {}),
          },
        })
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

  async function searchBank(keyword: string) {
    try {
      const result = await searchOnboardingBanks(
        application.id,
        keyword,
        getGroup(form, "settlementData").bankDistCode ?? "",
      )
      if (!result.success) {
        toast.error(result.message || "开户行查询失败")
        return
      }
      setBankOptions(result.banks ?? [])
      if (!result.banks?.length) toast.info(result.message || "未找到匹配开户行")
    } catch (error) {
      toast.error(actionErrorMessage(error, "开户行查询失败"))
    }
  }

  function selectBank(bank: OnboardingBankOption) {
    updateForm({
      ...form,
      settlementData: {
        ...getGroup(form, "settlementData"),
        openningBankName: bank.branchBankName,
        openningBankCode: bank.branchBankNo,
        ...(bank.clearNo ? { clearingBankCode: bank.clearNo } : {}),
      },
    })
    setBankOptions([])
    toast.success("已填入开户支行，请确认")
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
              <StatusBadge status={application.status} />
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
            <p className="text-sm font-medium">当前待办：{todoForApplication(application)}</p>
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
        bankOptions={bankOptions}
        onSearchBanks={searchBank}
        onSelectBank={selectBank}
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
                审核通过后系统会绑定未启用的收款商户；子商户号由定时任务持续查询。
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
                <p className="text-sm font-medium">法人完成外部认证后刷新状态</p>
                <p className="mt-1 text-xs text-[#62508B]">收款商户会保持未启用状态，仍需在收款商户页单独启用。</p>
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
                      { confirmText: "请确认法人已完成微信和支付宝认证。此操作不会自动启用收款。" },
                    )}
                  >
                    <ClipboardCheck />确认认证
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
