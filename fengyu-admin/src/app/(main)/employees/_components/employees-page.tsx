"use client";

import { useState, useCallback, useMemo } from "react";
import Link from "next/link";
import type { Employee, OrgNode, Position, SkillTag } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { OrgTreeSelect } from "@/components/ui/org-tree-select";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Pagination } from "@/components/ui/pagination";
import { formatPhone, buildOrgPath } from "@/lib/utils";
import { useUrlFilters } from "@/lib/hooks/use-url-filters";
import PositionManagementDialog from "./position-management-dialog";
import SkillTagManagementDialog from "./skill-tag-management-dialog";

const PAGE_SIZE_OPTIONS = [10, 20, 50];

/**
 * 员工列表页 — 服务端分页
 *
 * 数据已在 Server Component 中通过 getEmployeesPaginated() 完成 DB 级过滤+分页。
 */
export default function EmployeesPage({
  employees,
  total,
  orgNodes,
  positions,
  skillTags,
}: {
  employees: Employee[];
  total: number;
  orgNodes: OrgNode[];
  positions: Position[];
  skillTags: SkillTag[];
}) {
  const [positionDialogOpen, setPositionDialogOpen] = useState(false);
  const [skillTagDialogOpen, setSkillTagDialogOpen] = useState(false);
  const { get, set, setMany } = useUrlFilters();

  /** 筛选变更时重置到第 1 页 */
  const setFilter = useCallback(
    (key: string, value: string) => {
      setMany({ [key]: value, page: "" });
    },
    [setMany],
  );

  // 搜索框防抖：本地 state 即时响应，URL 延迟更新
  const [searchInput, setSearchInput] = useState(get("q"));
  const debounceRef = useState<ReturnType<typeof setTimeout> | null>(null);

  const handleSearchChange = useCallback(
    (value: string) => {
      setSearchInput(value);
      if (debounceRef[0]) clearTimeout(debounceRef[0]);
      debounceRef[0] = setTimeout(() => setFilter("q", value), 300);
    },
    [setFilter, debounceRef],
  );

  const marketFilter = get("market");
  const statusFilter = get("status");
  const currentPage = Math.max(1, Number(get("page", "1")) || 1);
  const pageSize = PAGE_SIZE_OPTIONS.includes(Number(get("size"))) ? Number(get("size")) : 20;

  /** 筛选用 org tree：仅保留 market/store 层级（不含 department） */
  const filterOrgNodes = useMemo(() => orgNodes.filter((n) => n.type !== "部门"), [orgNodes]);

  const columns: Column<Employee>[] = [
    { key: "employeeId", header: "员工编号" },
    {
      key: "name",
      header: "姓名",
      cell: (row) => <span className="font-medium">{row.name ?? "—"}</span>,
    },
    {
      key: "phone",
      header: "手机号",
      cell: (row) => <span>{row.phone ? formatPhone(row.phone) : "—"}</span>,
    },
    {
      key: "orgNodeId",
      header: "所属组织",
      cell: (row) => <span>{row.orgNodeId ? buildOrgPath(row.orgNodeId, orgNodes) : "—"}</span>,
    },
    {
      key: "storeName",
      header: "所属门店",
      cell: (row) => <span>{row.storeName ?? "—"}</span>,
    },
    {
      key: "positionName",
      header: "职位",
      cell: (row) => <span>{row.positionName ?? "—"}</span>,
    },
    {
      key: "isResigned",
      header: "在职状态",
      cell: (row) => (
        <Badge
          variant="outline"
          className={
            row.isResigned
              ? "border-[#888888] text-[#888888] bg-[#F5F5F5]"
              : "border-[#3D8A5A] text-[#3D8A5A] bg-[#F0F9F2]"
          }
        >
          {row.isResigned ? "已离职" : "在职"}
        </Badge>
      ),
    },
    {
      key: "actions",
      header: "操作",
      cell: (row) => (
        <Link href={`/employees/${row.employeeId}`}>
          <Button variant="link" size="sm" className="h-auto p-0">
            详情
          </Button>
        </Link>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-[var(--foreground)]">员工管理</h1>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setPositionDialogOpen(true)}>
            职位管理
          </Button>
          <Button variant="outline" onClick={() => setSkillTagDialogOpen(true)}>
            标签管理
          </Button>
          <Link href="/employees/create">
            <Button>新增员工</Button>
          </Link>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <OrgTreeSelect
          className="w-48"
          orgNodes={filterOrgNodes}
          value={marketFilter}
          onChange={(id) => setMany({ market: id, page: "" })}
          placeholder="全部组织"
        />
        <Select value={statusFilter} onChange={(e) => setFilter("status", e.target.value)} className="w-32">
          <option value="">全部状态</option>
          <option value="active">在职</option>
          <option value="resigned">已离职</option>
        </Select>
        <Input
          placeholder="搜索编号 / 姓名 / 手机号"
          value={searchInput}
          onChange={(e) => handleSearchChange(e.target.value)}
          className="max-w-xs"
        />
      </div>

      <DataTable columns={columns} data={employees} />

      <Pagination
        total={total}
        pageSize={pageSize}
        page={currentPage}
        onPageChange={(p) => set("page", p === 1 ? "" : String(p))}
        pageSizeOptions={PAGE_SIZE_OPTIONS}
        onPageSizeChange={(size) => setMany({ size: String(size), page: "" })}
      />

      <PositionManagementDialog
        open={positionDialogOpen}
        onOpenChange={setPositionDialogOpen}
        positions={positions}
      />
      <SkillTagManagementDialog
        open={skillTagDialogOpen}
        onOpenChange={setSkillTagDialogOpen}
        skillTags={skillTags}
      />
    </div>
  );
}
