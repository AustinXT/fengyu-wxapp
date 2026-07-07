import { useSearchParams, useRouter, usePathname } from 'next/navigation'
import { useCallback, useRef, useEffect } from 'react'


export function useUrlFilters() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()

  
  const paramsRef = useRef(searchParams)
  useEffect(() => {
    paramsRef.current = searchParams
  }, [searchParams])

  
  const get = useCallback(
    (key: string, defaultValue = '') => searchParams.get(key) ?? defaultValue,
    [searchParams]
  )

  
  const set = useCallback(
    (key: string, value: string) => {
      const params = new URLSearchParams(paramsRef.current.toString())
      if (value) {
        params.set(key, value)
      } else {
        params.delete(key)
      }
      const qs = params.toString()
      router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false })
    },
    [router, pathname]
  )

  
  const setMany = useCallback(
    (updates: Record<string, string>) => {
      const params = new URLSearchParams(paramsRef.current.toString())
      for (const [key, value] of Object.entries(updates)) {
        if (value) params.set(key, value)
        else params.delete(key)
      }
      const qs = params.toString()
      router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false })
    },
    [router, pathname]
  )

  return { get, set, setMany, searchParams }
}
