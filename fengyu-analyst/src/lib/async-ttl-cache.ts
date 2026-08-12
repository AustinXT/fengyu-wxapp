export interface AsyncTtlCacheOptions {
  ttlMs: number
  maxEntries?: number
  onLoad?: (event: { key: string; durationMs: number; size?: number }) => void
}

interface CacheEntry<T> {
  expiresAt: number
  value: T
}

export class AsyncTtlCache<T> {
  private readonly values = new Map<string, CacheEntry<T>>()
  private readonly pending = new Map<string, Promise<T>>()
  private readonly maxEntries: number

  constructor(private readonly options: AsyncTtlCacheOptions) {
    this.maxEntries = Math.max(1, options.maxEntries ?? 128)
  }

  getOrLoad(key: string, loader: () => Promise<T>): Promise<T> {
    const now = Date.now()
    const cached = this.values.get(key)
    if (cached && cached.expiresAt > now) {
      this.values.delete(key)
      this.values.set(key, cached)
      return Promise.resolve(cached.value)
    }
    if (cached) this.values.delete(key)

    const inFlight = this.pending.get(key)
    if (inFlight) return inFlight

    const startedAt = performance.now()
    const promise = loader()
      .then((value) => {
        this.values.set(key, { expiresAt: Date.now() + this.options.ttlMs, value })
        this.trim()
        this.options.onLoad?.({
          key,
          durationMs: Math.round(performance.now() - startedAt),
          size: Array.isArray(value) ? value.length : undefined,
        })
        return value
      })
      .finally(() => {
        this.pending.delete(key)
      })

    this.pending.set(key, promise)
    return promise
  }

  clear(): void {
    this.values.clear()
    this.pending.clear()
  }

  private trim(): void {
    while (this.values.size > this.maxEntries) {
      const oldestKey = this.values.keys().next().value
      if (oldestKey === undefined) return
      this.values.delete(oldestKey)
    }
  }
}

