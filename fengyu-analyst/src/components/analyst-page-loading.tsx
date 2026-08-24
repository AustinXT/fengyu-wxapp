export function AnalystPageLoading({ label }: { label?: string }) {
  const statusLabel = label ? `正在加载${label}` : "页面加载中"

  return (
    <div className="space-y-5" aria-label={statusLabel} role="status">
      {label ? (
        <div>
          <div className="text-xs font-medium text-neutral-400">正在加载</div>
          <div className="mt-1 text-2xl font-semibold text-neutral-950">{label}</div>
        </div>
      ) : (
        <div className="h-8 w-48 animate-pulse rounded bg-neutral-200" />
      )}
      <div className="h-24 animate-pulse rounded-lg border border-[var(--border)] bg-white" />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="h-28 animate-pulse rounded-lg bg-neutral-100" />
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <div className="h-72 animate-pulse rounded-lg bg-neutral-100" />
        <div className="h-72 animate-pulse rounded-lg bg-neutral-100" />
      </div>
    </div>
  )
}
