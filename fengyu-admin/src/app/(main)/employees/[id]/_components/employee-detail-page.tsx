"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { DataTable, type Column } from "@/components/ui/data-table"
import { Separator } from "@/components/ui/separator"
import { getRoleLabel } from "@/lib/auth"
import { formatDate } from "@/lib/utils"
import type { Employee, PermissionRole } from "@/lib/types"

export default function EmployeeDetailPage({ employee, roles }: { employee: Employee; roles: PermissionRole[] }) {
  const router = useRouter()
  const [showPwdForm, setShowPwdForm] = useState(false)

  const roleColumns: Column<PermissionRole>[] = [
    {
      key: "role",
      header: "角色",
      cell: (row) => <span className="font-medium">{getRoleLabel(row.role)}</span>,
    },
    {
      key: "scopeName",
      header: "作用域",
      cell: (row) => <span>{row.scopeName ?? "—"}</span>,
    },
    {
      key: "isVoid",
      header: "状态",
      cell: (row) => (
        <Badge
          variant="outline"
          className={
            row.isVoid
              ? "border-[#888888] text-[#888888] bg-[#F5F5F5]"
              : "border-[#3D8A5A] text-[#3D8A5A] bg-[#F0F9F2]"
          }
        >
          {row.isVoid ? "已撤销" : "生效中"}
        </Badge>
      ),
    },
    {
      key: "createdAt",
      header: "分配时间",
      cell: (row) => <span>{formatDate(row.createdAt)}</span>,
    },
  ]

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={() => router.back()}>
          &larr; 返回
        </Button>
        <h1 className="text-2xl font-bold text-[var(--foreground)]">
          员工详情 - {employee.name}
        </h1>
        <Badge
          variant="outline"
          className={
            employee.isResigned
              ? "border-[#888888] text-[#888888] bg-[#F5F5F5]"
              : "border-[#3D8A5A] text-[#3D8A5A] bg-[#F0F9F2]"
          }
        >
          {employee.isResigned ? "已离职" : "在职"}
        </Badge>
      </div>

      <Tabs defaultValue="info">
        <TabsList>
          <TabsTrigger value="info">基本信息</TabsTrigger>
          <TabsTrigger value="roles">权限角色</TabsTrigger>
          <TabsTrigger value="admin">管理后台</TabsTrigger>
        </TabsList>

        <TabsContent value="info">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base">基本信息</CardTitle>
              <Button variant="outline" size="sm">
                编辑
              </Button>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-x-8 gap-y-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">员工编号</label>
                  <Input value={employee.employeeId} disabled />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">姓名</label>
                  <Input defaultValue={employee.name ?? ""} />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">性别</label>
                  <Input defaultValue={employee.gender ?? ""} />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">手机号</label>
                  <Input defaultValue={employee.phone ?? ""} />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">身份证号</label>
                  <Input defaultValue={employee.idCard ?? ""} />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">生日</label>
                  <Input type="date" defaultValue={employee.birthday ?? ""} />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">所属门店</label>
                  <Input value={employee.storeName ?? ""} disabled />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">部门</label>
                  <Input value={employee.departmentName ?? ""} disabled />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">职位</label>
                  <Input defaultValue={employee.positionName ?? ""} />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">技能标签</label>
                  <Input defaultValue={employee.skills?.join(", ") ?? ""} />
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="roles">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base">权限角色</CardTitle>
              <Button size="sm">分配角色</Button>
            </CardHeader>
            <CardContent>
              <DataTable
                columns={roleColumns}
                data={roles}
                emptyText="暂无权限角色"
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="admin">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">管理后台账号</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between rounded-[var(--radius)] border border-[var(--border)] p-4">
                <div>
                  <div className="font-medium">登录账号</div>
                  <div className="text-sm text-[var(--muted-foreground)]">
                    手机号登录：{employee.phone ?? "未绑定"}
                  </div>
                </div>
                <Badge
                  variant="outline"
                  className={
                    employee.openid
                      ? "border-[#3D8A5A] text-[#3D8A5A] bg-[#F0F9F2]"
                      : "border-[#D4820A] text-[#D4820A] bg-[#FFF8E6]"
                  }
                >
                  {employee.openid ? "已绑定微信" : "未绑定微信"}
                </Badge>
              </div>

              <Separator />

              <div>
                <h3 className="text-sm font-medium mb-3">密码管理</h3>
                {showPwdForm ? (
                  <div className="space-y-3 max-w-sm">
                    <div className="space-y-2">
                      <label className="text-sm">新密码</label>
                      <Input type="password" placeholder="请输入新密码" />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm">确认密码</label>
                      <Input type="password" placeholder="请再次输入新密码" />
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm">确认重置</Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setShowPwdForm(false)}
                      >
                        取消
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShowPwdForm(true)}
                  >
                    重置密码
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
