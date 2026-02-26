# 开发环境参考

## 微信开发者工具 CLI

打开项目命令：

- **macOS**: `/Applications/wechatwebdevtools.app/Contents/MacOS/cli open --project "/path/to/project"`
- **Windows**: `"C:\Program Files (x86)\Tencent\微信web开发者工具\cli.bat" open --project "项目根目录"`

项目路径指向**包含 `project.config.json` 的目录**。

---

## libVersion 选项

| 值 | 说明 | 适用场景 |
|---|---|---|
| `"latest"` | 最新版本 | 开发调试 |
| `"trial"` | 预览版 | 测试新特性 |
| `"widelyUsed"` | 广泛使用的稳定版 | **生产环境推荐** |

> 开发阶段可使用 `"latest"`，上线前建议切换为 `"widelyUsed"` 以确保用户基础库兼容性。

---

## app.json 性能优化配置

```json
{
  "lazyCodeLoading": "requiredComponents",
  "enablePassiveEvent": true
}
```

| 配置 | 说明 |
|---|---|
| `lazyCodeLoading` | 按需加载组件代码，减少启动时间（**官方强烈推荐**） |
| `enablePassiveEvent` | 优化滚动性能，将 touch 事件标记为 passive |

---

## MCP 配置（CloudBase）

在 `.mcp.json` 中配置 CloudBase MCP：

```json
{
  "mcpServers": {
    "cloudbase": {
      "command": "npx",
      "args": ["@cloudbase/cloudbase-mcp@latest"]
    }
  }
}
```

MCP 提供的工具：环境管理、函数部署、数据库操作、安全规则配置等。

### 其他 IDE 的 MCP 配置

| IDE | 配置文件位置 | 格式 |
|---|---|---|
| **Claude Code** | `.mcp.json` | JSON |
| **Cursor** | `.cursor/mcp.json` | JSON |
| **Windsurf** | `~/.codeium/windsurf/mcp_config.json`（用户级） | JSON |
| **Cline** | 在 Cline 设置中查看 MCP 配置位置 | JSON |
| **GitHub Copilot Chat** | 在 VS Code 设置中查看 MCP 配置位置 | JSON |
| **Continue** | `.continue/mcpServers/` 目录 | YAML |

Continue 的 YAML 格式示例：

```yaml
name: CloudBase MCP
version: 1.0.0
schema: v1
mcpServers:
  - uses: stdio
    command: npx
    args: ["@cloudbase/cloudbase-mcp@latest"]
```

---

## mcporter CLI（MCP 不可用时的替代方案）

在不支持 MCP 的环境中，使用 mcporter CLI 调用 MCP 工具：

```bash
mcporter list                            # 列出服务器/工具
mcporter list <server> --schema          # 显示工具模式
mcporter call <server.tool> key=value    # 调用工具
```

配置文件 `./config/mcporter.json`：

```json
{
  "mcpServers": {
    "cloudbase-mcp": {
      "command": "npx",
      "args": ["@cloudbase/cloudbase-mcp@latest"],
      "env": {
        "TENCENTCLOUD_SECRETID": "<your_secret_id>",
        "TENCENTCLOUD_SECRETKEY": "<your_secret_key>",
        "CLOUDBASE_ENV_ID": "<your_env_id>"
      }
    }
  }
}
```

---

## 文件上传白名单

小程序允许上传的文件后缀（共 18 种）：

`wxs`, `png`, `jpg`, `jpeg`, `gif`, `svg`, `json`, `cer`, `mp3`, `aac`, `m4a`, `mp4`, `wav`, `ogg`, `silk`, `wasm`, `br`, `cert`

---

## glass-easel 组件框架

微信新推出的 glass-easel 组件框架支持模板内函数调用、链式 API、动态 slot 等增强能力。使用标准组件框架即可满足大多数场景，如需更灵活的组件开发能力可评估迁移。
