export default function MainLoading() {
  return (
    <div className="space-y-5" aria-label="页面加载中" role="status">
      <div className="h-8 w-48 animate-pulse rounded bg-neutral-200" />
      <div className="h-24 animate-pulse rounded-lg border border-[var(--border)] bg-white" />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => <div key={index} className="h-28 animate-pulse rounded-lg bg-neutral-100" />)}
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <div className="h-72 animate-pulse rounded-lg bg-neutral-100" />
        <div className="h-72 animate-pulse rounded-lg bg-neutral-100" />
      </div>
    </div>
  )
}
