import type { Employee } from './cloud';

const LOGIN_TTL = 30_000;
let revision = 0;
let cached: { key: string; at: number; user: Employee | null } | null = null;
let pending: { key: string; revision: number; promise: Promise<Employee | null> } | null = null;
const day = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
export function identityContext(): string {
  const channel = wx.getAccountInfoSync().miniProgram.envVersion;
  return `${revision}:${channel}:${channel === 'develop' ? wx.getStorageSync('dailyTestBindingCode') || '' : ''}:${day()}`;
}
export function sessionContext(): string {
  return `${identityContext()}:${wx.getStorageSync('dailyWorkspace') || ''}`;
}
export function sessionChanged(): Error {
  return Object.assign(new Error('身份或查看范围已切换'), { errorType: 'SESSION_CHANGED' });
}
export function expireLogin(): void { cached = null; }
export function invalidateSession(): void {
  revision++;
  cached = null;
  pending = null;
  // 身份切换或鉴权拒绝后，已挂载页面也不能继续展示旧身份的数据。
  if (typeof getCurrentPages !== 'function') return;
  for (const page of getCurrentPages()) {
    const tracked = page as unknown as { _loadId?: number };
    if (typeof tracked._loadId === 'number') tracked._loadId++;
    const defaults: Record<string, unknown> = {
      user: null, employee: null, report: null, overview: null, summary: null,
      personalSummary: null, metrics: null, target: null, reference: null,
      reports: [], recent: [], employees: [], employeeRows: [], entries: [],
      visibleStores: [], visibleEmployees: [], storePeople: [], storeReports: [],
      unsubmitted: [], periods: [], classes: [], rows: [], allRows: [],
      managerStores: [], organizationMarkets: [], scopes: [], scopeIndex: 0,
      peopleMarkets: [], peopleStores: [], organizationMarketId: '', organizationMarketIndex: 0,
      storeIndex: 0, periodIndex: 0, peopleStoreIndex: 0, search: '',
      contacts: [], candidates: [],
      visibleCandidates: [], ready: false, loading: false, refreshing: false,
      action: '', growth: '', plan: '', mentorId: '', peerId: '', scopeLabel: '',
    };
    const updates: Record<string, unknown> = {};
    for (const key of Object.keys(defaults)) if (key in page.data) updates[key] = defaults[key];
    page.setData(updates);
  }
}
export async function sessionUser(fetchUser: () => Promise<Employee | null>, force = false): Promise<Employee | null> {
  const key = identityContext(), currentRevision = revision;
  if (!force && cached?.key === key && Date.now() - cached.at < LOGIN_TTL) return cached.user;
  if (pending?.key === key && pending.revision === currentRevision) return pending.promise;
  const promise = fetchUser().then(user => {
    if (key !== identityContext()) throw sessionChanged();
    cached = { key, user, at: Date.now() };
    return user;
  });
  const request = { key, revision: currentRevision, promise };
  pending = request;
  try { return await promise; }
  finally { if (pending === request) pending = null; }
}
