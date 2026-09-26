/**
 * dist-equivalence 比较器自身的正反例（#360）。
 * 守护的价值取决于它「该绿的绿、该红的红」：bun 的每一种合法改写都要判等价，每一种真实漂移都要判不等。
 */
import { describe, expect, it } from 'vitest'
import { compareModuleRuntime } from './dist-equivalence'

/** 被导入模块在产物里的区段：只需声明出来的顶层名字 */
const SEGMENTS: Record<string, string> = {
  '@/db': 'var globalForDb, client, db2;\nvar init_db2 = __esm(() => {});',
  './helpers': 'var init_helpers = __esm(() => {});\nfunction helper(x) { return x }\nfunction wrap(f) { return f }\nvar LIMIT = 5;',
  './other': 'function X2() {}',
  './fx': 'var init_fx = __esm(() => {});',
  './destructured': 'var { alpha, beta: renamed } = source, [gamma] = list;',
  './empty': '',
}
const compare = (sourceCode: string, distCode: string) => compareModuleRuntime({
  sourceCode,
  distCode,
  distSegmentOfImport: (specifier) => SEGMENTS[specifier] ?? null,
})

describe('dist-equivalence：bun 的合法改写判为等价', () => {
  it('类型、注释、引号、分号、尾逗号、冗余括号、换行、if 拆行', () => {
    expect(compare(
      `// 注释
       const MAX: number = 64 // 行尾
       /* 块注释 */
       export function f(value: string | null, list: string[],): string | undefined {
         if (value === null) return undefined
         const size = (list.length + 1) * 2
         if (size > MAX) { return 'big' }
         return value.trim()
       }`,
      `var MAX = 64;
       function f(value, list) {
         if (value === null)
           return;
         const size = (list.length + 1) * 2;
         if (size > MAX) {
           return "big";
         }
         return value.trim();
       }`,
    )).toEqual([])
  })

  it('局部变量改名（含遮蔽与多个同名回调参数只改其中一个）', () => {
    expect(compare(
      `export function f(rows: number[]) {
         const total = rows.map((row) => row * 2).filter((row) => row > 0)
         { const total = 1; void total }
         return total
       }`,
      `function f(rows2) {
         const total3 = rows2.map((row) => row * 2).filter((row4) => row4 > 0);
         { const total = 1; void total; }
         return total3;
       }`,
    )).toEqual([])
  })

  it('导入绑定加后缀（被导入模块确实声明了该名字）、命名空间导入', () => {
    expect(compare(
      `import { db } from '@/db'
       import { sql } from 'drizzle-orm'
       import { helper } from './helpers'
       export async function q(id: string) { return db.execute(sql\`SELECT \${id}\`).then(helper) }`,
      `init_db2();
       init_helpers();
       var import_drizzle_orm60 = __toESM(require_drizzle_orm(), 1);
       async function q(id) { return db2.execute(import_drizzle_orm60.sql\`SELECT \${id}\`).then(helper); }`,
    )).toEqual([])
  })

  it('顶层 const → var 且名字加后缀；{ a } ≡ { a: a2 }；无替换模板 ≡ 同文字符串', () => {
    expect(compare(
      `const DATE_PATTERN = /^\\d+$/
       export function g(locationId: string) { return { locationId, tag: \`plain\`, ok: DATE_PATTERN.test(locationId) } }`,
      `var DATE_PATTERN2 = /^\\d+$/;
       function g(locationId2) { return { locationId: locationId2, tag: "plain", ok: DATE_PATTERN2.test(locationId2) }; }`,
    )).toEqual([])
  })

  it('命名空间导入 import * as ns ↔ import_pkgN；默认导入 ↔ import_pkgN.default；顶层 let ≡ var；BigInt 同值', () => {
    expect(compare(
      `import * as z from 'zod'
       import dayjs from 'dayjs'
       let COUNT = 1n
       export const s = z.string()
       export const d = dayjs(COUNT)`,
      `var import_zod3 = __toESM(require_zod(), 1);
       var import_dayjs2 = __toESM(require_dayjs(), 1);
       var COUNT = 1n;
       var s = import_zod3.string();
       var d = (0, import_dayjs2.default)(COUNT);`,
    )).toEqual([])
  })

  it('BigInt 按值：1n ≡ 0x1n ≡ 1_0n / 10；数字分隔符按值：1_000 ≡ 1000', () => {
    expect(compare('export const a = 1n\nexport const b = 1_0n', 'var a = 0x1n;\nvar b = 10n;')).toEqual([])
    expect(compare('export const a = 1_000\nexport const b = 1_000', 'var a = 1000;\nvar b = 1_000;')).toEqual([])
    expect(compare('export const a = 1_000', 'var a = 1_001;')).not.toEqual([])
  })

  it('init 调用与副作用导入各自保序；副作用导入可与 init 交错', () => {
    expect(compareModuleRuntime({
      sourceCode: 'import { db } from "@/db"\nimport "server-only"\nimport { helper } from "./helpers"\nexport const a = helper(db)',
      distCode: 'init_db2();\nimport"server-only";\ninit_helpers();\nvar a = helper(db2);',
      distSegmentOfImport: (specifier) => SEGMENTS[specifier] ?? null,
    })).toEqual([])
  })

  it('内部模块的副作用导入降为 init_x()，并按源码导入顺序夹在其它 init 之间', () => {
    expect(compare(
      'import { db } from "@/db"\nimport "./fx"\nimport { helper } from "./helpers"\nexport const a = helper(db)',
      'init_db2();\ninit_fx();\ninit_helpers();\nvar a = helper(db2);',
    )).toEqual([])
  })

  it('顶层 const / let ≡ var 无条件等价（bun 固定转换，TDZ 语义差异不在守护的威胁模型内，见比较器文件头）', () => {
    expect(compare('export function f() { return A }\nconst probe = f()\nconst A = 1', 'function f() { return A; }\nvar probe = f();\nvar A = 1;')).toEqual([])
  })

  it('空模块（区段存在但为空）的副作用导入：没有 init、也不报「找不到区段」', () => {
    expect(compare('import "./empty"\nexport const a = 1', 'var a = 1;')).toEqual([])
    expect(compare('import "./missing"\nexport const a = 1', 'var a = 1;').join('\n')).toMatch(/找不到 \.\/missing 在产物里的模块区段/)
  })

  it('被导入模块以解构形态声明导出名；纯转导出 export { … } 两侧都不参与比较', () => {
    expect(compare(
      'import { alpha, renamed, gamma } from "./destructured"\nexport const a = [alpha, renamed, gamma]\nexport { a as b }',
      'var a = [alpha, renamed, gamma];\nexport { a as b };',
    )).toEqual([])
  })

  it('only：只比指定声明，两侧各恰好一处', () => {
    const only = (names: string[], distCode: string) => compareModuleRuntime({
      sourceCode: 'export const a = 1\nexport const b = 2',
      distCode,
      distSegmentOfImport: () => null,
      only: names,
    })
    expect(only(['b'], 'var a = 99;\nvar b2 = 2;')).toEqual([])
    // only 支持类声明
    expect(compareModuleRuntime({
      sourceCode: 'export class K { m(): number { return 1 } }',
      distCode: 'class K2 { m() { return 1; } }',
      distSegmentOfImport: () => null,
      only: ['K'],
    })).toEqual([])
    expect(only(['b'], 'var b2 = 3;')).not.toEqual([])
    expect(() => only(['c'], 'var c = 1;')).toThrow(/源码里 c 的顶层声明找到 0 处/)
    expect(() => only(['b'], 'var a = 1;')).toThrow(/产物里 b 的顶层声明找到 0 处/)
    expect(() => only(['b'], 'var b = 2;\nvar b2 = 2;')).toThrow(/产物里 b 的顶层声明找到 2 处/)
    // only 模式下产物带来源的再导出同样不能被挑选静默丢掉
    expect(only(['b'], 'export { x } from "./dep";\nvar b2 = 2;').join('\n')).toMatch(/产物出现带来源的再导出/)
    // only 模式下产物残留的内部 import 同样不能被过滤放过
    expect(only(['b'], 'import"./fx";\nvar b2 = 2;').join('\n')).toMatch(/产物残留非预期的 import/)
  })

  it('"use server" 与 init_*() 样板不参与比较', () => {
    expect(compare(
      `'use server'
       import { helper } from './helpers'
       export const a = helper(1)`,
      `init_helpers();
       "use server";
       var a2 = helper(1);`,
    )).toEqual([])
  })
})

describe('dist-equivalence：真实漂移判为不等', () => {
  const differs = (sourceCode: string, distCode: string) => expect(compare(sourceCode, distCode)).not.toEqual([])

  it('一元运算符不同（! / - / +）', () => {
    differs('export function f(x: number) { return !x }', 'function f(x) { return -x; }')
    differs('export function f(x: number) { return +x }', 'function f(x) { return -x; }')
  })

  it('二元运算符 / 比较方向不同', () => {
    differs('export function f(a: number, b: number) { return a > b }', 'function f(a, b) { return a >= b; }')
  })

  it('模板原文差一个分号 / 一个逗号 / 一行 SQL 注释', () => {
    differs('import { sql } from "drizzle-orm"\nexport const q = sql`SELECT a, b`', 'var import_drizzle_orm1 = __toESM(x);\nvar q = import_drizzle_orm1.sql`SELECT a b`;')
    differs('import { sql } from "drizzle-orm"\nexport const q = sql`WHERE x`', 'var import_drizzle_orm1 = __toESM(x);\nvar q = import_drizzle_orm1.sql`WHERE x;`;')
    differs('import { sql } from "drizzle-orm"\nexport const q = sql`-- a\nSELECT 1`', 'var import_drizzle_orm1 = __toESM(x);\nvar q = import_drizzle_orm1.sql`-- b\nSELECT 1`;')
  })

  it('局部绑定：整体一致的 alpha 改名等价；没有二元运算符的引用串位也能检出', () => {
    expect(compare(
      'export function f() { const x = 1; const y = x + 1; return [x, y] }',
      'function f() { const y2 = 1; const x2 = y2 + 1; return [y2, x2]; }',
    )).toEqual([])
    differs('export function f() { const x = 1; const y = x + 1; return [x, y] }', 'function f() { const x = 1; const y = x + 1; return [y, x]; }')
  })

  it('局部绑定对调（参数引用串位）', () => {
    differs('export function f(a: number, b: number) { return a - b }', 'function f(a, b) { return b - a; }')
    differs('export function f(a: number, b: number) { return a - b }', 'function f(x, y) { return y - x; }')
  })

  it('导入绑定：产物用的 X2 不是被导入模块声明的', () => {
    differs('import { X } from "./helpers"\nexport const a = X()', 'var a = X2();')
  })

  it('导入绑定：名字对不上', () => {
    differs('import { helper } from "./helpers"\nexport const a = helper(1)', 'var a = LIMIT(1);')
  })

  it('模块内绑定：同一源码名在产物里对应两个不同名字', () => {
    differs(
      'const A = 1\nexport function f() { return A }\nexport function g() { return A }',
      'var A = 1;\nfunction f() { return A; }\nfunction g() { return A2; }',
    )
  })

  it('字符串 / 数字 / 正则 / 属性名 / 简写键不同', () => {
    differs('export const a = "x"', 'var a = "y";')
    differs('export const a = 64', 'var a = 65;')
    differs('export const a = /^a$/', 'var a = /^b$/;')
    differs('export function f(o: { a: number }) { return o.a }', 'function f(o) { return o.b; }')
    differs('export function f(a: number) { return { a } }', 'function f(a) { return { b: a }; }')
  })

  it('少一条语句 / 多一个参数 / 函数内 let 与 const 互换', () => {
    differs('export const a = 1\nexport const b = 2', 'var a = 1;')
    differs('export function f(a: number) { return a }', 'function f(a, b) { return a; }')
    differs('export function f() { const a = 1; return a }', 'function f() { let a = 1; return a; }')
  })

  it('打包样板：漏调 / 多调 / 重复调 / 调错 / 顺序对调 init；副作用导入不同或顺序对调；指令不同', () => {
    const source = 'import { helper } from "./helpers"\nexport const a = helper(1)'
    differs(source, 'var a = helper(1);')
    differs(source, 'init_helpers();\ninit_db2();\nvar a = helper(1);')
    differs(source, 'init_helpers();\ninit_helpers();\nvar a = helper(1);')
    differs(source, 'init_helper();\nvar a = helper(1);')
    differs(
      'import { db } from "@/db"\nimport { helper } from "./helpers"\nexport const a = helper(db)',
      'init_helpers();\ninit_db2();\nvar a = helper(db2);',
    )
    differs('import "a-pkg"\nimport "b-pkg"\nexport const a = 1', 'import"b-pkg";\nimport"a-pkg";\nvar a = 1;')
    // 内部副作用导入的 init 必须在源码导入顺序的位置上
    differs(
      'import { db } from "@/db"\nimport "./fx"\nimport { helper } from "./helpers"\nexport const a = helper(db)',
      'init_db2();\ninit_helpers();\ninit_fx();\nvar a = helper(db2);',
    )
    // 内部副作用导入在产物里被原样保留成 import（而不是降为 init）也算不等
    differs('import "./fx"\nexport const a = 1', 'import"./fx";\nvar a = 1;')
    // 产物同时有正确的 init_fx() 和残留的 import "./fx"：残留不能被过滤掉
    expect(compare('import "./fx"\nexport const a = 1', 'init_fx();\nimport"./fx";\nvar a = 1;').join('\n')).toMatch(/产物残留非预期的 import/)
    differs('import "server-only"\nexport const a = 1', 'var a = 1;')
    differs('"use server"\nexport const a = 1', 'var a = 1;')
  })

  it('命名空间：变量未在本区段声明 / 来自别的 require / 前缀对不上', () => {
    differs('import { sql } from "drizzle-orm"\nexport const q = sql`x`', 'var q = import_drizzle_orm999.sql`x`;')
    differs('import { sql } from "drizzle-orm"\nexport const q = sql`x`', 'var import_drizzle_orm1 = __toESM(require_zod(), 1);\nvar q = import_drizzle_orm1.sql`x`;')
    differs('import { sql } from "drizzle-orm"\nexport const q = sql`x`', 'var import_zod1 = __toESM(require_zod(), 1);\nvar q = import_zod1.sql`x`;')
    differs('import { sql } from "drizzle-orm"\nexport const q = sql`x`', 'var import_drizzle_orm1 = __toESM(require_drizzle_orm(), 1);\nvar q = import_drizzle_orm1.raw`x`;')
  })

  it('命名空间声明闭集：多出 / 缺少 / 重复；__toESM 形态不精确', () => {
    const source = 'import { sql } from "drizzle-orm"\nexport const q = sql`x`'
    const use = 'var q = import_drizzle_orm1.sql`x`;'
    const ok = 'var import_drizzle_orm1 = __toESM(require_drizzle_orm(), 1);\n'
    expect(compare(source, ok + use)).toEqual([])
    differs(source, ok + 'var import_zod1 = __toESM(require_zod(), 1);\n' + use)
    differs(source, ok + ok + use)
    // 源码确实用到 zod（未使用的导入会被 transpile / bun 一并省略，不算缺失），产物却没有它的命名空间声明
    expect(compare(
      'import { sql } from "drizzle-orm"\nimport { z } from "zod"\nexport const q = sql`x`\nexport const s = z',
      ok + use + '\nvar s = import_zod1;',
    ).join('\n')).toMatch(/namespaces: 源码导入的包 zod 在产物里没有对应/)
    expect(compare(source, ok + ok + use).join('\n')).toMatch(/命名空间变量重复声明/)
    expect(compare(source, ok + 'var import_zod1 = __toESM(require_zod(), 1);\n' + use).join('\n')).toMatch(/产物多出源码没有导入的命名空间声明/)
    differs(source, 'var import_drizzle_orm1 = __toESM(require_drizzle_orm(sideEffect), 1);\n' + use)
    differs(source, 'var import_drizzle_orm1 = __toESM(require_drizzle_orm(), 0);\n' + use)
    differs(source, 'var import_drizzle_orm1 = __toESM(require_drizzle_orm());\n' + use)
    // 两个包的导入顺序对调：require 执行顺序不同
    const two = 'import { sql } from "drizzle-orm"\nimport { z } from "zod"\nexport const q = [sql, z]'
    const zod = 'var import_zod1 = __toESM(require_zod(), 1);\n'
    const refs = 'var q = [import_drizzle_orm1.sql, import_zod1.z];'
    expect(compare(two, ok + zod + refs)).toEqual([])
    expect(compare(two, zod + ok + refs).join('\n')).toMatch(/命名空间声明顺序与源码导入顺序不同/)
    // 包名数字前缀歧义（foo / foo2）：一条声明同时对上两个包 → fail-closed
    expect(compare(
      'import { a } from "foo"\nimport { b } from "foo2"\nexport const q = [a, b]',
      'var import_foo21 = __toESM(require_foo2(), 1);\nvar import_foo2 = __toESM(require_foo(), 1);\nvar q = [import_foo2.a, import_foo21.b];',
    ).join('\n')).toMatch(/能同时对上多个包/)
  })

  it('(0, obj.method)() 丢 this、(0, eval)() 是间接 eval，都不等于直接调用', () => {
    differs('export function f(o: { m(): void }) { return o.m() }', 'function f(o) { return (0, o.m)(); }')
    differs('export function f(code: string) { return eval(code) }', 'function f(code) { return (0, eval)(code); }')
  })

  it('return undefined 中的 undefined 被遮蔽时不等于 return', () => {
    differs('export function f(undefined: number) { return undefined }', 'function f(undefined) { return; }')
  })

  it('带默认值的简写属性：默认值不同 / 形态不同', () => {
    differs('export function f(o: object) { let a; ({ a = 1 } = o as never); return a }', 'function f(o) { let a; ({ a = 2 } = o); return a; }')
    differs('export function f(o: object) { let a; ({ a = 1 } = o as never); return a }', 'function f(o) { let a; ({ a: a } = o); return a; }')
    // 键改名、默认值相同：局部绑定同步改名也不能掩盖读的是另一个属性
    differs('export function f(o: object) { let a; ({ a = 1 } = o as never); return a }', 'function f(o) { let b; ({ b = 1 } = o); return b; }')
  })

  it('私有名 / BigInt 不同', () => {
    differs('export class C { #x = 1; get() { return this.#x } }', 'class C { #y = 1; get() { return this.#y; } }')
    differs('export const n = 1n', 'var n = 2n;')
  })

  it('非序言位置的裸字符串语句是运行时语句，不能被当指令滤掉', () => {
    differs('export const a = 1\n"not a directive"', 'var a = 1;')
    differs('export const a = 1\n"x"', 'var a = 1;\n"y";')
  })

  it('内部模块的默认导入 / 命名空间导入尚未建模：明确抛错而不是报误导性的不等', () => {
    expect(() => compare('import x from "./helpers"\nexport const a = x', 'var a = helper;')).toThrow(/暂不支持内部模块的默认导入/)
    expect(() => compare('import * as h from "./helpers"\nexport const a = h.helper', 'var a = helper;')).toThrow(/暂不支持内部模块的命名空间导入/)
    // 带来源的再导出会加载依赖，不能当纯转导出滤掉
    expect(() => compare('export { helper } from "./helpers"\nexport const a = 1', 'var a = 1;')).toThrow(/暂不支持带来源的再导出/)
    expect(() => compare('export * from "./helpers"\nexport const a = 1', 'var a = 1;')).toThrow(/暂不支持带来源的再导出/)
    expect(() => compare('export default function f() { return 1 }', 'function f() { return 1; }')).toThrow(/暂不支持 export default/)
    expect(() => compare('const a = 1\nexport default a', 'var a = 1;')).toThrow(/暂不支持 export default/)
    expect(() => compare('export async function f() { return import("./helpers") }', 'async function f() { return Promise.resolve(); }')).toThrow(/暂不支持动态 import/)
    expect(() => compare('import { a } from "@scope/pkg"\nimport { b } from "scope_pkg"\nexport const q = [a, b]', 'var q = 1;')).toThrow(/暂不支持 slug 相同的两个包/)
    // 产物侧出现带来源的 export … from（bun 不会这样产出）同样不能被滤掉
    differs('export const a = 1', 'export { x } from "./dep";\nvar a = 1;')
  })

  it('两侧都提取不到运行时语句时抛错，而不是判等价', () => {
    expect(() => compare('import type { X } from "./helpers"', '')).toThrow(/提取不到运行时语句/)
  })
})
