import { z } from "zod";
import { dailyCyclePattern } from "./daily-config";
import {
  defaultDailyCyclePattern,
  type DailyCyclePattern,
} from "./daily-period-template";

export const cycleModesKey = "daily_cycle_modes";
export const cycleHistoryKey = "daily_cycle_mode_history";
export const cycleModesInput = z
  .array(
    z.object({
      id: z.string().min(1).max(50),
      name: z.string().trim().min(1).max(60),
      effectiveFrom: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .refine((s) => {
          const d = new Date(s + "T12:00:00Z");
          return (
            Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s
          );
        }, "请选择有效生效日期")
        .optional(),
      monthly: z
        .record(z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), dailyCyclePattern)
        .optional(),
      isDefault: z.boolean(),
      regionIds: z.array(z.string().min(1).max(100)),
      pattern: dailyCyclePattern,
    }),
  )
  .min(1)
  .max(50)
  .superRefine((modes, ctx) => {
    if (modes.filter((m) => m.isDefault).length !== 1)
      ctx.addIssue({ code: "custom", message: "必须保留一套总部默认模式" });
    if (
      new Set(modes.map((m) => m.id)).size !== modes.length ||
      new Set(modes.map((m) => m.name)).size !== modes.length
    )
      ctx.addIssue({ code: "custom", message: "周期模式编号和名称不可重复" });
    const assigned = modes.flatMap((m) => m.regionIds);
    if (
      new Set(assigned).size !== assigned.length ||
      modes.some((m) => m.isDefault && m.regionIds.length)
    )
      ctx.addIssue({
        code: "custom",
        message: "同一市场只能使用一套模式；未分配市场自动使用总部默认模式",
      });
  });
export type CycleMode = z.infer<typeof cycleModesInput>[number];

type Template = {
  id: string;
  regionId: string | null;
  name: string;
  pattern: unknown;
};
export function patternSignature(pattern: DailyCyclePattern) {
  const point = (p: DailyCyclePattern["start"]) => [p.monthOffset, p.day];
  return JSON.stringify([
    point(pattern.start),
    point(pattern.end),
    pattern.weeks.map((w) => [w.name, point(w.start), point(w.end)]),
  ]);
}

// 旧配置从模板重建分组；升级后的模式以版本历史为准，保留尚未生效的规则。
export function readCycleModes(
  templates: Template[],
  disabled: string[],
  regionIds: string[],
  raw?: string | null,
): CycleMode[] {
  let saved: CycleMode[] = [];
  if (raw) {
    try {
      saved = cycleModesInput.parse(JSON.parse(raw));
    } catch {
      throw Error("INVALID_STATE: 周期模式配置损坏，请联系管理员");
    }
  }
  if (saved.some((m) => m.effectiveFrom !== undefined)) return saved;
  const global = templates.find((t) => t.regionId === null);
  const base = saved.find((m) => m.isDefault);
  const result: CycleMode[] = [
    {
      id: base?.id || "headquarters",
      name: base?.name || global?.name || "总部标准周期",
      isDefault: true,
      regionIds: [],
      pattern: (global?.pattern ||
        base?.pattern ||
        defaultDailyCyclePattern) as DailyCyclePattern,
    },
    ...saved
      .filter((m) => !m.isDefault)
      .map((m) => ({ ...m, regionIds: [] as string[] })),
  ];
  for (const regionId of regionIds) {
    const template = templates.find(
      (t) => t.regionId === regionId && !disabled.includes(t.id),
    );
    if (!template) continue;
    const signature = patternSignature(template.pattern as DailyCyclePattern);
    const previous = saved.find(
      (m) =>
        !m.isDefault &&
        m.regionIds.includes(regionId) &&
        patternSignature(m.pattern) === signature,
    );
    let mode = previous
      ? result.find((m) => m.id === previous.id)
      : result.find(
          (m) =>
            !m.isDefault &&
            m.id.startsWith("legacy-") &&
            patternSignature(m.pattern) === signature,
        );
    if (!mode) {
      const id = "legacy-" + template.id.slice(0, 40);
      let name = template.name.slice(0, 60);
      let suffix = 1;
      while (result.some((m) => m.name === name))
        name = template.name.slice(0, 45) + `（独立${suffix++}）`;
      mode = {
        id,
        name,
        isDefault: false,
        regionIds: [],
        pattern: template.pattern as DailyCyclePattern,
      };
      result.push(mode);
    }
    mode.regionIds.push(regionId);
  }
  return result;
}

export type CycleRevision = { validFrom: string; modes: CycleMode[] };
export function readCycleHistory(raw?: string | null): CycleRevision[] {
  if (!raw) return [];
  try {
    return z
      .array(
        z.object({
          validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          modes: cycleModesInput,
        }),
      )
      .parse(JSON.parse(raw));
  } catch {
    throw Error("INVALID_STATE: 周期模式历史损坏，请联系管理员");
  }
}

// 以经营月首日判定生效；旧版本用于生效日前未生成月份，实际已生成月份始终保留。
export function resolveCycleMode(
  revisions: CycleRevision[],
  regionId: string,
  month: string,
) {
  for (const revision of revisions.slice().reverse()) {
    const specific = revision.modes.find(
      (m) => !m.isDefault && m.regionIds.includes(regionId),
    );
    const base = revision.modes.find((m) => m.isDefault);
    for (const mode of [specific, base]) {
      if (!mode) continue;
      const pattern = mode.monthly?.[month] || mode.pattern;
      // 这里只算首日，不依赖周规则是否合法；完整校验由月份规划负责。
      const [year, mon] = month.split("-").map(Number);
      const start = new Date(
        Date.UTC(year, mon - 1 + pattern.start.monthOffset, 1),
      );
      const last = new Date(
        Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0),
      ).getUTCDate();
      start.setUTCDate(Math.min(pattern.start.day, last));
      const date = start.toISOString().slice(0, 10);
      if (
        date >= revision.validFrom &&
        date >= (mode.effectiveFrom || "0001-01-01")
      )
        return { mode, pattern };
      // 专用模式尚未生效应找旧版本，不提前使用新版总部分配。
      if (specific) break;
    }
  }
  return null;
}

// 首次升级把旧月份例外带入模式，差异例外的市场拆成独立模式，防止保存时丢失旧规则。
export function upgradeCycleModes(
  templates: Template[],
  disabled: string[],
  regionIds: string[],
  overrides: {
    templateId: string;
    regionId: string | null;
    monthKey: string;
    pattern: unknown;
  }[],
  raw?: string | null,
) {
  const modes = readCycleModes(templates, disabled, regionIds, raw);
  if (modes.some((m) => m.effectiveFrom !== undefined)) return modes;
  const global = templates.find((t) => !t.regionId);
  const result = modes.map((mode) => ({
    ...mode,
    monthly: {} as Record<string, DailyCyclePattern>,
  }));
  const base = result.find((m) => m.isDefault)!;
  for (const o of overrides.filter(
    (o) => o.templateId === global?.id && !o.regionId,
  ))
    base.monthly[o.monthKey] = o.pattern as DailyCyclePattern;
  for (const [index, regionId] of regionIds.entries()) {
    const template =
      templates.find(
        (t) => t.regionId === regionId && !disabled.includes(t.id),
      ) || global;
    const owner =
      result.find((m) => !m.isDefault && m.regionIds.includes(regionId)) ||
      base;
    const monthly = Object.fromEntries(
      overrides
        .filter(
          (o) =>
            o.templateId === template?.id &&
            (!o.regionId || o.regionId === regionId),
        )
        .sort((a, b) => Number(!!a.regionId) - Number(!!b.regionId))
        .map((o) => [o.monthKey, o.pattern as DailyCyclePattern]),
    );
    if (JSON.stringify(monthly) === JSON.stringify(owner.monthly)) continue;
    if (!owner.isDefault && owner.regionIds.length === 1) {
      owner.monthly = monthly;
      continue;
    }
    owner.regionIds = owner.regionIds.filter((r) => r !== regionId);
    result.push({
      ...owner,
      id: `legacy-month-${index}-${(template?.id || "global").slice(0, 20)}`,
      name: `${owner.name.slice(0, 40)}（月份例外${index + 1}）`,
      isDefault: false,
      regionIds: [regionId],
      monthly,
    });
  }
  return result;
}
