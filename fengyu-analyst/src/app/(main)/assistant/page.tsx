import { SendHorizonal } from "lucide-react"

export default function AssistantPage() {
  return (
    <div className="flex min-h-[calc(100vh-8rem)] flex-col rounded-lg border border-[var(--border)] bg-white">
      <div className="border-b border-[var(--border)] px-4 py-3">
        <h1 className="text-lg font-semibold text-neutral-950">智能助手</h1>
      </div>
      <div className="flex flex-1 items-center justify-center px-4 text-sm text-neutral-400">
        等待提问
      </div>
      <form className="flex gap-2 border-t border-[var(--border)] p-3">
        <input
          className="min-h-11 flex-1 rounded-md border border-[var(--input)] bg-white px-3 text-sm outline-none focus:border-[var(--ring)]"
          placeholder="输入分析问题"
        />
        <button
          className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md bg-[var(--primary)] text-white"
          type="button"
          aria-label="发送"
        >
          <SendHorizonal className="size-4" />
        </button>
      </form>
    </div>
  )
}

