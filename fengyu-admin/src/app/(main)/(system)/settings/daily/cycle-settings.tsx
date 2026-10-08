"use client";
import { useEffect, useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  getDailyConfiguration,
  saveDailyCycleModes,
} from "@/actions/daily-config";
import { actionErrorMessage } from "@/lib/action-error";
import {
  buildDailyPeriod,
  patternFromPeriod,
  defaultDailyCyclePattern,
  type DailyCyclePattern,
  type CyclePoint,
} from "@/lib/daily-period-template";
import { readCycleModes, type CycleMode } from "@/lib/daily-cycle-modes";
import { monthRange, periodMonth } from "@/lib/daily-cycle-planner";

type Configuration = Omit<
  Awaited<ReturnType<typeof getDailyConfiguration>>,
  "disabledTemplateIds"
> & { disabledTemplateIds?: string[] };
const field =
  "h-10 rounded-md border border-[var(--border)] bg-white px-3 text-sm";
const primary =
  "rounded-md bg-[var(--primary)] px-4 py-2 text-sm text-white disabled:opacity-50";
const secondary =
  "rounded-md border border-[var(--border)] bg-white px-4 py-2 text-sm disabled:opacity-50";
const card =
  "rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--card)] p-5";
const today = () =>
  new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
const id = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(15)), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
const natural = (): DailyCyclePattern => ({
  start: { monthOffset: 0, day: 1 },
  end: { monthOffset: 0, day: 31 },
  weeks: [
    [1, 7],
    [8, 14],
    [15, 21],
    [22, 31],
  ].map(([a, b], i) => ({
    id: `w${i + 1}`,
    name: `第${i + 1}周`,
    start: { monthOffset: 0, day: a },
    end: { monthOffset: 0, day: b },
  })),
});
function duration(start: string, end: string) {
  return (
    Math.round(
      (Date.parse(end + "T12:00:00Z") - Date.parse(start + "T12:00:00Z")) /
        86400000,
    ) + 1
  );
}
function Point({
  label,
  value,
  change,
}: {
  label: string;
  value: CyclePoint;
  change: (p: CyclePoint) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <select
        aria-label={`${label}月份`}
        className={field}
        value={value.monthOffset}
        onChange={(e) =>
          change({
            ...value,
            monthOffset: Number(e.target.value) as CyclePoint["monthOffset"],
          })
        }
      >
        <option value={-1}>上月</option>
        <option value={0}>当月</option>
        <option value={1}>次月</option>
      </select>
      <input
        aria-label={`${label}日号`}
        className={`${field} w-20`}
        type="number"
        min={1}
        max={31}
        value={value.day}
        onChange={(e) => change({ ...value, day: Number(e.target.value) })}
      />
      <span className="text-sm">日</span>
    </div>
  );
}
function WeeksEditor({
  pattern,
  change,
  prefix = "",
}: {
  pattern: DailyCyclePattern;
  change: (p: DailyCyclePattern) => void;
  prefix?: string;
}) {
  const update = (
    i: number,
    value: Partial<DailyCyclePattern["weeks"][number]>,
  ) =>
    change({
      ...pattern,
      weeks: pattern.weeks.map((w, n) => (n === i ? { ...w, ...value } : w)),
    });
  return (
    <div className="space-y-3">
      {pattern.weeks.map((w, i) => (
        <div
          key={w.id}
          className="flex flex-wrap items-center gap-3 rounded-md bg-gray-50 p-3"
        >
          <input
            aria-label={`${prefix}第${i + 1}周名称`}
            className={`${field} w-32`}
            value={w.name}
            onChange={(e) => update(i, { name: e.target.value })}
          />
          <Point
            label={`${prefix}第${i + 1}周开始`}
            value={w.start}
            change={(start) => update(i, { start })}
          />
          <span>至</span>
          <Point
            label={`${prefix}第${i + 1}周结束`}
            value={w.end}
            change={(end) => update(i, { end })}
          />
          <button
            type="button"
            className="text-sm text-red-700 disabled:opacity-40"
            disabled={pattern.weeks.length <= 1}
            aria-label={`${prefix}删除第${i + 1}周`}
            onClick={() =>
              change({
                ...pattern,
                weeks: pattern.weeks.filter((_, n) => n !== i),
              })
            }
          >
            删除该周
          </button>
        </div>
      ))}
      <button
        type="button"
        className={secondary}
        disabled={pattern.weeks.length >= 31}
        onClick={() =>
          change({
            ...pattern,
            weeks: [
              ...pattern.weeks,
              {
                id: id(),
                name: `第${pattern.weeks.length + 1}周`,
                start: { monthOffset: 0, day: 1 },
                end: { monthOffset: 0, day: 7 },
              },
            ],
          })
        }
      >
        ＋ 添加一周
      </button>
      <p className="text-xs text-gray-500">
        各周须连续覆盖经营月，至少一周、最多31周；最后一周目标自动取月目标余额。
      </p>
    </div>
  );
}
export default function DailyCycleSettings({
  configuration,
  onConfigurationChange,
  onBusyChange,
  onDirtyChange,
}: {
  configuration: Configuration;
  onConfigurationChange: (
    c: Awaited<ReturnType<typeof getDailyConfiguration>>,
  ) => void;
  onBusyChange?: (v: boolean) => void;
  onDirtyChange?: (v: boolean) => void;
}) {
  const loaded = () =>
    configuration.cycleModes?.length
      ? configuration.cycleModes
      : readCycleModes(
          configuration.templates,
          configuration.disabledTemplateIds || [],
          configuration.regions.map((r) => r.id),
        );
  const [modes, setModes] = useState<CycleMode[]>(loaded);
  const [active, setActive] = useState(modes[0].id);
  const [baseline, setBaseline] = useState<CycleMode[]>(loaded);
  const dirty = JSON.stringify(modes) !== JSON.stringify(baseline);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const [from, setFrom] = useState(today().slice(0, 7));
  const [to, setTo] = useState(() => monthRange(today().slice(0, 7), 3)[2]);
  const [newMonth, setNewMonth] = useState(today().slice(0, 7));
  const [plan, setPlan] = useState<Awaited<ReturnType<typeof saveDailyCycleModes>>["automatic"] | null>(null);
  const [impactPreview, setImpactPreview] = useState<Awaited<ReturnType<typeof saveDailyCycleModes>>["automatic"] | null>(null);
  const [savedRevision, setSavedRevision] = useState(
    configuration.modesRevision,
  );
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty) {
      const list = loaded();
      setModes(list);
      setBaseline(list);
      setSavedRevision(configuration.modesRevision);
      setActive((a) => (list.some((m) => m.id === a) ? a : list[0].id));
    }
  }, [configuration]); // eslint-disable-line react-hooks/exhaustive-deps
  const mode = modes.find((m) => m.id === active) || modes[0];
  const run = async (work: () => Promise<void>, fallback: string) => {
    if (busy) return;
    setBusy(true);
    onBusyChange?.(true);
    setMessage("");
    try {
      await work();
    } catch (error) {
      setMessage(actionErrorMessage(error, fallback));
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  };
  const update = (value: Partial<CycleMode>) => {
    setModes((list) =>
      list.map((m) => (m.id === mode.id ? { ...m, ...value } : m)),
    );
    setPlan(null);
  };
  const replace = (list: CycleMode[]) => {
    setModes(list);
    setPlan(null);
  };
  const range = {from, to, modeId: active};
  const preview = () => run(async () => {
    setPlan(null);
    const result = await saveDailyCycleModes(modes, savedRevision, "", true, range);
    setPlan(result.automatic);
  }, "日期预览失败，请检查规则与月份范围");
  const save = (confirmation = "") => {
    if (!plan) return preview();
    if (plan.calendar?.issues.length) return;
    if (!confirmation && plan.impact.some(row => row.requiresConfirmation)) {
      setImpactPreview(plan);
      return;
    }
    return run(async () => {
      const result = await saveDailyCycleModes(modes, savedRevision, confirmation || plan.token, false, range);
      setImpactPreview(null);
      const config = await getDailyConfiguration();
      onConfigurationChange(config);
      setSavedRevision(config.modesRevision);
      const saved = config.cycleModes.length ? config.cycleModes : readCycleModes(config.templates, config.disabledTemplateIds, config.regions.map(r => r.id));
      setModes(saved); setBaseline(saved); setPlan(null);
      setMessage(`已保存规则并应用所选月份：新增${result.automatic.created}个市场月份，修正${result.automatic.impact.filter(r => r.before).length}个市场月份。`);
    }, "应用日期失败，请重新预览");
  };
  const switchMode = (next: string) => {
    if (dirty && !window.confirm("有尚未保存的修改，放弃后切换模式？")) return;
    if (dirty) {
      setModes(loaded());
    }
    setActive(next);
    setPlan(null);
  };
  const add = () => {
    const name = `新周期模式${modes.length}`;
    const entry: CycleMode = {
      id: id(),
      name,
      isDefault: false,
      regionIds: [],
      pattern: natural(),
      monthly: {},
      effectiveFrom: today(),
    };
    replace([...modes, entry]);
    setActive(entry.id);
  };
  const remove = () => {
    if (mode.isDefault) return;
    if (
      !window.confirm(
        "删除该模式后，原适用市场后续沿用总部默认；已有月份保留。删除仍需保存，确认？",
      )
    )
      return;
    const list = modes.filter((m) => m.id !== mode.id);
    replace(list);
    setActive(list[0].id);
  };
  const reset = () => {
    if (
      !window.confirm(
        "恢复默认将重置模式及按月规则，市场后续沿用总部跨月规则；已有月份保留。确认后还需保存。",
      )
    )
      return;
    const base = modes.find((m) => m.isDefault)!;
    replace([
      {
        ...base,
        name: "总部标准周期",
        pattern: structuredClone(defaultDailyCyclePattern),
        monthly: {},
        effectiveFrom: today(),
        regionIds: [],
      },
    ]);
    setActive(base.id);
  };
  const assign = (regionId: string, checked: boolean) => {
    if (mode.isDefault) return;
    replace(
      modes.map((m) => ({
        ...m,
        regionIds:
          m.id === mode.id
            ? checked
              ? [...m.regionIds, regionId]
              : m.regionIds.filter((r) => r !== regionId)
            : m.regionIds.filter((r) => !checked || r !== regionId),
      })),
    );
  };
  const monthlyChange = (key: string, pattern: DailyCyclePattern) =>
    update({ monthly: { ...mode.monthly, [key]: pattern } });
  useEffect(() => { setPlan(null); setImpactPreview(null); }, [modes, from, to, active, savedRevision]);
  const relevantRegions = configuration.regions.filter(r => mode.isDefault
    ? !modes.some(m => !m.isDefault && m.regionIds.includes(r.id)) : mode.regionIds.includes(r.id));
  const arranged = (key: string) => relevantRegions.map(region => configuration.periods.find(p => p.regionId === region.id && periodMonth(p) === key) || configuration.periods.find(p => !p.regionId && periodMonth(p) === key)).filter(p => !!p);
  const monthLocked = (key: string) => arranged(key).some(p => p.end < today());
  const exceptionPreview = (key:string, pattern:DailyCyclePattern) => {try {const p=buildDailyPeriod(key,pattern,"preview");return `${p.start} 至 ${p.end}`} catch {return "日期未完整衔接，请调整经营月及各周日期"}};
  const editMonth = (key: string) => {
    if (monthLocked(key)) {setMessage(`${key}已结束，保持只读`); return;}
    setNewMonth(key);
    if (key < from) setFrom(key);
    if (key > to) setTo(key);
    const existing = arranged(key);
    const patterns = existing.map(p => patternFromPeriod({...p,version:p.version},key));
    const same = patterns.every(p => JSON.stringify(p) === JSON.stringify(patterns[0]));
    if (!mode.monthly?.[key]) monthlyChange(key, same && patterns[0] ? patterns[0] : structuredClone(mode.pattern));
    if (!same) setMessage(`${key}各市场原日期不同，已在预览中分别列出；请明确设置本模式共同使用的日期。`);
    const section = document.getElementById("daily-month-settings") as HTMLDetailsElement | null;
    if (section) {section.open = true; section.scrollIntoView?.({block:"nearest"});}
  };
  let displayMonths: string[] = [];
  try { displayMonths = monthRange(from, 36).filter(m => m <= to); } catch { /* 无效范围由预览动作就近提示。 */ }
  if (plan?.calendar) displayMonths = [...new Set([...displayMonths,...plan.calendar.rows.map(r => r.month)])].sort();
  const groupedIssues = new Map<string, {month:string;message:string;markets:string[]}>();
  for (const issue of plan?.calendar?.issues || []) {
    const region = configuration.regions.find(r => issue.message.startsWith(r.name + " "));
    const text = region ? issue.message.slice(region.name.length + 1) : issue.message;
    const key = `${issue.month}:${text}`;
    const group = groupedIssues.get(key) || {month:issue.month,message:text,markets:[]};
    if (region && !group.markets.includes(region.name)) group.markets.push(region.name);
    groupedIssues.set(key,group);
  }
  const sourceLabel = (source: string) => ({"global-template":"总部默认规则", "region-template":"市场普通规则", "month-override":"按月配置", manual:"人工安排", legacy:"历史遗留安排"}[source] || "来源未记录");
  const cross = mode.pattern.end.day < mode.pattern.start.day;
  const changeMonthDays = (startDay: number, endDay: number) => {
    const shift = endDay < startDay ? -1 : 0,
      delta = shift - mode.pattern.start.monthOffset;
    update({
      pattern: {
        start: { monthOffset: shift, day: startDay },
        end: { monthOffset: 0, day: endDay },
        weeks: mode.pattern.weeks.map((w) => ({
          ...w,
          start: {
            ...w.start,
            monthOffset: Math.max(
              -1,
              Math.min(1, w.start.monthOffset + delta),
            ) as CyclePoint["monthOffset"],
          },
          end: {
            ...w.end,
            monthOffset: Math.max(
              -1,
              Math.min(1, w.end.monthOffset + delta),
            ) as CyclePoint["monthOffset"],
          },
        })),
      },
    });
  };
  return (
    <div className="space-y-4">
      {message && (
        <div
          role="status"
          className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm"
        >
          {message}
        </div>
      )}
      <Dialog open={!!impactPreview} onOpenChange={open => {if (!open) setImpactPreview(null)}} dismissible={!busy} ariaLabel="确认月份日期调整" className="max-w-4xl">
        <h2 className="text-lg font-semibold">确认月份日期调整</h2>
        <p className="my-3 text-sm text-gray-600">仅调整下列市场和月份的日期。日报正文、已提交快照、目标金额和PK分班保留；周/月统计与完成率按新日期计算，预览中列出的受影响月份会一同应用，生效日期之前的日期归属保留。</p>
        {message && <p role="alert" className="mb-3 rounded-md bg-amber-50 p-3 text-sm text-amber-800">{message}</p>}
        <div className="max-h-[60vh] space-y-3 overflow-y-auto">
          {impactPreview?.impact.filter(row => row.requiresConfirmation).map(row => <section key={`${row.market}:${row.month}`} className="rounded-md border p-3 text-sm">
            <b>{row.market} · {row.month}</b>
            <p>原日期：{row.before ? `${row.before.start} 至 ${row.before.end}` : "尚未配置"}</p>
            <p>新日期：{row.after.start} 至 {row.after.end}</p>
            <p className="mt-1 text-amber-700">相关日报 {row.reports} 份 · 目标 {row.targets} 份 · PK班级 {row.classes} 个</p>
            <details className="mt-2"><summary className="cursor-pointer">查看每周日期变化</summary>{row.after.weeks.map((w,i) => <p key={w.id}>{w.name}：{row.before?.weeks?.[i] ? `${(row.before.weeks as typeof row.after.weeks)[i].start} 至 ${(row.before.weeks as typeof row.after.weeks)[i].end}` : "未配置"} → {w.start} 至 {w.end}</p>)}</details>
          </section>)}
        </div>
        <div className="mt-4 flex justify-end gap-3"><Button variant="outline" disabled={busy} onClick={() => setImpactPreview(null)}>返回编辑</Button><Button disabled={busy} onClick={() => save(impactPreview?.token || "")}>{busy ? "保存中…" : "确认应用"}</Button></div>
      </Dialog>
      <fieldset disabled={busy} className="space-y-4">
        <section className={card}>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-4">
            <div
              role="tablist"
              aria-label="周期模式"
              className="flex flex-wrap gap-2"
            >
              {modes.map((m) => (
                <button
                  type="button"
                  role="tab"
                  aria-selected={m.id === mode.id}
                  key={m.id}
                  className={m.id === mode.id ? primary : secondary}
                  onClick={() => switchMode(m.id)}
                >
                  {m.name}
                  <span className="ml-2 text-xs">
                    已选 {configuration.regions.filter(r => m.isDefault
                      ? !modes.some(other => !other.isDefault && other.regionIds.includes(r.id))
                      : m.regionIds.includes(r.id)).length} 个市场 · {Object.keys(m.monthly || {}).length} 个月例外
                  </span>
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <button className={secondary} onClick={reset}>
                恢复默认
              </button>
              <button className={primary} onClick={add}>
                ＋ 新增周期模式
              </button>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-end gap-4">
            <label className="text-sm">
              模式名称
              <input
                aria-label="模式名称"
                className={`${field} mt-1 block`}
                value={mode.name}
                onChange={(e) => update({ name: e.target.value })}
              />
            </label>
            <label className="text-sm">
              生效日期
              <input
                aria-label="生效日期"
                type="date"
                className={`${field} mt-1 block`}
                value={
                  mode.effectiveFrom === "0001-01-01"
                    ? ""
                    : mode.effectiveFrom || ""
                }
                onChange={(e) =>
                  update({ effectiveFrom: e.target.value || "0001-01-01" })
                }
              />
            </label>
            <span className="text-sm text-gray-500">
              {(!mode.effectiveFrom || mode.effectiveFrom === "0001-01-01") &&
                "长期生效 · "}
              月周期：{mode.pattern.start.day}日～{cross ? "次月" : "当月"}
              {mode.pattern.end.day === 31
                ? "月末"
                : `${mode.pattern.end.day}日`}
            </span>
          </div>
          <p className="mt-3 text-xs text-gray-500">
            生效日期之前保留原日期归属，从生效日期起使用新规则。交界月份作为过渡月预览；已有未来月份可重新修正，确认后应用。
          </p>
          <div className="mt-5 space-y-6">
            <section>
              <h3 className="mb-3 font-medium">① 月经营周期（起止日）</h3>
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  variant={
                    !cross &&
                    mode.pattern.start.day === 1 &&
                    mode.pattern.end.day === 31
                      ? "default"
                      : "outline"
                  }
                  aria-pressed={
                    !cross &&
                    mode.pattern.start.day === 1 &&
                    mode.pattern.end.day === 31
                  }
                  className="cursor-pointer shadow-sm"
                  onClick={() => update({ pattern: natural() })}
                >
                  自然月：1日～月末
                </Button>
                <Button
                  type="button"
                  variant={
                    cross &&
                    mode.pattern.start.day === 26 &&
                    mode.pattern.end.day === 25
                      ? "default"
                      : "outline"
                  }
                  aria-pressed={
                    cross &&
                    mode.pattern.start.day === 26 &&
                    mode.pattern.end.day === 25
                  }
                  className="cursor-pointer shadow-sm"
                  onClick={() =>
                    update({
                      pattern: structuredClone(defaultDailyCyclePattern),
                    })
                  }
                >
                  跨月：26日～次月25日
                </Button>
                <label className="flex items-center gap-2 text-sm">
                  起始日
                  <input
                    aria-label="经营月开始日号"
                    className={`${field} w-20`}
                    type="number"
                    min={1}
                    max={31}
                    value={mode.pattern.start.day}
                    onChange={(e) =>
                      changeMonthDays(
                        Number(e.target.value),
                        mode.pattern.end.day,
                      )
                    }
                  />
                </label>
                <span>→</span>
                <label className="flex items-center gap-2 text-sm">
                  结束日
                  <input
                    aria-label="经营月结束日号"
                    className={`${field} w-20`}
                    type="number"
                    min={1}
                    max={31}
                    value={mode.pattern.end.day}
                    onChange={(e) =>
                      changeMonthDays(
                        mode.pattern.start.day,
                        Number(e.target.value),
                      )
                    }
                  />
                </label>
                <span className="text-xs text-gray-500">
                  {cross ? "跨月，归属于结束月份" : "当月内"}；短月自动取月末
                </span>
              </div>
            </section>
            <section>
              <h3 className="mb-3 font-medium">② 月内每周周期</h3>
              <WeeksEditor
                pattern={mode.pattern}
                change={(pattern) => update({ pattern })}
              />
            </section>
            <section>
              <h3 className="mb-3 font-medium">
                ③{" "}
                {mode.isDefault
                  ? "市场沿用情况（自动分配）"
                  : "适用市场（可多选）"}
              </h3>
              {mode.isDefault && (
                <p className="mb-3 text-sm text-gray-500">
                  总部默认自动接管未分配的市场，此处仅查看。需要市场使用不同日期时，点击“新增周期模式”，在新模式中勾选市场。
                </p>
              )}
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {configuration.regions.map((r) => {
                  const owner = modes.find(
                    (m) => !m.isDefault && m.regionIds.includes(r.id),
                  );
                  const checked = mode.isDefault
                    ? !owner
                    : mode.regionIds.includes(r.id);
                  return (
                    <label
                      className="flex items-start gap-2 rounded-md border p-3 text-sm"
                      key={r.id}
                    >
                      <input
                        aria-label={`适用市场 ${r.name}`}
                        type="checkbox"
                        checked={checked}
                        disabled={mode.isDefault}
                        className="mt-1 accent-[#C0322A]"
                        onChange={(e) => assign(r.id, e.target.checked)}
                      />
                      <span>
                        {r.name}
                        <small className="block text-gray-500">
                          当前：
                          {owner?.name || modes.find((m) => m.isDefault)?.name}
                        </small>
                      </span>
                    </label>
                  );
                })}
              </div>
              <p className="mt-2 text-xs text-gray-500">
                未单独分配的市场沿用总部默认。选择其他模式可重新分配市场，保存时统一生效。
              </p>
            </section>
            <details id="daily-month-settings" className="rounded-md border p-4">
              <summary className="cursor-pointer font-medium">
                ④ 特殊月份（{Object.keys(mode.monthly || {}).length}个月）
              </summary>
              <p className="mt-3 text-sm text-gray-500">
                按月配置用于明确修正已有日期或设置过渡月份，作用于本模式适用市场。其他月份沿用普通规则；已结束月份只读。
              </p>
              <div className="my-3 flex flex-wrap gap-3">
                <input
                  aria-label="新增配置归属月"
                  className={field}
                  type="month"
                  value={newMonth}
                  onChange={(e) => setNewMonth(e.target.value)}
                />
                <button
                  className={secondary}
                  disabled={monthLocked(newMonth) || !relevantRegions.length}
                  onClick={() => {
                    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(newMonth)) {
                      setMessage("请选择有效归属月");
                      return;
                    }
                    if (mode.monthly?.[newMonth]) {
                      setMessage("该月份例外已展开，请在下方编辑");
                      return;
                    }
                    editMonth(newMonth);
                  }}
                >
                  设置这个月
                </button>
              </div>
              {monthLocked(newMonth) && <p className="text-sm text-gray-500">{newMonth}已结束，历史日期保持只读。需修正历史时请联系总部进行专门核对。</p>}
              {Object.entries(mode.monthly || {})
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([key, pattern]) => (
                  <fieldset disabled={monthLocked(key)}
                    className="mt-4 space-y-3 rounded-md border bg-gray-50 p-4"
                    key={key}
                  >
                    <div className="flex items-center justify-between">
                      <b>{key} 特殊月份{monthLocked(key) ? " · 历史只读" : ""}</b>
                      <button
                        className="text-sm text-red-700"
                        onClick={() => {
                          if (
                            !window.confirm(
                              `恢复${key}普通规则？保存前会预览恢复后的日期和影响，其他月份不变。`,
                            )
                          )
                            return;
                          const monthly = { ...mode.monthly };
                          delete monthly[key];
                          update({ monthly });
                        }}
                      >
                        恢复普通规则
                      </button>
                    </div>
                    <p className="text-sm text-gray-600">日期预览：{exceptionPreview(key,pattern)} · 适用 {relevantRegions.length} 个市场，保存前校验并显示影响。</p>
                    <div className="flex flex-wrap gap-3">
                      <Point
                        label={`${key}月开始`}
                        value={pattern.start}
                        change={(start) =>
                          monthlyChange(key, { ...pattern, start })
                        }
                      />
                      <span>至</span>
                      <Point
                        label={`${key}月结束`}
                        value={pattern.end}
                        change={(end) =>
                          monthlyChange(key, { ...pattern, end })
                        }
                      />
                    </div>
                    <WeeksEditor
                      prefix={`${key} `}
                      pattern={pattern}
                      change={(p) => monthlyChange(key, p)}
                    />
                  </fieldset>
                ))}
            </details>
          </div>
          <div className="mt-5 flex flex-wrap justify-end gap-3">
            {!mode.isDefault && (
              <button className={`${secondary} text-red-700`} onClick={remove}>
                删除该模式
              </button>
            )}
            <button
              className={secondary}
              disabled={!dirty}
              onClick={() => {
                if (window.confirm("放弃尚未保存的修改？")) {
                  setModes(loaded());
                              setPlan(null);
                }
              }}
            >
              放弃修改
            </button>
            <button className={primary} onClick={() => void preview()}>
              保存该模式
            </button>
          </div>
        </section>
        <section className={card}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-medium">周期日历预览／批量应用</h3>
            <div className="flex flex-wrap items-center gap-2">
              <label className="text-sm">归属月<input aria-label="日期预览开始月份" className={`${field} ml-2`} type="month" value={from} onChange={e => setFrom(e.target.value)}/></label>
              <span>至</span><input aria-label="日期预览结束月份" className={field} type="month" value={to} onChange={e => setTo(e.target.value)}/>
              <button className={secondary} onClick={() => void preview()}>预览／校验</button>
              <button className={primary} disabled={!plan || !plan.calendar || !!plan.calendar.issues.length} onClick={() => void save()}>确认应用</button>
            </div>
          </div>
          <p className="mt-3 text-sm text-gray-500">针对当前模式的适用市场。预览使用当前编辑的规则，确认后同时保存规则和修正所选月份。</p>
          {dirty && <p className="mt-2 text-sm text-amber-800">规则尚未应用；下方已保存日期仍可查看，请预览修改后的日期。</p>}
          {plan?.calendar && <p className="mt-3 text-sm">预览范围：{displayMonths[0]}至{displayMonths.at(-1)}（含过渡月及受影响的已生成未来月份）。预览结果：新增{new Set(plan.calendar.rows.filter(r => r.action === "create").map(r => r.month)).size}个月，修正{new Set(plan.calendar.rows.filter(r => ["update","adjust"].includes(r.action)).map(r => r.month)).size}个月，保留{new Set(plan.calendar.rows.filter(r => r.action === "keep").map(r => r.month)).size}个月。确认后应用全部可更新的安排。</p>}
          {Array.from(groupedIssues.values()).map((issue,i) => <div role="alert" className="mt-2 rounded-md bg-amber-50 p-3 text-sm text-amber-800" key={i}><p>{issue.message}<button className="ml-3 underline" onClick={() => editMonth(issue.month)}>调整{issue.month}</button></p>{issue.markets.length > 0 && <details className="mt-1"><summary className="cursor-pointer">涉及{issue.markets.length}个市场</summary>{issue.markets.join("、")}</details>}</div>)}

          <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[640px] text-sm">
            <thead><tr className="bg-gray-50 text-left">{["归属月","月周期（已保存 → 拟应用）","周明细／来源","操作"].map(t => <th className="p-3" key={t}>{t}</th>)}</tr></thead>
            <tbody>{displayMonths.map(key => {
              const rows = plan?.calendar?.rows.filter(r => r.month === key) || [];
              const actual = relevantRegions.map(r => ({market:r.name,period:configuration.periods.find(p => p.regionId===r.id && periodMonth(p)===key) || configuration.periods.find(p=>!p.regionId && periodMonth(p)===key)}));
              const texts = rows.length ? rows.map(r => `${r.before ? `${r.before.start} 至 ${r.before.end}` : "尚未安排"}${r.after && (!r.before || r.before.start!==r.after.start || r.before.end!==r.after.end || JSON.stringify(r.before.weeks)!==JSON.stringify(r.after.weeks)) ? ` → ${r.after.start} 至 ${r.after.end}` : ""}`) : actual.map(r => r.period ? `${r.period.start} 至 ${r.period.end}` : "尚未安排，请预览");
              const common = new Set(texts).size <= 1;
              return <tr className="border-t align-top" key={key}>
                <td className="p-3 font-medium">{key}</td><td className="p-3">{common ? texts[0] || "暂无适用市场" : "各市场日期不同，请展开查看"}
                  {rows.length > 0 && <p className="mt-1 text-xs text-gray-500">{Array.from(new Set(rows.map(r=>r.reason))).join("；")}</p>}</td>
                <td className="p-3"><p className="mb-2 text-xs text-gray-500">{Array.from(new Set(rows.length ? rows.map(r => sourceLabel(r.source)) : actual.map(r => r.period ? sourceLabel(r.period.templateSource) : "尚未安排"))).join("／")}</p><details><summary className="cursor-pointer">查看周日期、天数与来源</summary>
                  {rows.length ? rows.map(r => <div className="mt-2" key={r.regionId}><b>{r.market} · {sourceLabel(r.source)}</b><p>{r.before ? `${r.before.start} 至 ${r.before.end}` : "尚未安排"}{r.after ? ` → ${r.after.start} 至 ${r.after.end}` : ""}</p>{r.after?.weeks.map(w => <p key={w.id}>{w.name}：{w.start} 至 {w.end} · {duration(w.start,w.end)}天</p>)}</div>) : actual.map(r => <div className="mt-2" key={r.market}><b>{r.market} · {r.period ? sourceLabel(r.period.templateSource) : "尚未安排"}</b><p>{r.period && `${r.period.start} 至 ${r.period.end}`}</p>{r.period?.weeks.map(w => <p key={w.id}>{w.name}：{w.start} 至 {w.end} · {duration(w.start,w.end)}天</p>)}</div>)}
                </details></td><td className="p-3"><button className="text-red-700 underline disabled:text-gray-400" disabled={monthLocked(key)} onClick={() => editMonth(key)}>{monthLocked(key) ? "已结束，只读" : "调整日期"}</button></td>
              </tr>;
            })}</tbody>
          </table></div>
        </section>
      </fieldset>
    </div>
  );
}
