/**
 * cron-worker 主动告警通道（企微机器人 webhook）
 *
 * 设计原则（详见 notes/tickets/2026-04-25-crontask-data-integrity-monitor.md）：
 *   - 单一函数 notifyOps(message)，所有 STEP 在告警分支调用
 *   - 环境变量缺失 → 退化为 console.warn，不抛异常、不阻塞 STEP
 *   - 网络/HTTP 错误 → console.warn，同样不抛
 *     （主张：被动告警通道 operation_logs + console.error 已就位，notify 失败不能拖垮 STEP）
 *   - 默认 markdown 消息体，沿用企微 robot 的 qyapi.weixin.qq.com/cgi-bin/webhook/send 协议
 */

const WEBHOOK_URL_ENV = 'WECHAT_BOT_WEBHOOK_URL'
const REQUEST_TIMEOUT_MS = 5000

export async function notifyOps(message: string): Promise<void> {
  const url = process.env[WEBHOOK_URL_ENV]
  if (!url) {
    console.warn(
      `[cron-worker] notifyOps skipped: ${WEBHOOK_URL_ENV} not set`,
    )
    return
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        msgtype: 'markdown',
        markdown: { content: message },
      }),
      signal: controller.signal,
    })
    if (!res.ok) {
      console.warn(
        `[cron-worker] notifyOps HTTP ${res.status}: ${res.statusText}`,
      )
    }
  } catch (err) {
    console.warn(
      `[cron-worker] notifyOps failed: ${(err as Error).message}`,
    )
  } finally {
    clearTimeout(timer)
  }
}
