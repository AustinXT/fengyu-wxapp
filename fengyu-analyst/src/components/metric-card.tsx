import type { LucideIcon } from "lucide-react"

export function MetricCard({
  icon: Icon,
  label,
  value,
}: {
  icon: LucideIcon
  label: string
  value: string
}) {
  return (
    <section className="rounded-lg border border-[var(--border)] bg-white p-4">
      <div className="flex items-center justify-between">
        <span className="text-sm text-neutral-500">{label}</span>
        <span className="flex size-9 items-center justify-center rounded-md bg-[var(--accent)] text-[var(--primary)]">
          <Icon className="size-4" />
        </span>
      </div>
      <div className="mt-4 text-2xl font-semibold text-neutral-950">{value}</div>
    </section>
  )
}

