"use client"

import { useState, useRef, useEffect, useMemo, useCallback } from "react"
import { cn, buildOrgPath } from "@/lib/utils"
import type { OrgNode } from "@/lib/types"

interface OrgTreeSelectProps {
  orgNodes: OrgNode[]
  value: string
  onChange: (nodeId: string) => void
  placeholder?: string
  disabled?: boolean
  className?: string
  excludeTypes?: string[]
  /** 允许选择的节点类型；不传 = 全部可选。超出的节点置灰禁选（展开仍可用） */
  allowedTypes?: string[]
  /** 允许选择的组织节点；null/不传 = 不按节点范围限制。 */
  allowedNodeIds?: string[] | null
}

function getAncestorIds(nodeId: string, nodeMap: Map<string, OrgNode>): Set<string> {
  const ids = new Set<string>()
  const visited = new Set<string>()
  let current = nodeMap.get(nodeId)
  while (current?.parentId && !visited.has(current.id)) {
    visited.add(current.id)
    ids.add(current.parentId)
    current = nodeMap.get(current.parentId)
  }
  return ids
}

export function OrgTreeSelect({
  orgNodes,
  value,
  onChange,
  placeholder = "请选择",
  disabled = false,
  className,
  excludeTypes,
  allowedTypes,
  allowedNodeIds,
}: OrgTreeSelectProps) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const activeNodes = useMemo(() => {
    let nodes = orgNodes.filter((n) => n.isActive)
    if (excludeTypes?.length) {
      nodes = nodes.filter((n) => !excludeTypes.includes(n.type))
    }
    return nodes
  }, [orgNodes, excludeTypes])
  const nodeMap = useMemo(() => new Map(orgNodes.map((n) => [n.id, n])), [orgNodes])
  const allowedNodeIdSet = useMemo(
    () => (allowedNodeIds ? new Set(allowedNodeIds) : null),
    [allowedNodeIds],
  )

  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => {
    const roots = activeNodes.filter((n) => !n.parentId)
    const initial = new Set(roots.map((n) => n.id))
    if (value) {
      for (const id of getAncestorIds(value, nodeMap)) {
        initial.add(id)
      }
    }
    return initial
  })

  // 点击外部关闭
  useEffect(() => {
    if (!open) return
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [open])

  // Escape 关闭
  useEffect(() => {
    if (!open) return
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("keydown", handleKey)
    return () => document.removeEventListener("keydown", handleKey)
  }, [open])

  const displayText = value ? buildOrgPath(value, orgNodes) : ""

  const toggleExpand = useCallback((nodeId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(nodeId)) next.delete(nodeId)
      else next.add(nodeId)
      return next
    })
  }, [])

  const handleSelect = useCallback((nodeId: string) => {
    onChange(nodeId)
    setOpen(false)
  }, [onChange])

  const handleClear = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    onChange("")
  }, [onChange])

  function getChildren(parentId: string | null) {
    return activeNodes
      .filter((n) => n.parentId === parentId)
      .sort((a, b) => a.sortOrder - b.sortOrder)
  }

  function renderNode(node: OrgNode, depth: number) {
    const children = getChildren(node.id)
    const hasChildren = children.length > 0
    const isExpanded = expandedIds.has(node.id)
    const isSelected = node.id === value
    // 展开三角独立于禁用按钮：置灰节点仍可展开以露出下层可选节点
    const hasInvalidType = !!allowedTypes && !allowedTypes.includes(node.type)
    const isOutsideScope = allowedNodeIdSet !== null && !allowedNodeIdSet.has(node.id)
    const isNodeDisabled = hasInvalidType || isOutsideScope

    return (
      <div key={node.id}>
        <div
          className="flex w-full items-center gap-1 text-sm"
          style={{ paddingLeft: depth * 20 + 12 }}
        >
          {hasChildren ? (
            <span
              // 稳定选择器：测试靠它展开树，换图标/换字符时不会碎（GLM 谱系第 9 轮 P3）
              data-testid={`org-tree-toggle-${node.id}`}
              className="inline-flex w-4 shrink-0 cursor-pointer select-none"
              onClick={(e) => toggleExpand(node.id, e)}
            >
              {isExpanded ? "▾" : "▸"}
            </span>
          ) : (
            <span className="inline-flex w-4 shrink-0" />
          )}
          <button
            type="button"
            disabled={isNodeDisabled}
            title={
              hasInvalidType
                ? "该角色不可绑定此类型节点"
                : isOutsideScope
                  ? "该节点不在您的可操作范围内"
                  : undefined
            }
            className={cn(
              "flex flex-1 min-w-0 items-center py-1.5 pr-3 text-left transition-colors",
              isNodeDisabled
                ? "cursor-not-allowed opacity-50 text-[var(--muted-foreground)]"
                : "hover:bg-[var(--accent)]",
              isSelected && !isNodeDisabled && "bg-[#FFF0EE] text-[#C0322A] font-medium",
            )}
            onClick={() => handleSelect(node.id)}
          >
            <span className="truncate">{node.name}</span>
          </button>
        </div>
        {hasChildren && isExpanded && children.map((child) => renderNode(child, depth + 1))}
      </div>
    )
  }

  const rootNodes = getChildren(null)

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen(!open)}
        className={cn(
          "flex h-10 w-full items-center justify-between rounded-[var(--radius)] border border-[var(--input)] bg-[var(--background)] px-3 text-sm",
          "focus:outline-none focus:ring-2 focus:ring-[var(--ring)] focus:ring-offset-2",
          disabled && "cursor-not-allowed opacity-50",
          !displayText && "text-[var(--muted-foreground)]",
        )}
      >
        <span className="truncate">{displayText || placeholder}</span>
        <span className="flex items-center gap-1 shrink-0 ml-2">
          {value && !disabled && (
            <span
              className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] cursor-pointer text-xs"
              onClick={handleClear}
            >
              ✕
            </span>
          )}
          <svg width="12" height="12" viewBox="0 0 12 12" className="text-[var(--muted-foreground)]">
            <path d="M3 4.5L6 7.5L9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] shadow-md max-h-[300px] overflow-y-auto">
          {rootNodes.length === 0 ? (
            <div className="px-3 py-2 text-sm text-[var(--muted-foreground)]">暂无数据</div>
          ) : (
            rootNodes.map((node) => renderNode(node, 0))
          )}
        </div>
      )}
    </div>
  )
}
