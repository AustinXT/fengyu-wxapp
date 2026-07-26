import type * as React from "react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

export const MEMBER_LEVEL_BADGE_CLASS: Record<string, string> = {
  黑钻: "border-[#1A1A1A] bg-[#1A1A1A] text-[#FFD700]",
  金钻: "border-[#D4820A] bg-[#FFF8E6] text-[#D4820A]",
  粉钻: "border-[#C06088] bg-[#FDF0F5] text-[#C06088]",
  星钻: "border-[#5E8BB3] bg-[#F0F5FA] text-[#5E8BB3]",
  初钻: "border-[#3D8A5A] bg-[#F0F9F2] text-[#3D8A5A]",
}

export function getMemberLevelBadgeClass(level?: string | null): string {
  if (!level) return ""
  return MEMBER_LEVEL_BADGE_CLASS[level] ?? "border-[#C0322A] bg-[#FFF0EE] text-[#C0322A]"
}

export function MemberLevelBadge({
  level,
  className,
  fallback = null,
  ...props
}: {
  level?: string | null
  fallback?: React.ReactNode
} & React.HTMLAttributes<HTMLSpanElement>) {
  if (!level) {
    return fallback == null ? null : <span className={className}>{fallback}</span>
  }

  return (
    <Badge
      variant="outline"
      className={cn(getMemberLevelBadgeClass(level), className)}
      {...props}
    >
      {level}
    </Badge>
  )
}
