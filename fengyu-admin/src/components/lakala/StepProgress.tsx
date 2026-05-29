"use client"

/**
 * 拉卡拉商户入网 14 步状态条
 *
 * 数据源：lakala-onboarding-state.ts 的 13 态枚举 → 映射到 14 步流程图。
 * 颜色契约（plan §4 + admin status 配色）：
 *   未到 = 灰  #888888
 *   进行中 = 蓝 #5E8BB3
 *   成功 = 绿 #3D8A5A
 *   失败 = 红 #D94040
 *   待审/复议 = 橙 #D4820A
 *
 * UI：横向 14 步圆点 + 步号 + 短文案；当前步标"进行中/失败/待审"色，过往步绿色，未到步灰色。
 * 配色对齐 .42cog/design/admin.ui.spec.md。
 *
 * **费率全不可见 plan §0★** —— 本组件不渲染任何费率字段。
 */

import type { LakalaOnboardingStatus } from "@/lib/lakala-onboarding-state"

interface Step {
  /** 1..14 步号 */
  index: number
  /** 步骤短名（中文） */
  label: string
  /** 状态详情副标题 */
  hint?: string
}

const STEPS: Step[] = [
  { index: 1, label: "准备资料", hint: "录入商户名 / 法人 / 经营 / 结算" },
  { index: 2, label: "上传法人证件", hint: "身份证正反面" },
  { index: 3, label: "上传配套附件", hint: "银行卡 / 营业执照 / 门头照 / 内景照" },
  { index: 4, label: "申请电子合同", hint: "applyContract" },
  { index: 5, label: "法人签署", hint: "H5 短信链接" },
  { index: 6, label: "签约回调", hint: "ecStatus=COMPLETED" },
  { index: 7, label: "查询合同", hint: "queryContract" },
  { index: 8, label: "下载合同", hint: "downloadContract（可选）" },
  { index: 9, label: "提交进件", hint: "submitMerchant" },
  { index: 10, label: "审核回调", hint: "等待 WAIT_FOR_CONTACT" },
  { index: 11, label: "查询/复议", hint: "queryMerchant / submitAppeal" },
  { index: 12, label: "审核通过", hint: "拿到 merchant_no / term_no" },
  { index: 13, label: "微信实名", hint: "querySubMerchantId 回填 wx_sub_mchid" },
  { index: 14, label: "支付宝实名", hint: "querySubMerchantId 回填 alipay_sub_mchid" },
]

/** 状态 → 当前所处步号（1..14）。 */
const STATUS_STEP_INDEX: Record<LakalaOnboardingStatus, number> = {
  draft: 1,
  contract_signing: 4,
  contract_signed: 7,
  attachments_uploading: 3,
  submitted: 9,
  callback_pending: 10,
  approved: 12,
  rejected: 11,
  under_review: 11,
  appealing: 11,
  realname_pending: 13,
  completed: 14,
  cancelled: 0, // 已作废：所有步骤都灰
}

type StepColor = "未到" | "进行中" | "成功" | "失败" | "待审" | "复议"

const COLOR_HEX: Record<StepColor, string> = {
  未到: "#888888",
  进行中: "#5E8BB3",
  成功: "#3D8A5A",
  失败: "#D94040",
  待审: "#D4820A",
  复议: "#D4820A",
}

/** 状态 → 当前步显示的"模式色"。 */
function statusToCurrentColor(status: LakalaOnboardingStatus): StepColor {
  switch (status) {
    case "rejected":
      return "失败"
    case "under_review":
      return "待审"
    case "appealing":
      return "复议"
    case "completed":
      return "成功"
    case "cancelled":
      return "失败"
    default:
      return "进行中"
  }
}

/** 计算每步颜色：< current = 成功；== current = 状态色；> current = 未到。 */
function stepColor(stepIdx: number, currentIdx: number, currentColor: StepColor): StepColor {
  if (currentIdx === 0) return "未到" // cancelled 全部置灰
  if (stepIdx < currentIdx) return "成功"
  if (stepIdx === currentIdx) return currentColor
  return "未到"
}

export interface StepProgressProps {
  status: LakalaOnboardingStatus
  /** 可选错误文案（rejected/under_review 时展示在副标题下方） */
  errorMsg?: string | null
  className?: string
}

export function StepProgress({ status, errorMsg, className }: StepProgressProps) {
  const currentIdx = STATUS_STEP_INDEX[status] ?? 0
  const currentColor = statusToCurrentColor(status)

  return (
    <div className={"w-full " + (className ?? "")}>
      <div className="flex items-center justify-between overflow-x-auto py-2">
        {STEPS.map((step, i) => {
          const color = stepColor(step.index, currentIdx, currentColor)
          const hex = COLOR_HEX[color]
          const showBar = i < STEPS.length - 1
          return (
            <div key={step.index} className="flex items-center min-w-[64px]">
              {/* 步号圆点 */}
              <div className="flex flex-col items-center text-center">
                <div
                  className="flex items-center justify-center rounded-full text-xs font-semibold text-white w-7 h-7 shrink-0"
                  style={{ backgroundColor: hex }}
                  title={step.hint}
                >
                  {step.index}
                </div>
                <div className="mt-1 text-[11px] leading-tight whitespace-nowrap" style={{ color: hex }}>
                  {step.label}
                </div>
              </div>
              {showBar && (
                <div
                  className="h-0.5 w-6 mx-1 shrink-0"
                  style={{ backgroundColor: stepColor(step.index + 1, currentIdx, currentColor) === "未到" ? COLOR_HEX["未到"] : COLOR_HEX["成功"] }}
                />
              )}
            </div>
          )
        })}
      </div>

      {/* 当前步副标题与错误信息 */}
      <div className="mt-2 flex items-baseline gap-3 text-sm">
        <span className="text-[var(--muted-foreground)]">
          当前阶段：
          <span className="font-medium" style={{ color: COLOR_HEX[currentColor] }}>
            {STEPS.find((s) => s.index === currentIdx)?.label ?? (status === "cancelled" ? "已作废" : "未开始")}
          </span>
        </span>
        {STEPS.find((s) => s.index === currentIdx)?.hint && (
          <span className="text-xs text-[var(--muted-foreground)]">
            {STEPS.find((s) => s.index === currentIdx)?.hint}
          </span>
        )}
      </div>
      {errorMsg ? (
        <div className="mt-1 text-xs" style={{ color: COLOR_HEX["失败"] }}>
          上次失败：{errorMsg}
        </div>
      ) : null}
    </div>
  )
}

export default StepProgress
