"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

export default function LoginPage() {
  const router = useRouter()
  const [phone, setPhone] = useState("")
  const [password, setPassword] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError("")

    if (!phone.trim()) {
      setError("请输入手机号")
      return
    }
    if (!password.trim()) {
      setError("请输入密码")
      return
    }
    if (!/^1\d{10}$/.test(phone)) {
      setError("请输入正确的手机号")
      return
    }

    setLoading(true)
    try {
      // TODO: Replace with real auth API call
      // Mock: any phone + password "admin123" succeeds
      await new Promise((resolve) => setTimeout(resolve, 800))

      if (password !== "admin123") {
        setError("手机号或密码错误")
        toast.error("登录失败，请检查手机号和密码")
        return
      }

      toast.success("登录成功")
      router.push("/dashboard")
    } catch {
      setError("网络异常，请稍后重试")
      toast.error("网络异常，请稍后重试")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="w-full max-w-md">
      {/* Header */}
      <div className="mb-8 text-center">
        <h1 className="text-2xl font-bold text-[var(--foreground)]">凤御美业管理后台</h1>
        <div className="mx-auto mt-3 h-0.5 w-16 bg-[var(--primary)]" />
      </div>

      {/* Login Card */}
      <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-white p-8 shadow-sm">
        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Phone */}
          <div>
            <label htmlFor="phone" className="mb-1.5 block text-sm font-medium text-[var(--foreground)]">
              手机号
            </label>
            <Input
              id="phone"
              type="tel"
              placeholder="请输入手机号"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              maxLength={11}
              autoComplete="tel"
            />
          </div>

          {/* Password */}
          <div>
            <label htmlFor="password" className="mb-1.5 block text-sm font-medium text-[var(--foreground)]">
              密码
            </label>
            <Input
              id="password"
              type="password"
              placeholder="请输入密码"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </div>

          {/* Error */}
          {error && (
            <p className="text-sm text-[var(--destructive)]">{error}</p>
          )}

          {/* Submit */}
          <Button
            type="submit"
            className="w-full"
            loading={loading}
          >
            登 录
          </Button>
        </form>
      </div>

      {/* Footer */}
      <p className="mt-6 text-center text-xs text-[#999999]">
        首次登录？请联系管理员开通权限
      </p>
    </div>
  )
}
