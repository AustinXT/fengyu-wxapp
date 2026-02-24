---
name: meta-42cog
description: >-
  此技能用于使用认知敏捷方法论初始化新项目。它通过扫描项目目录并识别关键模式，
  自动生成 real.md（现实约束）和 cog.md（认知模型）。
metadata:
  title: 认知敏捷初始化
  summary: 使用认知敏捷法初始化项目，自动生成 real.md（现实约束）和 cog.md（认知模型）
  description_zh: 使用认知敏捷法初始化新项目，通过扫描项目目录识别关键模式，自动生成 real.md（现实约束）和 cog.md（认知模型）
  author: voyager
  version: 1.0.0
---

# 元技能 - 认知敏捷基础文档生成器

## 概述

这是认知敏捷法的**元技能**。它生成所有其他技能所依赖的两个基础文档：

1. **real.md** - 现实约束文档
2. **cog.md** - 认知模型文档

这些文档遵循 RCSW 工作流：
```
Real → Cog → Spec → Work
```

## 何时使用此技能

- 使用认知敏捷方法论启动新项目时
- 当 real.md 或 cog.md 缺失且其他技能需要它们时
- 当项目结构发生重大变化，需要重新生成基础文档时
- 将项目接入认知敏捷工作流时

## 核心原则

此技能遵循认知敏捷的**最高原则**：

> **加速混合智能循环** — 所有设计都应以是否加速人机协作循环为评估标准。

### 四项具体原则

1. **独立运作**：让 AI 自主工作
2. **关注产出**：关心最终结果，而非中间步骤
3. **考虑例外**：处理 AI 可能无法预见的情况
4. **持续反思**：从经验中生成更多技能

## 流程

### 阶段 1：项目扫描

扫描项目目录以识别：

**技术栈检测：**
- `package.json` → Node.js/JavaScript 项目、依赖项
- `requirements.txt` / `pyproject.toml` → Python 项目
- `Cargo.toml` → Rust 项目
- `go.mod` → Go 项目
- `*.csproj` → .NET 项目

**框架检测：**
- Next.js, React, Vue, Angular（前端）
- Express, FastAPI, Django, Rails（后端）
- Drizzle, Prisma, TypeORM（ORM）

**数据库检测：**
- Schema 文件、迁移文件
- 环境文件中的连接字符串

**敏感数据模式：**
- 用户凭证（密码、令牌）
- API 密钥
- 个人信息（邮箱、电话、地址）
- 支付信息

### 阶段 2：生成 real.md

> **建议**：大多数项目应使用**简单格式**。仅当需要区分必需/可选约束或提供详细说明时，才使用详细格式。

**模板文件**：
- 简单格式（推荐）：[real-template-simple.md](./template/real-template-simple.md)
- 详细格式：[real-template-detailed.md](./template/real-template-detailed.md)

**示例文件**：
- 简单格式示例：[real-example-simple.md](./example/real-example-simple.md)
- 详细格式示例：[real-example-detailed.md](./example/real-example-detailed.md)

<real-md-template>

**格式**：Markdown + XML 语义闭合标签

**结构**：
```markdown
# [项目名称] - 现实约束文档

<meta>
  <document-id>[project]-real</document-id>
  <version>1.0.0</version>
  <project>[项目名称]</project>
  <type>Reality Constraints</type>
  <created>[日期]</created>
</meta>

## 文档用途

[简要描述本文档定义的内容]

<constraints>

## 必需约束（最多 4 条）

<constraint required="true" id="C1">
<title>[约束标题]</title>
<description>[必须做或必须避免的事项]</description>
<rationale>[此约束存在的原因]</rationale>
<violation-consequence>[违反后的后果]</violation-consequence>
</constraint>

[... 最多 4 条必需约束]

## 可选约束（最多 3 条）

<constraint required="false" id="C5">
<title>[约束标题]</title>
<description>[应该做或应该避免的事项]</description>
<rationale>[推荐此约束的原因]</rationale>
</constraint>

[... 最多 3 条可选约束]

</constraints>

## 技术环境

<environment>
<stack>
  [技术栈详情]
</stack>
</environment>

## 约束检查清单

[验证用的复选框]
```

</real-md-template>

**约束识别指南：**

| 优先级 | 类型 | 示例 |
|--------|------|------|
| 必需 | 安全性 | 密码哈希、API 密钥加密、数据所有权验证 |
| 必需 | 数据完整性 | 首用户管理员规则、唯一性约束 |
| 必需 | 合规性 | GDPR、数据驻留、审计日志 |
| 可选 | 用户体验简化 | 头像生成、文件类型限制 |
| 可选 | 性能 | 缓存规则、速率限制 |

**关键规则**：聚焦于 **AI 可能无法预见**但违反后会造成**现实世界损害**的约束。

### 阶段 3：生成 cog.md

> **建议**：大多数项目应使用**简单格式**。仅当需要更详细的属性定义和复杂关系时，才使用详细格式。

**模板文件**：
- 简单格式（推荐）：[cog-template-simple.md](./template/cog-template-simple.md)
- 详细格式：[cog-template-detailed.md](./template/cog-template-detailed.md)

**示例文件**：
- 简单格式示例：[cog-example-simple.md](./example/cog-example-simple.md)
- 详细格式示例：[cog-example-detailed.md](./example/cog-example-detailed.md)

<cog-md-template>

**格式**：Markdown + XML 语义闭合标签

**核心框架**：**主体 + 信息 + 上下文**

**结构**：
```markdown
# [项目名称] - 认知模型文档

<meta>
  <document-id>[project]-cog</document-id>
  <version>1.0.0</version>
  <project>[项目名称]</project>
  <type>Cognitive Model</type>
  <created>[日期]</created>
  <depends>real.md</depends>
</meta>

## 文档用途

[基于"主体 + 信息 + 上下文"框架的简要描述]

---

## 1. 主体

<agents>

### 1.1 人类主体

<agent type="human" id="A1">
<name>[主体名称]</name>
<identifier>[唯一标识方式 - UUID、邮箱等]</identifier>
<classification>
  <by-[标准]>[类别 1] | [类别 2]</by-[标准]>
</classification>
<capabilities>[能做什么]</capabilities>
<goals>[想要实现什么]</goals>
</agent>

### 1.2 AI 主体

<agent type="ai" id="A2">
<name>[AI 主体名称]</name>
<identifier>[标识方式 - 提供商 + 模型]</identifier>
<classification>
  <by-[标准]>[类别]</by-[标准]>
</classification>
<interaction-pattern>[输入/输出模式]</interaction-pattern>
</agent>

</agents>

---

## 2. 信息

<information>

### 2.1 核心实体

<entity id="E1">
<name>[实体名称]</name>
<unique-code>[唯一标识方式]</unique-code>
<classification>
  <by-[标准]>[类别]</by-[标准]>
</classification>
<attributes>[关键属性]</attributes>
<relations>[关系：1:1、1:N、N:N]</relations>
</entity>

### 2.2 信息流

<information-flow>
<flow id="F1" name="[流程名称]">
  [主体] → [操作] → [系统] → [响应] → [主体]
</flow>
</information-flow>

</information>

---

## 3. 上下文

<context>

### 3.1 应用上下文
[Web 应用、移动应用、CLI 工具等]

### 3.2 技术上下文
[架构、协议、安全措施]

### 3.3 用户体验上下文
[情感目标、交互风格]

</context>

---

## 4. 权重矩阵

<weights>
[实体和交互的重要性权重]
</weights>

---

## 5. 验证检查清单

[验证用的复选框]
```

</cog-md-template>

**实体识别指南：**

对于每个实体，需定义：
1. **唯一编码**：AI 如何定位和识别它（UUID、slug、复合键）
2. **分类**：人类定义的类别（AI 倾向于随意分类）

### 阶段 4：验证

生成两个文档后：

1. **交叉引用检查**：
   - cog.md 中的所有实体应遵守 real.md 中的约束
   - 安全敏感实体应有对应的约束

2. **完整性检查**：
   - real.md：共 4-7 条约束
   - cog.md：所有主要实体均已识别，并定义了唯一编码和分类

3. **格式检查**：
   - XML 标签正确闭合
   - Markdown 结构整洁
   - 约束/实体定义周围无代码围栏

## 输出

在项目的认知敏捷目录中生成两个文件：

```
.42cog/           （或项目特定位置）
├── real.md       # 现实约束
└── cog.md        # 认知模型
```

## 质量检查清单

- [ ] real.md 最多有 4 条必需约束
- [ ] real.md 最多有 3 条可选约束
- [ ] 所有约束聚焦于 AI 无法预见的、可能造成现实世界损害的问题
- [ ] cog.md 遵循"主体 + 信息 + 上下文"框架
- [ ] 所有实体均定义了唯一编码
- [ ] 所有实体均有人类定义的分类
- [ ] XML 语义闭合标签使用正确
- [ ] 文档简洁（AI 上下文窗口有限）

## 与其他技能的集成

| 技能 | 关系 |
|------|------|
| 所有 01-11 技能 | 输出：real.md 和 cog.md 是前置条件 |
| product-requirements | 依赖 cog.md 进行实体理解 |
| database-design | 依赖 cog.md 获取实体关系 |
| coding | 依赖 real.md 获取安全约束 |

## 触发条件

此技能在以下情况下自动调用：
1. 任何其他技能检测到 real.md 或 cog.md 缺失时
2. 用户明确请求生成基础文档时
3. 使用认知敏捷方法论初始化项目时
