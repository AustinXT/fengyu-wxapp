import { it, expect } from "vitest";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { expand } from "./target-write";
import * as rules from "./operating-target";
const require = createRequire(import.meta.url);
const pathResolve = resolve;
const period = { start: "2026-10-01", end: "2026-10-31", weeks: [] };
it("一周与五周的五项目标余额、按天分摊跨端一致", () => {
  const cloudExpand = require(
    pathResolve(
      process.cwd(),
      "../fengyu-daily/cloudfunctions/dailyApi/routes/target",
    ),
  ).expand;
  for (const count of [1, 5, 31]) {
    const weeks = Array.from({ length: count }, (_, i) => ({
      id: "v" + i,
      name: "周" + i,
      start: "2026-10-01",
      end: "2026-10-01",
    }));
    const target = {
      sales: 100,
      consumption: 200,
      visits: 50,
      new_customers: 20,
      projects: 60,
      weeks: Object.fromEntries(
        weeks
          .slice(0, -1)
          .map((w) => [
            w.id,
            {
              sales: 1,
              consumption: 2,
              visits: 1,
              newCustomers: 0,
              projects: 1,
            },
          ]),
      ),
    };
    const expanded = expand(target, { ...period, weeks });
    expect(expanded).toEqual(cloudExpand(target, { ...period, weeks }));
    expect(expanded.weeks[weeks[count - 1].id]).toMatchObject({
      sales: 100 - count + 1,
      consumption: 200 - (count - 1) * 2,
      visits: 50 - count + 1,
      newCustomers: 20,
      projects: 60 - count + 1,
    });
    expect(
      rules
        .distributeByDays(
          101,
          weeks.map(() => 1),
        )
        .reduce((a, b) => a + b, 0),
    ).toBe(101);
  }
});
