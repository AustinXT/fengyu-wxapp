"use client"

const SKILL_OPTIONS = ["美容师", "推广", "养生师"] as const

interface SkillSelectProps {
  value: string[]
  onChange?: (skills: string[]) => void
  disabled?: boolean
}

export function SkillSelect({ value, onChange, disabled }: SkillSelectProps) {
  function toggle(skill: string) {
    if (disabled || !onChange) return
    const next = value.includes(skill)
      ? value.filter((s) => s !== skill)
      : [...value, skill]
    onChange(next)
  }

  const items = disabled ? SKILL_OPTIONS.filter((s) => value.includes(s)) : SKILL_OPTIONS

  if (disabled && items.length === 0) {
    return <span className="text-sm text-gray-400">暂无</span>
  }

  return (
    <div className="flex flex-wrap gap-2">
      {items.map((skill) => {
        const selected = value.includes(skill)
        return (
          <button
            key={skill}
            type="button"
            disabled={disabled}
            onClick={() => toggle(skill)}
            className={`px-3 py-1 rounded-full text-sm border transition-colors ${
              selected
                ? "border-brand text-brand bg-brand-light"
                : "border-gray-400 text-gray-700 hover:border-brand hover:text-brand"
            } ${disabled ? "cursor-default" : "cursor-pointer"}`}
          >
            {skill}
          </button>
        )
      })}
    </div>
  )
}
