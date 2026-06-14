"""
MCP Unified Proxy Server

整合 @modelcontextprotocol/server-filesystem 與命令白名單執行工具，
共享同一份 allowed_paths。

啟動方式：
    python proxy_server.py [--host HOST] [--port PORT] [--bearer-token TOKEN] [--config PATH]
"""

from __future__ import annotations

import argparse
import logging
import time
from pathlib import Path
from typing import Any

import uvicorn
from fastmcp import FastMCP
from fastmcp.server import create_proxy
from fastmcp.client import Client
from fastmcp.client.transports import StdioTransport
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, Response
from starlette.routing import Route

from config import (
    DEFAULT_HOST,
    DEFAULT_PORT,
    DEFAULT_WHITELIST_FILENAME,
    _load_config,
    _resolve_allowed_paths,
    _load_whitelist,
)
from middleware import GitignoreExcludeMiddleware, ToolFilterMiddleware
from ripgrep import _ensure_ripgrep
from servers import (
    _download_tokens,
    _purge_expired_tokens,
    _session_base_urls,
    _build_cmd_server,
    _build_file_server,
    _build_grep_server,
    _build_markitdown_server,
    _build_read_server,
)

logger = logging.getLogger(__name__)


def build_app(
    allowed_paths: list[Path],
    whitelist: list[str],
    bearer_token: str | None,
    host: str = DEFAULT_HOST,
    port: int = DEFAULT_PORT,
    whitelist_filename: str = DEFAULT_WHITELIST_FILENAME,
    rg_path: str = "rg",
) -> Any:
    """組裝 FastMCP proxy 並回傳 ASGI app。"""

    _instructions = """\
此伺服器提供工作區存取，整合了以下工具：

讀寫與搜尋（自訂，對齊 CC 工具）：
- read_file             ：讀取文字檔，帶行號輸出，支援 offset+limit 任意行範圍
- grep_files            ：以 ripgrep 搜尋檔案內容，支援 output_mode / 前後文 / 類型過濾
- glob_files            ：以 ripgrep 搜尋檔名，依修改時間排序，尊重 .gitignore

檔案系統（fs_*，來自 @modelcontextprotocol/server-filesystem）：
- fs_write_file / fs_edit_file ：寫入 / 精確字串替換
- fs_directory_tree / fs_list_directory ：目錄展開
- fs_read_media_file   ：讀取圖片/音訊（base64）
- fs_get_file_info / fs_move_file 等其他工具

命令執行（cmd_*）：
- cmd_workspace_context ：一次取得路徑 + 命令 + 目錄結構（建議先呼叫）
- cmd_run_command       ：執行白名單命令
- cmd_list_allowed_commands

其他：
- file_get_download_uri ：產生 10 分鐘有效的匿名 HTTP 下載連結

建議的初始步驟：
1. 呼叫 cmd_workspace_context 取得完整環境概覽
2. 用 read_file 讀取文字檔，grep_files 搜尋內容，glob_files 搜尋檔名
3. 用 cmd_run_command 執行命令（必須完全符合白名單）

讀取文字檔請用 read_file（不是 fs_read_text_file，該工具已停用）。
產生 HTTP 下載連結才用 file_get_download_uri。
"""
    proxy = FastMCP(
        name="MCP Unified Proxy",
        instructions=_instructions,
        middleware=[ToolFilterMiddleware(), GitignoreExcludeMiddleware(allowed_paths)],
    )

    fs_args = [str(p) for p in allowed_paths]
    fs_transport = StdioTransport(
        command="npx",
        args=["-y", "@modelcontextprotocol/server-filesystem", *fs_args],
    )
    fs_client = Client(fs_transport)
    fs_proxy = create_proxy(fs_client, name="Filesystem")
    proxy.mount(fs_proxy, namespace="fs")

    cmd_server = _build_cmd_server(allowed_paths, whitelist, whitelist_filename)
    proxy.mount(cmd_server, namespace="cmd")

    file_server = _build_file_server(allowed_paths, host, port)
    proxy.mount(file_server, namespace="file")

    read_server = _build_read_server(allowed_paths)
    proxy.mount(read_server)

    grep_server = _build_grep_server(allowed_paths, rg_path)
    proxy.mount(grep_server)

    markitdown_server = _build_markitdown_server(allowed_paths)
    proxy.mount(markitdown_server, namespace="md")

    class BearerAuthMiddleware(BaseHTTPMiddleware):
        async def dispatch(self, request: Request, call_next):
            if request.url.path == "/health" or request.url.path.startswith("/download/"):
                return await call_next(request)
            if bearer_token:
                auth_header = request.headers.get("Authorization", "")
                if not auth_header.startswith("Bearer ") or auth_header[7:] != bearer_token:
                    return JSONResponse({"error": "Unauthorized"}, status_code=401)
            session_id = request.headers.get("mcp-session-id")
            if session_id:
                proto = request.headers.get("x-forwarded-proto", request.url.scheme)
                fwd_host = request.headers.get("x-forwarded-host", "")
                raw_host = request.headers.get("host", "")
                effective_host = fwd_host or raw_host
                if effective_host:
                    _session_base_urls[session_id] = f"{proto}://{effective_host}"
            return await call_next(request)

    starlette_app = proxy.http_app(transport="streamable-http")

    async def health(request: Request) -> Response:
        return JSONResponse({
            "status": "ok",
            "allowed_paths": [str(p) for p in allowed_paths],
            "whitelist_count": len(whitelist),
        })

    async def download(request: Request) -> Response:
        _purge_expired_tokens()
        token = request.path_params["token"]
        entry = _download_tokens.get(token)
        if entry is None:
            return JSONResponse({"error": "Token 無效或已過期"}, status_code=404)
        path, expire_at = entry
        if time.time() > expire_at:
            del _download_tokens[token]
            return JSONResponse({"error": "Token 已過期"}, status_code=410)
        if not path.is_file():
            return JSONResponse({"error": "檔案不存在"}, status_code=404)
        return FileResponse(str(path), filename=path.name)

    starlette_app.routes.insert(0, Route("/health", health, methods=["GET"]))
    starlette_app.routes.insert(1, Route("/download/{token}", download, methods=["GET"]))
    starlette_app.add_middleware(BearerAuthMiddleware)

    return starlette_app


def main() -> None:
    parser = argparse.ArgumentParser(description="MCP Unified Proxy Server")
    parser.add_argument("--host", default=None, help=f"監聽位址（預設 {DEFAULT_HOST}）")
    parser.add_argument("--port", type=int, default=None, help=f"監聽埠號（預設 {DEFAULT_PORT}）")
    parser.add_argument("--bearer-token", default=None, help="Bearer Token（不設定則不驗證）")
    parser.add_argument("--config", default=None, help="設定檔路徑")
    parser.add_argument(
        "--allowed-paths",
        nargs="+",
        default=None,
        metavar="PATH",
        help="允許存取的目錄（可多個，空格分隔；優先於設定檔）",
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    config = _load_config(args.config)

    host = args.host or config.get("host", DEFAULT_HOST)
    port = args.port or config.get("port", DEFAULT_PORT)
    bearer_token = args.bearer_token or config.get("bearer-token") or None
    whitelist_filename = config.get("whitelist-filename", DEFAULT_WHITELIST_FILENAME)

    if args.allowed_paths:
        allowed_paths = [Path(p).resolve() for p in args.allowed_paths]
    else:
        allowed_paths = _resolve_allowed_paths(config)
    whitelist = _load_whitelist(allowed_paths, whitelist_filename)

    print(f"[INFO] MCP Unified Proxy 啟動中")
    print(f"[INFO] 監聽：http://{host}:{port}/mcp")
    print(f"[INFO] 健康檢查：http://{host}:{port}/health")
    print(f"[INFO] Allowed paths：{[str(p) for p in allowed_paths]}")
    print(f"[INFO] 白名單命令數：{len(whitelist)}")
    if bearer_token:
        print(f"[INFO] Bearer Token 驗證：已啟用")
    else:
        print(f"[WARN] Bearer Token 驗證：未設定（所有請求均可存取）")

    rg_path = _ensure_ripgrep()
    print(f"[INFO] 使用 ripgrep：{rg_path}")

    app = build_app(allowed_paths, whitelist, bearer_token, host, port, whitelist_filename, rg_path)

    uvicorn.run(app, host=host, port=port)


if __name__ == "__main__":
    main()
