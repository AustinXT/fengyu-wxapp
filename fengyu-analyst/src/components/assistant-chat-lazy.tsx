"use client"

import dynamic from "next/dynamic"

const AssistantChat = dynamic(
  () => import("@/components/assistant-chat").then((module) => module.AssistantChat),
  {
    ssr: false,
    loading: () => (
      <div className="grid min-h-[calc(100vh-7rem)] gap-4 lg:grid-cols-[18rem_1fr]" role="status" aria-label="助手加载中">
        <div className="animate-pulse rounded-lg bg-neutral-100" />
        <div className="animate-pulse rounded-lg bg-neutral-100" />
      </div>
    ),
  },
)

export function AssistantChatLazy() {
  return <AssistantChat />
}
