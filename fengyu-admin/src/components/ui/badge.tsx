import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--ring)] focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-[var(--primary)] text-[var(--primary-foreground)]",
        secondary:
          "border-transparent bg-[var(--secondary)] text-[var(--secondary-foreground)]",
        destructive:
          "border-transparent bg-[var(--destructive)] text-[var(--destructive-foreground)]",
        outline:
          "text-[var(--foreground)]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props} />
  )
}


export const STATUS_BADGE_MAP: Record<string, string> = {
  
  '待支付':       'border-[#D4820A] text-[#D4820A] bg-[#FFF8E6]',
  '已支付':       'border-[#3D8A5A] text-[#3D8A5A] bg-[#F0F9F2]',
  '已完成':       'border-[#888888] text-[#888888] bg-[#F5F5F5]',
  '支付失败':     'border-[#D94040] text-[#D94040] bg-[#FFF0F0]',
  '已关闭':       'border-[#888888] text-[#888888] bg-[#F5F5F5]',
  
  '待服务':       'border-[#D4820A] text-[#D4820A] bg-[#FFF8E6]',
  '服务中':       'border-[#5E8BB3] text-[#5E8BB3] bg-[#F0F5FA]',
  '待客户确认':   'border-[#C0322A] text-[#C0322A] bg-[#FCEEED]',
  
  '待确认':       'border-[#D4820A] text-[#D4820A] bg-[#FFF8E6]',
  '已确认':       'border-[#3D8A5A] text-[#3D8A5A] bg-[#F0F9F2]',
  '已取消':       'border-[#888888] text-[#888888] bg-[#F5F5F5]',
}

export function StatusBadge({ status, className, ...props }: { status: string } & React.HTMLAttributes<HTMLSpanElement>) {
  const statusClass = STATUS_BADGE_MAP[status] ?? ''
  return (
    <Badge variant="outline" className={cn(statusClass, className)} {...props}>
      {status}
    </Badge>
  )
}

export { Badge, badgeVariants }
