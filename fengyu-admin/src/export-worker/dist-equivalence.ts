/**
 * 源码模块 ↔ dist/export-worker.mjs 里 bun 改写后的同一模块：**语义等价**比较（测试专用，#360）。
 *
 * 为什么不比文本：bun 会改写 JS（去类型 / 注释、单双引号、分号、尾逗号、`if (…) x` 拆行、冗余括号、
 * 局部变量与导入绑定加数字后缀、命名空间导入改成 `import_xxxN.name`）。逐行文本归一要么漏报要么误红
 * （#360 codex / GLM round-2~6 连续命中）。这里改为：两侧解析成 AST，用 TypeScript checker 做**符号解析**，
 * 同步遍历、逐节点配对比较。
 *
 * 等价规则（全部按「绑定」而不是按文本）：
 *   - 局部绑定（函数内声明的参数 / 变量 / 内层函数）：按**符号身份**建双向映射，名字可以不同，
 *     但对应关系必须一一且全程一致 —— 变量遮蔽、多个同名回调参数都各自独立；
 *   - 本模块顶层声明：名字须为 `X` 或 `X\d+`，且双向一一对应；
 *   - 导入绑定：产物名须为「导入名」或「导入名 + 数字」，且**被导入模块在产物里确实声明了这个名字**
 *     （杜绝「源码用 X、过期产物用另一个真实存在的 X2」被当成同一绑定）；
 *     第三方包的命名空间导入 `import_pkgN.name` 视为从该包导入的 `name`；
 *   - 全局 / 未解析名（Number、undefined …）：文本相同；属性名：文本相同；
 *   - 字面量逐值比较；**模板字面量比原文（rawText）** —— SQL 里多一个分号、少一个逗号、改一行 `--` 注释都算不等；
 *   - 运算符逐个比较（一元运算符不是子节点，单独比）；
 *   - 已知等价形态：`(…)` 透明、`(0, f)` ≡ `f`、`return undefined` ≡ `return`、
 *     无替换模板 ≡ 同文字符串、`{ a }` ≡ `{ a: a }`、顶层 `const` ≡ `var`（仅顶层，函数内 let/const 仍须一致）。
 *
 * 比较对象是模块的**全部运行时顶层语句**（导入、类型声明、`init_*()` / `__toESM` / `import "x"` /
 * `"use server"` 这类打包样板除外），所以常量、withPermission 包装器、行映射都在闭集内。
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
   * 用于大模块（如 registry.ts）里只守护某一段；给了名字却提取不到任一侧时抛错。
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

/** 打包样板与非运行时语句：不参与比较 */
function isRuntimeStatement(statement: ts.Statement): boolean {
  if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) return false
  if (ts.isExpressionStatement(statement)) {
    const expression = statement.expression
    if (ts.isStringLiteral(expression)) return false // "use server" 等指令
    if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)
      && /^init_/.test(expression.expression.text) && expression.arguments.length === 0) return false
  }
  if (ts.isVariableStatement(statement)) {
    const [declaration] = statement.declarationList.declarations
    if (
      statement.declarationList.declarations.length === 1
      && ts.isIdentifier(declaration.name)
      && /^import_/.test(declaration.name.text)
      && declaration.initializer
      && ts.isCallExpression(declaration.initializer)
      && ts.isIdentifier(declaration.initializer.expression)
      && declaration.initializer.expression.text === '__toESM'
    ) return false
  }
  return true
}

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

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const isRenamedFrom = (renamed: string, original: string) =>
  renamed === original || new RegExp(`^${escapeRegExp(original)}\\d+$`).test(renamed)

/** 包名 → bun 命名空间变量前缀：drizzle-orm → import_drizzle_orm */
const namespacePrefix = (specifier: string) => `import_${specifier.replace(/^@/, '').replace(/[^A-Za-z0-9]/g, '_')}`

type Ref =
  | { kind: 'local'; symbol: ts.Symbol }
  | { kind: 'own'; name: string }
  | { kind: 'import'; specifier: string; imported: string }
  | { kind: 'global'; name: string }

class Comparator {
  readonly issues: string[] = []
  private readonly localSrcToDist = new Map<ts.Symbol, ts.Symbol>()
  private readonly localDistToSrc = new Map<ts.Symbol, ts.Symbol>()
  private readonly nameSrcToDist = new Map<string, string>()
  private readonly nameDistToSrc = new Map<string, string>()
  private readonly declaredCache = new Map<string, Set<string> | null>()

  constructor(
    private readonly src: Bound,
    private readonly dist: Bound,
    private readonly distSegmentOfImport: ModuleSides['distSegmentOfImport'],
  ) {}

  private fail(path: string, message: string) {
    if (this.issues.length < 20) this.issues.push(`${path}: ${message}`)
  }

  private declaredInImport(specifier: string): Set<string> | null {
    if (!this.declaredCache.has(specifier)) {
      const segment = this.distSegmentOfImport(specifier)
      this.declaredCache.set(specifier, segment == null ? null : topLevelDeclaredNames(segment))
    }
    return this.declaredCache.get(specifier)!
  }

  private classify(side: Bound, identifier: ts.Identifier): Ref {
    const symbol = ts.isShorthandPropertyAssignment(identifier.parent) && identifier.parent.name === identifier
      ? side.checker.getShorthandAssignmentValueSymbol(identifier.parent)
      : side.checker.getSymbolAtLocation(identifier)
    const declaration = symbol?.declarations?.[0]
    if (!symbol || !declaration || declaration.getSourceFile() !== side.sourceFile) {
      return { kind: 'global', name: identifier.text }
    }
    if (ts.isImportSpecifier(declaration)) {
      const importDeclaration = declaration.parent.parent.parent
      return {
        kind: 'import',
        specifier: (importDeclaration.moduleSpecifier as ts.StringLiteral).text,
        imported: (declaration.propertyName ?? declaration.name).text,
      }
    }
    if (ts.isImportClause(declaration) || ts.isNamespaceImport(declaration)) {
      const importDeclaration = ts.isImportClause(declaration) ? declaration.parent : declaration.parent.parent
      return { kind: 'import', specifier: (importDeclaration.moduleSpecifier as ts.StringLiteral).text, imported: 'default' }
    }
    // 顶层声明 = 声明节点到 SourceFile 之间没有函数边界
    let cursor: ts.Node | undefined = declaration.parent
    while (cursor && !ts.isSourceFile(cursor)) {
      if (ts.isFunctionLike(cursor) || ts.isClassLike(cursor)) return { kind: 'local', symbol }
      cursor = cursor.parent
    }
    return { kind: 'own', name: identifier.text }
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
    if (a.kind === 'import' && (b.kind === 'global' || b.kind === 'own')) {
      const distName = b.name
      if (!isRenamedFrom(distName, a.imported)) {
        this.fail(path, `导入绑定不同：源码 ${a.imported}（from ${a.specifier}）/ 产物 ${distName}`)
        return
      }
      const declared = this.declaredInImport(a.specifier)
      if (!declared) {
        this.fail(path, `找不到 ${a.specifier} 在产物里的模块区段，无法核实 ${distName}`)
        return
      }
      if (!declared.has(distName)) {
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

  /** 已知等价形态的归一（两侧都做） */
  private normalize(node: ts.Node): ts.Node {
    let current = node
    for (;;) {
      if (ts.isParenthesizedExpression(current)) {
        current = current.expression
        continue
      }
      if (
        ts.isBinaryExpression(current)
        && current.operatorToken.kind === ts.SyntaxKind.CommaToken
        && ts.isNumericLiteral(current.left)
        && current.left.text === '0'
        && (ts.isPropertyAccessExpression(current.right) || ts.isIdentifier(current.right))
      ) {
        current = current.right
        continue
      }
      return current
    }
  }

  /** `import_pkgN.name`（N 可无）→ 视为从包 pkg 导入的 name */
  private namespaceRef(node: ts.Node): { prefix: string; name: string } | null {
    if (!ts.isPropertyAccessExpression(node) || !ts.isIdentifier(node.expression)) return null
    const match = /^(import_[A-Za-z0-9_]+?)\d*$/.exec(node.expression.text)
    return match ? { prefix: match[1], name: node.name.text } : null
  }

  private children(node: ts.Node): ts.Node[] {
    const out: ts.Node[] = []
    ts.forEachChild(node, (child) => {
      if (child.kind === ts.SyntaxKind.ExportKeyword || child.kind === ts.SyntaxKind.DeclareKeyword) return
      out.push(child)
    })
    return out
  }

  private isReturnUndefined(node: ts.Node) {
    return ts.isReturnStatement(node)
      && (!node.expression || (ts.isIdentifier(node.expression) && node.expression.text === 'undefined'))
  }

  private stringValue(node: ts.Node): string | null {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
    return null
  }

  compare(path: string, rawSrc: ts.Node, rawDist: ts.Node, topLevel = false) {
    if (this.issues.length >= 20) return
    const srcNode = this.normalize(rawSrc)
    const distNode = this.normalize(rawDist)

    // 源码 import { sql } from 'drizzle-orm' 的引用 ↔ 产物 import_drizzle_ormN.sql
    const distNamespace = this.namespaceRef(distNode)
    if (distNamespace && ts.isIdentifier(srcNode)) {
      const ref = this.classify(this.src, srcNode)
      if (ref.kind === 'import' && namespacePrefix(ref.specifier) === distNamespace.prefix && ref.imported === distNamespace.name) return
      this.fail(path, `命名空间导入不同：源码 ${srcNode.text} / 产物 ${distNode.getText()}`)
      return
    }

    if (this.isReturnUndefined(srcNode) && this.isReturnUndefined(distNode)) return

    const srcString = this.stringValue(srcNode)
    const distString = this.stringValue(distNode)
    if (srcString !== null || distString !== null) {
      if (srcString !== distString) this.fail(path, `字符串不同：${JSON.stringify(srcString)} / ${JSON.stringify(distString)}`)
      return
    }

    // { a } ≡ { a: a }
    if (ts.isShorthandPropertyAssignment(srcNode) || ts.isShorthandPropertyAssignment(distNode)) {
      const key = (node: ts.Node) => (ts.isShorthandPropertyAssignment(node) || ts.isPropertyAssignment(node)) && ts.isIdentifier(node.name) ? node.name.text : null
      const value = (node: ts.Node) => ts.isShorthandPropertyAssignment(node) ? node.name : ts.isPropertyAssignment(node) ? node.initializer : null
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
      if (srcNode.operator !== (distNode as typeof srcNode).operator) {
        this.fail(path, `一元运算符不同：${ts.tokenToString(srcNode.operator)} / ${ts.tokenToString((distNode as typeof srcNode).operator)}`)
        return
      }
    }
    if (ts.isVariableDeclarationList(srcNode) && ts.isVariableDeclarationList(distNode) && !topLevel) {
      const kind = (node: ts.VariableDeclarationList) => node.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)
      if (kind(srcNode) !== kind(distNode)) this.fail(path, `变量声明种类不同（let/const/var）`)
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
}

function statementLabel(statement: ts.Statement): string {
  if (ts.isFunctionDeclaration(statement) && statement.name) return statement.name.text
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.map((item) => item.name.getText()).join(',')
  }
  return ts.SyntaxKind[statement.kind]
}

/**
 * 比较一个模块的全部运行时顶层语句。返回不等价之处（空数组 = 等价）。
 * 提取不到任何运行时语句时抛错（两侧都空不能当成等价）。
 */
export function compareModuleRuntime(sides: ModuleSides): string[] {
  const src = bind('source.js', sides.sourceCode, true)
  const dist = bind('dist.js', sides.distCode, false)
  let srcStatements = src.sourceFile.statements.filter(isRuntimeStatement)
  let distStatements = dist.sourceFile.statements.filter(isRuntimeStatement)
  if (sides.only) {
    const declares = (statement: ts.Statement, name: string, allowSuffix: boolean) => {
      const matches = (declared: string) => (allowSuffix ? isRenamedFrom(declared, name) : declared === name)
      if (ts.isFunctionDeclaration(statement) && statement.name) return matches(statement.name.text)
      return ts.isVariableStatement(statement) && statement.declarationList.declarations
        .some((item) => ts.isIdentifier(item.name) && matches(item.name.text))
    }
    const pick = (statements: ts.Statement[], allowSuffix: boolean, side: string) => sides.only!.map((name) => {
      const found = statements.filter((statement) => declares(statement, name, allowSuffix))
      if (found.length !== 1) throw new Error(`${side}里 ${name} 的顶层声明找到 ${found.length} 处（应恰为 1）`)
      return found[0]
    })
    srcStatements = pick(srcStatements, false, '源码')
    distStatements = pick(distStatements, true, '产物')
  }
  if (srcStatements.length === 0 || distStatements.length === 0) {
    throw new Error(`提取不到运行时语句：源码 ${srcStatements.length} 条 / 产物 ${distStatements.length} 条`)
  }
  const comparator = new Comparator(src, dist, sides.distSegmentOfImport)
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
