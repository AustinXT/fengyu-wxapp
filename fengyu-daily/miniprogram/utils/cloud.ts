import { identityContext, invalidateSession, sessionChanged } from './session';
export type Workspace = "employee" | "manager" | "management";
export interface Employee {
  employeeId: string;
  name: string;
  storeId: string | null;
  storeName: string;
  positionName?: string;
  orgName?: string;
  managerStores: { store_id: string; store_name: string }[];
  managerWorkspaceStores?: { store_id: string; store_name: string }[];
  scopedStores: { store_id: string; store_name: string }[];
  availableWorkspaces: Workspace[];
  staffLevel: string | null;
  roleBindings: {
    role: string;
    roleName: string;
    scopeId?: string;
    scopeType: string;
    scopeName: string;
  }[];
}
export interface Management {
  markets: { id: string; name: string; due: number; submitted: number; missing: number; rate: number }[];
  range: { label: string; start: string; end: string; kind: string };
  summary: { due: number; submitted: number; missing: number; rate: number };
  stores: {
    store_id: string;
    store_name: string;
    org_node_id: string | null;
    due: number;
    submitted: number;
    missing: number;
    rate: number;
  }[];
  employees: {
    employee_id: string;
    name: string;
    position_name?: string | null;
    is_store_manager?: boolean;
    store_id: string;
    store_name: string;
    report_id: string | null;
    due: number;
    submitted: number;
  }[];
  nodes: { id: string; name: string; type: string; parent_id: string | null }[];
}
export interface Business {
  businessType: "service" | "sale";
  businessId: string;
  title: string;
  customer: string;
  status: string;
  items: { name: string; sourceOrderId?: string; sessions?: number }[];
  feedback: string;
  followUp: string;
  businessDate?: string;
  auto?: boolean;
  unavailable?: boolean;
}
export interface Report {
  id: string;
  report_date: string;
  status: "draft" | "submitted";
  version: number;
  action: string;
  growth: string;
  plan: string;
  employee_name: string;
  store_name: string;
  submitted_at: string | null;
  updated_at?: string;
  metric_snapshot?: MetricSnapshot | null;
  period_snapshot?: MetricSnapshot['period'];
  mentor_employee_id?: string | null;
  peer_employee_id?: string | null;
}
export interface MetricSnapshot {
  scope: 'personal' | 'store' | 'market';
  scopeId?: string;
  day: MetricActuals;
  actuals?: { day: MetricActuals; week: MetricActuals | null; month: MetricActuals | null };
  period: { id: string; name: string; start: string; end: string } | null;
  week: { id?: string; name: string; start?: string; end?: string; sales?: { done: number; target: number | null }; consumption?: { done: number; target: number | null } } | null;
  month: { start?: string; end?: string; sales?: { done: number; target: number | null }; consumption?: { done: number; target: number | null } } | null;
  scopes?: Partial<Record<'personal' | 'store' | 'market', {
    scope: 'personal' | 'store' | 'market'; scopeId: string;
    day: MetricActuals; week: MetricActuals | null; month: MetricActuals | null;
  }>>;
  savedAt?: string;
  guidance?: { mentor: { employeeId: string; name: string } | null; peer: { employeeId: string; name: string } | null };
}
export interface MetricActuals {
  sales: number;
  consumption: number;
  visits?: number;
  newCustomers?: number;
  projects?: number;
}
export interface Editor {
  date: string;
  report: Report | null;
  entries: Business[];
  readOnly: boolean;
  metrics?: MetricSnapshot | null;
}
export function today(): string {
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
}
export function functionName(): string {
  return wx.getAccountInfoSync().miniProgram.envVersion === "develop"
    ? "dailyApiDev"
    : "dailyApi";
}
export async function callApi<T>(
  action: string,
  payload: object = {},
  extra: object = {},
): Promise<T> {
  const identity = identityContext();
  const testCode = wx.getAccountInfoSync().miniProgram.envVersion === "develop"
    ? wx.getStorageSync("dailyTestBindingCode") as string
    : "";
  const requestPayload = testCode && action !== "auth.bindTestCode"
    ? { ...payload, testCode }
    : payload;
  const response = await wx.cloud.callFunction({
    name: functionName(),
    data: { action, payload: requestPayload, ...extra },
  });
  if (identity !== identityContext()) throw sessionChanged();
  const result = response.result as {
    code: number;
    message: string;
    errorType?: string;
    data: T;
  };
  if (!result || typeof result.code !== "number") {
    throw new Error("日报服务返回格式不正确，请确认已上传日报云函数代码。");
  }
  if (result.code !== 0) {
    if ([-401, -403].includes(result.code) || ["UNAUTHORIZED", "PHONE_REQUIRED", "PERMISSION_DENIED"].includes(result.errorType || "")) invalidateSession();
    const error = new Error(
      result?.message || "服务暂不可用，请稍后重试",
    ) as Error & { errorType?: string };
    error.errorType = result?.errorType;
    throw error;
  }
  // 云函数数据是 JSON；复制为当前逻辑层的普通对象，避免跨上下文代理进入 setData。
  return JSON.parse(JSON.stringify(result.data)) as T;
}
export function showError(error: unknown): void {
  const e = error as Error & { errorType?: string };
  if (e.errorType === "SESSION_CHANGED") return;
  if (e.errorType === "PHONE_REQUIRED") {
    wx.showModal({
      title: "需要绑定员工身份",
      content: "请返回首页授权手机号，再继续填写日报。",
      showCancel: false,
      success: () => wx.reLaunch({ url: "/pages/home/home" }),
    });
    return;
  }
  wx.showModal({
    title: "未能完成",
    content: e.message || "服务暂不可用，请稍后重试",
    showCancel: false,
  });
}
