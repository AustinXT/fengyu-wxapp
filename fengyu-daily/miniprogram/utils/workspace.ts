import { callApi, Employee, Workspace } from "./cloud";
export function currentWorkspace(user: Employee): Workspace {
  const saved = wx.getStorageSync("dailyWorkspace") as Workspace;
  const allowed = user.availableWorkspaces || ["employee"];
  const selected = allowed.includes(saved)
    ? saved
    : allowed[allowed.length - 1];
  wx.setStorageSync("dailyWorkspace", selected);
  return selected;
}
export function setWorkspace(user: Employee, workspace: Workspace) {
  if (!user.availableWorkspaces.includes(workspace))
    throw Error("无权切换到该工作台");
  wx.setStorageSync("dailyWorkspace", workspace);
}
export function syncTabs(
  page: WechatMiniprogram.Page.Instance<any, any>,
  workspace: Workspace,
  selected: number,
) {
  const bar = page.getTabBar?.();
  if (bar) bar.setData({ workspace, selected });
  else wx.nextTick(() => page.getTabBar?.()?.setData({ workspace, selected }));
}
export async function login() {
  const { user } = await callApi<{ user: Employee | null }>("auth.login");
  return {
    user,
    workspace: user ? currentWorkspace(user) : ("employee" as Workspace),
  };
}
