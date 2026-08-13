import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Download, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

const guides = {
  wechat: {
    title: '微信商户实名认证指南',
    description: '请使用营业执照对应法人本人微信账号和身份完成认证。',
    downloadHref: '/lakala-guides/wechat/wechat-certification-guide.docx',
    images: Array.from({ length: 15 }, (_, index) => `/lakala-guides/wechat/step-${String(index + 1).padStart(2, '0')}.png`),
  },
  alipay: {
    title: '支付宝商户实名认证指南',
    description: '请使用营业执照对应法人本人支付宝账号和身份完成认证。',
    downloadHref: '/lakala-guides/alipay/alipay-certification-guide.docx',
    images: [
      '/lakala-guides/alipay/step-01.jpeg',
      ...Array.from({ length: 11 }, (_, index) => `/lakala-guides/alipay/step-${String(index + 2).padStart(2, '0')}.png`),
    ],
  },
} as const

export default async function LakalaGuidePage({ params }: { params: Promise<{ channel: string }> }) {
  const { channel } = await params
  const guide = guides[channel as keyof typeof guides]
  if (!guide) notFound()

  return (
    <main className="min-h-screen bg-[#F7F7F7] px-4 py-6 sm:px-8">
      <div className="mx-auto max-w-5xl space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-[#C0322A]">凤御美业 · 拉卡拉认证指南</p>
            <h1 className="mt-1 text-2xl font-bold">{guide.title}</h1>
            <p className="mt-1 text-sm text-[#777777]">本页面无需后台账号，可直接发送给门店法人查看。</p>
          </div>
          <Link href={guide.downloadHref} target="_blank">
            <Button variant="outline"><Download />下载原始 Word</Button>
          </Link>
        </div>

        <Card className="border-[#D9E8DF] bg-[#F6FBF8]">
          <CardContent className="flex items-start gap-3 p-4">
            <ShieldCheck className="mt-0.5 size-5 shrink-0 text-[#287342]" />
            <div>
              <p className="font-medium text-[#287342]">请使用营业执照对应法人本人账号和身份信息。</p>
              <p className="mt-1 text-sm text-[#5E7A68]">
                {guide.description}完成后回到入网申请详情，点击“确认认证”；系统核验通过后会关联未启用的收款商户。
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">图文步骤</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            {guide.images.map((src, index) => (
              <figure key={src} className="overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-white">
                <figcaption className="border-b border-[var(--border)] bg-[var(--muted)] px-4 py-2 text-sm font-medium text-[#666666]">
                  第 {index + 1} 步
                </figcaption>
                {/* 交接图包含不同纵横比，使用原始 img 保持文档截图的真实尺寸。 */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={src} alt={`${guide.title}第 ${index + 1} 步`} className="mx-auto block max-h-[860px] w-full object-contain" />
              </figure>
            ))}
          </CardContent>
        </Card>
      </div>
    </main>
  )
}
