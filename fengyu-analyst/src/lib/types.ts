export type RoleType = "admin" | "manager" | "finance" | "hr" | "product" | "customer_mgr" | "staff"

export interface AuthSession {
  employeeId: string
  name: string
  phone: string
  roles: Array<{
    role: RoleType
    scopeId: string
    scopeType: "总部" | "市场" | "门店"
  }>
  permissions: {
    actions: string[]
    scopeStoreIds: string[]
  }
}

