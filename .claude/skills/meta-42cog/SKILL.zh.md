---
name: meta-42cog
description: 本技能用于使用认知敏捷法初始化新项目。通过扫描项目目录并识别关键模式，自动生成real.md（现实约束）和cog.md（认知模型）文档。
---

# 元技能 - 认知敏捷法基础文档生成器

## 概述

这是认知敏捷法（42COG）的**元技能**。它生成所有其他技能依赖的两个基础文档：

1. **real.md** - 现实约束文档
2. **cog.md** - 认知模型文档

这些文档遵循RCSW工作流：
```
Real（现实约束）→ Cog（认知模型）→ Spec（规约文档）→ Work（实际作品）
```

## 适用场景

- 使用认知敏捷法启动新项目
- 当real.md或cog.md缺失，而其他技能需要它们时
- 当项目结构发生重大变化，需要重新生成基础文档时
- 将现有项目迁移到认知敏捷法工作流时

## 核心原则

本技能遵循认知敏捷法的**至高原则**：

> **加速混合智能循环** — 一切设计是否合理，都要看是否能加速人机协作的循环。

### 四大具体原则

1. **独立作业**：让AI独立工作，人干预不干预都没那么重要
2. **聚焦作品**：不关心中间步骤，只关心最终作品
3. **考虑意外**：处理AI可能无法预料的情况
4. **持续反思**：从经验中生成更多技能

## 流程

### 阶段一：项目扫描

扫描项目目录以识别：

**技术栈检测：**
- `package.json` → Node.js/JavaScript项目，依赖项
- `requirements.txt` / `pyproject.toml` → Python项目
- `Cargo.toml` → Rust项目
- `go.mod` → Go项目
- `*.csproj` → .NET项目

**框架检测：**
- Next.js、React、Vue、Angular（前端）
- Express、FastAPI、Django、Rails（后端）
- Drizzle、Prisma、TypeORM（ORM）

**数据库检测：**
- Schema文件、迁移文件
- 环境文件中的连接字符串

**敏感数据模式：**
- 用户凭证（密码、令牌）
- API密钥
- 个人信息（邮箱、电话、地址）
- 支付信息

### 阶段二：生成 real.md

> **推荐**：大多数项目推荐使用**简明写法**。仅在需要区分必选/可选约束，或需要详细说明时使用详细写法。

**模板文件**：
- 简明写法（推荐）：[real-template-simple.md](./template/real-template-simple.md)
- 详细写法：[real-template-detailed.md](./template/real-template-detailed.md)

**示例文件**：
- 简明写法示例：[real-example-simple.md](./example/real-example-simple.md)
- 详细写法示例：[real-example-detailed.md](./example/real-example-detailed.md)

<real-md-template>

**格式**：Markdown + XML语义闭合标签

**结构**：
```markdown
# [项目名称] - 现实约束文档

<meta>
  <document-id>[project]-real</document-id>
  <version>1.0.0</version>
  <project>[项目名称]</project>
  <type>现实约束</type>
  <created>[日期]</created>
</meta>

## 文档说明

[简述本文档定义的内容]

<constraints>

## 必选约束（最多4条）

<constraint required="true" id="C1">
<title>[约束标题]</title>
<description>[必须做什么或避免什么]</description>
<rationale>[为什么需要这个约束]</rationale>
<violation-consequence>[违反后果]</violation-consequence>
</constraint>

[... 最多4条必选约束]

## 可选约束（最多3条）

<constraint required="false" id="C5">
<title>[约束标题]</title>
<description>[应该做什么或避免什么]</description>
<rationale>[为什么推荐这样做]</rationale>
</constraint>

[... 最多3条可选约束]

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
| 必选 | 安全 | 密码哈希、API密钥加密、数据归属验证 |
| 必选 | 数据完整性 | 首用户管理员规则、唯一约束 |
| 必选 | 合规 | GDPR、数据驻留、审计日志 |
| 可选 | 体验简化 | 头像生成、文件类型限制 |
| 可选 | 性能 | 缓存规则、限流 |

**关键规则**：聚焦于**AI可能无法预料**但违反后会造成**现实损害**的约束。

### 阶段三：生成 cog.md

> **推荐**：大多数项目推荐使用**简明写法**。仅在需要更详细的属性定义和复杂关系时使用详细写法。

**模板文件**：
- 简明写法（推荐）：[cog-template-simple.md](./template/cog-template-simple.md)
- 详细写法：[cog-template-detailed.md](./template/cog-template-detailed.md)

**示例文件**：
- 简明写法示例：[cog-example-simple.md](./example/cog-example-simple.md)
- 详细写法示例：[cog-example-detailed.md](./example/cog-example-detailed.md)

<cog-md-template>

**格式**：Markdown + XML语义闭合标签

**核心框架**：**智能体 + 信息 + 上下文**

**结构**：
```markdown
# [项目名称] - 认知模型文档

<meta>
  <document-id>[project]-cog</document-id>
  <version>1.0.0</version>
  <project>[项目名称]</project>
  <type>认知模型</type>
  <created>[日期]</created>
  <depends>real.md</depends>
</meta>

## 文档说明

[基于"智能体 + 信息 + 上下文"框架的简述]

---

## 一、智能体（Agents）

<agents>

### 1.1 人类智能体

<agent type="human" id="A1">
<name>[智能体名称]</name>
<identifier>[如何唯一识别 - UUID、邮箱等]</identifier>
<classification>
  <by-[标准]>[分类1] | [分类2]</by-[标准]>
</classification>
<capabilities>[能做什么]</capabilities>
<goals>[想要达成什么]</goals>
</agent>

### 1.2 人工智能体

<agent type="ai" id="A2">
<name>[AI智能体名称]</name>
<identifier>[如何识别 - provider + model]</identifier>
<classification>
  <by-[标准]>[分类]</by-[标准]>
</classification>
<interaction-pattern>[输入/输出模式]</interaction-pattern>
</agent>

</agents>

---

## 二、信息（Information）

<information>

### 2.1 核心实体

<entity id="E1">
<name>[实体名称]</name>
<unique-code>[如何唯一识别]</unique-code>
<classification>
  <by-[标准]>[分类]</by-[标准]>
</classification>
<attributes>[关键属性]</attributes>
<relations>[关系：1:1, 1:N, N:N]</relations>
</entity>

### 2.2 信息流动

<information-flow>
<flow id="F1" name="[流程名称]">
  [智能体] → [动作] → [系统] → [响应] → [智能体]
</flow>
</information-flow>

</information>

---

## 三、上下文（Context）

<context>

### 3.1 应用上下文
[Web应用、移动应用、CLI工具等]

### 3.2 技术上下文
[架构、协议、安全措施]

### 3.3 用户体验上下文
[情感目标、交互风格]

</context>

---

## 四、权重矩阵

<weights>
[实体和交互的重要性权重]
</weights>

---

## 五、验收检查

[验证用的复选框]
```

</cog-md-template>

**实体识别指南：**

为每个实体定义：
1. **唯一编码**：AI如何定位和识别它（UUID、slug、复合键）
2. **分类方式**：人类定义的分类（AI倾向于随意分类）

### 阶段四：验证

生成两个文档后：

1. **交叉引用检查**：
   - cog.md中的所有实体应遵守real.md中的约束
   - 安全敏感实体应有相应的约束

2. **完整性检查**：
   - real.md：总共4-7条约束
   - cog.md：所有主要实体都有唯一编码和分类

3. **格式检查**：
   - XML标签正确闭合
   - Markdown结构清晰
   - 约束/实体定义周围没有代码围栏

## 输出

在项目的认知敏捷法目录中生成两个文件：

```
.42cog/           （或项目特定位置）
├── real.md       # 现实约束
└── cog.md        # 认知模型
```

## 质量检查清单

- [ ] real.md最多4条必选约束
- [ ] real.md最多3条可选约束
- [ ] 所有约束聚焦于AI无法预料、会造成现实损害的问题
- [ ] cog.md遵循"智能体 + 信息 + 上下文"框架
- [ ] 所有实体都定义了唯一编码
- [ ] 所有实体都有人类定义的分类
- [ ] XML语义闭合标签使用正确
- [ ] 文档简洁（AI上下文窗口有限）

## 与其他技能的关系

| 技能 | 关系 |
|------|------|
| 所有01-11技能 | 输出：real.md和cog.md是前置条件 |
| product-requirements | 依赖cog.md理解实体 |
| database-design | 依赖cog.md获取实体关系 |
| coding | 依赖real.md获取安全约束 |

## 触发条件

本技能在以下情况自动调用：
1. 任何其他技能检测到缺失real.md或cog.md
2. 用户明确请求生成基础文档
3. 项目正在使用认知敏捷法初始化
