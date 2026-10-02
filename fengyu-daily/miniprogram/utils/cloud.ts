export type Workspace = "employee" | "manager" | "management";
export interface Employee {
  employeeId: string;
  name: string;
  storeId: string | null;
  storeName: string;
  managerStores: { store_id: string; store_name: string }[];
  scopedStores: { store_id: string; store_name: string }[];
  availableWorkspaces: Workspace[];
  staffLevel: string | null;
  roleBindings: {
    role: string;
    roleName: string;
    scopeType: string;
    scopeName: string;
  }[];
}
export interface Management {
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
    store_id: string;
    store_name: string;
    report_id: string | null;
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
}
export interface Editor {
  date: string;
  report: Report | null;
  entries: Business[];
  readOnly: boolean;
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
  const response = await wx.cloud.callFunction({
    name: functionName(),
    data: { action, payload, ...extra },
  });
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
    const error = new Error(
      result?.message || "服务暂不可用，请稍后重试",
    ) as Error & { errorType?: string };
    error.errorType = result?.errorType;
    throw error;
  }
  return result.data;
}
export function showError(error: unknown): void {
  const e = error as Error & { errorType?: string };
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
