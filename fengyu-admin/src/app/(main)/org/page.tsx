"use client"

import { useState, useMemo } from "react"
import { MOCK_ORG_NODES } from "@/lib/mock-data"
import type { OrgNode } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { formatDateTime } from "@/lib/utils"

const TYPE_ICON: Record<OrgNode["type"], string> = {
  headquarters: "\u{1F3E2}",
  market: "\u{1F4CA}",
  store: "\u{1F3EA}",
  department: "\u{1F3F7}\uFE0F",
}

const TYPE_LABEL: Record<OrgNode["type"], string> = {
  headquarters: "总部",
  market: "市场",
  store: "门店",
  department: "部门",
}

interface TreeNodeProps {
  node: OrgNode
  children: OrgNode[]
  allNodes: OrgNode[]
  depth: number
  selectedId: string | null
  expandedIds: Set<string>
  onSelect: (id: string) => void
  onToggle: (id: string) => void
}

function TreeNode({ node, children, allNodes, depth, selectedId, expandedIds, onSelect, onToggle }: TreeNodeProps) {
  const hasChildren = children.length > 0
  const isExpanded = expandedIds.has(node.id)
  const isSelected = selectedId === node.id

  return (
    <div>
      <div
        className={`flex items-center gap-1 rounded-[var(--radius)] px-2 py-1.5 text-sm cursor-pointer transition-colors ${
          isSelected ? "bg-[#FFF0EE] text-[#C0322A]" : "hover:bg-[var(--muted)]"
        }`}
        style={{ paddingLeft: `${depth * 20 + 8}px` }}
        onClick={() => onSelect(node.id)}
      >
        <button
          className="w-4 h-4 flex items-center justify-center text-xs text-[var(--muted-foreground)] shrink-0"
          onClick={(e) => {
            e.stopPropagation()
            if (hasChildren) onToggle(node.id)
          }}
        >
          {hasChildren ? (isExpanded ? "\u25BE" : "\u25B8") : ""}
        </button>
        <span className="shrink-0">{TYPE_ICON[node.type]}</span>
        <span className="truncate font-medium">{node.name}</span>
        {!node.isActive && (
          <Badge variant="secondary" className="ml-auto text-[10px] px-1.5 py-0">
            停用
          </Badge>
        )}
      </div>
      {isExpanded &&
        children
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((child) => (
            <TreeNode
              key={child.id}
              node={child}
              children={allNodes.filter((n) => n.parentId === child.id)}
              allNodes={allNodes}
              depth={depth + 1}
              selectedId={selectedId}
              expandedIds={expandedIds}
              onSelect={onSelect}
              onToggle={onToggle}
            />
          ))}
    </div>
  )
}

export default function OrgPage() {
  const [selectedId, setSelectedId] = useState<string | null>("org-hq")
  const [expandedIds, setExpandedIds] = useState<Set<string>>(
    () => new Set(MOCK_ORG_NODES.map((n) => n.id))
  )

  const rootNodes = useMemo(
    () =>
      MOCK_ORG_NODES.filter((n) => n.parentId === null).sort(
        (a, b) => a.sortOrder - b.sortOrder
      ),
    []
  )

  const selectedNode = useMemo(
    () => MOCK_ORG_NODES.find((n) => n.id === selectedId) ?? null,
    [selectedId]
  )

  const parentNode = useMemo(
    () =>
      selectedNode?.parentId
        ? MOCK_ORG_NODES.find((n) => n.id === selectedNode.parentId) ?? null
        : null,
    [selectedNode]
  )

  const handleToggle = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-[var(--foreground)]">组织架构</h1>
      </div>

      <div className="flex gap-4" style={{ minHeight: "calc(100vh - 220px)" }}>
        {/* Left: Tree */}
        <Card className="w-80 shrink-0 flex flex-col">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">组织树</CardTitle>
          </CardHeader>
          <CardContent className="flex-1 overflow-auto pb-3">
            {rootNodes.map((node) => (
              <TreeNode
                key={node.id}
                node={node}
                children={MOCK_ORG_NODES.filter((n) => n.parentId === node.id)}
                allNodes={MOCK_ORG_NODES}
                depth={0}
                selectedId={selectedId}
                expandedIds={expandedIds}
                onSelect={setSelectedId}
                onToggle={handleToggle}
              />
            ))}
          </CardContent>
          <Separator />
          <div className="p-4">
            <Button variant="outline" className="w-full" size="sm">
              新增根节点
            </Button>
          </div>
        </Card>

        {/* Right: Detail */}
        <Card className="flex-1">
          {selectedNode ? (
            <>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
                <CardTitle className="text-base">节点详情</CardTitle>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm">
                    编辑
                  </Button>
                  <Button size="sm">新增子节点</Button>
                </div>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-x-8 gap-y-4">
                  <div>
                    <div className="text-sm text-[var(--muted-foreground)]">节点名称</div>
                    <div className="mt-1 font-medium">{selectedNode.name}</div>
                  </div>
                  <div>
                    <div className="text-sm text-[var(--muted-foreground)]">节点类型</div>
                    <div className="mt-1 font-medium">
                      {TYPE_ICON[selectedNode.type]} {TYPE_LABEL[selectedNode.type]}
                    </div>
                  </div>
                  <div>
                    <div className="text-sm text-[var(--muted-foreground)]">上级节点</div>
                    <div className="mt-1 font-medium">
                      {parentNode ? parentNode.name : "（无）"}
                    </div>
                  </div>
                  <div>
                    <div className="text-sm text-[var(--muted-foreground)]">排序</div>
                    <div className="mt-1 font-medium">{selectedNode.sortOrder}</div>
                  </div>
                  <div>
                    <div className="text-sm text-[var(--muted-foreground)]">状态</div>
                    <div className="mt-1">
                      <Badge
                        variant="outline"
                        className={
                          selectedNode.isActive
                            ? "border-[#3D8A5A] text-[#3D8A5A] bg-[#F0F9F2]"
                            : "border-[#888888] text-[#888888] bg-[#F5F5F5]"
                        }
                      >
                        {selectedNode.isActive ? "启用" : "停用"}
                      </Badge>
                    </div>
                  </div>
                  <div>
                    <div className="text-sm text-[var(--muted-foreground)]">节点 ID</div>
                    <div className="mt-1 font-mono text-xs text-[var(--muted-foreground)]">
                      {selectedNode.id}
                    </div>
                  </div>
                  <div>
                    <div className="text-sm text-[var(--muted-foreground)]">创建时间</div>
                    <div className="mt-1 text-sm">{formatDateTime(selectedNode.createdAt)}</div>
                  </div>
                  <div>
                    <div className="text-sm text-[var(--muted-foreground)]">更新时间</div>
                    <div className="mt-1 text-sm">{formatDateTime(selectedNode.updatedAt)}</div>
                  </div>
                </div>

                <Separator className="my-6" />

                <div>
                  <h3 className="text-sm font-medium text-[var(--muted-foreground)] mb-3">
                    下级节点
                  </h3>
                  {MOCK_ORG_NODES.filter((n) => n.parentId === selectedNode.id).length === 0 ? (
                    <p className="text-sm text-[var(--muted-foreground)]">暂无下级节点</p>
                  ) : (
                    <div className="space-y-1">
                      {MOCK_ORG_NODES.filter((n) => n.parentId === selectedNode.id)
                        .sort((a, b) => a.sortOrder - b.sortOrder)
                        .map((child) => (
                          <div
                            key={child.id}
                            className="flex items-center gap-2 rounded-[var(--radius)] px-3 py-2 text-sm hover:bg-[var(--muted)] cursor-pointer"
                            onClick={() => setSelectedId(child.id)}
                          >
                            <span>{TYPE_ICON[child.type]}</span>
                            <span>{child.name}</span>
                            {!child.isActive && (
                              <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                                停用
                              </Badge>
                            )}
                          </div>
                        ))}
                    </div>
                  )}
                </div>
              </CardContent>
            </>
          ) : (
            <CardContent className="flex items-center justify-center h-full">
              <p className="text-[var(--muted-foreground)]">请在左侧选择一个节点</p>
            </CardContent>
          )}
        </Card>
      </div>
    </div>
  )
}
