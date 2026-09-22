"use client";

import { useState, useCallback, useMemo } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { Employee, OrgNode, SkillTag } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { MultiSelect } from "@/components/ui/multi-select";
import { OrgTreeSelect } from "@/components/ui/org-tree-select";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Pagination } from "@/components/ui/pagination";
import { toHttpUrl } from "@/components/ui/image-upload";
import { formatPhone, buildOrgPath } from "@/lib/utils";
import { useUrlFilters } from "@/lib/hooks/use-url-filters";
import { PreserveListContextLink } from "@/components/return-context";
import { filterValidSkillValues } from "@/lib/list-filters";
import { ExportButton } from "@/components/ui/export-button";
import SkillTagManagementDialog from "./skill-tag-management-dialog";
import { normalizePage } from "@/lib/paging";

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
  canCreate,
  canManageSkillTags,
}: {
  employees: Employee[];
  total: number;
  orgNodes: OrgNode[];
  skillTags: SkillTag[];
  canCreate: boolean;
  /** 仅系统管理员：标签的新增/编辑/删除同一口径，见 page.tsx 与 skill-tags.ts（#211） */
  canManageSkillTags: boolean;
}) {
  const [skillTagDialogOpen, setSkillTagDialogOpen] = useState(false);
  const { get, set, setMany } = useUrlFilters();

  // 技能标签全量名字集合：清洗 URL 残留的已删除标签（字典外孤儿），防幽灵筛选。
  // 三处同源清洗：列表 page.tsx（后端查询前）+ selectedSkills（前端展示）+ handleExport（导出）。
  const validSkillNames = useMemo(
    () => new Set(skillTags.map((t) => t.name)),
    [skillTags],
  );
  const searchParams = useSearchParams();

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
  // 技能标签多选：URL 单值字符串以逗号分隔；剔除已停用标签防幽灵筛选（validSkillNames 见上）
  const selectedSkills = useMemo(() => {
    const raw = get("skill");
    const arr = raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [];
    return filterValidSkillValues(arr, validSkillNames) ?? [];
  }, [get, validSkillNames]);
  const currentPage = normalizePage(get("page", "1"));
  const pageSize = PAGE_SIZE_OPTIONS.includes(Number(get("size"))) ? Number(get("size")) : 20;

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
      key: "skills",
      header: "技能",
      cell: (row) => {
        // 防御：只渲染字典内标签名，隐藏已删除/改名残留的旧副本
        const visible = row.skills?.filter((s) => validSkillNames.has(s)) ?? []
        return (
          <div className="flex flex-wrap gap-1">
            {visible.length ? (
              visible.map((s) => (
                <Badge
                  key={s}
                  variant="outline"
                  className="border-[var(--brand)] text-[var(--brand)] bg-[var(--brand-light)]"
                >
                  {s}
                </Badge>
              ))
            ) : (
              <span className="text-[var(--muted-foreground)]">—</span>
            )}
          </div>
        )
      },
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
        <PreserveListContextLink href={`/employees/${row.employeeId}`}>
          <Button variant="link" size="sm" className="h-auto p-0">
            详情
          </Button>
        </PreserveListContextLink>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-[var(--foreground)]">员工管理</h1>
        <div className="flex items-center gap-2">
          {canManageSkillTags && (
            <Button variant="outline" onClick={() => setSkillTagDialogOpen(true)}>
              标签管理
            </Button>
          )}
          {canCreate && (
            <Link href="/employees/create">
              <Button>新增员工</Button>
            </Link>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <OrgTreeSelect
          className="w-48"
          orgNodes={orgNodes}
          value={marketFilter}
          onChange={(id) => setMany({ market: id, page: "" })}
          placeholder="全部组织"
        />
        <Select value={statusFilter} onChange={(e) => setFilter("status", e.target.value)} className="w-32">
          <option value="">全部状态</option>
          <option value="active">在职</option>
          <option value="resigned">已离职</option>
        </Select>
        <MultiSelect
          options={skillTags.map((t) => ({ value: t.name, label: t.name }))}
          value={selectedSkills}
          onChange={(arr) => setFilter("skill", arr.join(","))}
          placeholder="技能标签"
          className="w-48"
        />
        <Input
          placeholder="搜索编号 / 姓名 / 手机号"
          value={searchInput}
          onChange={(e) => handleSearchChange(e.target.value)}
          className="max-w-xs"
        />
        <ExportButton
          exportRequest={{
            exportType: "employees",
            payload: Object.fromEntries(searchParams.entries()),
          }}
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

      {canManageSkillTags && (
        <SkillTagManagementDialog
          open={skillTagDialogOpen}
          onOpenChange={setSkillTagDialogOpen}
          skillTags={skillTags}
          canManage={canManageSkillTags}
        />
      )}
    </div>
  );
}
