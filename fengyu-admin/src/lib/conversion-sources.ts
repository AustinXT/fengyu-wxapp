import { sql } from 'drizzle-orm';
import { db } from '@/db';
import { retainedRefundFeeSql } from './refund-fee-sql';
type Row = Record<string, any>;
type Query = (text: string, params: unknown[]) => Promise<Row[]>;
type Source = {
    sourceOrderId: string;
    sourceItemId?: string;
    pointOrderId: string | null;
    valueCents: number;
};
type Lot = {
    id: string;
    kind: 'inherited' | 'cash';
    originalCents: number;
    originalPoints: number;
    valueCents: number;
    points: number;
    movedCents: number;
    movedPoints: number;
};
type Snapshot = {
    version: number;
    valueCents: number;
    sources: Source[];
    lastCashPaymentId?: number;
    lots?: Lot[];
    retainedLots?: Lot[];
    exited?: boolean;
    pointSettlement?: { inheritedReversedPoints: number };
};
export function conversionSourceQuery(tx: Pick<typeof db, 'execute'>): Query {
    return async (text, params) => {
        const statement = sql.join(text.split(/(\$\d+)/).map(part => /^\$\d+$/.test(part) ? sql `${params[Number(part.slice(1)) - 1]}` : sql.raw(part)), sql.raw(''));
        return await tx.execute(statement) as unknown as Row[];
    };
}
function cents(value: unknown): number {
    const n = Math.round(Number(value) * 100);
    if (!Number.isSafeInteger(n) || n < 0)
        throw new Error('CONFLICT: 转换来源金额无效');
    return n;
}
function integer(n: any): boolean { return Number.isSafeInteger(n) && n >= 0; }
export function snapshot(sources: Source[]): Snapshot { return { version: 1, valueCents: sources.reduce((sum, s) => sum + s.valueCents, 0), sources }; }
export function parseSnapshot(value: any): Snapshot | null {
    if (value == null)
        return null;
    const v = typeof value === 'string' ? JSON.parse(value) : value;
    if (![1, 2].includes(v.version) || !integer(v.valueCents) || !Array.isArray(v.sources)
        || v.sources.some((s: Source) => typeof s.sourceOrderId !== 'string' || !s.sourceOrderId || !integer(s.valueCents))
        || v.sources.reduce((sum: number, s: Source) => sum + s.valueCents, 0) !== v.valueCents
        || (v.lastCashPaymentId != null && !integer(v.lastCashPaymentId))
        || (v.version === 2 && (!Array.isArray(v.lots) || v.lots.some(invalidLot)
            || v.lots.reduce((sum: number, l: Lot) => sum + l.valueCents, 0) !== v.valueCents
            || (v.retainedLots != null && (!Array.isArray(v.retainedLots) || v.retainedLots.some(invalidLot))))))
        throw new Error('CONFLICT: 转换来源快照损坏，请核查来源');
    return v;
}
function invalidLot(l: Lot): boolean {
    return !l || !['inherited', 'cash'].includes(l.kind) || typeof l.id !== 'string'
        || ![l.originalCents, l.originalPoints, l.valueCents, l.points, l.movedCents, l.movedPoints].every(integer)
        || l.valueCents > l.originalCents || l.points > l.originalPoints || l.movedCents > l.valueCents || l.movedPoints > l.points;
}
function localSnapshot(value: any): Snapshot {
    const v = parseSnapshot(value);
    if (!v || v.version !== 2)
        throw new Error('CONFLICT: 转换商品责任尚未交接，请核查历史凭据后退款');
    return v;
}
function sourceKey(s: Source): string { return JSON.stringify([s.sourceOrderId, s.sourceItemId || null, s.pointOrderId || null]); }
function mergeSources(sources: Source[]): Source[] {
    const map = new Map<string, Source>();
    for (const s of sources) {
        const key = sourceKey(s);
        map.set(key, { ...s, valueCents: (map.get(key)?.valueCents || 0) + s.valueCents });
    }
    return [...map.values()].filter(s => s.valueCents > 0);
}
export function takeSources(sources: Source[], amount: number): Source[] {
    const total = sources.reduce((sum, s) => sum + s.valueCents, 0);
    if (!integer(amount) || amount > total)
        throw new Error('CONFLICT: 转换冻结来源与已付来源不一致');
    let running = 0;
    const ratio = (n: number) => total ? Number((BigInt(amount) * BigInt(n) * BigInt(2) + BigInt(total)) / (BigInt(2) * BigInt(total))) : 0;
    return sources.map(s => { const before = running; running += s.valueCents; return { ...s, valueCents: ratio(running) - ratio(before) }; }).filter(s => s.valueCents > 0);
}
function subtractSources(pool: Source[], used: Source[]): Source[] {
    const amounts = new Map(pool.map(s => [sourceKey(s), s.valueCents]));
    for (const s of used) {
        const left = (amounts.get(sourceKey(s)) || 0) - s.valueCents;
        if (left < 0)
            throw new Error('CONFLICT: 转换冻结来源与已付来源不一致');
        amounts.set(sourceKey(s), left);
    }
    return pool.map(s => ({ ...s, valueCents: amounts.get(sourceKey(s)) || 0 })).filter(s => s.valueCents > 0);
}
function lot(id: string, kind: 'inherited' | 'cash', valueCents: number, points: number): Lot { return { id, kind, originalCents: valueCents, originalPoints: points, valueCents, points, movedCents: 0, movedPoints: 0 }; }
// 累计已移出金额取整，避免分次退款重复舍入。
function removeLots(lots: Lot[], amount: number, move: boolean): Lot[] {
    const parts = takeSources(lots.map(l => ({ sourceOrderId: l.id, pointOrderId: null, valueCents: l.valueCents - l.movedCents })), amount);
    return parts.map(p => {
        const l = lots.find(l => l.id === p.sourceOrderId)!, before = l.originalCents - l.valueCents + l.movedCents;
        const proportional = (n: number) => l.originalCents ? Number(BigInt(l.originalPoints) * BigInt(n) / BigInt(l.originalCents)) : 0;
        const points = proportional(before + p.valueCents) - proportional(before);
        if (move) {
            l.movedCents += p.valueCents;
            l.movedPoints += points;
        }
        else {
            l.valueCents -= p.valueCents;
            l.points -= points;
        }
        return lot(l.id, l.kind, p.valueCents, points);
    });
}
function inheritedFromValues(values: Snapshot[]): number {
    return values.flatMap(v => [...(v.lots || []), ...(v.retainedLots || [])])
        .filter(l => l.kind === 'inherited').reduce((s, l) => s + l.points - l.movedPoints, 0);
}
function expectedFromValues(values: Snapshot[]): number {
    return inheritedFromValues(values) + Math.floor(values.flatMap(v => [...(v.lots || []), ...(v.retainedLots || [])])
        .filter(l => l.kind === 'cash').reduce((s, l) => s + l.valueCents - l.movedCents, 0) / 10000);
}
export const POINT_ACCOUNT_LEDGER_SQL = `SELECT (COALESCE((SELECT SUM(amount) FROM point_transactions WHERE ref_order_id=$1 AND type IN ('消费赠送','消费冲销')),0)
 +COALESCE((SELECT SUM(transferred_points) FROM conversion_point_transfers WHERE to_order_id=$1),0)
 -COALESCE((SELECT SUM(transferred_points) FROM conversion_point_transfers WHERE from_order_id=$1),0))::bigint AS granted`;
function salePointBasisSql(): string {
    return `SELECT GREATEST(0,COALESCE(SUM(COALESCE(received,0)-COALESCE(refunded_amount,0)-${retainedRefundFeeSql('sale_orders.sale_order_id')}),0)*100
    -COALESCE((SELECT SUM(excluded_basis_cents) FROM conversion_point_transfers WHERE from_order_id=$1),0)) AS basis
    FROM sale_orders WHERE sale_order_id=$1 OR (ref_sale_order_id=$1 AND sale_order_type <> '转换单')`;
}
export async function getPointAccount(query: Query, orderId: string, orderType: string): Promise<{
    expected: number;
    granted: number;
    inheritedPoints: number;
    ownGranted: number;
    inheritedOwned: number;
}> {
    const ledger = await query(POINT_ACCOUNT_LEDGER_SQL, [orderId]);
    let expected = 0, inheritedPoints = 0, inheritedOwned = 0;
    if (orderType === '转换单') {
        const rows = await query('SELECT item_direction,conversion_value_snapshot FROM sale_items WHERE sale_order_id=$1 ORDER BY sale_item_id', [orderId]);
        const values = rows.map(r => localSnapshot(r.conversion_value_snapshot));
        const outgoing = rows.map((r, index) => ({ row: r, value: values[index] })).filter(r => r.row.item_direction === '转出');
        const transfers = (await query(`SELECT COUNT(*) AS count,COALESCE(SUM(transferred_points),0) AS points,COALESCE(SUM(COALESCE(public.try_numeric(batch_snapshot->>'ownCashPoints'),0)),0) AS own_points,COALESCE((SELECT SUM(public.try_numeric(b->>'points')) FROM conversion_point_transfers x CROSS JOIN LATERAL jsonb_array_elements(COALESCE(x.batch_snapshot->'batches','[]'::jsonb)) b WHERE x.to_order_id=$1 AND b->>'ownCash'='true'),0) AS own_batch_points FROM conversion_point_transfers WHERE to_order_id=$1`, [orderId]))[0];
        if (Number(transfers?.count || 0) !== outgoing.length || Number(transfers?.points || 0) !== Number(transfers?.own_points || 0)+outgoing.reduce((sum, r) => sum + r.value.lots!.reduce((n, l) => n + l.originalPoints, 0), 0))
            throw new Error('CONFLICT: 转换积分交接凭据不完整，请核查本单责任');
        const active = values.map((v, index) => rows[index].item_direction === '转出' ? { ...v, lots: [] } : v);
        expected = expectedFromValues(active);
        inheritedPoints = inheritedFromValues(active);
        if(Number(transfers?.own_points || 0)!==Number(transfers?.own_batch_points || 0)) throw new Error('CONFLICT: 历史补款积分批次交接凭据不完整');
        const marker=values[0]?.pointSettlement?.inheritedReversedPoints ?? 0;
        if(!integer(marker)) throw new Error('CONFLICT: 本单积分责任冲销凭据损坏');
        const reversed=marker;
        const moved=(await query("SELECT COALESCE(SUM(transferred_points-COALESCE(public.try_numeric(batch_snapshot->>'ownTransferred'),0)),0) AS points FROM conversion_point_transfers WHERE from_order_id=$1",[orderId]))[0];
        const total=Number(transfers?.points || 0)-Number(transfers?.own_points || 0), movedPoints=Number(moved?.points || 0);
        if(reversed>total-movedPoints-inheritedPoints) throw new Error('CONFLICT: 本单积分责任冲销凭据损坏');
        inheritedOwned=total-movedPoints-reversed;
    }
    else if (orderType === '销售单')
        expected = Math.floor(Number((await query(salePointBasisSql(), [orderId]))[0]?.basis || 0) / 10000);
    const granted=Number(ledger[0]?.granted || 0);
    return { expected, granted, inheritedPoints, inheritedOwned, ownGranted: granted-inheritedOwned };
}
async function writeValue(query: Query, itemId: string, value: Snapshot): Promise<void> { await query('UPDATE sale_items SET conversion_value_snapshot=$2::jsonb WHERE sale_item_id=$1', [itemId, JSON.stringify(value)]); }
// 支付/退款只读本单快照、本单回款分配，不读取原单。
export async function refreshConversionSources(query: Query, orderId: string): Promise<void> {
    if ((await query('SELECT sale_order_type FROM sale_orders WHERE sale_order_id=$1', [orderId]))[0]?.sale_order_type !== '转换单')
        return;
    const rows = await query("SELECT sale_item_id,conversion_value_snapshot FROM sale_items WHERE sale_order_id=$1 AND item_direction='转入' ORDER BY sale_item_id", [orderId]);
    for (const row of rows) {
        const v = parseSnapshot(row.conversion_value_snapshot);
        if (!v || v.version !== 2) {
            await reportConversionSourceGap(query, orderId, 'responsibility-not-handed-over', row.sale_item_id);
            continue;
        }
        const receipts = await query(`SELECT cash.id,spir.amount FROM sale_payment_item_receipts spir JOIN sale_order_payments cash ON cash.id=spir.sale_payment_id
      WHERE spir.sale_item_id=$1 AND cash.sale_order_id=$2 AND cash.status='已支付' AND cash.change_type IN ('首次支付','回款','储值卡抵扣') AND cash.id>$3 ORDER BY cash.id`, [row.sale_item_id, orderId, v.lastCashPaymentId || 0]);
        for (const r of receipts) {
            const n = cents(r.amount);
            v.sources = mergeSources([...v.sources, { sourceOrderId: orderId, pointOrderId: null, valueCents: n }]);
            v.lots!.push(lot(`cash:${r.id}:${row.sale_item_id}`, 'cash', n, 0));
            v.valueCents += n;
            v.lastCashPaymentId = Math.max(v.lastCashPaymentId || 0, Number(r.id));
        }
        if (receipts.length)
            await writeValue(query, row.sale_item_id, v);
    }
}
async function movePointBatches(query: Query, userId: string, from: string, to: string, points: number, ownPoints: number): Promise<Row[]> {
    if (!points)
        return [];
    const facts: Row[] = [];
    for (const group of [{ own: true, amount: ownPoints }, { own: false, amount: points - ownPoints }]) {
        if (!group.amount)
            continue;
        const rows = await query(`SELECT pb.* FROM point_batches pb JOIN point_transactions pt ON pt.id=pb.source_transaction_id
          WHERE pb.user_id=$1 AND pb.ref_order_id=$2 AND pb.source_type='消费赠送'
            AND ((pt.ref_order_id IS NOT DISTINCT FROM $2) OR pb.id IN (SELECT public.try_numeric(b->>'toBatchId')::bigint FROM conversion_point_transfers t CROSS JOIN LATERAL jsonb_array_elements(COALESCE(t.batch_snapshot->'batches','[]'::jsonb)) b WHERE t.to_order_id=$2 AND b->>'ownCash'='true'))=$3::boolean
          ORDER BY CASE WHEN pb.remaining_amount>0 AND pb.expire_at>NOW() THEN 0 WHEN pb.remaining_amount>0 THEN 1 ELSE 2 END,pb.expire_at,pb.id FOR UPDATE OF pb`, [userId, from, group.own]);
        let left = group.amount;
        for (const b of rows) {
            const n = Math.min(left, Number(b.original_amount));
            if (!n)
                continue;
            const remaining = Math.min(n, Number(b.remaining_amount));
            let newId = Number(b.id);
            if (n === Number(b.original_amount))
                await query('UPDATE point_batches SET ref_order_id=$2,updated_at=NOW() WHERE id=$1', [b.id, to]);
            else {
                newId = Number((await query(`INSERT INTO point_batches(user_id,source_transaction_id,source_type,ref_order_id,original_amount,remaining_amount,earned_at,expire_at,expired_at,created_at,updated_at)
        SELECT user_id,source_transaction_id,source_type,$2,$3,$4,earned_at,expire_at,expired_at,NOW(),NOW() FROM point_batches WHERE id=$1 RETURNING id`, [b.id, to, n, remaining]))[0].id);
                await query('UPDATE point_batches SET original_amount=original_amount-$2,remaining_amount=remaining_amount-$3,updated_at=NOW() WHERE id=$1', [b.id, n, remaining]);
            }
            facts.push({ fromBatchId: Number(b.id), toBatchId: newId, points: n, remaining, earnedAt: b.earned_at, expireAt: b.expire_at, expiredAt: b.expired_at });
            left -= n;
            if (!left)
                break;
        }
        if (left)
            throw new Error('CONFLICT: 原积分批次责任不完整，请核查历史凭据');
    }
    return facts;
}
// 创建转换的持锁事务内交接；退款不调用、不追溯。
export async function initializeConversionSources(query: Query, orderId: string): Promise<void> {
    const order = (await query(`SELECT client_user_id,received,COALESCE((SELECT SUM(amount) FROM sale_order_payments WHERE sale_order_id=$1 AND status='已支付' AND change_type IN ('首次支付','回款','储值卡抵扣') AND amount>0),0) AS actual_cash FROM sale_orders WHERE sale_order_id=$1`, [orderId]))[0];
    if (!order)
        throw new Error('CONFLICT: 转换单不存在');
    const rows = await query('SELECT * FROM sale_items WHERE sale_order_id=$1 ORDER BY sale_item_id', [orderId]);
    if (rows.length && rows.every(r => parseSnapshot(r.conversion_value_snapshot)?.version === 2))
        return;
    if ((await query("SELECT id FROM sale_order_payments WHERE sale_order_id=$1 AND change_type='退款' AND status='已支付' LIMIT 1", [orderId])).length)
        throw new Error('CONFLICT: 历史转换退款需离线核查交接');
    if (rows.some(r => r.conversion_value_snapshot != null))
        throw new Error('CONFLICT: 历史转换责任需离线核查交接');
    let pool: Source[] = [], poolLots: Lot[] = [];
    const outgoing = rows.filter(r => r.item_direction === '转出');
    // 原订单锁已由创建入口取得；批次按统一到期/id顺序预锁，分组只决定归属分配。
    await query(`SELECT pb.id FROM point_batches pb WHERE pb.user_id=$1 AND pb.ref_order_id IN (
      SELECT ref.sale_order_id FROM sale_items oi JOIN sale_items ref ON ref.sale_item_id=oi.ref_sale_item_id
      WHERE oi.sale_order_id=$2 AND oi.item_direction='转出') ORDER BY pb.expire_at,pb.id FOR UPDATE`,[order.client_user_id,orderId]);
    for (const out of outgoing) {
        const ref = (await query('SELECT si.*,so.sale_order_type,so.client_user_id FROM sale_items si JOIN sale_orders so USING(sale_order_id) WHERE si.sale_item_id=$1', [out.ref_sale_item_id]))[0];
        if (!ref || ref.client_user_id !== order.client_user_id)
            throw new Error('CONFLICT: 转换来源顾客不一致');
        const amount = cents(-Number(out.received));
        if ((await query("SELECT id FROM point_transactions WHERE ref_order_id=$1 AND type IN ('获取','回款赠送') AND amount>0 LIMIT 1", [ref.sale_order_id])).length)
            throw new Error('CONFLICT: 历史积分类型责任需离线核查，请先补全交接凭据');
        await refreshConversionSources(query, ref.sale_order_id);
        const before = await getPointAccount(query, ref.sale_order_id, ref.sale_order_type);
        let afterExpected = before.expected, moved: Lot[] = [], ownTransferred = 0;
        if (ref.sale_order_type === '转换单') {
            const v = localSnapshot((await query('SELECT conversion_value_snapshot FROM sale_items WHERE sale_item_id=$1', [ref.sale_item_id]))[0]?.conversion_value_snapshot);
            moved = removeLots(v.lots!, amount, true);
            v.exited = ref.product_type === '疗程卡' ? Number(ref.remaining_sessions) === 0 : Number(ref.picked_up_quantity || 0) + Number(ref.refunded_quantity || 0) + Number(ref.converted_quantity || 0) >= Number(ref.quantity);
            await writeValue(query, ref.sale_item_id, v);
            const after = await getPointAccount(query, ref.sale_order_id, ref.sale_order_type);
            afterExpected = after.expected;
            const actualOwn = Math.max(0,before.ownGranted);
            const ownDelta = (before.expected - before.inheritedPoints) - (after.expected - after.inheritedPoints);
            ownTransferred = Math.min(actualOwn, Math.max(0, ownDelta));
        }
        else if (ref.sale_order_type === '销售单')
            afterExpected = Math.floor(Math.max(0, Number((await query(salePointBasisSql(), [ref.sale_order_id]))[0]?.basis || 0) - amount) / 10000);
        const inheritedMoved = moved.filter(l => l.kind === 'inherited').reduce((n, l) => n + l.points, 0);
        const target = ref.sale_order_type === '转换单' ? inheritedMoved + ownTransferred : Math.max(0, before.expected - afterExpected);
        const transferred = Math.min(Math.max(0, before.granted), target);
        if (ref.sale_order_type !== '转换单')
            ownTransferred = transferred;
        ownTransferred = Math.min(ownTransferred, transferred);
        const batches = await movePointBatches(query, order.client_user_id, ref.sale_order_id, orderId, transferred, ownTransferred);
        await query(`INSERT INTO conversion_point_transfers(user_id,from_order_id,to_order_id,from_sale_item_id,excluded_basis_cents,transferred_points,batch_snapshot)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`, [order.client_user_id, ref.sale_order_id, orderId, ref.sale_item_id, amount, transferred, JSON.stringify({ batches, moved, ownTransferred })]);
        const sources = [{ sourceOrderId: ref.sale_order_id, sourceItemId: ref.sale_item_id, pointOrderId: null, valueCents: amount }], inherited = lot(`transfer:${out.sale_item_id}`, 'inherited', amount, transferred);
        await writeValue(query, out.sale_item_id, { version: 2, valueCents: amount, sources, lots: [inherited] });
        pool.push(...sources);
        poolLots.push({ ...inherited });
    }
    const cash = cents(order.actual_cash);
    pool = mergeSources([...pool, { sourceOrderId: orderId, pointOrderId: null, valueCents: cash }]);
    if (cash)
        poolLots.push(lot(`initial-cash:${orderId}`, 'cash', cash, 0));
    const incoming = rows.filter(r => r.item_direction === '转入'), prices = incoming.map(r => ({ sourceOrderId: r.sale_item_id, pointOrderId: null, valueCents: cents(r.sale_amount) }));
    const allocated = takeSources(prices, Math.min(prices.reduce((s, p) => s + p.valueCents, 0), pool.reduce((s, p) => s + p.valueCents, 0)));
    const last = Number((await query("SELECT COALESCE(MAX(id),0) AS id FROM sale_order_payments WHERE sale_order_id=$1 AND status='已支付' AND change_type IN ('首次支付','回款','储值卡抵扣')", [orderId]))[0]?.id || 0);
    for (const r of incoming) {
        const n = allocated.find(p => p.sourceOrderId === r.sale_item_id)?.valueCents || 0, sources = takeSources(pool, n);
        pool = subtractSources(pool, sources);
        const portions = removeLots(poolLots, n, false).map((l, index) => lot(`${l.id}:${r.sale_item_id}:${index}`, l.kind, l.valueCents, l.points));
        await writeValue(query, r.sale_item_id, { version: 2, valueCents: n, sources, lots: portions, lastCashPaymentId: last });
        await query('UPDATE sale_items SET received=$2 WHERE sale_item_id=$1',[r.sale_item_id,(n/100).toFixed(2)]);
    }
    // 负差额入储值卡：未换入商品的责任保留本单，商品退款不冲此部分。
    const retained = poolLots.filter(l => l.valueCents > 0);
    if (retained.length && outgoing[0]) {
        const v = localSnapshot((await query('SELECT conversion_value_snapshot FROM sale_items WHERE sale_item_id=$1', [outgoing[0].sale_item_id]))[0].conversion_value_snapshot);
        v.retainedLots = retained;
        await writeValue(query, outgoing[0].sale_item_id, v);
    }
}
// CAS 成功后减毛退本金，查询均限定本单/本单明细。
export async function recordConversionRefundSources(query: Query, orderId: string, paymentId: number): Promise<string[]> {
    const note = (await query('SELECT public.try_jsonb(note) AS note FROM sale_order_payments WHERE id=$1 AND sale_order_id=$2', [paymentId, orderId]))[0]?.note;
    if (note?.conversionRefund !== true)
        return [];
    if (note.conversionSourceRecordedVersion === 2)
        return [orderId];
    await getPointAccount(query, orderId, '转换单');
    for (const it of note.items || []) {
        const rows = await query(`SELECT si.conversion_value_snapshot,si.received::numeric-COALESCE((SELECT SUM(COALESCE(public.try_numeric(elem->>'handlingFee'),0)+COALESCE(public.try_numeric(elem->>'overdraftDeduction'),0))
      FROM sale_order_payments p CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(public.try_jsonb(p.note)->'items')='array' THEN public.try_jsonb(p.note)->'items' ELSE '[]'::jsonb END) elem
      WHERE p.sale_order_id=$2 AND p.id<>$3 AND p.status='已支付' AND p.change_type='退款' AND elem->>'refSaleItemId'=si.sale_item_id),0) AS principal_received
      FROM sale_items si WHERE si.sale_item_id=$1 AND si.sale_order_id=$2 AND si.item_direction='转入'`, [it.refSaleItemId, orderId, paymentId]);
        const v = localSnapshot(rows[0]?.conversion_value_snapshot);
        if (v.valueCents !== cents(rows[0].principal_received))
            throw new Error('CONFLICT: 转换责任本金与已付金额不一致，请核查');
        const n = cents(it.refundAmount), taken = takeSources(v.sources, n), responsibility = removeLots(v.lots!, n, false);
        v.sources = subtractSources(v.sources, taken);
        v.valueCents -= n;
        it.conversionSources = taken;
        it.conversionResponsibility = responsibility;
        await writeValue(query, it.refSaleItemId, v);
    }
    note.conversionSourceRecordedVersion = 2;
    await query('UPDATE sale_order_payments SET note=$2 WHERE id=$1 AND sale_order_id=$3', [paymentId, JSON.stringify(note), orderId]);
    return [orderId];
}
// 撤销未付款转换才恢复交接；逐项退款永远不调用。
export async function rollbackConversionPointTransfers(query: Query, orderId: string): Promise<void> {
    const rows = await query('SELECT * FROM conversion_point_transfers WHERE to_order_id=$1 ORDER BY from_order_id,from_sale_item_id FOR UPDATE', [orderId]);
    for (const row of rows) {
        const fact = row.batch_snapshot;
        for (const b of fact.batches || [])
            await query('UPDATE point_batches SET ref_order_id=$2,updated_at=NOW() WHERE id=$1 AND ref_order_id=$3', [b.toBatchId, row.from_order_id, orderId]);
        if (fact.moved?.length) {
            const v = localSnapshot((await query('SELECT conversion_value_snapshot FROM sale_items WHERE sale_item_id=$1', [row.from_sale_item_id]))[0]?.conversion_value_snapshot);
            for (const part of fact.moved) {
                const l = v.lots!.find(l => l.id === part.id);
                if (!l || l.movedCents < part.valueCents || l.movedPoints < part.points)
                    throw new Error('CONFLICT: 转换积分交接回滚事实不一致');
                l.movedCents -= part.valueCents;
                l.movedPoints -= part.points;
            }
            v.exited = false;
            await writeValue(query, row.from_sale_item_id, v);
        }
    }
    await query('DELETE FROM conversion_point_transfers WHERE to_order_id=$1', [orderId]);
}
export async function lockConversionPointBatches(query: Query, userId: string, orderId: string): Promise<void> {
    await query('SELECT id FROM point_batches WHERE user_id=$1 AND ref_order_id=$2 ORDER BY expire_at,id FOR UPDATE',[userId,orderId]);
}
export async function recordConversionInheritedReversal(query: Query, orderId: string, points: number): Promise<void> {
    if(!points) return;
    const row=(await query('SELECT sale_item_id,conversion_value_snapshot FROM sale_items WHERE sale_order_id=$1 ORDER BY sale_item_id LIMIT 1',[orderId]))[0];
    const value=localSnapshot(row?.conversion_value_snapshot);
    value.pointSettlement={inheritedReversedPoints:(value.pointSettlement?.inheritedReversedPoints || 0)+points};
    await writeValue(query,row.sale_item_id,value);
}
export function stripConversionSourcesFromNote(note: string | null | undefined): string | null | undefined {
    if (!note)
        return note;
    try {
        const value = JSON.parse(note);
        if (!value || !Array.isArray(value.items))
            return note;
        return JSON.stringify({ ...value, items: value.items.map((it: Row) => {
                if (!it || typeof it !== 'object')
                    return it;
                const clean = { ...it };
                delete clean.conversionSources;
                delete clean.conversionResponsibility;
                return clean;
            }) });
    }
    catch (_) {
        return note;
    }
}
export const CONVERSION_SOURCE_AUDIT_SQL = `WITH items AS (
 SELECT si.*,so.client_user_id,COALESCE((SELECT SUM(COALESCE(public.try_numeric(part->>'handlingFee'),0)+COALESCE(public.try_numeric(part->>'overdraftDeduction'),0))
   FROM sale_order_payments p CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(public.try_jsonb(p.note)->'items')='array' THEN public.try_jsonb(p.note)->'items' ELSE '[]'::jsonb END) part
   WHERE p.sale_order_id=si.sale_order_id AND p.change_type='退款' AND p.status='已支付' AND part->>'refSaleItemId'=si.sale_item_id),0) AS retained_fee
 FROM sale_items si JOIN sale_orders so USING(sale_order_id) WHERE so.sale_order_type='转换单' AND so.status<>'已关闭'
)
SELECT i.sale_order_id,i.sale_item_id,'responsibility-not-handed-over-or-invalid' AS reason FROM items i
 WHERE COALESCE(conversion_value_snapshot->>'version','')<>'2'
 OR jsonb_typeof(conversion_value_snapshot->'lots') IS DISTINCT FROM 'array'
 OR public.try_numeric(conversion_value_snapshot->>'valueCents') IS NULL
 OR public.try_numeric(conversion_value_snapshot->>'valueCents')<0
 OR COALESCE((SELECT SUM(public.try_numeric(l->>'valueCents')) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(conversion_value_snapshot->'lots')='array' THEN conversion_value_snapshot->'lots' ELSE '[]'::jsonb END) l),0) IS DISTINCT FROM public.try_numeric(conversion_value_snapshot->>'valueCents')
 OR ABS(public.try_numeric(conversion_value_snapshot->>'valueCents')/100-CASE WHEN item_direction='转出' THEN -received::numeric ELSE received::numeric-retained_fee END)>0.005
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(conversion_value_snapshot->'lots')='array' THEN conversion_value_snapshot->'lots' ELSE '[]'::jsonb END) l
   WHERE public.try_numeric(l->>'movedCents')>public.try_numeric(l->>'valueCents') OR public.try_numeric(l->>'movedPoints')>public.try_numeric(l->>'points')
   OR public.try_numeric(l->>'points')<0 OR public.try_numeric(l->>'valueCents')<0)
 OR (item_direction='转出' AND NOT EXISTS(SELECT 1 FROM conversion_point_transfers t WHERE t.to_order_id=i.sale_order_id AND t.from_sale_item_id=i.ref_sale_item_id AND t.user_id=i.client_user_id
   AND t.excluded_basis_cents=public.try_numeric(i.conversion_value_snapshot->>'valueCents')
   AND t.transferred_points=COALESCE(public.try_numeric(t.batch_snapshot->>'ownCashPoints'),0)+COALESCE((SELECT SUM(public.try_numeric(l->>'originalPoints')) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(i.conversion_value_snapshot->'lots')='array' THEN i.conversion_value_snapshot->'lots' ELSE '[]'::jsonb END) l),0))) LIMIT 100`;
async function reportConversionSourceGap(query: Query, orderId: string, reason: string, sourceItemId: string | null): Promise<void> {
    console.warn('[conversion.sourceUnresolved]', { orderId, reason, sourceItemId });
    let created = false;
    try {
        await query('SAVEPOINT sp_conversion_source_report', []);
        created = true;
        await query("INSERT INTO operation_logs(action,target_type,target_id,detail,source,created_at) VALUES('conversion.sourceUnresolved','sale_order',$1,$2::jsonb,'conversion-sources',NOW())", [orderId, JSON.stringify({ reason, sourceItemId })]);
        await query('RELEASE SAVEPOINT sp_conversion_source_report', []);
    }
    catch (_) {
        if (created) {
            try {
                await query('ROLLBACK TO SAVEPOINT sp_conversion_source_report', []);
                await query('RELEASE SAVEPOINT sp_conversion_source_report', []);
            }
            catch (_) { }
        }
    }
}
