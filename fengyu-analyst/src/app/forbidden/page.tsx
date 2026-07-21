export default function ForbiddenPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--background)] px-6">
      <section className="w-full max-w-sm rounded-lg border border-[var(--border)] bg-white p-6 text-center">
        <h1 className="text-lg font-semibold text-neutral-950">无权访问</h1>
        <p className="mt-2 text-sm text-neutral-500">请联系管理员开通经营分析权限。</p>
      </section>
    </main>
  )
}

