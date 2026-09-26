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
 *   - `(…)` 透明；产物侧 `(0, f)` / `(0, import_pkgN.f)` ≡ `f`（只限普通标识符与命名空间成员 —— `(0, obj.m)` 会丢 this，不归一）；
 *   - `return undefined` ≡ `return`（仅当 `undefined` 是未被遮蔽的全局名）；
 *   - 无替换模板 ≡ 同文字符串；`{ a }` ≡ `{ a: a }`（有默认值 `{ a = 1 }` 时两侧须同为简写且默认值等价）；
 *   - 顶层 `const` / `let` ≡ `var`：仅当源码里**声明之前没有任何对它的引用**（否则 TDZ 与 undefined 行为不同）。
 *
 * 打包样板单独核对，不是简单忽略：
 *   - 产物里的 `init_x()` 调用集合 ≡ 源码导入的各内部模块在产物里声明的 `init_x` 集合（漏调、多调、调错都算不等）；
 *   - 副作用导入 `import "x"` 的说明符集合两侧相同；`"use server"` 等指令两侧相同。
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
  const [required] = init.arguments
  if (!required || !ts.isCallExpression(required) || !ts.isIdentifier(required.expression)) return null
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
      // 产物侧 (0, f) / (0, import_pkgN.f)：去 this 的间接调用。只归一普通标识符与命名空间成员
      if (
        side === 'dist'
        && ts.isBinaryExpression(current)
        && current.operatorToken.kind === ts.SyntaxKind.CommaToken
        && ts.isNumericLiteral(current.left)
        && current.left.text === '0'
        && (ts.isIdentifier(current.right) || this.namespaceMember(current.right))
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
      if (srcNode.text !== distNode.text) this.fail(path, `BigInt 不同：${srcNode.text} / ${distNode.text}`)
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

  /** 顶层 const/let → var 只在「声明之前没有任何引用」时等价（否则 TDZ 抛错与读到 undefined 不同） */
  private checkTopLevelVarSafe(path: string, list: ts.VariableDeclarationList) {
    const symbols = new Set<ts.Symbol>()
    for (const declaration of list.declarations) {
      if (!ts.isIdentifier(declaration.name)) {
        this.fail(path, '顶层解构声明的 const / let → var 不做等价归一')
        return
      }
      const symbol = this.src.checker.getSymbolAtLocation(declaration.name)
      if (symbol) symbols.add(symbol)
    }
    const declaredAt = list.getStart()
    const visit = (node: ts.Node) => {
      if (node.getStart() >= declaredAt) return
      if (ts.isIdentifier(node)) {
        const symbol = this.src.checker.getSymbolAtLocation(node)
        if (symbol && symbols.has(symbol)) this.fail(path, `顶层 ${node.text} 在声明之前被引用，const/let → var 不等价`)
      }
      ts.forEachChild(node, visit)
    }
    visit(this.src.sourceFile)
  }
}

function statementLabel(statement: ts.Statement): string {
  if (ts.isFunctionDeclaration(statement) && statement.name) return statement.name.text
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.map((item) => item.name.getText()).join(',')
  }
  return ts.SyntaxKind[statement.kind]
}

const sideEffectImports = (statements: readonly ts.Statement[]) => statements
  .filter((statement): statement is ts.ImportDeclaration => ts.isImportDeclaration(statement) && !statement.importClause)
  .map((statement) => (statement.moduleSpecifier as ts.StringLiteral).text)
  .sort()

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
  const distInits: string[] = []
  for (const statement of dist.sourceFile.statements) {
    const namespace = namespaceDeclaration(statement)
    if (namespace) distNamespaces.set(namespace[0], namespace[1])
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
    // 打包样板核对：init 调用集合、副作用导入、指令
    const expectedInits = new Set<string>()
    for (const statement of src.sourceFile.statements) {
      if (!ts.isImportDeclaration(statement)) continue
      const specifier = (statement.moduleSpecifier as ts.StringLiteral).text
      if (isBareSpecifier(specifier)) continue
      const segment = comparator.importSegment(specifier)
      if (!segment) {
        comparator.fail('imports', `找不到 ${specifier} 在产物里的模块区段`)
        continue
      }
      segment.inits.forEach((name) => expectedInits.add(name))
    }
    const actualInits = [...new Set(distInits)].sort()
    const expected = [...expectedInits].sort()
    if (JSON.stringify(actualInits) !== JSON.stringify(expected) || distInits.length !== actualInits.length) {
      comparator.fail('init', `产物的 init 调用 [${distInits.join(' ')}] ≠ 源码导入模块声明的 init [${expected.join(' ')}]`)
    }
    const srcSideEffects = sideEffectImports(src.sourceFile.statements)
    const distSideEffects = sideEffectImports(dist.sourceFile.statements)
    if (JSON.stringify(srcSideEffects) !== JSON.stringify(distSideEffects)) {
      comparator.fail('imports', `副作用导入不同：[${srcSideEffects.join(' ')}] / [${distSideEffects.join(' ')}]`)
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
