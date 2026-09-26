/**
 * 源码模块 ↔ dist/export-worker.mjs 里 bun 改写后的同一模块：**语义等价**比较（测试专用，#360）。
 *
 * 为什么不比文本：bun 会改写 JS（去类型 / 注释、单双引号、分号、尾逗号、`if (…) x` 拆行、冗余括号、
 * 局部变量与导入绑定加数字后缀、第三方包改成 `import_xxxN.name` 命名空间访问）。逐行文本归一要么漏报要么误红
 * （#360 codex / GLM round-2~6 连续命中）。这里改为：两侧解析成 AST，用 TypeScript checker 做**符号解析**，
 * 同步遍历、逐节点配对比较。
 *
 * 等价规则（全部按「绑定」而不是按文本）：
 *   - 局部绑定（函数内声明的参数 / 变量 / 内层函数）：按**符号身份**建双向映射，名字可以不同，
 *     但对应关系必须一一且全程一致 —— 变量遮蔽、多个同名回调参数都各自独立；
 *   - 本模块顶层声明：名字须为 `X` 或 `X\d+`，且双向一一对应；
 *   - 内部模块导入：产物名须为「导入名」或「导入名 + 数字」，且**被导入模块在产物里确实声明了这个名字**；
 *   - 第三方包导入：产物里的 `import_pkgN` 须由本模块区段 `var import_pkgN = __toESM(require_pkg(), 1)` 声明、
 *     且 `require_` 名与包名对应、一一对应；具名导入 ↔ `import_pkgN.name`，命名空间导入 ↔ `import_pkgN`；
 *   - 全局 / 未解析名（Number、undefined …）：文本相同；属性名、私有名：文本相同；
 *   - 字面量逐值比较；**模板字面量比原文（rawText）** —— SQL 里多一个分号、少一个逗号、改一行 `--` 注释都算不等；
 *   - 运算符逐个比较（一元运算符不是子节点，单独比）。
 *
 * 已知等价形态（只在确认安全的范围内归一）：
 *   - `(…)` 透明；产物侧 `(0, import_pkgN.f)` ≡ `f`（只限命名空间成员 —— `(0, obj.m)` 丢 this、`(0, eval)` 是间接 eval，不归一）；
 *   - `return undefined` ≡ `return`（仅当 `undefined` 是未被遮蔽的全局名）；
 *   - 无替换模板 ≡ 同文字符串；`{ a }` ≡ `{ a: a }`（有默认值 `{ a = 1 }` 时两侧须同为简写且默认值等价）；
 *   - 顶层 `const` / `let` ≡ `var`：仅当没有引用会在它**初始化完成之前被执行**（按急切执行分析，保守；否则 TDZ 与 undefined 行为不同）。
 *
 * 打包样板单独核对（保序），不是简单忽略：
 *   - 产物 `init_x()` 调用序列 ≡ 按源码导入顺序推出的各内部模块 `init_x` 序列（漏调、多调、重复、顺序不同都算不等）；
 *   - 第三方包：源码运行时导入的每个包 ↔ 产物恰好一条 `__toESM(require_<包>(), 1)` 声明（多、缺、重复都算不等）；
 *   - 副作用导入 `import "x"` 的序列两侧相同；`"use server"` 等指令两侧相同。
 */
import ts from 'typescript'

export interface ModuleSides {
  /** 源码全文（TS） */
  sourceCode: string
  /** 产物里该模块的区段全文（可能被别的模块切成多段，拼接后传入；需保留原始缩进） */
  distCode: string
  /** 源码 import 说明符 → 被导入模块在产物里的区段全文；第三方包返回 null */
  distSegmentOfImport: (specifier: string) => string | null
  /**
   * 只比这些顶层声明（按源码名；产物侧按「源码名或源码名 + 数字」匹配）。缺省 = 全部运行时顶层语句。
   * 用于大模块（如 registry.ts）里只守护某一段；给了名字却在任一侧找不到恰好一处时抛错。
   * 给了 only 时不核对打包样板（init / 副作用导入 / 指令）—— 那是整模块层面的事。
   */
  only?: readonly string[]
}

interface Bound {
  sourceFile: ts.SourceFile
  checker: ts.TypeChecker
}

function bind(fileName: string, code: string, fromTs: boolean): Bound {
  const text = fromTs
    ? ts.transpileModule(code, {
      compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, removeComments: true },
    }).outputText
    : code
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const options: ts.CompilerOptions = { allowJs: true, noResolve: true, noLib: true, types: [] }
  const host = ts.createCompilerHost(options)
  host.getSourceFile = (name) => (name === fileName ? sourceFile : undefined)
  host.fileExists = (name) => name === fileName
  host.readFile = (name) => (name === fileName ? text : undefined)
  const program = ts.createProgram([fileName], options, host)
  return { sourceFile: program.getSourceFile(fileName)!, checker: program.getTypeChecker() }
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const isRenamedFrom = (renamed: string, original: string) =>
  renamed === original || new RegExp(`^${escapeRegExp(original)}\\d+$`).test(renamed)

/** 包名 → bun 的命名空间变量前缀与 require 函数名：drizzle-orm → import_drizzle_orm / require_drizzle_orm */
const packageSlug = (specifier: string) => specifier.replace(/^@/, '').replace(/[^A-Za-z0-9]/g, '_')
const isBareSpecifier = (specifier: string) => !specifier.startsWith('.') && !specifier.startsWith('@/') && !specifier.startsWith('@db/')

const isDirective = (statement: ts.Statement) =>
  ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression)

/** 产物侧 `init_x()` */
const initCallName = (statement: ts.Statement): string | null => {
  if (!ts.isExpressionStatement(statement)) return null
  const expression = statement.expression
  return ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)
    && /^init_/.test(expression.expression.text) && expression.arguments.length === 0
    ? expression.expression.text
    : null
}

/** 产物侧 `var import_x = __toESM(require_y(), 1)` → [import_x, require_y] */
const namespaceDeclaration = (statement: ts.Statement): [string, string] | null => {
  if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) return null
  const [declaration] = statement.declarationList.declarations
  const init = declaration.initializer
  if (
    !ts.isIdentifier(declaration.name) || !/^import_/.test(declaration.name.text)
    || !init || !ts.isCallExpression(init) || !ts.isIdentifier(init.expression) || init.expression.text !== '__toESM'
  ) return null
  // 精确形态：__toESM(require_x(), 1) —— 恰两个参数、第二个是字面量 1、require_x 零参数
  if (init.arguments.length !== 2) return null
  const [required, flag] = init.arguments
  if (!ts.isNumericLiteral(flag) || flag.text !== '1') return null
  if (
    !ts.isCallExpression(required) || !ts.isIdentifier(required.expression)
    || !/^require_/.test(required.expression.text) || required.arguments.length !== 0
  ) return null
  return [declaration.name.text, required.expression.text]
}

/** 模块区段的顶层声明名（`var a, b;` / `function f` / `class C`） */
function topLevelDeclaredNames(code: string): Set<string> {
  const sourceFile = ts.createSourceFile('segment.js', code, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS)
  const names = new Set<string>()
  for (const statement of sourceFile.statements) {
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
      names.add(statement.name.text)
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text)
      }
    }
  }
  return names
}

type Ref =
  | { kind: 'local'; symbol: ts.Symbol }
  | { kind: 'own'; name: string; symbol: ts.Symbol }
  | { kind: 'import'; specifier: string; imported: string }
  | { kind: 'namespace'; specifier: string }
  | { kind: 'global'; name: string }

class Comparator {
  readonly issues: string[] = []
  private readonly localSrcToDist = new Map<ts.Symbol, ts.Symbol>()
  private readonly localDistToSrc = new Map<ts.Symbol, ts.Symbol>()
  private readonly nameSrcToDist = new Map<string, string>()
  private readonly nameDistToSrc = new Map<string, string>()
  private readonly segmentCache = new Map<string, { names: Set<string>; inits: Set<string> } | null>()

  constructor(
    private readonly src: Bound,
    private readonly dist: Bound,
    private readonly distSegmentOfImport: ModuleSides['distSegmentOfImport'],
    /** 产物区段里的 import_x → require_y */
    private readonly distNamespaces: Map<string, string>,
  ) {}

  fail(path: string, message: string) {
    if (this.issues.length < 20) this.issues.push(`${path}: ${message}`)
  }

  /** 被导入模块在产物里的声明（不含 init_ 名）与 init_ 名；区段缺失返回 null */
  importSegment(specifier: string): { names: Set<string>; inits: Set<string> } | null {
    if (!this.segmentCache.has(specifier)) {
      const segment = this.distSegmentOfImport(specifier)
      if (segment == null || segment.trim() === '') {
        this.segmentCache.set(specifier, null)
      } else {
        const all = topLevelDeclaredNames(segment)
        const inits = new Set([...all].filter((name) => /^init_/.test(name)))
        const names = new Set([...all].filter((name) => !/^init_/.test(name)))
        this.segmentCache.set(specifier, { names, inits })
      }
    }
    return this.segmentCache.get(specifier)!
  }

  private classify(side: Bound, identifier: ts.Identifier): Ref {
    const symbol = ts.isShorthandPropertyAssignment(identifier.parent) && identifier.parent.name === identifier
      ? side.checker.getShorthandAssignmentValueSymbol(identifier.parent)
      : side.checker.getSymbolAtLocation(identifier)
    const declaration = symbol?.declarations?.[0]
    if (!symbol || !declaration || declaration.getSourceFile() !== side.sourceFile) {
      return { kind: 'global', name: identifier.text }
    }
    const specifierOf = (node: { moduleSpecifier: ts.Expression }) => (node.moduleSpecifier as ts.StringLiteral).text
    if (ts.isImportSpecifier(declaration)) {
      return {
        kind: 'import',
        specifier: specifierOf(declaration.parent.parent.parent),
        imported: (declaration.propertyName ?? declaration.name).text,
      }
    }
    if (ts.isImportClause(declaration)) return { kind: 'import', specifier: specifierOf(declaration.parent), imported: 'default' }
    if (ts.isNamespaceImport(declaration)) return { kind: 'namespace', specifier: specifierOf(declaration.parent.parent) }
    // 顶层声明 = 声明节点到 SourceFile 之间没有函数 / 类边界
    let cursor: ts.Node | undefined = declaration.parent
    while (cursor && !ts.isSourceFile(cursor)) {
      if (ts.isFunctionLike(cursor) || ts.isClassLike(cursor)) return { kind: 'local', symbol }
      cursor = cursor.parent
    }
    return { kind: 'own', name: identifier.text, symbol }
  }

  private pairNames(path: string, srcName: string, distName: string) {
    const mapped = this.nameSrcToDist.get(srcName)
    const reverse = this.nameDistToSrc.get(distName)
    if ((mapped !== undefined && mapped !== distName) || (reverse !== undefined && reverse !== srcName)) {
      this.fail(path, `绑定对应不一致：源码 ${srcName} ↔ 产物 ${distName}（此前 ${srcName}↔${mapped ?? '∅'} / ${reverse ?? '∅'}↔${distName}）`)
      return
    }
    this.nameSrcToDist.set(srcName, distName)
    this.nameDistToSrc.set(distName, srcName)
  }

  /** 第三方包命名空间变量核实：须由本区段 `__toESM(require_<包>())` 声明，并与包一一对应 */
  private checkNamespaceBase(path: string, specifier: string, base: string): boolean {
    const slug = packageSlug(specifier)
    if (!isRenamedFrom(base, `import_${slug}`)) {
      this.fail(path, `命名空间变量不对应：源码包 ${specifier} / 产物 ${base}`)
      return false
    }
    const required = this.distNamespaces.get(base)
    if (!required) {
      this.fail(path, `产物里的 ${base} 没有在本模块区段以 __toESM(require_…) 声明`)
      return false
    }
    if (!isRenamedFrom(required, `require_${slug}`)) {
      this.fail(path, `产物里的 ${base} 来自 ${required}，不是包 ${specifier}`)
      return false
    }
    this.pairNames(path, `ns:${specifier}`, base)
    return true
  }

  private compareIdentifier(path: string, srcId: ts.Identifier, distId: ts.Identifier) {
    const a = this.classify(this.src, srcId)
    const b = this.classify(this.dist, distId)
    if (a.kind === 'local' && b.kind === 'local') {
      const mapped = this.localSrcToDist.get(a.symbol)
      const reverse = this.localDistToSrc.get(b.symbol)
      if ((mapped && mapped !== b.symbol) || (reverse && reverse !== a.symbol)) {
        this.fail(path, `局部绑定对应不一致：源码 ${srcId.text} ↔ 产物 ${distId.text}`)
        return
      }
      this.localSrcToDist.set(a.symbol, b.symbol)
      this.localDistToSrc.set(b.symbol, a.symbol)
      return
    }
    if (a.kind === 'own' && b.kind === 'own') {
      if (!isRenamedFrom(b.name, a.name)) this.fail(path, `模块内绑定不同：源码 ${a.name} / 产物 ${b.name}`)
      else this.pairNames(path, `own:${a.name}`, b.name)
      return
    }
    if (a.kind === 'namespace' && (b.kind === 'own' || b.kind === 'global')) {
      this.checkNamespaceBase(path, a.specifier, distId.text)
      return
    }
    if (a.kind === 'import' && (b.kind === 'global' || b.kind === 'own')) {
      const distName = b.name
      if (isBareSpecifier(a.specifier)) {
        this.fail(path, `第三方包 ${a.specifier} 的 ${a.imported} 在产物里应为 import_…${a.imported} 命名空间访问，实为 ${distName}`)
        return
      }
      if (!isRenamedFrom(distName, a.imported)) {
        this.fail(path, `导入绑定不同：源码 ${a.imported}（from ${a.specifier}）/ 产物 ${distName}`)
        return
      }
      const segment = this.importSegment(a.specifier)
      if (!segment) {
        this.fail(path, `找不到 ${a.specifier} 在产物里的模块区段（区段缺失，不是声明核实失败）`)
        return
      }
      if (!segment.names.has(distName)) {
        this.fail(path, `产物里的 ${distName} 不是 ${a.specifier} 声明的（源码导入 ${a.imported}）`)
        return
      }
      this.pairNames(path, `import:${a.specifier}:${a.imported}`, distName)
      return
    }
    if (a.kind === 'global' && b.kind === 'global') {
      if (a.name !== b.name) this.fail(path, `全局名不同：${a.name} / ${b.name}`)
      return
    }
    this.fail(path, `绑定类别不同：源码 ${srcId.text}(${a.kind}) / 产物 ${distId.text}(${b.kind})`)
  }

  /** `import_pkgN.name`：base 是本区段声明过的命名空间变量 */
  private namespaceMember(node: ts.Node): { base: string; name: string } | null {
    if (!ts.isPropertyAccessExpression(node) || !ts.isIdentifier(node.expression)) return null
    return this.distNamespaces.has(node.expression.text) ? { base: node.expression.text, name: node.name.text } : null
  }

  private normalize(node: ts.Node, side: 'src' | 'dist'): ts.Node {
    let current = node
    for (;;) {
      if (ts.isParenthesizedExpression(current)) {
        current = current.expression
        continue
      }
      // 产物侧 (0, import_pkgN.f)：bun 对命名空间成员调用生成的去 this 形态。只归一命名空间成员 ——
      // (0, obj.m) 会丢 this、(0, eval) 是间接 eval，语义都不同，不归一
      if (
        side === 'dist'
        && ts.isBinaryExpression(current)
        && current.operatorToken.kind === ts.SyntaxKind.CommaToken
        && ts.isNumericLiteral(current.left)
        && current.left.text === '0'
        && this.namespaceMember(current.right)
      ) {
        current = current.right
        continue
      }
      return current
    }
  }

  private children(node: ts.Node): ts.Node[] {
    const out: ts.Node[] = []
    ts.forEachChild(node, (child) => {
      if (child.kind === ts.SyntaxKind.ExportKeyword || child.kind === ts.SyntaxKind.DeclareKeyword) return
      out.push(child)
    })
    return out
  }

  private isReturnUndefined(side: Bound, node: ts.Node) {
    if (!ts.isReturnStatement(node)) return false
    if (!node.expression) return true
    // 只认未被遮蔽的全局 undefined
    return ts.isIdentifier(node.expression) && node.expression.text === 'undefined'
      && this.classify(side, node.expression).kind === 'global'
  }

  private stringValue(node: ts.Node): string | null {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
    return null
  }

  compare(path: string, rawSrc: ts.Node, rawDist: ts.Node, topLevel = false) {
    if (this.issues.length >= 20) return
    const srcNode = this.normalize(rawSrc, 'src')
    const distNode = this.normalize(rawDist, 'dist')

    // 源码第三方具名导入 / 默认导入的引用 ↔ 产物 import_pkgN.name
    const member = this.namespaceMember(distNode)
    if (member && ts.isIdentifier(srcNode)) {
      const ref = this.classify(this.src, srcNode)
      if (ref.kind !== 'import' || !isBareSpecifier(ref.specifier) || ref.imported !== member.name) {
        this.fail(path, `命名空间成员不同：源码 ${srcNode.text} / 产物 ${distNode.getText()}`)
        return
      }
      this.checkNamespaceBase(path, ref.specifier, member.base)
      return
    }

    if (this.isReturnUndefined(this.src, srcNode) && this.isReturnUndefined(this.dist, distNode)) return

    const srcString = this.stringValue(srcNode)
    const distString = this.stringValue(distNode)
    if (srcString !== null || distString !== null) {
      if (srcString !== distString) this.fail(path, `字符串不同：${JSON.stringify(srcString)} / ${JSON.stringify(distString)}`)
      return
    }

    // { a } ≡ { a: a }；带默认值的简写须两侧都是简写且默认值等价
    if (ts.isShorthandPropertyAssignment(srcNode) || ts.isShorthandPropertyAssignment(distNode)) {
      const initializerOf = (node: ts.Node) => (ts.isShorthandPropertyAssignment(node) ? node.objectAssignmentInitializer : undefined)
      const srcInit = initializerOf(srcNode)
      const distInit = initializerOf(distNode)
      if (srcInit || distInit) {
        if (!srcInit || !distInit || !ts.isShorthandPropertyAssignment(srcNode) || !ts.isShorthandPropertyAssignment(distNode)) {
          this.fail(path, `带默认值的简写属性形态不同：${srcNode.getText()} / ${distNode.getText()}`)
          return
        }
        // 简写的名字同时是属性键：键必须逐字相同（绑定同步改名也不能掩盖读的是另一个属性）
        if (srcNode.name.text !== distNode.name.text) {
          this.fail(path, `简写属性键不同：${srcNode.name.text} / ${distNode.name.text}`)
          return
        }
        this.compareIdentifier(`${path}.${srcNode.name.text}`, srcNode.name, distNode.name)
        this.compare(`${path}.${srcNode.name.text}=`, srcInit, distInit)
        return
      }
      const key = (node: ts.Node) => (ts.isShorthandPropertyAssignment(node) || ts.isPropertyAssignment(node)) && ts.isIdentifier(node.name) ? node.name.text : null
      const value = (node: ts.Node) => (ts.isShorthandPropertyAssignment(node) ? node.name : ts.isPropertyAssignment(node) ? node.initializer : null)
      const srcValue = value(srcNode)
      const distValue = value(distNode)
      if (key(srcNode) === null || key(srcNode) !== key(distNode) || !srcValue || !distValue) {
        this.fail(path, `对象属性不同：${srcNode.getText()} / ${distNode.getText()}`)
        return
      }
      this.compare(`${path}.${key(srcNode)}`, srcValue, distValue)
      return
    }

    if (srcNode.kind !== distNode.kind) {
      this.fail(path, `节点类型不同：${ts.SyntaxKind[srcNode.kind]} / ${ts.SyntaxKind[distNode.kind]}（${srcNode.getText().slice(0, 80)} ｜ ${distNode.getText().slice(0, 80)}）`)
      return
    }

    if (ts.isPrivateIdentifier(srcNode) && ts.isPrivateIdentifier(distNode)) {
      if (srcNode.text !== distNode.text) this.fail(path, `私有名不同：${srcNode.text} / ${distNode.text}`)
      return
    }
    if (ts.isIdentifier(srcNode) && ts.isIdentifier(distNode)) {
      const parent = srcNode.parent
      const isPropertyName = (ts.isPropertyAccessExpression(parent) && parent.name === srcNode)
        || ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isGetAccessor(parent)
          || ts.isSetAccessor(parent) || ts.isPropertyDeclaration(parent)) && parent.name === srcNode)
        || (ts.isBindingElement(parent) && parent.propertyName === srcNode)
      if (isPropertyName) {
        if (srcNode.text !== distNode.text) this.fail(path, `属性名不同：${srcNode.text} / ${distNode.text}`)
        return
      }
      this.compareIdentifier(path, srcNode, distNode)
      return
    }
    if (ts.isNumericLiteral(srcNode) && ts.isNumericLiteral(distNode)) {
      if (Number(srcNode.text) !== Number(distNode.text)) this.fail(path, `数字不同：${srcNode.text} / ${distNode.text}`)
      return
    }
    if (ts.isBigIntLiteral(srcNode) && ts.isBigIntLiteral(distNode)) {
      const value = (text: string) => BigInt(text.replace(/_/g, '').replace(/n$/, ''))
      if (value(srcNode.text) !== value(distNode.text)) this.fail(path, `BigInt 不同：${srcNode.text} / ${distNode.text}`)
      return
    }
    if (ts.isRegularExpressionLiteral(srcNode) && ts.isRegularExpressionLiteral(distNode)) {
      if (srcNode.text !== distNode.text) this.fail(path, `正则不同：${srcNode.text} / ${distNode.text}`)
      return
    }
    if (ts.isTemplateLiteralToken(srcNode) && ts.isTemplateLiteralToken(distNode)) {
      if ((srcNode.rawText ?? srcNode.text) !== (distNode.rawText ?? distNode.text)) {
        this.fail(path, `模板原文不同：${JSON.stringify(srcNode.rawText)} / ${JSON.stringify(distNode.rawText)}`)
      }
      return
    }
    if ((ts.isPrefixUnaryExpression(srcNode) && ts.isPrefixUnaryExpression(distNode))
      || (ts.isPostfixUnaryExpression(srcNode) && ts.isPostfixUnaryExpression(distNode))) {
      const distOperator = (distNode as typeof srcNode).operator
      if (srcNode.operator !== distOperator) {
        this.fail(path, `一元运算符不同：${ts.tokenToString(srcNode.operator)} / ${ts.tokenToString(distOperator)}`)
        return
      }
    }
    if (ts.isVariableDeclarationList(srcNode) && ts.isVariableDeclarationList(distNode)) {
      const kind = (node: ts.VariableDeclarationList) => node.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)
      if (kind(srcNode) !== kind(distNode)) {
        if (!topLevel || kind(distNode) !== 0) {
          this.fail(path, '变量声明种类不同（let / const / var）')
        } else {
          this.checkTopLevelVarSafe(path, srcNode)
        }
      }
    }

    const srcChildren = this.children(srcNode)
    const distChildren = this.children(distNode)
    if (srcChildren.length !== distChildren.length) {
      this.fail(path, `子节点数不同：${ts.SyntaxKind[srcNode.kind]} ${srcChildren.length} / ${distChildren.length}（${srcNode.getText().slice(0, 80)} ｜ ${distNode.getText().slice(0, 80)}）`)
      return
    }
    const nextTopLevel = topLevel && (ts.isVariableStatement(srcNode) || ts.isVariableDeclarationList(srcNode))
    srcChildren.forEach((child, index) => {
      this.compare(`${path}/${ts.SyntaxKind[child.kind]}`, child, distChildren[index], nextTopLevel)
    })
  }

  /** 源码模块里「急切执行」到的标识符引用及其执行时刻（按源码位置近似顶层执行顺序），见 checkTopLevelVarSafe */
  private eagerReferences?: Array<{ node: ts.Identifier; time: number }>

  /**
   * 近似模块顶层的执行时序：
   *   - 顶层语句按书写顺序执行，引用的执行时刻 = 它自己的位置；
   *   - 函数体延后执行，不算；
   *   - 但被急切调用的本地函数（函数声明 / 以函数初始化的变量 / 别名链），以及**传给任何调用的回调**（保守：
   *     不知道被调方会不会同步调用它，一律按「在调用点执行」处理），其函数体在调用点时刻执行（可传递）；
   *   - 调用了解析不出、且**可能持有本地可调用对象**的本地绑定（如装了本地函数的对象上的方法）：fail-closed，
   *     本模块全部函数视为在调用点执行。只装字面量 / 导入 / 全局值的常量表上的方法调用不触发。
   * 宁可误红不可漏报：不能证明延后执行的，都按急切执行算。
   */
  private collectEagerReferences() {
    if (this.eagerReferences) return this.eagerReferences
    const references: Array<{ node: ts.Identifier; time: number }> = []
    const executedAt = new Map<ts.Node, number>()
    const checker = this.src.checker
    const isOwnDeclaration = (declaration: ts.Declaration | undefined) =>
      !!declaration && declaration.getSourceFile() === this.src.sourceFile
      && !ts.isImportSpecifier(declaration) && !ts.isImportClause(declaration) && !ts.isNamespaceImport(declaration)
    /**
     * 本地绑定「可能持有本地可调用对象」：初始化值里（递归追溯引用的本地绑定）出现函数字面量或本地函数。
     * 只装字面量 / 导入值 / 全局值的数组、对象（如字符串常量表）不会让调用落回本模块函数。
     */
    const mayHoldLocalCallable = (declaration: ts.Declaration, seen: Set<ts.Node>): boolean => {
      if (seen.has(declaration)) return false
      seen.add(declaration)
      if (ts.isFunctionDeclaration(declaration) || ts.isClassDeclaration(declaration)) return true
      if (!ts.isVariableDeclaration(declaration)) return false // 参数等：外部传入
      if (!declaration.initializer) return false
      let found = false
      const scan = (node: ts.Node) => {
        if (found) return
        if (ts.isFunctionLike(node) || ts.isClassExpression(node)) {
          found = true
          return
        }
        if (ts.isIdentifier(node)) {
          const target = checker.getSymbolAtLocation(node)?.declarations?.[0]
          if (target && isOwnDeclaration(target) && target !== declaration && mayHoldLocalCallable(target, seen)) found = true
        }
        ts.forEachChild(node, scan)
      }
      scan(declaration.initializer)
      return found
    }
    /**
     * 被调用表达式 → 本地函数：函数字面量、函数声明、以函数初始化的变量，以及**别名链**
     * （const alias = read / const alias = other_alias）。返回 'unknown-local' 表示它是本模块的绑定
     * （或本地绑定上的属性）但解析不出具体函数 —— 调用方据此 fail-closed。
     */
    const localFunction = (callee: ts.Expression, seen = new Set<ts.Node>()): ts.SignatureDeclaration | 'unknown-local' | undefined => {
      let target: ts.Expression = callee
      while (ts.isParenthesizedExpression(target)) target = target.expression
      if (ts.isArrowFunction(target) || ts.isFunctionExpression(target)) return target
      if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
        let root: ts.Expression = target
        while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)) root = root.expression
        const rootDeclaration = ts.isIdentifier(root) ? checker.getSymbolAtLocation(root)?.declarations?.[0] : undefined
        return isOwnDeclaration(rootDeclaration) && mayHoldLocalCallable(rootDeclaration!, new Set()) ? 'unknown-local' : undefined
      }
      if (!ts.isIdentifier(target)) return undefined
      const declaration = checker.getSymbolAtLocation(target)?.declarations?.[0]
      if (!isOwnDeclaration(declaration) || seen.has(declaration!)) return seen.has(declaration!) ? 'unknown-local' : undefined
      seen.add(declaration!)
      if (ts.isFunctionDeclaration(declaration!)) return declaration
      if (ts.isVariableDeclaration(declaration!) && declaration.initializer) {
        const init = declaration.initializer
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init
        if (ts.isIdentifier(init) || ts.isParenthesizedExpression(init)) {
          return localFunction(init, seen) ?? (mayHoldLocalCallable(declaration!, new Set()) ? 'unknown-local' : undefined)
        }
      }
      if (ts.isParameter(declaration!)) return undefined // 参数：外部传入，按未知外部可调用处理（回调参数另行保守处理）
      return mayHoldLocalCallable(declaration!, new Set()) ? 'unknown-local' : undefined
    }
    /** 本模块全部函数（fail-closed 时整体视为在某时刻执行） */
    const allLocalFunctions: ts.SignatureDeclaration[] = []
    const collectFunctions = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
        || ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)) {
        allLocalFunctions.push(node)
      }
      ts.forEachChild(node, collectFunctions)
    }
    collectFunctions(this.src.sourceFile)
    const run = (fn: ts.SignatureDeclaration, time: number) => {
      const previous = executedAt.get(fn)
      if (previous !== undefined && previous <= time) return
      executedAt.set(fn, time)
      const body = (fn as ts.FunctionLikeDeclaration).body
      if (body) visit(body, time)
    }
    const visit = (node: ts.Node, inherited: number | null) => {
      const time = inherited ?? node.getStart()
      if (ts.isFunctionLike(node)) return // 延后执行，除非被 run 显式执行
      if (ts.isIdentifier(node)) references.push({ node, time })
      ts.forEachChild(node, (child) => visit(child, inherited))
      if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node)) {
        const callee = ts.isTaggedTemplateExpression(node) ? node.tag : node.expression
        const invoke = (target: ReturnType<typeof localFunction>) => {
          if (target === 'unknown-local') {
            // 调用了解析不出的本地可调用对象：保守认为本模块任何函数都可能在此刻执行
            for (const fn of allLocalFunctions) run(fn, time)
          } else if (target) {
            run(target, time)
          }
        }
        invoke(localFunction(callee))
        const args = ts.isTaggedTemplateExpression(node) ? [] : node.arguments ?? []
        for (const argument of args) invoke(localFunction(argument))
      }
    }
    for (const statement of this.src.sourceFile.statements) visit(statement, null)
    this.eagerReferences = references
    return references
  }

  /**
   * 顶层 const/let → var 只在没有 TDZ 期执行的引用时等价：对每个声明项，任何在**该声明项初始化完成之前
   * 被执行**的引用（声明之前的顶层代码、自身初始化器、初始化期间被调用的本地函数 / 回调里的引用）
   * 都会让 const 抛 ReferenceError 而 var 读到 undefined。延后执行的引用（如 `const A = () => A`）不算。
   */
  private checkTopLevelVarSafe(path: string, list: ts.VariableDeclarationList) {
    const guarded = new Map<ts.Symbol, ts.VariableDeclaration>()
    for (const declaration of list.declarations) {
      if (!ts.isIdentifier(declaration.name)) {
        this.fail(path, '顶层解构声明的 const / let → var 不做等价归一')
        return
      }
      const symbol = this.src.checker.getSymbolAtLocation(declaration.name)
      if (symbol) guarded.set(symbol, declaration)
    }
    for (const { node, time } of this.collectEagerReferences()) {
      const symbol = this.src.checker.getSymbolAtLocation(node)
      const declaration = symbol ? guarded.get(symbol) : undefined
      if (declaration && node !== declaration.name && time < declaration.getEnd()) {
        this.fail(path, `顶层 ${node.text} 可能在初始化完成之前被执行读取，const/let → var 不等价`)
        return
      }
    }
  }
}

function statementLabel(statement: ts.Statement): string {
  if (ts.isFunctionDeclaration(statement) && statement.name) return statement.name.text
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.map((item) => item.name.getText()).join(',')
  }
  return ts.SyntaxKind[statement.kind]
}

/**
 * 第三方包的副作用导入 `import "pkg"`，保持源码顺序（bun 原样保留它们，并与 init 调用交错；
 * 内部模块的副作用导入会被降为 init_x()，已并入 init 序列核对）
 */
const sideEffectImports = (statements: readonly ts.Statement[]) => statements
  .filter((statement): statement is ts.ImportDeclaration => ts.isImportDeclaration(statement) && !statement.importClause)
  .map((statement) => (statement.moduleSpecifier as ts.StringLiteral).text)
  .filter(isBareSpecifier)

const directives = (statements: readonly ts.Statement[]) => statements
  .filter(isDirective)
  .map((statement) => ((statement as ts.ExpressionStatement).expression as ts.StringLiteral).text)
  .sort()

/**
 * 比较一个模块的运行时代码。返回不等价之处（空数组 = 等价）。
 * 提取不到任何运行时语句时抛错（两侧都空不能当成等价）。
 */
export function compareModuleRuntime(sides: ModuleSides): string[] {
  const src = bind('source.js', sides.sourceCode, true)
  const dist = bind('dist.js', sides.distCode, false)

  const distNamespaces = new Map<string, string>()
  const namespaceDeclarations: Array<[string, string]> = []
  const distInits: string[] = []
  for (const statement of dist.sourceFile.statements) {
    const namespace = namespaceDeclaration(statement)
    if (namespace) {
      namespaceDeclarations.push(namespace)
      distNamespaces.set(namespace[0], namespace[1])
    }
    const init = initCallName(statement)
    if (init) distInits.push(init)
  }
  const comparator = new Comparator(src, dist, sides.distSegmentOfImport, distNamespaces)

  let srcStatements = src.sourceFile.statements
    .filter((statement) => !ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement) && !isDirective(statement))
  let distStatements = dist.sourceFile.statements
    .filter((statement) => !ts.isImportDeclaration(statement) && !isDirective(statement)
      && !initCallName(statement) && !namespaceDeclaration(statement))

  if (sides.only) {
    const declares = (statement: ts.Statement, name: string, allowSuffix: boolean) => {
      const matches = (declared: string) => (allowSuffix ? isRenamedFrom(declared, name) : declared === name)
      if (ts.isFunctionDeclaration(statement) && statement.name) return matches(statement.name.text)
      return ts.isVariableStatement(statement) && statement.declarationList.declarations
        .some((item) => ts.isIdentifier(item.name) && matches(item.name.text))
    }
    const pick = (statements: readonly ts.Statement[], allowSuffix: boolean, side: string) => sides.only!.map((name) => {
      const found = statements.filter((statement) => declares(statement, name, allowSuffix))
      if (found.length !== 1) throw new Error(`${side}里 ${name} 的顶层声明找到 ${found.length} 处（应恰为 1）`)
      return found[0]
    })
    srcStatements = pick(srcStatements, false, '源码')
    distStatements = pick(distStatements, true, '产物')
  } else {
    // 打包样板核对（保序）：init 调用序列、第三方命名空间声明闭集、副作用导入序列、指令
    // 单遍按源码导入顺序：内部模块（无论具名导入还是副作用导入 import "./x"）原位追加它在产物里声明的 init；
    // 第三方包：有绑定的进命名空间闭集，副作用导入 import "pkg" 原样保留、单独比较序列
    const expectedInits: string[] = []
    const expectedPackages: string[] = []
    for (const statement of src.sourceFile.statements) {
      if (!ts.isImportDeclaration(statement)) continue
      const specifier = (statement.moduleSpecifier as ts.StringLiteral).text
      if (isBareSpecifier(specifier)) {
        if (statement.importClause && !expectedPackages.includes(specifier)) expectedPackages.push(specifier)
        continue
      }
      const segment = comparator.importSegment(specifier)
      if (!segment) {
        comparator.fail('imports', `找不到 ${specifier} 在产物里的模块区段`)
        continue
      }
      for (const name of segment.inits) if (!expectedInits.includes(name)) expectedInits.push(name)
    }
    if (JSON.stringify(distInits) !== JSON.stringify(expectedInits)) {
      comparator.fail('init', `产物的 init 调用序列 [${distInits.join(' ')}] ≠ 源码导入顺序推出的 [${expectedInits.join(' ')}]（漏调 / 多调 / 重复 / 顺序不同）`)
    }
    // 第三方包：源码运行时导入的每个包 ↔ 产物恰好一条 __toESM(require_<包>(), 1) 声明，不多不少、不重复
    const declaredNames = namespaceDeclarations.map(([name]) => name)
    if (new Set(declaredNames).size !== declaredNames.length) {
      comparator.fail('namespaces', `命名空间变量重复声明：[${declaredNames.join(' ')}]`)
    }
    const unmatched = [...namespaceDeclarations]
    for (const specifier of expectedPackages) {
      const slug = packageSlug(specifier)
      const index = unmatched.findIndex(([name, required]) =>
        isRenamedFrom(name, `import_${slug}`) && isRenamedFrom(required, `require_${slug}`))
      if (index < 0) comparator.fail('namespaces', `源码导入的包 ${specifier} 在产物里没有对应的 __toESM(require_${slug}(), 1) 声明`)
      else unmatched.splice(index, 1)
    }
    if (unmatched.length > 0) {
      comparator.fail('namespaces', `产物多出源码没有导入的命名空间声明：[${unmatched.map(([name, required]) => `${name}=${required}`).join(' ')}]`)
    }
    // 产物里不应残留任何内部模块的 import（bun 会把它们降为 init_x()）；残留即不等，不能被过滤掉
    for (const statement of dist.sourceFile.statements) {
      if (!ts.isImportDeclaration(statement)) continue
      const specifier = (statement.moduleSpecifier as ts.StringLiteral).text
      if (!isBareSpecifier(specifier) || statement.importClause) {
        comparator.fail('imports', `产物残留非预期的 import：${statement.getText()}`)
      }
    }
    const srcSideEffects = sideEffectImports(src.sourceFile.statements)
    const distSideEffects = sideEffectImports(dist.sourceFile.statements)
    if (JSON.stringify(srcSideEffects) !== JSON.stringify(distSideEffects)) {
      comparator.fail('imports', `副作用导入序列不同：[${srcSideEffects.join(' ')}] / [${distSideEffects.join(' ')}]`)
    }
    const srcDirectives = directives(src.sourceFile.statements)
    const distDirectives = directives(dist.sourceFile.statements)
    if (JSON.stringify(srcDirectives) !== JSON.stringify(distDirectives)) {
      comparator.fail('directives', `指令不同：[${srcDirectives.join(' ')}] / [${distDirectives.join(' ')}]`)
    }
  }

  if (srcStatements.length === 0 || distStatements.length === 0) {
    throw new Error(`提取不到运行时语句：源码 ${srcStatements.length} 条 / 产物 ${distStatements.length} 条`)
  }
  if (srcStatements.length !== distStatements.length) {
    comparator.issues.push(
      `顶层运行时语句数不同：源码 ${srcStatements.length}（${srcStatements.map(statementLabel).join(' ')}）`
      + ` / 产物 ${distStatements.length}（${distStatements.map(statementLabel).join(' ')}）`,
    )
    return comparator.issues
  }
  srcStatements.forEach((statement, index) => {
    comparator.compare(statementLabel(statement), statement, distStatements[index], true)
  })
  return comparator.issues
}
