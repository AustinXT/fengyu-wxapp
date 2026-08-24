import { describe, expect, it, vi } from "vitest"
import { AsyncTtlCache } from "@/lib/async-ttl-cache"

describe("AsyncTtlCache", () => {
  it("合并相同 key 的在途请求", async () => {
    let resolve!: (value: string) => void
    const loader = vi.fn(() => new Promise<string>((done) => { resolve = done }))
    const cache = new AsyncTtlCache<string>({ ttlMs: 1000 })

    const first = cache.getOrLoad("same", loader)
    const second = cache.getOrLoad("same", loader)
    resolve("ok")

    await expect(Promise.all([first, second])).resolves.toEqual(["ok", "ok"])
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it("失败不写缓存且允许重试", async () => {
    const loader = vi.fn()
      .mockRejectedValueOnce(new Error("failed"))
      .mockResolvedValueOnce("recovered")
    const cache = new AsyncTtlCache<string>({ ttlMs: 1000 })

    await expect(cache.getOrLoad("key", loader)).rejects.toThrow("failed")
    await expect(cache.getOrLoad("key", loader)).resolves.toBe("recovered")
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it("TTL 到期后重新加载", async () => {
    vi.useFakeTimers()
    const loader = vi.fn().mockResolvedValueOnce("first").mockResolvedValueOnce("second")
    const cache = new AsyncTtlCache<string>({ ttlMs: 1000 })

    await expect(cache.getOrLoad("key", loader)).resolves.toBe("first")
    vi.advanceTimersByTime(1001)
    await expect(cache.getOrLoad("key", loader)).resolves.toBe("second")
    vi.useRealTimers()
  })

  it("超过容量时淘汰最旧项", async () => {
    const loader = vi.fn(async (value: string) => value)
    const cache = new AsyncTtlCache<string>({ ttlMs: 1000, maxEntries: 2 })

    await cache.getOrLoad("a", () => loader("a"))
    await cache.getOrLoad("b", () => loader("b"))
    await cache.getOrLoad("c", () => loader("c"))
    await cache.getOrLoad("a", () => loader("a2"))

    expect(loader).toHaveBeenCalledTimes(4)
  })
})
