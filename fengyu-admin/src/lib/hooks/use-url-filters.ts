import { useSearchParams, useRouter, usePathname, type ReadonlyURLSearchParams } from 'next/navigation'
import { useCallback, useRef, useEffect } from 'react'

/**
 * URL 驱动的列表筛选 hook
 *
 * 将筛选状态同步到 URL searchParams，支持浏览器后退/前进和 URL 分享。
 * 读取初始值来自 URL；变更时 replace URL（不产生额外历史记录）。
 *
 * ```tsx
 * const { get, set, setMany } = useUrlFilters()
 *
 * // 读取：get('status') → URL 中 ?status=xxx 的值，无则 ''
 * // 写入：set('status', '待支付') → URL 变为 ?status=待支付
 * // 清除：set('status', '') → 从 URL 删除 status 参数
 * // 批量：setMany({ status: '待支付', page: '1' })
 * ```
 */
export function useUrlFilters() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()

  // 用 ref 保存最新 searchParams 避免闭包过期；联合类型兼容 effect 写回
  // ReadonlyURLSearchParams 与 set/setMany 内立即写回的可变 URLSearchParams
  const paramsRef = useRef<URLSearchParams | ReadonlyURLSearchParams>(searchParams)
  useEffect(() => {
    paramsRef.current = searchParams
  }, [searchParams])

  /** 读取单个筛选值 */
  const get = useCallback(
    (key: string, defaultValue = '') => searchParams.get(key) ?? defaultValue,
    [searchParams]
  )

  /** 设置单个筛选值（空字符串=删除该参数） */
  const set = useCallback(
    (key: string, value: string) => {
      const params = new URLSearchParams(paramsRef.current.toString())
      if (value) {
        params.set(key, value)
      } else {
        params.delete(key)
      }
      paramsRef.current = params
      const qs = params.toString()
      router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false })
    },
    [router, pathname]
  )

  /** 批量设置筛选值 */
  const setMany = useCallback(
    (updates: Record<string, string>) => {
      const params = new URLSearchParams(paramsRef.current.toString())
      for (const [key, value] of Object.entries(updates)) {
        if (value) params.set(key, value)
        else params.delete(key)
      }
      paramsRef.current = params
      const qs = params.toString()
      router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false })
    },
    [router, pathname]
  )

  /**
   * 整体替换筛选参数（只保留 next 里的键），如「重置」。与 set/setMany 共用 paramsRef，
   * 所以**同一实例**上紧接着的筛选操作基于重置后的参数，而不是被旧参数覆盖回去。
   * ⚠️ paramsRef 是实例级的：同页其它 useUrlFilters 实例要等新 searchParams 到达才同步，
   * 这段窗口里它们写 URL 会把重置前的参数带回来——同一张筛选卡片 / 同一个页面的筛选请共用一个实例。
   */
  const replaceAll = useCallback(
    (next: Record<string, string>) => {
      const params = new URLSearchParams()
      for (const [key, value] of Object.entries(next)) {
        if (value) params.set(key, value)
      }
      paramsRef.current = params
      const qs = params.toString()
      router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false })
    },
    [router, pathname]
  )

  return { get, set, setMany, replaceAll, searchParams }
}
