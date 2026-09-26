/**
 * dist-equivalence 比较器自身的正反例（#360）。
 * 守护的价值取决于它「该绿的绿、该红的红」：bun 的每一种合法改写都要判等价，每一种真实漂移都要判不等。
 */
import { describe, expect, it } from 'vitest'
import { compareModuleRuntime } from './dist-equivalence'

/** 被导入模块在产物里的区段：只需声明出来的顶层名字 */
const SEGMENTS: Record<string, string> = {
  '@/db': 'var globalForDb, client, db2;\nvar init_db2 = __esm(() => {});',
  './helpers': 'var init_helpers = __esm(() => {});\nfunction helper(x) { return x }\nvar LIMIT = 5;',
  './other': 'function X2() {}',
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

  it('导入绑定加后缀（被导入模块确实声明了该名字）、命名空间导入、(0, f) 间接调用', () => {
    expect(compare(
      `import { db } from '@/db'
       import { sql } from 'drizzle-orm'
       import { helper } from './helpers'
       export async function q(id: string) { return db.execute(sql\`SELECT \${id}\`).then(helper) }`,
      `init_db2();
       init_helpers();
       var import_drizzle_orm60 = __toESM(require_drizzle_orm(), 1);
       async function q(id) { return db2.execute(import_drizzle_orm60.sql\`SELECT \${id}\`).then((0, helper)); }`,
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

  it('only：只比指定声明，两侧各恰好一处', () => {
    const only = (names: string[], distCode: string) => compareModuleRuntime({
      sourceCode: 'export const a = 1\nexport const b = 2',
      distCode,
      distSegmentOfImport: () => null,
      only: names,
    })
    expect(only(['b'], 'var a = 99;\nvar b2 = 2;')).toEqual([])
    expect(only(['b'], 'var b2 = 3;')).not.toEqual([])
    expect(() => only(['c'], 'var c = 1;')).toThrow(/源码里 c 的顶层声明找到 0 处/)
    expect(() => only(['b'], 'var a = 1;')).toThrow(/产物里 b 的顶层声明找到 0 处/)
    expect(() => only(['b'], 'var b = 2;\nvar b2 = 2;')).toThrow(/产物里 b 的顶层声明找到 2 处/)
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

  it('打包样板：漏调 / 多调 / 调错 init；副作用导入不同；指令不同', () => {
    const source = 'import { helper } from "./helpers"\nexport const a = helper(1)'
    differs(source, 'var a = helper(1);')
    differs(source, 'init_helpers();\ninit_db2();\nvar a = helper(1);')
    differs(source, 'init_helper();\nvar a = helper(1);')
    differs('import "server-only"\nexport const a = 1', 'var a = 1;')
    differs('"use server"\nexport const a = 1', 'var a = 1;')
  })

  it('命名空间：变量未在本区段声明 / 来自别的 require / 前缀对不上', () => {
    differs('import { sql } from "drizzle-orm"\nexport const q = sql`x`', 'var q = import_drizzle_orm999.sql`x`;')
    differs('import { sql } from "drizzle-orm"\nexport const q = sql`x`', 'var import_drizzle_orm1 = __toESM(require_zod(), 1);\nvar q = import_drizzle_orm1.sql`x`;')
    differs('import { sql } from "drizzle-orm"\nexport const q = sql`x`', 'var import_zod1 = __toESM(require_zod(), 1);\nvar q = import_zod1.sql`x`;')
    differs('import { sql } from "drizzle-orm"\nexport const q = sql`x`', 'var import_drizzle_orm1 = __toESM(require_drizzle_orm(), 1);\nvar q = import_drizzle_orm1.raw`x`;')
  })

  it('(0, obj.method)() 丢 this，不等于 obj.method()', () => {
    differs('export function f(o: { m(): void }) { return o.m() }', 'function f(o) { return (0, o.m)(); }')
  })

  it('return undefined 中的 undefined 被遮蔽时不等于 return', () => {
    differs('export function f(undefined: number) { return undefined }', 'function f(undefined) { return; }')
  })

  it('带默认值的简写属性：默认值不同 / 形态不同', () => {
    differs('export function f(o: object) { let a; ({ a = 1 } = o as never); return a }', 'function f(o) { let a; ({ a = 2 } = o); return a; }')
    differs('export function f(o: object) { let a; ({ a = 1 } = o as never); return a }', 'function f(o) { let a; ({ a: a } = o); return a; }')
  })

  it('顶层 const 在声明前被引用时，与 var 不等价（TDZ 抛错 vs undefined）', () => {
    differs('export function f() { return A }\nconst probe = f()\nconst A = 1', 'function f() { return A; }\nvar probe = f();\nvar A = 1;')
  })

  it('私有名 / BigInt 不同', () => {
    differs('export class C { #x = 1; get() { return this.#x } }', 'class C { #y = 1; get() { return this.#y; } }')
    differs('export const n = 1n', 'var n = 2n;')
  })

  it('两侧都提取不到运行时语句时抛错，而不是判等价', () => {
    expect(() => compare('import type { X } from "./helpers"', '')).toThrow(/提取不到运行时语句/)
  })
})
