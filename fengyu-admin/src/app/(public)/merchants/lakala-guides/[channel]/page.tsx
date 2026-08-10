import { notFound } from "next/navigation"
import { BadgeCheck, ChevronRight, CircleUserRound, ClipboardCheck, ScanLine, ShieldCheck } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

const guides = {
  wechat: {
    title: "微信商户实名认证指南",
    description: "请使用营业执照对应法人本人的微信账号和身份信息完成认证。",
    steps: [
      "使用法人常用微信扫描拉卡拉提供的认证入口。",
      "按页面提示选择商户主体，并填写营业执照对应的法人信息。",
      "完成身份核验或对公账户验证，保留平台提示的完成状态。",
      "返回入网申请页面，确认微信认证状态后等待后台审核启用。",
    ],
  },
  alipay: {
    title: "支付宝商户实名认证指南",
    description: "请使用营业执照对应法人本人的支付宝账号和身份信息完成认证。",
    steps: [
      "使用法人常用支付宝扫描拉卡拉提供的认证入口。",
      "按页面提示选择商户主体，并填写营业执照对应的法人信息。",
      "完成身份核验或对公账户验证，保留平台提示的完成状态。",
      "返回入网申请页面，确认支付宝认证状态后等待后台审核启用。",
    ],
  },
} as const

const stepIcons = [ScanLine, CircleUserRound, ClipboardCheck, BadgeCheck]

export default async function LakalaGuidePage({
  params,
}: {
  params: Promise<{ channel: string }>
}) {
  const { channel } = await params
  const guide = guides[channel as keyof typeof guides]
  if (!guide) notFound()

  return (
    <main className="min-h-screen bg-[#F7F7F7] px-4 py-6 sm:px-8">
      <div className="mx-auto max-w-4xl space-y-5">
        <div>
          <div>
            <p className="text-sm font-medium text-[#C0322A]">凤御美业 · 拉卡拉认证指南</p>
            <h1 className="mt-1 text-2xl font-bold">{guide.title}</h1>
            <p className="mt-1 text-sm text-[#777777]">本页面可直接发送给门店法人，无需登录管理后台。</p>
          </div>
        </div>

        <Card className="border-[#D9E8DF] bg-[#F6FBF8]">
          <CardContent className="flex items-start gap-3 p-4">
            <ShieldCheck className="mt-0.5 size-5 shrink-0 text-[#287342]" />
            <div>
              <p className="font-medium text-[#287342]">请使用营业执照对应法人本人账号和身份信息。</p>
              <p className="mt-1 text-sm text-[#5E7A68]">
                {guide.description} 完成后，请回到对应的入网申请页面确认认证状态。
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">认证步骤</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            {guide.steps.map((step, index) => {
              const Icon = stepIcons[index]
              return (
                <div key={step} className="flex min-h-32 gap-3 border border-[var(--border)] bg-white p-4">
                  <div className="flex size-9 shrink-0 items-center justify-center bg-[#FFF0EF] text-[#C0322A]">
                    <Icon className="size-5" aria-hidden="true" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">第 {index + 1} 步</p>
                    <p className="mt-2 text-sm leading-6 text-[#666666]">{step}</p>
                  </div>
                </div>
              )
            })}
          </CardContent>
        </Card>

        <div className="flex items-center gap-2 text-sm text-[#666666]">
          <ChevronRight className="size-4 text-[#C0322A]" aria-hidden="true" />
          认证完成不代表收款已启用，请等待后台核验后使用。
        </div>
      </div>
    </main>
  )
}
