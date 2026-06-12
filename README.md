# external-workspace-mcp

一個整合式 MCP（Model Context Protocol）Proxy 伺服器，將檔案系統存取、命令白名單執行、檔案下載與內容搜尋功能統一透過單一 HTTP 端點提供給遠端 AI agent 使用。

## 功能概覽

| 命名空間 | 工具 | 說明 |
|----------|------|------|
| `fs_*` | 來自 `@modelcontextprotocol/server-filesystem` | 讀寫檔案、列目錄、搜尋檔案等 |
| `cmd_run_command` | 執行白名單命令 | 只允許執行 `.cmd_whitelist.json` 中定義的命令 |
| `cmd_list_allowed_commands` | 列出允許的命令 | 回傳白名單清單與描述 |
| `cmd_list_allowed_paths` | 列出允許的路徑 | 回傳 proxy 可存取的目錄 |
| `file_get_download_uri` | 產生臨時下載 URI | 產生 10 分鐘有效的匿名下載連結 |
| `grep_files` | 以 ripgrep 搜尋內容 | 跨檔案正則搜尋，支援 glob 過濾與上下文行數 |

**額外特性：**
- **Gitignore 過濾**：`fs_search_files` / `fs_directory_tree` 會自動讀取 `.gitignore` 並排除對應檔案
- **Bearer Token 驗證**：可設定 token 保護所有 MCP 端點
- **ripgrep 自動安裝**：若系統未安裝 `rg`，會自動從 GitHub 下載對應平台的 binary
- **反向代理友好**：透過 `X-Forwarded-Proto` / `X-Forwarded-Host` 自動產生正確的對外下載 URI

## 需求

- Python 3.11+
- Node.js + npx（用於啟動 `@modelcontextprotocol/server-filesystem`）

## 安裝

```bash
pip install -r requirements.txt
```

## 設定

### 設定檔 `.mcp-proxy.json`

在工作目錄建立 `.mcp-proxy.json`（或以 `--config` 指定路徑）：

```json
{
  "allowed_paths": ["D:/your/project"],
  "host": "0.0.0.0",
  "port": 8100,
  "bearer-token": "your-secret-token",
  "whitelist-filename": ".cmd_whitelist.json"
}
```

| 欄位 | 預設值 | 說明 |
|------|--------|------|
| `allowed_paths` | `["."]`（當前目錄）| 允許存取的目錄，可多個 |
| `host` | `0.0.0.0` | 監聽位址 |
| `port` | `8100` | 監聽埠號 |
| `bearer-token` | （不驗證）| 設定後所有請求需附帶 `Authorization: Bearer <token>` |
| `whitelist-filename` | `.cmd_whitelist.json` | 命令白名單檔案名稱 |

設定檔搜尋順序：`--config` 引數 → `MCP_PROXY_CONFIG` 環境變數 → `<cwd>/.mcp-proxy.json` → `<cwd>/config/config.json`

### 命令白名單 `.cmd_whitelist.json`

在各 `allowed_path` 根目錄建立白名單，定義允許執行的命令：

```json
{
  "commands": [
    "git status",
    "git log --oneline -20",
    { "command": "npm run build", "description": "執行前端 build" }
  ]
}
```

每個項目可以是純字串，或是包含 `command`（必填）與 `description`（選填）的物件。

**安全注意**：只允許完全符合白名單的命令字串，不支援模糊比對或萬用字元。

## 啟動

```bash
# 使用設定檔（自動搜尋 .mcp-proxy.json）
python proxy_server.py

# 指定參數
python proxy_server.py --host 0.0.0.0 --port 8100 --bearer-token mysecret

# 指定允許路徑（覆蓋設定檔）
python proxy_server.py --allowed-paths D:/project1 D:/project2

# 指定設定檔路徑
python proxy_server.py --config /path/to/config.json
```

啟動後可用的端點：

| 端點 | 說明 |
|------|------|
| `POST /mcp` | MCP Streamable HTTP 端點（主要入口） |
| `GET /health` | 健康檢查，回傳 allowed_paths 與白名單數量 |
| `GET /download/{token}` | 臨時檔案下載（無需 Bearer Token） |

## 連接至 Claude Code

在 Claude Code 的 MCP 設定中新增此 proxy：

```json
{
  "mcpServers": {
    "workspace": {
      "type": "http",
      "url": "http://your-server:8100/mcp",
      "headers": {
        "Authorization": "Bearer your-secret-token"
      }
    }
  }
}
```

## 專案結構

```
external-workspace-mcp/
├── proxy_server.py        # 主程式
├── .mcp-proxy.json        # 伺服器設定
├── .cmd_whitelist.json    # 命令白名單（範例）
├── requirements.txt       # Python 依賴
└── bin/                   # ripgrep binary 自動下載位置（.gitignore 建議排除）
```

## 授權

MIT
