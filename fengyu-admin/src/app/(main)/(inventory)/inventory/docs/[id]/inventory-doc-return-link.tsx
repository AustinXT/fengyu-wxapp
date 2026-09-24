'use client'

import { useCallback, type MouseEvent } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'

/** `window.close()` 失败时的降级等待（ms）。关成功的话这个标签页已经没了，定时器不会触发。 */
const CLOSE_FALLBACK_DELAY_MS = 150

/**
 * 「返回XX办理台」入口（#190）。
 *
 * 甲方要的是**字面意义**的「返回到原来的页面」：办理台的表单填了一半，单据号在新标签打开，
 * 返回时原标签必须原封不动。所以这里是两条路：
 *
 *  1) 本标签是办理台用 `<a target="_blank" rel="opener">` 开出来的 → `window.close()`，
 *     浏览器焦点回到原标签，React state 一个字不丢。
 *  2) `window.close()` 对**非 script 打开**的标签在 Chrome/Edge 被静默忽略（不抛错、不返回值），
 *     直接敲 URL / 刷新过 / 从收藏进来时也没有 opener → 必须降级成在本标签导航到办理台。
 *     降级只能恢复 URL 层（level + 选中的业务卡片 + 单据 Tab），恢复不了任何 React state ——
 *     这正是要优先走 close 的原因，也是 `href` 仍然指向办理台的原因（可复制、可中键打开）。
 *
 * 元素保持 `<a href>`：中键 / Cmd+点击 / 右键复制链接地址全部走浏览器原生行为，不拦。
 */
export function InventoryDocReturnLink({
  href,
  label,
  className,
}: {
  href: string
  label: string
  className?: string
}) {
  const router = useRouter()

  const handleClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      // 中键 / Cmd / Ctrl / Shift / Alt + 点击是「在新地方打开」，交还浏览器。
      if (event.defaultPrevented) return
      if (event.button !== 0) return
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return

      let opener: Window | null = null
      try {
        opener = window.opener as Window | null
      } catch {
        // 跨源 opener 读属性可能抛；当作没有 opener 处理。
        opener = null
      }

      let openerAlive = false
      try {
        openerAlive = !!opener && !opener.closed
      } catch {
        openerAlive = false
      }

      if (!openerAlive) {
        // 没有原标签可回，就让 <Link> 的默认行为跑（客户端软导航到办理台）。
        return
      }

      event.preventDefault()
      try {
        opener!.focus()
      } catch {
        // 聚焦失败不影响关闭，忽略。
      }
      window.close()
      // 关不掉时页面还在这儿：等一小会儿再降级导航。
      // 不能用 `window.closed` 同步判断 —— 关闭是异步的，同步读永远是 false。
      window.setTimeout(() => {
        router.push(href)
      }, CLOSE_FALLBACK_DELAY_MS)
    },
    [href, router],
  )

  return (
    <Link href={href} onClick={handleClick} className={className}>
      <ArrowLeft className="size-4" /> {label}
    </Link>
  )
}

export default InventoryDocReturnLink
