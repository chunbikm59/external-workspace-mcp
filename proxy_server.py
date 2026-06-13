"""
MCP Unified Proxy Server

整合 @modelcontextprotocol/server-filesystem 與命令白名單執行工具，
共享同一份 allowed_paths。

啟動方式：
    python proxy_server.py [--host HOST] [--port PORT] [--bearer-token TOKEN] [--config PATH]
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import platform
import subprocess
import sys
import shutil
import tarfile
import time
import urllib.request
import uuid
import zipfile
from pathlib import Path
from typing import Any

import mcp.types as mt
from fastmcp.server.middleware import Middleware, MiddlewareContext
from fastmcp.server.middleware.middleware import CallNext, ToolResult

import uvicorn
from fastmcp import FastMCP
from fastmcp.server import create_proxy
from fastmcp.server.context import Context
from fastmcp.client import Client
from fastmcp.client.transports import StdioTransport
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, Response
from starlette.routing import Route

logger = logging.getLogger(__name__)

# ── Gitignore 排除 middleware ──────────────────────────────────────────────────

# 會自動注入 excludePatterns 的工具名稱（含 fs namespace 前綴）
_TOOLS_WITH_EXCLUDE = {"fs_search_files", "fs_directory_tree"}


def _gitignore_to_minimatch(pattern: str) -> list[str]:
    """將單一 gitignore pattern 轉換為 minimatch 相容的 glob patterns。"""
    p = pattern.strip()
    if not p or p.startswith("#"):
        return []
    # 目錄專用 pattern（尾斜線）：.venv/ → .venv 和 .venv/**
    if p.endswith("/"):
        base = p.rstrip("/")
        return [base, f"{base}/**"]
    # 無路徑分隔符的 pattern（如 *.pyc）在 gitignore 語意上匹配任意層級
    # minimatch 需要明確加上 **/ 前綴才能跨目錄匹配
    if "/" not in p:
        return [p, f"**/{p}"]
    return [p]


def _load_gitignore_patterns(allowed_paths: list[Path]) -> list[str]:
    """從各 allowed_path 讀取 .gitignore，回傳 minimatch 相容的 pattern 清單。"""
    patterns: list[str] = []
    for base in allowed_paths:
        gi = base / ".gitignore"
        if gi.is_file():
            try:
                for line in gi.read_text(encoding="utf-8").splitlines():
                    patterns.extend(_gitignore_to_minimatch(line))
            except Exception as exc:
                logger.warning("讀取 .gitignore 失敗：%s", exc)
    return patterns


class GitignoreExcludeMiddleware(Middleware):
    """在 search_files / directory_tree 的請求參數中自動注入 gitignore excludePatterns。"""

    def __init__(self, allowed_paths: list[Path]) -> None:
        self._allowed_paths = allowed_paths

    async def on_call_tool(
        self,
        context: MiddlewareContext[mt.CallToolRequestParams],
        call_next: CallNext[mt.CallToolRequestParams, ToolResult],
    ) -> ToolResult:
        params = context.message
        if params.name in _TOOLS_WITH_EXCLUDE:
            patterns = _load_gitignore_patterns(self._allowed_paths)
            if patterns:
                existing = list(params.arguments.get("excludePatterns", []) if params.arguments else [])
                merged = list(dict.fromkeys(existing + patterns))  # 去重保序
                new_args = {**(params.arguments or {}), "excludePatterns": merged}
                new_params = mt.CallToolRequestParams(name=params.name, arguments=new_args)
                context = context.copy(message=new_params)
        return await call_next(context)


# ── 設定載入 ──────────────────────────────────────────────────────────────────

DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 8100
DEFAULT_WHITELIST_FILENAME = ".cmd_whitelist.json"


def _load_config(cli_config: str | None) -> dict[str, Any]:
    """依優先順序搜尋設定檔，回傳設定 dict（可能為空）。"""
    candidates: list[Path] = []

    if cli_config:
        candidates.append(Path(cli_config))
    else:
        env_path = os.environ.get("MCP_PROXY_CONFIG")
        if env_path:
            candidates.append(Path(env_path))
        cwd = Path.cwd()
        candidates.append(cwd / ".mcp-proxy.json")
        candidates.append(cwd / "config" / "config.json")

    for path in candidates:
        if path.is_file():
            logger.info("載入設定檔：%s", path)
            with path.open(encoding="utf-8") as f:
                return json.load(f)

    logger.info("未找到設定檔，使用預設值（cwd 作為 allowed_path）")
    return {}


def _resolve_allowed_paths(config: dict[str, Any]) -> list[Path]:
    """解析 allowed_paths，預設為當前工作目錄。"""
    raw = config.get("allowed_paths")
    if not raw:
        return [Path.cwd().resolve()]
    return [Path(p).resolve() for p in raw]


def _load_whitelist(allowed_paths: list[Path], filename: str) -> list[str]:
    """從每個 allowed_path 根目錄讀取白名單，合併後回傳命令列表。"""
    commands: list[str] = []
    for base in allowed_paths:
        wl_file = base / filename
        if not wl_file.is_file():
            continue
        try:
            data = json.loads(wl_file.read_text(encoding="utf-8"))
            for entry in data.get("commands", []):
                if isinstance(entry, str):
                    commands.append(entry)
                elif isinstance(entry, dict):
                    cmd = entry.get("command")
                    if cmd:
                        commands.append(cmd)
        except Exception as exc:
            logger.warning("讀取白名單 %s 失敗：%s", wl_file, exc)
    return commands


def _build_shell_args(command: str) -> list[str]:
    """依作業系統回傳對應的 shell 呼叫參數。"""
    if platform.system() == "Windows":
        return ["powershell", "-NoProfile", "-NonInteractive", "-Command", command]
    return ["/bin/sh", "-c", command]


# ── 命令執行工具 ──────────────────────────────────────────────────────────────

def _build_cmd_server(
    allowed_paths: list[Path],
    whitelist: list[str],
    whitelist_filename: str = DEFAULT_WHITELIST_FILENAME,
) -> FastMCP:
    """建立內含命令白名單執行工具的 FastMCP 子伺服器。"""
    cmd_mcp = FastMCP(name="命令白名單執行器")

    # 產生每個命令對應的描述 map（供白名單讀取描述）
    cmd_descriptions: dict[str, str] = {}
    for base in allowed_paths:
        wl_file = base / whitelist_filename
        if not wl_file.is_file():
            continue
        try:
            data = json.loads(wl_file.read_text(encoding="utf-8"))
            for entry in data.get("commands", []):
                if isinstance(entry, dict):
                    cmd = entry.get("command", "")
                    desc = entry.get("description", "")
                    if cmd:
                        cmd_descriptions[cmd] = desc
        except Exception:
            pass

    # 產生白名單說明文字供 LLM 參考
    whitelist_doc = "\n".join(
        f"  - `{cmd}`" + (f"  # {cmd_descriptions[cmd]}" if cmd_descriptions.get(cmd) else "")
        for cmd in whitelist
    ) or "  （白名單為空）"

    @cmd_mcp.tool()
    def run_command(command: str) -> dict[str, Any]:
        if command not in whitelist:
            return {
                "success": False,
                "error": f"命令 '{command}' 不在白名單中。允許的命令：{whitelist}",
            }

        # 在第一個 allowed_path 下執行
        cwd = str(allowed_paths[0]) if allowed_paths else None

        try:
            result = subprocess.run(
                _build_shell_args(command),
                capture_output=True,
                text=True,
                cwd=cwd,
                timeout=120,
            )
            return {
                "success": result.returncode == 0,
                "returncode": result.returncode,
                "stdout": result.stdout,
                "stderr": result.stderr,
            }
        except subprocess.TimeoutExpired:
            return {"success": False, "error": "命令執行超時（120 秒）"}
        except Exception as exc:
            return {"success": False, "error": str(exc)}

    _cwd_display = str(allowed_paths[0]) if allowed_paths else "（無）"
    run_command.__doc__ = f"""執行白名單中的命令（Windows 使用 PowerShell，其他平台使用 /bin/sh）。

工作目錄：{_cwd_display}（第一個 allowed_path）

允許的命令：
{whitelist_doc}

回傳值（dict）：
  success    (bool) — returncode == 0 時為 True
  returncode (int)  — shell 結束碼
  stdout     (str)  — 標準輸出內容
  stderr     (str)  — 標準錯誤內容

失敗時回傳：{{"success": false, "error": "<原因>"}}

注意：命令必須與白名單完全符合，不支援模糊比對。
若不確定有哪些命令可用，請先呼叫 cmd_list_allowed_commands 或 cmd_workspace_context。
"""

    @cmd_mcp.tool()
    def list_allowed_commands() -> dict[str, Any]:
        """列出白名單中所有允許執行的命令。

        若不確定 cmd_run_command 可以執行哪些命令，請先呼叫此工具。
        （也可呼叫 cmd_workspace_context 一次取得路徑 + 命令 + 目錄結構）

        回傳值（dict）：
          allowed_commands : list[{command, description}] — 所有可用命令及其說明
          total            : int — 命令總數
        """
        items = []
        for cmd in whitelist:
            items.append({
                "command": cmd,
                "description": cmd_descriptions.get(cmd, ""),
            })
        return {"allowed_commands": items, "total": len(items)}

    @cmd_mcp.tool()
    def list_allowed_paths() -> dict[str, Any]:
        """列出此 proxy 允許存取的所有目錄路徑。

        回傳值（dict）：
          allowed_paths : list[str] — 可存取的絕對路徑清單

        請將這些路徑作為 grep_files 的 path 參數起點，
        或傳入 fs_directory_tree 展開目錄結構。
        """
        return {"allowed_paths": [str(p) for p in allowed_paths]}

    @cmd_mcp.tool()
    def workspace_context() -> dict[str, Any]:
        """取得完整工作區概覽，供 agent 初始定向使用。

        第一次連線時請優先呼叫此工具，可一次取得：
          allowed_paths    : list[str]                     — 此伺服器可存取的根目錄
          allowed_commands : list[{command, description}]  — 可執行的白名單命令
          directory_trees  : dict[path, list[str]]         — 各根目錄的頂層子項目

        取得概覽後，可用 fs_directory_tree 深入展開子目錄、grep_files 搜尋內容、
        cmd_run_command 執行命令。
        """
        trees: dict[str, list[str]] = {}
        for base in allowed_paths:
            try:
                children = sorted(str(p.relative_to(base)) for p in base.iterdir())
            except Exception:
                children = []
            trees[str(base)] = children

        items = [
            {"command": cmd, "description": cmd_descriptions.get(cmd, "")}
            for cmd in whitelist
        ]
        return {
            "allowed_paths": [str(p) for p in allowed_paths],
            "allowed_commands": items,
            "directory_trees": trees,
        }

    return cmd_mcp


# ── 臨時下載 token 儲存（token -> (path, expire_at)）──────────────────────────

_download_tokens: dict[str, tuple[Path, float]] = {}
_session_base_urls: dict[str, str] = {}  # session_id -> "https://host"

DOWNLOAD_TOKEN_TTL = 600  # 秒


def _purge_expired_tokens() -> None:
    now = time.time()
    expired = [k for k, (_, exp) in _download_tokens.items() if now > exp]
    for k in expired:
        del _download_tokens[k]


def _build_file_server(
    allowed_paths: list[Path],
    fallback_host: str,
    port: int,
) -> FastMCP:
    """建立提供臨時下載 URI 的 FastMCP 子伺服器。"""
    file_mcp = FastMCP(name="檔案下載 URI 產生器")

    @file_mcp.tool()
    def get_download_uri(file_path: str, ctx: Context) -> dict[str, Any]:
        """產生指定檔案的臨時 HTTP 下載 URI（10 分鐘有效），供遠端 agent 或使用者直接下載。

        適用情境：
          - 檔案為二進位格式（圖片、壓縮檔、PDF）—— 無法以文字讀取
          - 需要讓使用者或另一個服務透過 HTTP 下載（wget / curl / 瀏覽器）
          - 檔案過大，直接讀取會超出 context 限制

        請勿用於讀取文字檔 —— 直接用 fs_read_file 即可。

        file_path 必須為絕對路徑且在 allowed_paths 範圍內。
        請從 cmd_list_allowed_paths 或 cmd_workspace_context 取得有效的根路徑。
        回傳的 uri 可直接以 wget / curl / requests.get 下載，不需附帶 Authorization header。

        成功回傳（dict）：
          success            (bool) — True
          uri                (str)  — HTTP 下載網址，有效期間為 expires_in_seconds 秒
          expires_in_seconds (int)  — 600（10 分鐘）
          file_name          (str)  — 檔案名稱

        失敗回傳（dict）：
          success (bool) — False
          error   (str)  — 失敗原因
        """
        _purge_expired_tokens()

        path = Path(file_path).resolve()

        if not path.is_file():
            return {"success": False, "error": f"檔案不存在：{file_path}"}

        if not any(
            path == base or base in path.parents
            for base in allowed_paths
        ):
            return {"success": False, "error": "檔案不在允許的目錄範圍內"}

        token = str(uuid.uuid4())
        _download_tokens[token] = (path, time.time() + DOWNLOAD_TOKEN_TTL)

        session_id = ctx.session_id
        base = _session_base_urls.get(session_id)
        if not base:
            display_host = "localhost" if fallback_host in ("0.0.0.0", "") else fallback_host
            base = f"http://{display_host}:{port}"

        uri = f"{base}/download/{token}"
        return {
            "success": True,
            "uri": uri,
            "expires_in_seconds": DOWNLOAD_TOKEN_TTL,
            "file_name": path.name,
        }

    return file_mcp


# ── ripgrep 自動安裝 ──────────────────────────────────────────────────────────

_RG_LOCAL_DIR = Path(__file__).parent / "bin"
_RG_GITHUB_VERSION = "15.1.0"


def _ensure_ripgrep() -> str:
    """確保 rg binary 可用，回傳執行路徑。若系統沒有則自動從 GitHub 下載。"""
    system_rg = shutil.which("rg")
    if system_rg:
        return system_rg

    local_rg = _RG_LOCAL_DIR / ("rg.exe" if platform.system() == "Windows" else "rg")
    if local_rg.is_file():
        return str(local_rg)

    system = platform.system()
    machine = platform.machine().lower()

    if system == "Windows":
        if machine in ("amd64", "x86_64"):
            asset = f"ripgrep-{_RG_GITHUB_VERSION}-x86_64-pc-windows-msvc.zip"
        elif machine == "arm64":
            asset = f"ripgrep-{_RG_GITHUB_VERSION}-aarch64-pc-windows-msvc.zip"
        else:
            raise RuntimeError(f"不支援的 Windows 架構：{machine}")
    elif system == "Darwin":
        if machine == "arm64":
            asset = f"ripgrep-{_RG_GITHUB_VERSION}-aarch64-apple-darwin.tar.gz"
        else:
            asset = f"ripgrep-{_RG_GITHUB_VERSION}-x86_64-apple-darwin.tar.gz"
    elif system == "Linux":
        if machine in ("amd64", "x86_64"):
            asset = f"ripgrep-{_RG_GITHUB_VERSION}-x86_64-unknown-linux-gnu.tar.gz"
        elif machine == "aarch64":
            asset = f"ripgrep-{_RG_GITHUB_VERSION}-aarch64-unknown-linux-gnu.tar.gz"
        else:
            raise RuntimeError(f"不支援的 Linux 架構：{machine}")
    else:
        raise RuntimeError(f"不支援的作業系統：{system}")

    url = f"https://github.com/BurntSushi/ripgrep/releases/download/{_RG_GITHUB_VERSION}/{asset}"
    download_path = _RG_LOCAL_DIR / asset

    print(f"[INFO] 找不到 ripgrep，從 GitHub 下載：{url}")
    _RG_LOCAL_DIR.mkdir(parents=True, exist_ok=True)

    try:
        urllib.request.urlretrieve(url, download_path)
    except Exception as exc:
        raise RuntimeError(f"下載 ripgrep 失敗：{exc}") from exc

    rg_name = "rg.exe" if system == "Windows" else "rg"
    try:
        if asset.endswith(".zip"):
            with zipfile.ZipFile(download_path) as zf:
                rg_entry = next(n for n in zf.namelist() if n.endswith(rg_name))
                with zf.open(rg_entry) as src, open(local_rg, "wb") as dst:
                    dst.write(src.read())
        else:
            with tarfile.open(download_path) as tf:
                rg_entry = next(m for m in tf.getmembers() if m.name.endswith(rg_name))
                src = tf.extractfile(rg_entry)
                local_rg.write_bytes(src.read())
    finally:
        download_path.unlink(missing_ok=True)

    if system != "Windows":
        local_rg.chmod(0o755)

    print(f"[INFO] ripgrep 已安裝至：{local_rg}")
    return str(local_rg)


# ── 檔案內容搜尋工具（ripgrep）────────────────────────────────────────────────

def _build_grep_server(allowed_paths: list[Path], rg_path: str) -> FastMCP:
    """建立以 ripgrep 提供檔案內容搜尋功能的 FastMCP 子伺服器。"""
    grep_mcp = FastMCP(name="檔案內容搜尋器")

    @grep_mcp.tool()
    def grep_files(
        pattern: str,
        path: str,
        glob: str = "",
        context_lines: int = 3,
        ignore_case: bool = False,
        head_limit: int = 250,
        fixed_strings: bool = False,
    ) -> str:
        """以 ripgrep 在允許目錄內搜尋檔案內容，回傳匹配行與上下文。

        參數：
            pattern       — ripgrep 正則表達式（或 fixed_strings=True 時為純字串）
                            範例：'TODO'、'def \\w+'、'import os'
            path          — 要搜尋的絕對路徑（必須在 allowed_paths 範圍內）
                            請從 cmd_list_allowed_paths 或 cmd_workspace_context 取得有效路徑
            glob          — 檔案過濾 glob，例如 '*.py'、'*.{ts,tsx}'（空字串 = 不限）
            context_lines — 每個匹配前後顯示的行數（0–10，預設 3）
            ignore_case   — 是否忽略大小寫（預設 False）
            head_limit    — 輸出截斷行數（預設 250；0 = 不限）
            fixed_strings — True 表示純字串比對（停用 regex，等同 rg -F）

        輸出格式（純文字）：
            <檔案名稱>
            <行號>:<匹配行>
            <上下文行>
            --          （匹配之間的分隔符）

        無匹配時回傳以 [NO MATCH] 開頭的說明字串。
        錯誤時回傳以 [ERROR] 開頭的說明字串。

        建議：內容搜尋請優先用 grep_files（比 fs_search_files 更快且有上下文）；
              只需搜尋檔名時才使用 fs_search_files。
        """
        search_path = Path(path).resolve()
        if not any(search_path == base or base in search_path.parents for base in allowed_paths):
            return "[ERROR] 路徑不在允許範圍內。請用 cmd_list_allowed_paths 取得有效路徑。"

        if not search_path.exists():
            return f"[ERROR] 路徑不存在：{path}"

        context_lines = max(0, min(10, context_lines))
        cmd: list[str] = [rg_path, "--color=never", "--heading", "--line-number"]
        cmd += [f"--context={context_lines}"]
        if ignore_case:
            cmd.append("--ignore-case")
        if fixed_strings:
            cmd.append("--fixed-strings")
        if glob:
            cmd += ["--glob", glob]
        cmd += [pattern, str(search_path)]

        try:
            result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", timeout=30)
        except subprocess.TimeoutExpired:
            return "[ERROR] 搜尋超時（30 秒）。請縮小搜尋路徑或加上 glob 過濾。"

        if result.returncode == 2:
            return f"[ERROR] {(result.stderr or '').strip() or '執行 rg 失敗'}"
        if result.returncode == 1:
            return f"[NO MATCH] pattern={pattern!r} 在 {path} 中無符合結果"

        lines = (result.stdout or "").splitlines()
        if head_limit > 0 and len(lines) > head_limit:
            lines = lines[:head_limit]
            lines.append(f"--- 輸出已截斷（前 {head_limit} 行），請縮小搜尋範圍或使用 glob 過濾 ---")

        return "\n".join(lines)

    return grep_mcp


# ── 主程式 ────────────────────────────────────────────────────────────────────

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

    # 1. 建立主 proxy 伺服器，掛載 gitignore middleware（每次 tool call 動態讀取 .gitignore）
    _instructions = """\
此伺服器提供工作區存取，整合了以下工具命名空間：

- fs_*                  ：讀寫檔案、列目錄、搜尋檔名（來自 @modelcontextprotocol/server-filesystem）
- cmd_*                 ：執行白名單命令、列出可用命令與路徑、取得工作區概覽
- grep_files            ：以 ripgrep 搜尋檔案內容（比 fs_search_files 更快且顯示上下文）
- file_get_download_uri ：產生 10 分鐘有效的匿名 HTTP 下載連結

建議的初始步驟：
1. 呼叫 cmd_workspace_context 一次取得完整環境概覽（允許路徑、命令清單、頂層目錄）
2. 使用 grep_files 搜尋內容，fs_directory_tree 展開子目錄
3. 以 cmd_run_command 執行命令（命令字串必須完全符合白名單）

讀取文字檔請用 fs_read_file；只有需要產生 HTTP 下載連結時才用 file_get_download_uri。
"""
    proxy = FastMCP(
        name="MCP Unified Proxy",
        instructions=_instructions,
        middleware=[GitignoreExcludeMiddleware(allowed_paths)],
    )

    # 2. 掛載 filesystem MCP（透過 npx stdio 子程序）
    fs_args = [str(p) for p in allowed_paths]
    fs_transport = StdioTransport(
        command="npx",
        args=["-y", "@modelcontextprotocol/server-filesystem", *fs_args],
    )
    fs_client = Client(fs_transport)
    fs_proxy = create_proxy(fs_client, name="Filesystem")
    proxy.mount(fs_proxy, namespace="fs")

    # 3. 掛載命令白名單工具
    cmd_server = _build_cmd_server(allowed_paths, whitelist, whitelist_filename)
    proxy.mount(cmd_server, namespace="cmd")

    # 4. 掛載檔案下載 URI 工具
    file_server = _build_file_server(allowed_paths, host, port)
    proxy.mount(file_server, namespace="file")

    # 5. 掛載檔案內容搜尋工具（ripgrep）
    grep_server = _build_grep_server(allowed_paths, rg_path)
    proxy.mount(grep_server, namespace="grep")

    # 6. Bearer Token 中介軟體（兼記錄各 session 的反向代理 base URL）
    class BearerAuthMiddleware(BaseHTTPMiddleware):
        async def dispatch(self, request: Request, call_next):
            # /health 與 /download/* 不驗證（token 本身即為憑證）
            if request.url.path == "/health" or request.url.path.startswith("/download/"):
                return await call_next(request)
            if bearer_token:
                auth_header = request.headers.get("Authorization", "")
                if not auth_header.startswith("Bearer ") or auth_header[7:] != bearer_token:
                    return JSONResponse(
                        {"error": "Unauthorized"},
                        status_code=401,
                    )
            # 記錄此 session 對應的 base URL（供 get_download_uri 產生正確的對外位址）
            session_id = request.headers.get("mcp-session-id")
            if session_id:
                proto = request.headers.get("x-forwarded-proto", request.url.scheme)
                fwd_host = request.headers.get("x-forwarded-host", "")
                raw_host = request.headers.get("host", "")
                effective_host = fwd_host or raw_host
                if effective_host:
                    _session_base_urls[session_id] = f"{proto}://{effective_host}"
            return await call_next(request)

    # 7. 取得底層 Starlette app，加入路由與認證中介軟體
    starlette_app = proxy.http_app(transport="streamable-http")

    # 加入 /health 路由
    async def health(request: Request) -> Response:
        return JSONResponse({
            "status": "ok",
            "allowed_paths": [str(p) for p in allowed_paths],
            "whitelist_count": len(whitelist),
        })

    # 加入 /download/{token} 路由
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

    # 加入認證中介軟體
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

    # 載入設定檔
    config = _load_config(args.config)

    # CLI 參數優先於設定檔
    host = args.host or config.get("host", DEFAULT_HOST)
    port = args.port or config.get("port", DEFAULT_PORT)
    bearer_token = args.bearer_token or config.get("bearer-token") or None
    whitelist_filename = config.get("whitelist-filename", DEFAULT_WHITELIST_FILENAME)

    if args.allowed_paths:
        allowed_paths = [Path(p).resolve() for p in args.allowed_paths]
    else:
        allowed_paths = _resolve_allowed_paths(config)
    whitelist = _load_whitelist(allowed_paths, whitelist_filename)

    # 啟動資訊
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
