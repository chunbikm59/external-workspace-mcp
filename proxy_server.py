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
from markitdown import MarkItDown

logger = logging.getLogger(__name__)

# ── Gitignore 排除 middleware ──────────────────────────────────────────────────

# 會自動注入 excludePatterns 的工具名稱（含 fs namespace 前綴）
_TOOLS_WITH_EXCLUDE = {"fs_directory_tree"}

# 被自訂工具取代、應從 agent 工具清單中隱藏的 fs_* 工具
_FS_TOOLS_EXCLUDED = {"fs_read_file", "fs_read_text_file", "fs_search_files"}


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


class ToolFilterMiddleware(Middleware):
    """隱藏被自訂工具取代的 fs_* 工具，讓 agent 不再看到已棄用或已被取代的工具。"""

    async def on_list_tools(self, context, call_next):
        tools = await call_next(context)
        return [t for t in tools if t.name not in _FS_TOOLS_EXCLUDED]

    async def on_call_tool(
        self,
        context: MiddlewareContext[mt.CallToolRequestParams],
        call_next: CallNext[mt.CallToolRequestParams, ToolResult],
    ) -> ToolResult:
        if context.message.name in _FS_TOOLS_EXCLUDED:
            raise ValueError(
                f"工具 '{context.message.name}' 已停用。"
                f"請改用：read_file（讀取文字）、glob_files（搜尋檔名）。"
            )
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

        請將這些路徑作為 read_file / grep_files / glob_files 的 path 參數起點，
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

        取得概覽後，可用 read_file 讀取文字檔、grep_files 搜尋內容、
        glob_files 搜尋檔名、fs_directory_tree 展開目錄、cmd_run_command 執行命令。
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

        請勿用於讀取文字檔 —— 直接用 read_file 即可。

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


# ── 增強文字讀取工具（取代 fs_read_text_file）────────────────────────────────────

def _build_read_server(allowed_paths: list[Path]) -> FastMCP:
    """建立帶行號、支援 offset/limit 的文字讀取工具。"""
    read_mcp = FastMCP(name="增強文字讀取器")

    @read_mcp.tool()
    def read_file(path: str, offset: int = 0, limit: int = 0) -> dict[str, Any]:
        """讀取文字檔，回傳帶行號的內容（對齊 CC Read 工具）。

        此工具取代 fs_read_text_file，提供行號輸出與任意行範圍支援。
        二進位檔案（圖片、音訊）請改用 fs_read_media_file。

        參數：
          path   — 絕對路徑（從 cmd_workspace_context 取得根路徑）
          offset — 起始行（0-indexed，預設 0 = 從第一行）
          limit  — 讀取行數（預設 0 = 全部；大型檔案建議設定此值）

        成功回傳（dict）：
          file_path   (str)  — 讀取的絕對路徑
          content     (str)  — 帶行號內容，格式："{行號}\\t{該行內容}"
          num_lines   (int)  — 本次回傳行數
          start_line  (int)  — 起始行號（1-indexed）
          total_lines (int)  — 檔案總行數（供判斷是否已讀完整個檔案）

        失敗回傳（dict）：
          error (str) — 失敗原因（以 [ERROR] 開頭）
        """
        file_path = Path(path).resolve()
        if not any(file_path == base or base in file_path.parents for base in allowed_paths):
            return {"error": "[ERROR] 路徑不在允許範圍內。請用 cmd_list_allowed_paths 取得有效路徑。"}
        if not file_path.is_file():
            return {"error": f"[ERROR] 檔案不存在：{path}"}
        try:
            all_lines = file_path.read_text(encoding="utf-8", errors="replace").splitlines()
        except Exception as exc:
            return {"error": f"[ERROR] 讀取失敗：{exc}"}

        total_lines = len(all_lines)
        chunk = all_lines[offset: (offset + limit) if limit else None]
        start_line = offset + 1  # 1-indexed，與 CC Read 一致
        content = "\n".join(f"{start_line + i}\t{line}" for i, line in enumerate(chunk))

        return {
            "file_path": str(file_path),
            "content": content,
            "num_lines": len(chunk),
            "start_line": start_line,
            "total_lines": total_lines,
        }

    return read_mcp


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


# ── 檔案內容搜尋與檔名搜尋工具（ripgrep）────────────────────────────────────────

# 自動排除的版本控制目錄 glob（rg 預設也會排除 .git，這裡明確加上其他 VCS）
_VCS_EXCLUDE_GLOBS = ["!.svn", "!.hg", "!.jj", "!.bzr"]


def _build_grep_server(allowed_paths: list[Path], rg_path: str) -> FastMCP:
    """建立以 ripgrep 提供檔案內容搜尋（grep_files）與檔名搜尋（glob_files）的子伺服器。"""
    grep_mcp = FastMCP(name="ripgrep 搜尋工具")

    @grep_mcp.tool()
    def grep_files(
        pattern: str,
        path: str,
        output_mode: str = "content",
        glob: str = "",
        file_type: str = "",
        context_lines: int = 0,
        before_context: int = 0,
        after_context: int = 0,
        ignore_case: bool = False,
        head_limit: int = 250,
        offset: int = 0,
        fixed_strings: bool = False,
        multiline: bool = False,
    ) -> dict[str, Any]:
        """以 ripgrep 搜尋檔案內容（對齊 CC Grep 工具）。自動排除 VCS 目錄（.git 等）。

        參數：
          pattern        — 搜尋的正則表達式（或 fixed_strings=True 時為純字串）
                           範例：'TODO'、'def \\w+'、'import os'
          path           — 要搜尋的絕對路徑（必須在 allowed_paths 範圍內）
                           請從 cmd_workspace_context 取得有效路徑
          output_mode    — 輸出模式（預設 "content"）：
                           "content"           — 回傳匹配行與上下文（純文字）
                           "files_with_matches"— 只回傳有匹配的檔案清單
                           "count"             — 回傳各檔案的匹配數量
          glob           — 檔案過濾 glob，例如 '*.py'、'*.{ts,tsx}'（空字串 = 不限）
          file_type      — ripgrep 檔案類型，例如 'py'、'ts'、'rust'（空字串 = 不限）
                           比 glob 更簡潔；可用 rg --type-list 查詢支援的類型
          context_lines  — 匹配前後對稱顯示行數（等同 -C，預設 0）
          before_context — 匹配前顯示行數（等同 -B，預設 0）
          after_context  — 匹配後顯示行數（等同 -A，預設 0）
          ignore_case    — 忽略大小寫（預設 False）
          head_limit     — 輸出截斷行數/筆數（預設 250；0 = 不限）
          offset         — 跳過前 N 行結果（分頁用，預設 0）
          fixed_strings  — True 表示純字串比對（停用 regex，等同 rg -F）
          multiline      — 啟用多行模式（. 可匹配換行，預設 False）

        回傳（dict）— 依 output_mode：

        output_mode="content"：
          mode          (str)       — "content"
          num_files     (int)       — 匹配到的檔案數
          filenames     (list[str]) — 匹配到的檔案路徑清單
          content       (str)       — 匹配行與上下文（純文字）
          num_lines     (int)       — 本次回傳行數
          applied_limit (int)       — 實際套用的 head_limit（0 表示未截斷）
          applied_offset (int)      — 實際套用的 offset

        output_mode="files_with_matches"：
          mode      (str)       — "files_with_matches"
          num_files (int)       — 匹配到的檔案數
          filenames (list[str]) — 匹配到的檔案路徑清單

        output_mode="count"：
          mode        (str)       — "count"
          num_matches (int)       — 全部匹配總數
          per_file    (list[dict])— 各檔案的 {file, count}

        錯誤時回傳：{"error": "[ERROR] <原因>"}
        無匹配時回傳：{"mode": ..., "num_files": 0, ...（其他欄位為空）}
        """
        search_path = Path(path).resolve()
        if not any(search_path == base or base in search_path.parents for base in allowed_paths):
            return {"error": "[ERROR] 路徑不在允許範圍內。請用 cmd_list_allowed_paths 取得有效路徑。"}
        if not search_path.exists():
            return {"error": f"[ERROR] 路徑不存在：{path}"}

        # 建立 rg 指令
        cmd: list[str] = [rg_path, "--color=never"]

        if output_mode == "files_with_matches":
            cmd.append("--files-with-matches")
        elif output_mode == "count":
            cmd.append("--count")
        else:
            cmd += ["--heading", "--line-number"]
            if context_lines > 0:
                cmd += [f"--context={max(0, min(10, context_lines))}"]
            else:
                if before_context > 0:
                    cmd += [f"--before-context={max(0, min(10, before_context))}"]
                if after_context > 0:
                    cmd += [f"--after-context={max(0, min(10, after_context))}"]

        if ignore_case:
            cmd.append("--ignore-case")
        if fixed_strings:
            cmd.append("--fixed-strings")
        if multiline:
            cmd += ["--multiline", "--multiline-dotall"]
        if glob:
            cmd += ["--glob", glob]
        if file_type:
            cmd += ["--type", file_type]
        for vcs_glob in _VCS_EXCLUDE_GLOBS:
            cmd += ["--glob", vcs_glob]

        cmd += [pattern, str(search_path)]

        try:
            result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", timeout=30)
        except subprocess.TimeoutExpired:
            return {"error": "[ERROR] 搜尋超時（30 秒）。請縮小搜尋路徑或加上 glob / file_type 過濾。"}

        if result.returncode == 2:
            return {"error": f"[ERROR] {(result.stderr or '').strip() or '執行 rg 失敗'}"}

        # 無匹配（returncode == 1）
        if result.returncode == 1:
            if output_mode == "files_with_matches":
                return {"mode": "files_with_matches", "num_files": 0, "filenames": []}
            elif output_mode == "count":
                return {"mode": "count", "num_matches": 0, "per_file": []}
            else:
                return {"mode": "content", "num_files": 0, "filenames": [],
                        "content": "", "num_lines": 0, "applied_limit": 0, "applied_offset": offset}

        stdout = result.stdout or ""

        # ── files_with_matches ──────────────────────────────────────────────
        if output_mode == "files_with_matches":
            filenames = [f for f in stdout.splitlines() if f]
            if head_limit > 0:
                filenames = filenames[offset: offset + head_limit]
            elif offset:
                filenames = filenames[offset:]
            return {"mode": "files_with_matches", "num_files": len(filenames), "filenames": filenames}

        # ── count ────────────────────────────────────────────────────────────
        if output_mode == "count":
            per_file = []
            total = 0
            for line in stdout.splitlines():
                if ":" in line:
                    fname, _, cnt = line.rpartition(":")
                    try:
                        c = int(cnt)
                        per_file.append({"file": fname, "count": c})
                        total += c
                    except ValueError:
                        pass
            return {"mode": "count", "num_matches": total, "per_file": per_file}

        # ── content ──────────────────────────────────────────────────────────
        lines = stdout.splitlines()
        # 解析 heading 行取得 filenames（heading 格式下，無 : 的非空行為檔案名稱）
        filenames = [l for l in lines if l and ":" not in l and not l.startswith("-")]
        # 套用 offset + head_limit
        if offset:
            lines = lines[offset:]
        applied_limit = 0
        if head_limit > 0 and len(lines) > head_limit:
            lines = lines[:head_limit]
            lines.append(f"--- 輸出已截斷（offset={offset}, limit={head_limit}），請縮小搜尋範圍或使用 glob 過濾 ---")
            applied_limit = head_limit

        return {
            "mode": "content",
            "num_files": len(set(filenames)),
            "filenames": list(dict.fromkeys(filenames)),
            "content": "\n".join(lines),
            "num_lines": len(lines),
            "applied_limit": applied_limit,
            "applied_offset": offset,
        }

    @grep_mcp.tool()
    def glob_files(
        pattern: str,
        path: str = "",
        limit: int = 100,
    ) -> dict[str, Any]:
        """以 ripgrep 搜尋符合 glob pattern 的檔名，結果依修改時間排序（最新在前）。

        取代 fs_search_files。自動尊重 .gitignore（由 ripgrep 原生處理）。

        參數：
          pattern — glob pattern，例如 '**/*.py'、'src/**/*.ts'、'*.json'
          path    — 搜尋根目錄（空字串 = 第一個 allowed_path）
                    請從 cmd_workspace_context 取得有效路徑
          limit   — 結果上限（預設 100）

        回傳（dict）：
          num_files  (int)       — 實際匹配到的檔案總數（截斷前）
          filenames  (list[str]) — 絕對路徑清單（依修改時間降序，最新在前）
          truncated  (bool)      — 結果是否被 limit 截斷

        錯誤時回傳：{"error": "[ERROR] <原因>"}
        """
        if not path:
            search_path = allowed_paths[0] if allowed_paths else Path.cwd()
        else:
            search_path = Path(path).resolve()

        if not any(search_path == base or base in search_path.parents for base in allowed_paths):
            return {"error": "[ERROR] 路徑不在允許範圍內。請用 cmd_list_allowed_paths 取得有效路徑。"}
        if not search_path.exists():
            return {"error": f"[ERROR] 路徑不存在：{path or str(search_path)}"}

        cmd = [rg_path, "--files", "--glob", pattern, str(search_path)]

        try:
            result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", timeout=30)
        except subprocess.TimeoutExpired:
            return {"error": "[ERROR] 搜尋超時（30 秒）。請縮小搜尋路徑或使用更具體的 pattern。"}

        if result.returncode == 2:
            return {"error": f"[ERROR] {(result.stderr or '').strip() or '執行 rg 失敗'}"}

        filenames = [f for f in (result.stdout or "").splitlines() if f]

        # 依修改時間降序排列
        def _mtime(p: str) -> float:
            try:
                return os.path.getmtime(p)
            except OSError:
                return 0.0

        filenames.sort(key=_mtime, reverse=True)

        total = len(filenames)
        truncated = total > limit
        if truncated:
            filenames = filenames[:limit]

        return {"num_files": total, "filenames": filenames, "truncated": truncated}

    return grep_mcp


# ── markitdown 檔案轉換工具 ───────────────────────────────────────────────────

def _build_markitdown_server(allowed_paths: list[Path]) -> FastMCP:
    """建立以 markitdown 提供檔案轉換為 Markdown 功能的 FastMCP 子伺服器。"""
    md_mcp = FastMCP(name="Markitdown 轉換器")

    @md_mcp.tool()
    def convert_to_markdown(
        input_path: str,
        output_path: str = "",
    ) -> dict[str, Any]:
        """將檔案（PDF、DOCX、PPTX、XLSX、HTML、圖片等）轉換為 Markdown，直接寫入磁碟。

        參數：
            input_path  - 來源檔案路徑（必須在 allowed_paths 範圍內）
            output_path - 輸出 .md 檔案路徑（留空時自動以同目錄同檔名加 .md 副檔名）

        回傳：
            output_path - 實際寫入的 .md 檔案完整路徑
            title       - 原文件標題（若有）
            char_count  - 輸出 Markdown 字元數
        """
        src = Path(input_path).resolve()

        if not src.is_file():
            return {"success": False, "error": f"檔案不存在：{input_path}"}

        if not any(src == base or base in src.parents for base in allowed_paths):
            return {"success": False, "error": "input_path 不在允許的目錄範圍內"}

        if output_path:
            dst = Path(output_path).resolve()
            if not any(dst.parent == base or base in dst.parent.parents for base in allowed_paths):
                return {"success": False, "error": "output_path 不在允許的目錄範圍內"}
        else:
            dst = src.with_suffix(".md")

        try:
            result = MarkItDown().convert(str(src))
        except Exception as exc:
            return {"success": False, "error": f"轉換失敗：{exc}"}

        try:
            dst.write_text(result.markdown, encoding="utf-8")
        except Exception as exc:
            return {"success": False, "error": f"寫入檔案失敗：{exc}"}

        return {
            "success": True,
            "output_path": str(dst),
            "title": result.title or "",
            "char_count": len(result.markdown),
        }

    return md_mcp


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

    # 1. 建立主 proxy 伺服器
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
- cmd_list_allowed_commands / cmd_list_allowed_paths

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

    # 5. 掛載增強文字讀取工具（無 namespace → 工具名稱直接是 read_file）
    read_server = _build_read_server(allowed_paths)
    proxy.mount(read_server)

    # 6. 掛載 ripgrep 搜尋工具（無 namespace → 工具名稱直接是 grep_files / glob_files）
    grep_server = _build_grep_server(allowed_paths, rg_path)
    proxy.mount(grep_server)

    # 6. 掛載 markitdown 檔案轉換工具
    markitdown_server = _build_markitdown_server(allowed_paths)
    proxy.mount(markitdown_server, namespace="md")

    # 7. Bearer Token 中介軟體（兼記錄各 session 的反向代理 base URL）
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

    # 8. 取得底層 Starlette app，加入路由與認證中介軟體
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
