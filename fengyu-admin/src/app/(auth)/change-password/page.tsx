"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { changePassword } from "@/actions/auth"

const PASSWORD_REGEX = /^(?=.*[a-zA-Z])(?=.*\d).{8,}$/

export default function ChangePasswordPage() {
  const router = useRouter()
  const [newPassword, setNewPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [loading, setLoading] = useState(false)
  const [errors, setErrors] = useState<{ newPassword?: string; confirmPassword?: string }>({})

  function validate(): boolean {
    const newErrors: typeof errors = {}

    if (!newPassword) {
      newErrors.newPassword = "请输入新密码"
    } else if (!PASSWORD_REGEX.test(newPassword)) {
      newErrors.newPassword = "密码至少 8 位，需包含字母和数字"
    }

    if (!confirmPassword) {
      newErrors.confirmPassword = "请确认新密码"
    } else if (confirmPassword !== newPassword) {
      newErrors.confirmPassword = "两次输入的密码不一致"
    }

    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    if (!validate()) return

    setLoading(true)
    try {
      const result = await changePassword(newPassword)

      if (!result.success) {
        toast.error(result.message)
        return
      }

      toast.success("密码修改成功")
      router.push("/dashboard")
    } catch {
      toast.error("网络异常，请稍后重试")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="w-full max-w-md">
      {/* Header */}
      <div className="mb-8 text-center">
        <h1 className="text-2xl font-bold text-[var(--foreground)]">修改密码</h1>
        <p className="mt-2 text-sm text-[#999999]">
          首次登录需要修改初始密码
        </p>
      </div>

      {/* Card */}
      <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-white p-8 shadow-sm">
        <form onSubmit={handleSubmit} className="space-y-5">
          {/* New Password */}
          <div>
            <label htmlFor="new-password" className="mb-1.5 block text-sm font-medium text-[var(--foreground)]">
              新密码
            </label>
            <Input
              id="new-password"
              type="password"
              placeholder="至少 8 位，需包含字母和数字"
              value={newPassword}
              onChange={(e) => {
                setNewPassword(e.target.value)
                if (errors.newPassword) setErrors((prev) => ({ ...prev, newPassword: undefined }))
              }}
              autoComplete="new-password"
            />
            {errors.newPassword && (
              <p className="mt-1 text-xs text-[var(--destructive)]">{errors.newPassword}</p>
            )}
          </div>

          {/* Confirm Password */}
          <div>
            <label htmlFor="confirm-password" className="mb-1.5 block text-sm font-medium text-[var(--foreground)]">
              确认密码
            </label>
            <Input
              id="confirm-password"
              type="password"
              placeholder="请再次输入新密码"
              value={confirmPassword}
              onChange={(e) => {
                setConfirmPassword(e.target.value)
                if (errors.confirmPassword) setErrors((prev) => ({ ...prev, confirmPassword: undefined }))
              }}
              autoComplete="new-password"
            />
            {errors.confirmPassword && (
              <p className="mt-1 text-xs text-[var(--destructive)]">{errors.confirmPassword}</p>
            )}
          </div>

          {/* Submit */}
          <Button
            type="submit"
            className="w-full"
            loading={loading}
          >
            确认修改
          </Button>
        </form>
      </div>
    </div>
  )
}
