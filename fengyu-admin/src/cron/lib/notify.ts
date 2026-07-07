

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
