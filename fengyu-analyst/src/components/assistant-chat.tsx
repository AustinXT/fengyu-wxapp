"use client"

import { FormEvent, useEffect, useMemo, useRef, useState } from "react"
import ReactMarkdown from "react-markdown"
import type { Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import { toast } from "sonner"
import {
  Bar,
  BarChart as RechartsBarChart,
  CartesianGrid,
  Funnel,
  FunnelChart,
  LabelList,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import {
  Bot,
  Check,
  Loader2,
  MessageSquare,
  Pencil,
  Plus,
  SendHorizonal,
  Trash2,
  UserRound,
  X,
} from "lucide-react"
import {
  DEFAULT_ASSISTANT_CHAT_TITLE,
  titleFromAssistantQuestion,
  type AssistantChartRow,
  type AssistantChatMessage,
  type AssistantChatSessionDetail,
  type AssistantChatSessionSummary,
  type AssistantChatTurnResponse,
  type AssistantVisualization,
} from "@/lib/assistant-types"
import { cn } from "@/lib/utils"

interface ChatSession extends AssistantChatSessionSummary {
  messages?: AssistantChatMessage[]
}

interface ChatSessionPageResponse {
  sessions: AssistantChatSessionSummary[]
  nextCursor: string | null
}

interface ChatSessionResponse {
  session: AssistantChatSessionDetail
}

interface ChatSessionSummaryResponse {
  session: AssistantChatSessionSummary
}

interface ApiErrorResponse {
  error?: string
  message?: string
}

const suggestions = [
  "今年科颜美复购率是多少？",
  "今年各品项复购率对比",
  "科颜美普及率是多少？",
  "今年新客漏斗表现怎么样？",
]

const markdownComponents: Components = {
  h1: ({ node: _node, ...props }) => <h1 className="mb-3 text-lg font-semibold text-neutral-950" {...props} />,
  h2: ({ node: _node, ...props }) => <h2 className="mb-3 text-base font-semibold text-neutral-950" {...props} />,
  h3: ({ node: _node, ...props }) => <h3 className="mb-2 text-sm font-semibold text-neutral-950" {...props} />,
  h4: ({ node: _node, ...props }) => <h4 className="mb-2 text-sm font-medium text-neutral-950" {...props} />,
  p: ({ node: _node, ...props }) => <p className="my-2 first:mt-0 last:mb-0" {...props} />,
  strong: ({ node: _node, ...props }) => <strong className="font-semibold text-neutral-950" {...props} />,
  em: ({ node: _node, ...props }) => <em className="text-neutral-700" {...props} />,
  ul: ({ node: _node, ...props }) => <ul className="my-2 list-disc space-y-1 pl-5 first:mt-0 last:mb-0" {...props} />,
  ol: ({ node: _node, ...props }) => <ol className="my-2 list-decimal space-y-1 pl-5 first:mt-0 last:mb-0" {...props} />,
  li: ({ node: _node, ...props }) => <li className="pl-1" {...props} />,
  blockquote: ({ node: _node, ...props }) => (
    <blockquote className="my-3 border-l-2 border-[var(--primary)] pl-3 text-neutral-600" {...props} />
  ),
  a: ({ node: _node, ...props }) => (
    <a {...props} className="font-medium text-[var(--primary)] underline-offset-2 hover:underline" target="_blank" rel="noreferrer" />
  ),
  code: ({ node: _node, className, ...props }) => (
    <code className={cn("rounded bg-white px-1 py-0.5 font-mono text-[0.85em] text-neutral-800", className)} {...props} />
  ),
  pre: ({ node: _node, ...props }) => (
    <pre
      className="my-3 overflow-x-auto rounded-md bg-neutral-900 p-3 text-xs leading-5 text-neutral-100 [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-inherit"
      {...props}
    />
  ),
  table: ({ node: _node, ...props }) => (
    <div className="my-3 overflow-x-auto rounded-md border border-[var(--border)] bg-white">
      <table className="min-w-full border-collapse text-left text-xs" {...props} />
    </div>
  ),
  thead: ({ node: _node, ...props }) => <thead className="bg-neutral-50 text-neutral-600" {...props} />,
  tbody: ({ node: _node, ...props }) => <tbody className="divide-y divide-[var(--border)]" {...props} />,
  tr: ({ node: _node, ...props }) => <tr className="border-b border-[var(--border)] last:border-0" {...props} />,
  th: ({ node: _node, align, ...props }) => (
    <th
      className={cn(
        "whitespace-nowrap px-3 py-2 font-medium text-neutral-700",
        align === "right" && "text-right",
        align === "center" && "text-center",
      )}
      {...props}
    />
  ),
  td: ({ node: _node, align, ...props }) => (
    <td
      className={cn(
        "whitespace-nowrap px-3 py-2 text-neutral-700",
        align === "right" && "text-right tabular-nums",
        align === "center" && "text-center",
      )}
      {...props}
    />
  ),
  hr: ({ node: _node, ...props }) => <hr className="my-4 border-[var(--border)]" {...props} />,
}

function nowIso(): string {
  return new Date().toISOString()
}

function sortSessions(sessions: ChatSession[]): ChatSession[] {
  return [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

let nextTemporaryMessageId = -1

function createTemporaryMessageId(): number {
  return nextTemporaryMessageId--
}

function mergeSessionSummaries(current: ChatSession[], incoming: AssistantChatSessionSummary[]): ChatSession[] {
  const sessions = new Map(current.map((session) => [session.id, session]))
  for (const summary of incoming) {
    const existing = sessions.get(summary.id)
    sessions.set(summary.id, existing ? { ...summary, messages: existing.messages } : summary)
  }
  return sortSessions(Array.from(sessions.values()))
}

async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init)
  const payload = (await response.json().catch(() => null)) as (T & ApiErrorResponse) | null
  if (!response.ok) {
    throw new Error(payload?.message || payload?.error || "请求失败")
  }
  if (!payload) throw new Error("服务端未返回数据")
  return payload
}

function AssistantMarkdown({ content }: { content: string }) {
  return (
    <div className="min-w-0 break-words [overflow-wrap:anywhere]">
      <ReactMarkdown components={markdownComponents} remarkPlugins={[remarkGfm]} skipHtml>
        {content}
      </ReactMarkdown>
    </div>
  )
}

function formatDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ""
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date)
}

function formatChartValue(value: unknown, format: AssistantVisualization["valueFormat"] = "number"): string {
  if (value === null || value === undefined || value === "") return "--"
  if (format === "rate") return `${(Number(value) * 100).toFixed(1)}%`
  if (format === "number") {
    const numeric = Number(value)
    return Number.isFinite(numeric) ? numeric.toLocaleString("zh-CN") : String(value)
  }
  return String(value)
}

function TooltipContent({
  active,
  payload,
  label,
  valueFormat,
}: {
  active?: boolean
  payload?: Array<{ payload: AssistantChartRow }>
  label?: string
  valueFormat?: AssistantVisualization["valueFormat"]
}) {
  if (!active || !payload?.length) return null
  const row = payload[0].payload
  return (
    <div className="rounded-md border border-[var(--border)] bg-white px-3 py-2 text-xs shadow-sm">
      <div className="font-medium text-neutral-950">{label ?? row.name}</div>
      {"repurchaseRate" in row ? (
        <div className="mt-1 text-neutral-600">复购率：{formatChartValue(row.repurchaseRate, valueFormat)}</div>
      ) : null}
      {"penetrationRate" in row ? (
        <div className="mt-1 text-neutral-600">普及率：{formatChartValue(row.penetrationRate, valueFormat)}</div>
      ) : null}
      {"entryCount" in row ? <div className="text-neutral-500">进入人数：{formatChartValue(row.entryCount)}</div> : null}
      {"repurchaseCount" in row ? <div className="text-neutral-500">复购人数：{formatChartValue(row.repurchaseCount)}</div> : null}
      {"cardHolderCount" in row ? <div className="text-neutral-500">持卡会员：{formatChartValue(row.cardHolderCount)}</div> : null}
      {"memberCount" in row ? <div className="text-neutral-500">总会员：{formatChartValue(row.memberCount)}</div> : null}
      {"remainingSessions" in row ? <div className="text-neutral-500">剩余次数：{formatChartValue(row.remainingSessions)}</div> : null}
      {"newCustomerCount" in row ? <div className="text-neutral-500">新客人数：{formatChartValue(row.newCustomerCount)}</div> : null}
      {"arrivedCount" in row ? <div className="text-neutral-500">到店人数：{formatChartValue(row.arrivedCount)}</div> : null}
      {"arrivalRate" in row ? <div className="text-neutral-500">到店率：{formatChartValue(row.arrivalRate, "rate")}</div> : null}
      {"memberCustomerCount" in row ? <div className="text-neutral-500">会员客户：{formatChartValue(row.memberCustomerCount)}</div> : null}
      {"memberConversionRate" in row ? <div className="text-neutral-500">会员成交率：{formatChartValue(row.memberConversionRate, "rate")}</div> : null}
    </div>
  )
}

function EmptyVisualization() {
  return (
    <div className="flex min-h-32 items-center justify-center rounded-md bg-neutral-50 text-xs text-neutral-400">
      暂无图表数据
    </div>
  )
}

function MetricsVisualization({ visualization }: { visualization: AssistantVisualization }) {
  if (!visualization.metrics?.length) return <EmptyVisualization />
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      {visualization.metrics.map((metric) => (
        <div key={metric.label} className="rounded-md border border-[var(--border)] bg-white p-3">
          <div className="text-xs text-neutral-500">{metric.label}</div>
          <div className="mt-1 text-lg font-semibold tabular-nums text-neutral-950">{metric.value}</div>
          {metric.helper ? <div className="mt-1 text-xs text-neutral-500">{metric.helper}</div> : null}
        </div>
      ))}
    </div>
  )
}

function LineVisualization({ visualization }: { visualization: AssistantVisualization }) {
  const rows = visualization.rows ?? []
  const labelKey = visualization.labelKey ?? "name"
  const valueKey = visualization.valueKey ?? "value"
  if (rows.length === 0) return <EmptyVisualization />
  return (
    <div className="h-[240px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: 12, right: 16, left: -12, bottom: 0 }}>
          <CartesianGrid stroke="#eeeeee" vertical={false} />
          <XAxis dataKey={labelKey} tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: "#737373" }} />
          <YAxis
            tickFormatter={(value) => formatChartValue(value, visualization.valueFormat)}
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 12, fill: "#737373" }}
            width={58}
          />
          <Tooltip content={<TooltipContent valueFormat={visualization.valueFormat} />} />
          <Line
            type="monotone"
            dataKey={valueKey}
            stroke="#C0322A"
            strokeWidth={2.5}
            dot={{ r: 3, fill: "#C0322A", strokeWidth: 0 }}
            activeDot={{ r: 5 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

function BarVisualization({ visualization }: { visualization: AssistantVisualization }) {
  const rows = (visualization.rows ?? []).slice(0, 12)
  const labelKey = visualization.labelKey ?? "name"
  const valueKey = visualization.valueKey ?? "value"
  if (rows.length === 0) return <EmptyVisualization />
  const height = Math.max(240, rows.length * 34)
  return (
    <div className="w-full overflow-x-auto">
      <div className="min-w-[520px]" style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <RechartsBarChart data={rows} layout="vertical" margin={{ top: 4, right: 54, left: 12, bottom: 4 }}>
            <CartesianGrid stroke="#eeeeee" horizontal={false} />
            <XAxis
              type="number"
              tickFormatter={(value) => formatChartValue(value, visualization.valueFormat)}
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 12 }}
            />
            <YAxis
              type="category"
              dataKey={labelKey}
              tickLine={false}
              axisLine={false}
              width={128}
              tick={{ fontSize: 12, fill: "#525252" }}
            />
            <Tooltip content={<TooltipContent valueFormat={visualization.valueFormat} />} />
            <Bar dataKey={valueKey} fill="#C0322A" radius={[0, 4, 4, 0]}>
              <LabelList
                dataKey={valueKey}
                position="right"
                formatter={(value) => formatChartValue(value, visualization.valueFormat)}
              />
            </Bar>
          </RechartsBarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

function FunnelVisualization({ visualization }: { visualization: AssistantVisualization }) {
  const rows = visualization.rows ?? []
  const labelKey = visualization.labelKey ?? "name"
  const valueKey = visualization.valueKey ?? "value"
  const visible = rows.filter((row) => Number(row[valueKey] ?? 0) > 0)
  if (visible.length === 0) return <EmptyVisualization />
  return (
    <div className="h-[240px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <FunnelChart margin={{ top: 12, right: 24, bottom: 12, left: 24 }}>
          <Tooltip content={<TooltipContent valueFormat={visualization.valueFormat} />} />
          <Funnel dataKey={valueKey} data={visible} fill="#C0322A" isAnimationActive={false}>
            <LabelList
              dataKey={labelKey}
              position="right"
              fill="#262626"
              formatter={(value) => String(value)}
            />
            <LabelList
              dataKey={valueKey}
              position="center"
              fill="#ffffff"
              formatter={(value) => formatChartValue(value, visualization.valueFormat)}
            />
          </Funnel>
        </FunnelChart>
      </ResponsiveContainer>
    </div>
  )
}

function TableVisualization({ visualization }: { visualization: AssistantVisualization }) {
  const columns = visualization.columns ?? []
  const rows = visualization.rows ?? []
  if (columns.length === 0 || rows.length === 0) return <EmptyVisualization />
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] text-left text-xs">
        <thead className="border-b border-[var(--border)] text-neutral-500">
          <tr>
            {columns.map((column) => (
              <th key={column.key} className={cn("py-2 font-medium", column.align === "right" && "text-right")}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--border)] text-neutral-700">
          {rows.map((row, index) => (
            <tr key={index}>
              {columns.map((column) => (
                <td key={column.key} className={cn("py-2", column.align === "right" && "text-right tabular-nums")}>
                  {formatChartValue(row[column.key], column.align === "right" ? "number" : "text")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function AssistantVisualizationPanel({ visualization }: { visualization: AssistantVisualization }) {
  return (
    <div className="mt-3 rounded-md border border-[var(--border)] bg-white p-3">
      <div className="mb-3 text-sm font-medium text-neutral-950">{visualization.title}</div>
      {visualization.kind === "metrics" ? <MetricsVisualization visualization={visualization} /> : null}
      {visualization.kind === "line" ? <LineVisualization visualization={visualization} /> : null}
      {visualization.kind === "bar" ? <BarVisualization visualization={visualization} /> : null}
      {visualization.kind === "funnel" ? <FunnelVisualization visualization={visualization} /> : null}
      {visualization.kind === "table" ? <TableVisualization visualization={visualization} /> : null}
    </div>
  )
}

export function AssistantChat() {
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [activeSessionId, setActiveSessionId] = useState<number | null>(null)
  const [input, setInput] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [isInitialLoading, setIsInitialLoading] = useState(true)
  const [loadingSessionId, setLoadingSessionId] = useState<number | null>(null)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [isCreatingSession, setIsCreatingSession] = useState(false)
  const [deletingSessionId, setDeletingSessionId] = useState<number | null>(null)
  const [editingSessionId, setEditingSessionId] = useState<number | null>(null)
  const [editingTitle, setEditingTitle] = useState("")
  const [isSavingTitle, setIsSavingTitle] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const sessionLoadRef = useRef(0)

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) ?? null,
    [activeSessionId, sessions],
  )
  const activeMessages = activeSession?.messages ?? []
  const isActiveSessionLoading = loadingSessionId === activeSession?.id

  async function loadSession(sessionId: number, silent = false) {
    const requestId = ++sessionLoadRef.current
    setLoadingSessionId(sessionId)
    try {
      const payload = await requestJson<ChatSessionResponse>(`/api/analyst/chat/sessions/${sessionId}`)
      if (requestId !== sessionLoadRef.current) return
      setSessions((current) =>
        sortSessions(
          current.map((session) => (session.id === sessionId ? payload.session : session)),
        ),
      )
    } catch (error) {
      if (!silent && requestId === sessionLoadRef.current) {
        toast.error((error as Error).message || "加载聊天记录失败")
      }
    } finally {
      if (requestId === sessionLoadRef.current) setLoadingSessionId(null)
    }
  }

  useEffect(() => {
    let mounted = true

    async function initialize() {
      try {
        const page = await requestJson<ChatSessionPageResponse>("/api/analyst/chat/sessions")
        if (!mounted) return

        setNextCursor(page.nextCursor)
        if (page.sessions.length === 0) {
          const created = await requestJson<ChatSessionSummaryResponse>("/api/analyst/chat/sessions", {
            method: "POST",
          })
          if (!mounted) return
          const session: ChatSession = { ...created.session, messages: [] }
          setSessions([session])
          setActiveSessionId(session.id)
          return
        }

        const initial = page.sessions[0]
        setSessions(sortSessions(page.sessions))
        setActiveSessionId(initial.id)
        void loadSession(initial.id)
      } catch (error) {
        if (mounted) toast.error((error as Error).message || "加载聊天记录失败")
      } finally {
        if (mounted) setIsInitialLoading(false)
      }
    }

    void initialize()
    return () => {
      mounted = false
      sessionLoadRef.current += 1
      abortRef.current?.abort()
    }
  }, [])

  async function createSession() {
    if (isCreatingSession) return
    setIsCreatingSession(true)
    try {
      const payload = await requestJson<ChatSessionSummaryResponse>("/api/analyst/chat/sessions", {
        method: "POST",
      })
      const session: ChatSession = { ...payload.session, messages: [] }
      setSessions((current) => sortSessions([session, ...current]))
      setActiveSessionId(session.id)
      setInput("")
      return session
    } catch (error) {
      toast.error((error as Error).message || "新建对话失败")
    } finally {
      setIsCreatingSession(false)
    }
  }

  function selectSession(sessionId: number) {
    const selected = sessions.find((session) => session.id === sessionId)
    if (sessionId === activeSessionId && selected?.messages) return
    setActiveSessionId(sessionId)
    setInput("")
    void loadSession(sessionId)
  }

  async function loadMoreSessions() {
    if (!nextCursor || isLoadingMore) return
    setIsLoadingMore(true)
    try {
      const payload = await requestJson<ChatSessionPageResponse>(
        `/api/analyst/chat/sessions?cursor=${encodeURIComponent(nextCursor)}`,
      )
      setSessions((current) => mergeSessionSummaries(current, payload.sessions))
      setNextCursor(payload.nextCursor)
    } catch (error) {
      toast.error((error as Error).message || "加载更多记录失败")
    } finally {
      setIsLoadingMore(false)
    }
  }

  async function deleteSession(sessionId: number) {
    if (isLoading || deletingSessionId !== null) return
    setDeletingSessionId(sessionId)
    try {
      await requestJson<{ success: true }>(`/api/analyst/chat/sessions/${sessionId}`, { method: "DELETE" })
      const next = sessions.filter((session) => session.id !== sessionId)
      setSessions(next)
      if (sessionId !== activeSessionId) return

      if (next.length > 0) {
        selectSession(next[0].id)
      } else {
        setActiveSessionId(null)
        await createSession()
      }
    } catch (error) {
      toast.error((error as Error).message || "删除对话失败")
    } finally {
      setDeletingSessionId(null)
    }
  }

  function startRename(session: ChatSession) {
    setEditingSessionId(session.id)
    setEditingTitle(session.title)
  }

  async function commitRename(sessionId: number) {
    const title = editingTitle.trim() || DEFAULT_ASSISTANT_CHAT_TITLE
    setIsSavingTitle(true)
    try {
      const payload = await requestJson<ChatSessionSummaryResponse>(`/api/analyst/chat/sessions/${sessionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      })
      setSessions((current) =>
        sortSessions(
          current.map((session) =>
            session.id === sessionId ? { ...payload.session, messages: session.messages } : session,
          ),
        ),
      )
      setEditingSessionId(null)
      setEditingTitle("")
    } catch (error) {
      toast.error((error as Error).message || "重命名失败")
    } finally {
      setIsSavingTitle(false)
    }
  }

  function cancelRename() {
    setEditingSessionId(null)
    setEditingTitle("")
  }

  async function send(content: string) {
    const question = content.trim()
    const session = activeSession
    if (!question || !session || isLoading || isActiveSessionLoading) return

    const now = nowIso()
    const userMessage: AssistantChatMessage = {
      id: createTemporaryMessageId(),
      role: "user",
      content: question,
      visualizations: [],
      createdAt: now,
    }
    const assistantMessage: AssistantChatMessage = {
      id: createTemporaryMessageId(),
      role: "assistant",
      content: "",
      visualizations: [],
      createdAt: now,
    }
    const provisionalTitle =
      session.messageCount === 0 && session.title === DEFAULT_ASSISTANT_CHAT_TITLE
        ? titleFromAssistantQuestion(question)
        : session.title

    setSessions((current) =>
      sortSessions(
        current.map((item) =>
          item.id === session.id
            ? {
                ...item,
                title: provisionalTitle,
                messageCount: item.messageCount + 2,
                updatedAt: now,
                messages: [...(item.messages ?? []), userMessage, assistantMessage],
              }
            : item,
        ),
      ),
    )
    setInput("")
    setIsLoading(true)

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const turn = await requestJson<AssistantChatTurnResponse>("/api/analyst/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: session.id, content: question }),
        signal: controller.signal,
      })
      setSessions((current) =>
        sortSessions(
          current.map((item) => {
            if (item.id !== session.id) return item
            const existingMessages = (item.messages ?? []).filter(
              (message) => message.id !== userMessage.id && message.id !== assistantMessage.id,
            )
            return {
              ...turn.session,
              messages: [...existingMessages, turn.userMessage, turn.assistantMessage],
            }
          }),
        ),
      )
    } catch (error) {
      setSessions((current) =>
        current.map((item) =>
          item.id === session.id
            ? {
                ...item,
                title: session.title,
                messageCount: session.messageCount,
                updatedAt: session.updatedAt,
                messages: (item.messages ?? []).filter(
                  (message) => message.id !== userMessage.id && message.id !== assistantMessage.id,
                ),
              }
            : item,
        ),
      )
      toast.error(
        (error as Error).name === "AbortError"
          ? "已停止等待服务端回应"
          : (error as Error).message || "发送失败",
      )
      void loadSession(session.id, true)
    } finally {
      setIsLoading(false)
      if (abortRef.current === controller) abortRef.current = null
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void send(input)
  }

  return (
    <div className="grid min-h-[calc(100vh-8rem)] gap-4 lg:grid-cols-[17rem_1fr]">
      <aside className="flex min-h-48 flex-col rounded-lg border border-[var(--border)] bg-white">
        <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-3">
          <div className="text-sm font-semibold text-neutral-950">历史聊天</div>
          <button
            type="button"
            onClick={() => void createSession()}
            disabled={isCreatingSession || isLoading}
            className="inline-flex size-8 items-center justify-center rounded-md border border-[var(--border)] text-neutral-600 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50"
            title="新建对话"
            aria-label="新建对话"
          >
            <Plus className="size-4" />
          </button>
        </div>
        <div className="flex-1 space-y-1 overflow-y-auto p-2">
          {sessions.map((session) => {
            const active = session.id === activeSession?.id
            const editing = editingSessionId === session.id
            return (
              <div
                key={session.id}
                className={cn(
                  "group rounded-md border border-transparent",
                  active ? "bg-[var(--accent)] text-[var(--accent-foreground)]" : "hover:bg-neutral-50",
                )}
              >
                {editing ? (
                  <div className="flex items-center gap-1 p-1.5">
                    <input
                      className="h-8 min-w-0 flex-1 rounded-md border border-[var(--input)] bg-white px-2 text-xs text-neutral-800 outline-none focus:border-[var(--ring)]"
                      value={editingTitle}
                      autoFocus
                      onChange={(event) => setEditingTitle(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void commitRename(session.id)
                        if (event.key === "Escape") cancelRename()
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => void commitRename(session.id)}
                      disabled={isSavingTitle}
                      className="inline-flex size-8 items-center justify-center rounded-md text-neutral-500 hover:bg-white disabled:opacity-50"
                      title="保存"
                      aria-label="保存"
                    >
                      <Check className="size-4" />
                    </button>
                    <button
                      type="button"
                      onClick={cancelRename}
                      className="inline-flex size-8 items-center justify-center rounded-md text-neutral-500 hover:bg-white"
                      title="取消"
                      aria-label="取消"
                    >
                      <X className="size-4" />
                    </button>
                  </div>
                ) : (
                  <div className="grid grid-cols-[1fr_auto] items-center gap-1 p-1.5">
                    <button
                      type="button"
                      onClick={() => selectSession(session.id)}
                      className="min-w-0 rounded-md px-2 py-1.5 text-left"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <MessageSquare className="size-3.5 shrink-0" />
                        <span className="truncate text-sm font-medium">{session.title}</span>
                      </div>
                      <div className={cn("mt-0.5 text-xs", active ? "text-red-700/70" : "text-neutral-400")}>
                        {session.messageCount} 条 · {formatDate(session.updatedAt)}
                      </div>
                    </button>
                    <div className="flex shrink-0 opacity-100 lg:opacity-0 lg:group-hover:opacity-100">
                      <button
                        type="button"
                        onClick={() => startRename(session)}
                        className="inline-flex size-7 items-center justify-center rounded-md text-neutral-500 hover:bg-white"
                        title="重命名"
                        aria-label="重命名"
                      >
                        <Pencil className="size-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => void deleteSession(session.id)}
                        disabled={isLoading || deletingSessionId !== null}
                        className="inline-flex size-7 items-center justify-center rounded-md text-neutral-500 hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
                        title="删除"
                        aria-label="删除"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
          {nextCursor ? (
            <button
              type="button"
              onClick={() => void loadMoreSessions()}
              disabled={isLoadingMore}
              className="mt-2 w-full rounded-md border border-[var(--border)] px-2 py-2 text-xs text-neutral-500 hover:bg-neutral-50 disabled:opacity-50"
            >
              {isLoadingMore ? "加载中..." : "加载更多"}
            </button>
          ) : null}
        </div>
      </aside>

      <section className="flex min-h-[calc(100vh-8rem)] flex-col rounded-lg border border-[var(--border)] bg-white">
        <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold text-neutral-950">
              {activeSession?.title ?? DEFAULT_ASSISTANT_CHAT_TITLE}
            </h1>
            <p className="mt-0.5 text-xs text-neutral-500">经营分析问答</p>
          </div>
          {isLoading ? (
            <button
              type="button"
              onClick={() => abortRef.current?.abort()}
              className="shrink-0 rounded-md border border-[var(--border)] px-3 py-1.5 text-xs text-neutral-600 hover:bg-neutral-50"
            >
              停止
            </button>
          ) : null}
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
          {isInitialLoading || isActiveSessionLoading ? (
            <div className="flex min-h-32 items-center justify-center text-sm text-neutral-400">
              <Loader2 className="mr-2 size-4 animate-spin" />
              加载聊天记录
            </div>
          ) : null}

          {!isInitialLoading && !isActiveSessionLoading && activeSession && activeMessages.length === 0 ? (
            <div className="grid gap-2 sm:grid-cols-2">
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => send(suggestion)}
                  className="min-h-11 rounded-md border border-[var(--border)] px-3 text-left text-sm text-neutral-700 hover:border-[var(--primary)] hover:bg-[var(--accent)]"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          ) : null}

          {!isInitialLoading && !isActiveSessionLoading && activeMessages.map((message) => {
            const isUser = message.role === "user"
            const Icon = isUser ? UserRound : Bot
            return (
              <div key={message.id} className={cn("flex gap-3", isUser ? "justify-end" : "justify-start")}>
                {!isUser ? (
                  <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-[var(--accent)] text-[var(--primary)]">
                    <Icon className="size-4" />
                  </span>
                ) : null}
                <div
                  className={cn(
                    "max-w-[min(860px,88%)] rounded-lg px-3 py-2 text-sm leading-6",
                    isUser ? "bg-[var(--primary)] text-white" : "bg-neutral-50 text-neutral-800",
                  )}
                >
                  {message.content ? (
                    isUser ? (
                      <div className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{message.content}</div>
                    ) : (
                      <AssistantMarkdown content={message.content} />
                    )
                  ) : (
                    <span className="inline-flex items-center gap-2 text-neutral-400">
                      <Loader2 className="size-3.5 animate-spin" />
                      生成中
                    </span>
                  )}
                  {!isUser && message.visualizations?.length ? (
                    <div className="mt-2 space-y-3">
                      {message.visualizations.map((visualization) => (
                        <AssistantVisualizationPanel key={visualization.id} visualization={visualization} />
                      ))}
                    </div>
                  ) : null}
                </div>
                {isUser ? (
                  <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-neutral-100 text-neutral-600">
                    <Icon className="size-4" />
                  </span>
                ) : null}
              </div>
            )
          })}
        </div>

        <form className="sticky bottom-0 flex gap-2 border-t border-[var(--border)] bg-white p-3" onSubmit={onSubmit}>
          <textarea
            className="min-h-11 max-h-32 flex-1 resize-none rounded-md border border-[var(--input)] bg-white px-3 py-2 text-sm leading-6 outline-none focus:border-[var(--ring)]"
            placeholder="输入分析问题"
            value={input}
            rows={1}
            disabled={isInitialLoading || isActiveSessionLoading || !activeSession}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault()
                event.currentTarget.form?.requestSubmit()
              }
            }}
          />
          <button
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md bg-[var(--primary)] text-white disabled:cursor-not-allowed disabled:opacity-50"
            type="submit"
            disabled={isLoading || isInitialLoading || isActiveSessionLoading || !activeSession || input.trim().length === 0}
            aria-label="发送"
          >
            {isLoading ? <Loader2 className="size-4 animate-spin" /> : <SendHorizonal className="size-4" />}
          </button>
        </form>
      </section>
    </div>
  )
}
