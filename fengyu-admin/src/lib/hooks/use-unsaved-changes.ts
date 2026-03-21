import { useEffect } from 'react'

/**
 * 表单未保存变更保护
 *
 * 当 isDirty 为 true 时，拦截浏览器关闭/刷新/前进后退，
 * 弹出 "你确定要离开？未保存的更改将会丢失" 确认框。
 *
 * 使用方式：
 * ```tsx
 * const [dirty, setDirty] = useState(false)
 * useUnsavedChanges(dirty)
 *
 * <form onInput={() => setDirty(true)}>
 *   ...
 *   <button onClick={async () => { await save(); setDirty(false) }}>保存</button>
 * </form>
 * ```
 */
export function useUnsavedChanges(isDirty: boolean) {
  useEffect(() => {
    if (!isDirty) return

    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [isDirty])
}
