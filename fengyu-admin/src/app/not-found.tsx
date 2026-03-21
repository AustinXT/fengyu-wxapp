import Link from "next/link"

export default function GlobalNotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#FAFAFA]">
      <div className="w-full max-w-md rounded-lg border border-[#E8E8E8] bg-white p-8 text-center shadow-sm space-y-4">
        <div className="text-5xl text-[#999999]">404</div>
        <h2 className="text-xl font-semibold text-[#1A1A1A]">页面不存在</h2>
        <p className="text-sm text-[#666666]">您访问的页面不存在或已被移除</p>
        <Link
          href="/dashboard"
          className="mt-4 inline-flex h-10 items-center justify-center rounded-md border border-[#E8E8E8] bg-white px-4 text-sm font-medium text-[#1A1A1A] hover:bg-[#FAFAFA]"
        >
          返回工作台
        </Link>
      </div>
    </div>
  )
}
