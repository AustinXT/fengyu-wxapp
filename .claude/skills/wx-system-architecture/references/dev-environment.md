# 开发环境参考

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

### 其他 IDE 的 MCP 配置

| IDE | 配置文件位置 |
|---|---|
| **Claude Code** | `.mcp.json` |
| **Cursor** | `.cursor/mcp.json` |
| **Windsurf** | `~/.codeium/windsurf/mcp_config.json` |
| **Cline** | Cline 设置中查看 |
| **GitHub Copilot Chat** | VS Code 设置中查看 |
| **Continue** | `.continue/mcpServers/` 目录（YAML 格式） |

---

## 文件上传白名单

小程序允许上传的文件后缀（共 18 种）：

`wxs`, `png`, `jpg`, `jpeg`, `gif`, `svg`, `json`, `cer`, `mp3`, `aac`, `m4a`, `mp4`, `wav`, `ogg`, `silk`, `wasm`, `br`, `cert`
