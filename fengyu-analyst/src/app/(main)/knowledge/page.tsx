const rules = [
  ["品项进入", "同一顾客、同一天、同门店、同品项合并后达到门槛。"],
  ["复购", "进入后，后续非同日达标购买。"],
  ["门槛", "默认 1980 元，读取系统配置。"],
]

export default function KnowledgePage() {
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold text-neutral-950">指标知识库</h1>
        <p className="mt-1 text-sm text-neutral-500">复购率口径</p>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        {rules.map(([title, body]) => (
          <section key={title} className="rounded-lg border border-[var(--border)] bg-white p-4">
            <h2 className="text-base font-medium text-neutral-950">{title}</h2>
            <p className="mt-2 text-sm leading-6 text-neutral-600">{body}</p>
          </section>
        ))}
      </div>
    </div>
  )
}

