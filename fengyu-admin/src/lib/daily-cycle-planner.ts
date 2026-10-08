import { resolveCycleMode, type CycleRevision } from "./daily-cycle-modes";
import { dailyCyclePattern } from "./daily-config";
import {
  buildDailyPeriod,
  type DailyCyclePattern,
} from "./daily-period-template";

export const inheritedTemplatesKey = "daily_period_inherited_templates";

export function inheritedTemplateIds(value?: string | null): string[] {
  if (!value) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw Error("INVALID_STATE: 日期规则继承配置损坏，请联系管理员");
  }
  if (!Array.isArray(parsed) || parsed.some((id) => typeof id !== "string")) {
    throw Error("INVALID_STATE: 日期规则继承配置损坏，请联系管理员");
  }
  return parsed;
}

export function monthRange(monthKey: string, months = 1) {
  if (
    !/^\d{4}-(0[1-9]|1[0-2])$/.test(monthKey) ||
    !Number.isInteger(months) ||
    months < 1 ||
    months > 36
  ) {
    throw Error("INVALID_PARAMS: 请选择有效月份，生成范围为1至36个月");
  }
  const [year, month] = monthKey.split("-").map(Number);
  return Array.from({ length: months }, (_, index) => {
    const date = new Date(Date.UTC(year, month - 1 + index, 1));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  });
}

export function periodMonth(period: {
  monthKey?: string | null;
  name: string;
  end?: string;
}) {
  return (
    period.monthKey ||
    (/^\d{6}$/.test(period.name)
      ? `${period.name.slice(0, 4)}-${period.name.slice(4)}`
      : period.end?.slice(0, 7) || "")
  );
}

export function samePeriodDates(
  a: {
    start: string;
    end: string;
    weeks: { name?: string; start: string; end: string }[];
  },
  b: typeof a,
) {
  return (
    a.start === b.start &&
    a.end === b.end &&
    JSON.stringify(a.weeks.map((w) => [w.name, w.start, w.end])) ===
      JSON.stringify(b.weeks.map((w) => [w.name, w.start, w.end]))
  );
}

type PlanData = {
  regions: { id: string; name: string }[];
  templates: {
    id: string;
    regionId: string | null;
    pattern: unknown;
    version: number;
  }[];
  overrides: {
    templateId: string;
    regionId: string | null;
    monthKey: string;
    pattern: unknown;
  }[];
  periods: {
    id: string;
    name: string;
    regionId: string | null;
    monthKey: string | null;
    start: string;
    end: string;
    version: number;
    weeks: { id: string; name: string; start: string; end: string }[];
  }[];
  modeHistory?: CycleRevision[];
  modeId?: string;
  updateUnused?: boolean;
  disabledTemplateIds: string[];
};

export function planDailyMonths(
  data: PlanData,
  monthKey: string,
  months: number,
  today: string,
) {
  const keys = monthRange(monthKey, months);
  const global = data.templates.find((t) => t.regionId === null);
  const regions = data.regions.length
    ? data.regions
    : [{ id: null, name: "全局" }];
  return regions.flatMap((region) => {
    const specific = data.templates.find(
      (t) =>
        t.regionId === region.id && !data.disabledTemplateIds.includes(t.id),
    );
    const template = specific || global;
    const rows = keys.map((key) => {
      const existing =
        data.periods.find(
          (p) => p.regionId === region.id && periodMonth(p) === key,
        ) ||
        data.periods.find((p) => p.regionId === null && periodMonth(p) === key);
      const override =
        template &&
        (data.overrides.find(
          (o) =>
            o.templateId === template.id &&
            o.regionId === region.id &&
            o.monthKey === key,
        ) ||
          data.overrides.find(
            (o) =>
              o.templateId === template.id &&
              o.regionId === null &&
              o.monthKey === key,
          ));
      const selected = data.modeHistory?.length
        ? resolveCycleMode(data.modeHistory, region.id || "", key)
        : null;
      const source = selected
        ? selected.mode.monthly?.[key]
          ? "month-override"
          : selected.mode.isDefault
            ? "global-template"
            : "region-template"
        : override
          ? "month-override"
          : specific?.regionId
            ? "region-template"
            : "global-template";
      let computed = null;
      let error = "";
      if (selected || (!data.modeHistory?.length && template)) {
        const pattern = dailyCyclePattern.safeParse(
          selected?.pattern || override?.pattern || template?.pattern,
        );
        if (!pattern.success) error = "日期规则格式有误，请先修改长期规则";
        else {
          try {
            computed = buildDailyPeriod(
              key,
              pattern.data as DailyCyclePattern,
              "preview",
            );
          } catch {
            error = "经营周必须连续覆盖经营月，请检查规则及短月日期";
          }
        }
      } else error = "请先保存总部默认规则或该市场专用规则";
      const period = existing || computed;
      return {
        proposed: computed,
        modeId: selected?.mode.id || null,
        monthKey: key,
        regionId: region.id,
        regionName: region.name,
        templateId: template?.id || null,
        source,
        period,
        action: existing
          ? ("keep" as const)
          : error
            ? ("blocked" as const)
            : ("create" as const),
        reason: existing
          ? existing.regionId === null
            ? "保留已有全局安排及关联数据"
            : "保留已有月份安排"
          : error,
        ruleChanged: !!(
          existing &&
          computed &&
          !samePeriodDates(existing, computed)
        ),
      };
    });
    const plannedDates = (row: (typeof rows)[number] | undefined) => {
      const original = data.periods.find((p) => p.id === row?.period?.id);
      return data.updateUnused &&
        row?.ruleChanged &&
        original?.regionId === region.id &&
        (!data.modeId || row.modeId === data.modeId)
        ? row.proposed || row.period
        : row?.period;
    };
    for (const row of rows) {
      if (row.action !== "create" || !row.period) continue;
      const p = row.period;
      if (p.start <= today) {
        row.action = "blocked";
        row.reason = "只能准备尚未开始的完整经营月";
        continue;
      }
      const sameScope = data.periods
        .filter((old) => old.regionId === region.id || old.regionId === null)
        .map((old) => ({
          ...old,
          ...(plannedDates(rows.find((r) => r.period?.id === old.id)) || {}),
          id: old.id,
        }));
      if (sameScope.some((old) => old.start <= p.end && old.end >= p.start)) {
        row.action = "blocked";
        row.reason = "与已有经营月重叠，请先核对启用边界";
        continue;
      }
      const previousKey = monthRange(row.monthKey)[0];
      const [y, m] = previousKey.split("-").map(Number);
      const previousDate = new Date(Date.UTC(y, m - 2, 1));
      const previousMonth = `${previousDate.getUTCFullYear()}-${String(previousDate.getUTCMonth() + 1).padStart(2, "0")}`;
      const previous =
        plannedDates(rows.find((r) => r.monthKey === previousMonth)) ||
        sameScope.find(
          (old) =>
            periodMonth(old) === previousMonth && old.regionId === region.id,
        ) ||
        sameScope.find((old) => periodMonth(old) === previousMonth);
      const nextMonth = monthRange(row.monthKey, 3)[1];
      const next =
        plannedDates(rows.find((r) => r.monthKey === nextMonth)) ||
        sameScope.find(
          (old) => periodMonth(old) === nextMonth && old.regionId === region.id,
        ) ||
        sameScope.find((old) => periodMonth(old) === nextMonth);
      if (
        (previous &&
          Date.parse(p.start) - Date.parse(previous.end) !== 86400000) ||
        (next && Date.parse(next.start) - Date.parse(p.end) !== 86400000)
      ) {
        row.action = "blocked";
        row.reason = "与相邻经营月日期不连续，请核对市场规则或本月特殊安排";
      }
    }
    return data.modeId
      ? rows.filter((row) => row.modeId === data.modeId)
      : rows;
  });
}
