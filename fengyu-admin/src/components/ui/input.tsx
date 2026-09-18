import * as React from "react"
import { cn } from "@/lib/utils"

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, onWheel, ...props }, ref) => {
    // `input[type=number]` 在获得焦点时，滚轮会按 step 增减数值（Chrome/Edge/Firefox 都如此）。
    // 库存的办理台与各弹窗都是需要滚动的长表单，用户点进「数量 / 单价 / 优惠」之后滚页面，
    // 就会**静默**改掉金额或数量 —— 没有任何报错，业务侧的 positiveNumber() 校验照样放行，
    // 错值直接进库存台账。失焦即可解除滚轮绑定，页面继续正常滚动。
    // 调用方自己传的 onWheel 仍然会被执行（在 blur 之后）。
    const handleWheel = type === 'number'
      ? (event: React.WheelEvent<HTMLInputElement>) => {
        event.currentTarget.blur()
        onWheel?.(event)
      }
      : onWheel

    return (
      <input
        type={type}
        onWheel={handleWheel}
        className={cn(
          "flex h-10 w-full rounded-[var(--radius)] border border-[var(--input)] bg-transparent px-3 py-2 text-sm file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-[var(--muted-foreground)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = "Input"

export { Input }
