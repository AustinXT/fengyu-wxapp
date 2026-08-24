import type { LucideIcon } from "lucide-react"

export function MetricCard({
  icon: Icon,
  label,
  value,
  helper,
  tone = "default",
}: {
  icon: LucideIcon
  label: string
  value: string
  helper?: string
  tone?: "default" | "positive" | "negative"
}) {
  const helperClass =
    tone === "positive" ? "text-emerald-600" : tone === "negative" ? "text-red-600" : "text-neutral-500"

  return (
    <section className="rounded-lg border border-[var(--border)] bg-white p-4">
      <div className="flex items-center justify-between">
        <span className="text-sm text-neutral-500">{label}</span>
        <span className="flex size-9 items-center justify-center rounded-md bg-[var(--accent)] text-[var(--primary)]">
          <Icon className="size-4" />
        </span>
      </div>
      <div className="mt-4 text-2xl font-semibold text-neutral-950">{value}</div>
      {helper ? <div className={`mt-2 text-xs ${helperClass}`}>{helper}</div> : null}
    </section>
  )
}
