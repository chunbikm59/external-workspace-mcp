# external-workspace-mcp

一個整合式 MCP（Model Context Protocol）Proxy 伺服器，將檔案系統存取、命令白名單執行、檔案下載、內容搜尋與文件轉換功能統一透過單一 HTTP 端點提供給遠端 AI agent 使用。

## 功能概覽

| 工具 | 說明 |
|------|------|
| `read_file` | 讀取文字檔，帶行號輸出，支援 offset/limit 分段讀取 |
| `grep_files` | 以 ripgrep 搜尋檔案內容，支援三種輸出模式、前後文、類型過濾 |
| `glob_files` | 以 glob pattern 搜尋檔名，依修改時間排序，尊重 .gitignore |
| `fs_*` | 來自 `@modelcontextprotocol/server-filesystem`（寫檔、目錄操作、媒體讀取等） |
| `cmd_workspace_context` | 一次取得路徑 + 命令 + 頂層目錄結構（建議連線後第一步呼叫） |
| `cmd_run_command` | 執行白名單命令，支援 `;` 串接多個命令 |
| `cmd_list_allowed_commands` | 列出白名單命令及說明 |
| `cmd_reload_whitelist` | 重新從磁碟載入白名單（需本機使用者確認） |
| `file_get_download_uri` | 產生 10 分鐘有效的匿名 HTTP 下載連結 |
| `md_convert_to_markdown` | 將 PDF、DOCX、PPTX、XLSX、HTML、圖片等轉換為 Markdown 並寫入硬碟 |

**額外特性：**
- **Gitignore 過濾**：`fs_directory_tree` 自動讀取 `.gitignore` 並排除對應檔案
- **工具隱藏**：已被自訂工具取代的 `fs_read_file`、`fs_read_text_file`、`fs_search_files` 自動隱藏
- **Bearer Token 驗證**：可設定 token 保護所有 MCP 端點
- **ripgrep 自動安裝**：若系統未安裝 `rg`，會自動從 GitHub 下載對應平台的 binary
- **串接命令**：`cmd_run_command` 支援以 `;` 串接多個白名單命令依序執行

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
**串接執行**：可用 `"git status; git log --oneline -20"` 一次呼叫執行多個白名單命令，任一命令失敗時預設停止（可透過 `fail_fast=false` 調整）。

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

## 建議使用流程

1. 呼叫 `cmd_workspace_context` 取得工作區完整概覽（路徑、可用命令、頂層目錄結構）
2. 用 `read_file` 讀取文字檔、`grep_files` 搜尋內容、`glob_files` 搜尋檔名
3. 用 `fs_write_file` / `fs_edit_file` 寫入或修改檔案
4. 用 `cmd_run_command` 執行命令（必須完全符合白名單）
5. 需要下載二進位檔案時，用 `file_get_download_uri` 產生臨時連結
6. 需要轉換 PDF/Office 文件時，用 `md_convert_to_markdown`

## 專案結構

```
external-workspace-mcp/
├── proxy_server.py        # 主程式：組裝 proxy、路由、middleware、啟動 uvicorn
├── config.py              # 設定載入、白名單解析、shell 命令建構
├── middleware.py           # GitignoreExcludeMiddleware、ToolFilterMiddleware
├── servers.py             # 各子伺服器工具定義（cmd/file/read/grep/markitdown）
├── ripgrep.py             # ripgrep binary 自動下載與管理
├── .mcp-proxy.json        # 伺服器設定
├── .cmd_whitelist.json    # 命令白名單（範例）
├── requirements.txt       # Python 依賴
└── bin/                   # ripgrep binary 自動下載位置（建議加入 .gitignore）
```

## 授權

MIT
