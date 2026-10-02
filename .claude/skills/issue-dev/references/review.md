# Codex 开发 · GLM-5.3[1M] + DeepSeek 双谱系评审

Codex 主会话负责实现、验证、四维自审和 finding 裁决。独立评审固定为
GLM-5.3[1M]（OpenCode，请求规格 `zhipuai-coding-plan/glm-5.3[1m]`）+ DeepSeek-V4.1-Flash
（Claude Code CLI，默认 `deepseek-flash[1m]`）；CLI 品牌不是模型谱系。
这是用户指定组合，不自动换成其它型号。DeepSeek 官方 API 用 `deepseek-flash`
调用 V4.1 Flash，参见 [发布说明](https://api-docs.deepseek.com/zh-cn/news/news260910/)。
旧 `.claude/dev-launch.review.md` 的 Codex reviewer / 自动替换链不再适用于这三个 skill。

GLM 调用层将 `[1m]` 规格映射到 OpenCode 支持的 `zhipuai-coding-plan/glm-5.3`，
在子进程配置中显式设置 1,000,000 token 上下文、131,072 token 输出，并设置
`OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX=131072`，避免默认 32K 输出限制截断推理与结论。
不修改全局 OpenCode 配置；显式指定其它 GLM 型号时不套用这组限制。

## 四维自审（替代 Claude 专属 pr-ready / simplify）

审 `origin/dev...HEAD` 的完整交付 diff，不能只审最后一次 staged diff：

1. sibling：四端独立副本、调用方、SQL / 返回值 / 类型契约是否一起更新；禁 shared 目录。
2. concurrency：事务、CAS 影响行数、幂等、锁顺序、订单序号、PG 池 max 5。
3. boundary：OPENID / scope / 错误白名单、金额/日期/零值、特殊单和状态机正负例。
4. simplify：仅删本次改动引入的冗余，不借评审扩大重构。

产出 `review/self-audit.md`，列相关 invariant、证据与结论。业务规则从仓库
`AGENTS.md`、`.42cog/real.md`、相关 spec 取；旧 memory 在
`~/.claude/projects/-Users-nv-proj-xt-com-fengyu-wxapp/memory/` 时只读相关条目。
这不是 Claude 登录依赖；找不到 memory 就查仓库和已确认 issue，不能编造口径。

## 准备输入

`review/context.md` 包含：issue 验收标准、范围/明确不做项、相关 invariant、实际验证结果、
变更后的关键文件/调用方/副本全文（带路径与行号）。完整 diff 由脚本自动加入。
不得包含 `.env`、私有配置、密钥或客户数据。两位 reviewer 收到相同输入，独立给结论。
他们不运行工具；上下文不足必须返回 `incomplete`，由 Codex 补材料再审。
这解决旧 GLM 的变异测试污染、worktree 外目录拒绝和重复跑全套测试的问题。

```bash
python3 "$WT/.agents/skills/issue-dev/scripts/dual_review.py" \
  --cwd "$WT" --context "$WT/_tmp/issue-N/review/context.md" \
  --out "$WT/_tmp/issue-N/review/round-1"
```

脚本只审干净、已提交的 HEAD；输出 packet、原始 CLI 输出、结构化结果、退出状态，
记录 base SHA / HEAD SHA / packet hash。同目录不覆盖旧轮次。默认单路超时 15 分钟，
可用 `--timeout` 调整；等待时每分钟给进度。先 `--probe` 实测鉴权与结构化返回，
探针通过不等于代码评审通过。GLM 模型用 `--glm-model`，DeepSeek 用 `--deepseek-model`
或同名 `REVIEW_*_MODEL` 环境变量；模型必须仍属于指定谱系。

DeepSeek 密钥优先 `DEEPSEEK_API_KEY`，否则只读取本机 `~/.claude/settings.json` 中
DeepSeek endpoint 对应的 token；子进程固定 DeepSeek endpoint，`--bare`、禁工具、禁 MCP。
不会改全局 Claude / Codex 配置，不依赖 Anthropic 账号。OpenCode 用已有 GLM provider
凭证，禁工具权限、自动分享和插件。参见 [OpenCode CLI](https://opencode.ai/docs/cli/)、
[权限](https://opencode.ai/docs/permissions/)、[DeepSeek 接入 Claude Code](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/)。

## 裁决与收敛

每条 finding 要有严重度、文件位置、触发条件、用户影响、证据，区分：
`introduced`（本次引入）、`acceptance`（验收缺口）、`existing`（既有问题）、
`suggestion`（可选维护）。审查者给分级，Codex 验证并写 `disposition.md`：

- 本次引入/验收缺口的 P0/P1/P2 是阻塞项，修复后两路必须复审最终 HEAD。
- 误报写可复核反证；不能靠改标签清零。脚本 exit 2 表示有 finding，需裁决，不能当自动通过。
- 既有 P0/P1 风险先报告并判断是否使本次上线不安全；不安全就阻塞。
- 范围外 P2/P3 / suggestion 放本地 backlog，**不自动新建 issue**，不要求无限美化。

两路均 `complete`、同一最终 HEAD、无未处理的范围内 P0/P1/P2 才通过。
任一路认证/余额/超时/空输出/无结论，exit 3：保留现场，可开 draft，不能称双谱系完成。
瞬态故障最多重试 2 次；账户余额/权限故障立即报告。不得偷偷用 Codex 替代 DeepSeek。
连续两轮没有新有效阻塞发现却反复争议，或累计 5 轮未收敛：总结未解决项、保留 draft
等用户裁决，不通过轮数豁免闸门。修改代码后旧 HEAD 的通过记录作废。
