import { vi } from 'vitest';
const api = vi.fn();
vi.mock('../../utils/cloud', () => ({ callClientApi: (...args: any[]) => api(...args) }));
vi.mock('../../utils/member-pricing', () => ({ getIsMember: () => false, priceView: (_: any, __: any, price: any) => ({ display: price, strike: null }) }));
vi.mock('../../utils/feature-flags', () => ({ ORDERS_ENTRY_ENABLED: true }));
vi.mock('@vant/weapp/toast/toast', () => ({ default: Object.assign(vi.fn(), { fail: vi.fn() }) }));
let definition: any;
(globalThis as any).Page = (options: any) => { definition = options; };
let experience: any, orders: any;
beforeAll(async () => {
  await import('../../pagesExperience/list/list'); experience = definition;
  await import('../../pagesOrder/orders/orders'); orders = definition;
});
function instance(options: any) {
  const page = { ...options, data: JSON.parse(JSON.stringify(options.data)), setData(patch: any, cb?: () => void) {
    for (const [path, value] of Object.entries(patch)) {
      const match = /^(\w+)\[(\d+)\](?:\.(\w+))?$/.exec(path);
      if (!match) page.data[path] = value;
      else if (match[3]) page.data[match[1]][+match[2]][match[3]] = value;
      else page.data[match[1]][+match[2]] = value;
    }
    cb?.();
  } };
  page.onLoad({});
  return page;
}
beforeEach(() => { api.mockReset(); (wx as any).__resetObservers(); vi.useFakeTimers(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

test('体验卡刷新丢弃旧回包，翻页使用cursor且重建窗口', async () => {
  const page = instance(experience);
  let resolveOld: any;
  api.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
  const old = page.loadList();
  api.mockResolvedValueOnce({ skuList: [{ sku_id: 'new', price: 10 }], hasMore: true, nextCursor: 'c1' });
  await page.loadList();
  resolveOld({ skuList: [{ sku_id: 'old' }] }); await old;
  expect(page.data.skuList.map((r: any) => r.sku_id)).toEqual(['new']);
  api.mockResolvedValueOnce({ skuList: [{ sku_id: 'next' }], hasMore: false });
  const observer = (wx as any).__lastObserver();
  await page.loadList(true);
  expect(api.mock.calls.at(-1)[1]).toEqual({ limit: 20, cursor: 'c1' });
  expect(page.data.skuList.map((r: any) => r.sku_id)).toEqual(['new', 'next']);
  expect(observer.disconnected).toBe(true);
  page.onUnload();
});

test('200张体验图滚动到尾部仅保留窗口图，隐藏断开', async () => {
  const page = instance(experience);
  api.mockResolvedValueOnce({ skuList: Array.from({ length: 20 }, (_, i) => ({ sku_id: String(i), cover_image: 'x' })), hasMore: true, nextCursor: 'c1' });
  await page.loadList();
  for (let batch = 1; batch < 10; batch++) {
    api.mockResolvedValueOnce({ skuList: Array.from({ length: 20 }, (_, i) => ({ sku_id: String(batch * 20 + i), cover_image: 'x' })), hasMore: batch < 9, nextCursor: batch < 9 ? `c${batch+1}` : null });
    await page.loadList(true);
  }
  expect(page.data.skuList).toHaveLength(200);
  expect(api).toHaveBeenCalledTimes(10);
  const observer = (wx as any).__lastObserver();
  expect(observer.relativeToSelector).toBe('');
  for (let i = 0; i < 200; i++) observer.callback({ dataset: { idx: String(i) }, intersectionRatio: i >= 194 ? 1 : 0 });
  vi.advanceTimersByTime(50);
  expect(page.data.skuList.filter((r: any) => r.coverVisible)).toHaveLength(6);
  page.onHide(); expect(observer.disconnected).toBe(true);
  page.onUnload();
});

test('一个200明细订单按图片槽位窗口控制，追加槽位索引连续', async () => {
  const page = instance(orders);
  api.mockResolvedValueOnce({ orders: [{ sale_order_id: 'a', items: Array.from({ length: 200 }, (_, i) => ({ sale_item_id: String(i), cover_image: 'x' })) }], hasMore: true });
  await page.loadOrders();
  const observer = (wx as any).__lastObserver();
  for (let i = 0; i < 200; i++) observer.callback({ dataset: { idx: String(i) }, intersectionRatio: i >= 194 ? 1 : 0 });
  vi.advanceTimersByTime(50);
  expect(page.data.coverRows.filter((r: any) => r.coverVisible)).toHaveLength(6);
  api.mockResolvedValueOnce({ orders: [{ sale_order_id: 'b', items: [{ sale_item_id: 'b1' }] }], hasMore: false });
  await page.loadMore();
  expect(page.data.list[1].items[0].coverIndex).toBe(200);
  expect(page.data.coverRows).toHaveLength(201);
  page.onUnload();
});

test('订单切Tab/刷新废弃旧翻页回包及其loading状态', async () => {
  const page = instance(orders);
  api.mockResolvedValueOnce({ orders: [{ sale_order_id: 'first', items: [] }], hasMore: true });
  await page.loadOrders();
  let resolve: any;
  api.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  const more = page.loadMore();
  api.mockResolvedValueOnce({ orders: [{ sale_order_id: 'new', items: [] }], hasMore: false });
  await page.loadOrders();
  resolve({ orders: [{ sale_order_id: 'stale', items: [] }], hasMore: true }); await more;
  expect(page.data.list.map((r: any) => r.sale_order_id)).toEqual(['new']);
  expect(page.data.loadingMore).toBe(false);
  expect(page._page).toBe(1);
  page.onUnload();
});

 test('刷新失败保留旧游标，后续触底沿原链追加', async () => {
  const page = instance(experience);
  api.mockResolvedValueOnce({ skuList: [{ sku_id: 'old' }], hasMore: true, nextCursor: 'c1' }); await page.loadList();
  api.mockRejectedValueOnce(new Error('offline')); await page.loadList();
  api.mockResolvedValueOnce({ skuList: [{ sku_id: 'next' }], hasMore: false }); await page.loadList(true);
  expect(api.mock.calls.at(-1)[1].cursor).toBe('c1');
  expect(page.data.skuList.map((r: any) => r.sku_id)).toEqual(['old', 'next']); page.onUnload();
});
