"use client";

import { useState, useCallback, useMemo } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import type { Employee, OrgNode, SkillTag } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { OrgTreeSelect } from "@/components/ui/org-tree-select";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Pagination } from "@/components/ui/pagination";
import { toHttpUrl } from "@/components/ui/image-upload";
import { formatPhone, buildOrgPath } from "@/lib/utils";
import { useUrlFilters } from "@/lib/hooks/use-url-filters";
import { ExportButton } from "@/components/ui/export-button";
import { exportEmployees } from "@/actions/employees";
import { exportToXlsx, fmtDate, maskIdCard } from "@/lib/export-xlsx";
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
  skillTags,
}: {
  employees: Employee[];
  total: number;
  orgNodes: OrgNode[];
  skillTags: SkillTag[];
}) {
  const [skillTagDialogOpen, setSkillTagDialogOpen] = useState(false);
  const { get, set, setMany } = useUrlFilters();
  const searchParams = useSearchParams();

  /** 导出当前筛选命中的全部员工（跨分页，身份证脱敏） */
  const handleExport = useCallback(async () => {
    const raw = Object.fromEntries(searchParams.entries());
    const { rows, truncated } = await exportEmployees(raw);
    if (rows.length === 0) {
      toast.info("当前筛选无数据可导出");
      return;
    }
    await exportToXlsx({
      filename: "员工",
      sheetName: "员工",
      columns: [
        { header: "员工编号", width: 16, accessor: (r) => r.employeeId },
        { header: "姓名", accessor: (r) => r.name },
        { header: "性别", width: 8, accessor: (r) => r.gender },
        { header: "手机号", width: 14, accessor: (r) => r.phone },
        { header: "身份证(后4位)", width: 14, accessor: (r) => maskIdCard(r.idCard) },
        { header: "所属组织", width: 18, accessor: (r) => r.marketName },
        { header: "所属门店", width: 18, accessor: (r) => r.storeName },
        { header: "职位", accessor: (r) => r.positionName },
        { header: "生日", width: 14, accessor: (r) => fmtDate(r.birthday) },
        { header: "技能", width: 24, accessor: (r) => r.skills },
        { header: "社保", width: 8, accessor: (r) => (r.socialInsurance ? "是" : "否") },
        { header: "在职状态", width: 10, accessor: (r) => (r.isResigned ? "已离职" : "在职") },
        { header: "离职原因", width: 24, accessor: (r) => r.resignationReason },
      ],
      rows,
    });
    if (truncated) toast.warning("数据量过大，已导出前 10000 条，请缩小筛选范围");
  }, [searchParams]);

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
    {
      key: "avatarUrl",
      header: "头像",
      cell: (row) => {
        const url = row.avatarUrl ? toHttpUrl(row.avatarUrl) : null;
        const fallback = (row.name ?? row.employeeId ?? "?").slice(0, 1);
        return url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={url}
            alt={row.name ?? ""}
            className="h-8 w-8 rounded-full object-cover border border-[var(--input)]"
          />
        ) : (
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--muted)] text-xs text-[var(--muted-foreground)] border border-[var(--input)]">
            {fallback}
          </div>
        );
      },
    },
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
        <ExportButton onExport={handleExport} />
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

      <SkillTagManagementDialog
        open={skillTagDialogOpen}
        onOpenChange={setSkillTagDialogOpen}
        skillTags={skillTags}
      />
    </div>
  );
}
