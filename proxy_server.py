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
import re
import subprocess
import sys
import shutil
import tarfile
import time
import urllib.request
import uuid
import zipfile
from pathlib import Path
from typing import Annotated, Any

import sys

import mcp.types as mt
from fastmcp.server.middleware import Middleware, MiddlewareContext
from fastmcp.server.middleware.middleware import CallNext, ToolResult

import uvicorn
from pydantic import Field
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


def _ask_user_confirm(prompt_lines: list[str]) -> bool:
    """在終端印出提示並等待使用者輸入 y/N，回傳 True 表示確認。
    在非互動式 stdin（被重導向）時預設拒絕。"""
    try:
        sys.stdout.write("\n".join(prompt_lines))
        sys.stdout.flush()
        answer = sys.stdin.readline().strip().lower()
        return answer in ("y", "yes")
    except EOFError:
        sys.stdout.write("\n[INFO] stdin 非互動式，自動拒絕重載。\n")
        sys.stdout.flush()
        return False


def _build_shell_args(command: str) -> list[str]:
    """依作業系統回傳對應的 shell 呼叫參數。"""
    if platform.system() == "Windows":
        return ["powershell", "-NoProfile", "-NonInteractive", "-Command", command]
    return ["/bin/sh", "-c", command]


_COMPOSITE_SEP = re.compile(r"\s*;\s*")


def _parse_composite_command(command: str) -> list[str]:
    """將以 ';' 分隔的組合命令拆成子命令清單，單一命令回傳長度為 1 的清單。"""
    parts = _COMPOSITE_SEP.split(command)
    return [p.strip() for p in parts if p.strip()]


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
    def run_command(
        command: Annotated[str, Field(description="要執行的命令；可用 ';' 串接多個白名單命令，例如 'npm install; npm run build'")],
        fail_fast: Annotated[bool, Field(description="串接命令模式下，若某步驟失敗是否立即停止")] = True,
    ) -> dict[str, Any]:
        sub_commands = _parse_composite_command(command)

        if not sub_commands:
            return {"success": False, "error": "命令為空"}

        invalid = [cmd for cmd in sub_commands if cmd not in whitelist]
        if invalid:
            return {
                "success": False,
                "error": f"以下子命令不在白名單中：{invalid}。\n允許的命令：{whitelist}",
            }

        cwd = str(allowed_paths[0]) if allowed_paths else None
        results = []
        overall_success = True

        for sub_cmd in sub_commands:
            try:
                proc = subprocess.run(
                    _build_shell_args(sub_cmd),
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    cwd=cwd,
                    timeout=120,
                )
                sub_result: dict[str, Any] = {
                    "command": sub_cmd,
                    "success": proc.returncode == 0,
                    "returncode": proc.returncode,
                    "stdout": proc.stdout,
                    "stderr": proc.stderr,
                }
            except subprocess.TimeoutExpired:
                sub_result = {"command": sub_cmd, "success": False, "error": "命令執行超時（120 秒）"}
            except Exception as exc:
                sub_result = {"command": sub_cmd, "success": False, "error": str(exc)}

            results.append(sub_result)
            if not sub_result["success"]:
                overall_success = False
                if fail_fast:
                    break

        # 單一命令：維持向後相容格式
        if len(sub_commands) == 1:
            r = results[0]
            if "error" in r:
                return {"success": r["success"], "error": r["error"]}
            return {
                "success": r["success"],
                "returncode": r["returncode"],
                "stdout": r["stdout"],
                "stderr": r["stderr"],
            }

        # 組合命令
        return {
            "success": overall_success,
            "commands_executed": len(results),
            "commands_total": len(sub_commands),
            "results": results,
        }

    _cwd_display = str(allowed_paths[0]) if allowed_paths else "（無）"
    run_command.__doc__ = f"""執行白名單中的命令（Windows 使用 PowerShell，其他平台使用 /bin/sh）。
可用 ';' 串接多個白名單命令依序執行。每個子命令必須完全符合白名單中的某一項，否則整批不執行。
不確定有哪些命令可用時，請先呼叫 cmd_list_allowed_commands。

工作目錄：{_cwd_display}

允許的命令：
{whitelist_doc}
"""

    @cmd_mcp.tool()
    def list_allowed_commands() -> dict[str, Any]:
        """列出所有可傳入 cmd_run_command 的白名單命令及說明。
        不確定能執行哪些命令時呼叫此工具。
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
        """列出此伺服器允許存取的目錄路徑。
        作為 read_file / grep_files / glob_files / fs_directory_tree 的 path 起點。
        """
        return {"allowed_paths": [str(p) for p in allowed_paths]}

    @cmd_mcp.tool()
    def workspace_context() -> dict[str, Any]:
        """一次取得完整工作區概覽：可存取的路徑、可執行的命令、各根目錄頂層結構。
        連線後第一步請呼叫此工具完成定向。
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

    @cmd_mcp.tool()
    def reload_whitelist() -> dict[str, Any]:
        """重新從磁碟載入白名單檔案；伺服器端會暫停並向本機使用者確認，待確認後才套用。
        白名單檔案變更後（新增/移除命令）呼叫此工具。
        """
        new_cmds = _load_whitelist(allowed_paths, whitelist_filename)

        current_set = set(whitelist)
        new_set = set(new_cmds)
        added = [c for c in new_cmds if c not in current_set]
        removed = [c for c in whitelist if c not in new_set]
        unchanged = [c for c in whitelist if c in new_set]

        _R = "\033[31m"  # 紅
        _G = "\033[32m"  # 綠
        _Y = "\033[33m"  # 黃
        _B = "\033[1m"   # 粗體
        _0 = "\033[0m"   # reset

        diff_lines: list[str] = []
        for c in removed:
            diff_lines.append(f"{_R}  - {c}{_0}")
        for c in unchanged:
            diff_lines.append(f"    {c}")
        for c in added:
            diff_lines.append(f"{_G}  + {c}{_0}")

        summary_parts = []
        if added:
            summary_parts.append(f"{_G}+{len(added)} 新增{_0}")
        if removed:
            summary_parts.append(f"{_R}-{len(removed)} 移除{_0}")
        if not added and not removed:
            summary_parts.append(f"{_Y}無變更{_0}")

        prompt_lines = [
            f"\n{_B}" + "=" * 60 + _0,
            f"{_B}[白名單重載請求] 遠端 agent 要求重新載入白名單{_0}",
            f"檔案：{whitelist_filename}  |  {', '.join(summary_parts)}  |  套用後共 {len(new_cmds)} 個命令",
            "",
            *diff_lines,
            "",
            _B + "=" * 60 + _0,
            "請確認是否套用新白名單？[y/N] ",
        ]

        confirmed = _ask_user_confirm(prompt_lines)

        if confirmed:
            whitelist.clear()
            whitelist.extend(new_cmds)

            cmd_descriptions.clear()
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

            sys.stdout.write(f"[INFO] 白名單已更新，共 {len(whitelist)} 個命令。\n")
            sys.stdout.flush()
            return {
                "success": True,
                "message": f"白名單已更新，共 {len(whitelist)} 個命令",
                "commands": list(whitelist),
            }
        else:
            sys.stdout.write("[INFO] 使用者拒絕重載，白名單維持不變。\n")
            sys.stdout.flush()
            return {"success": False, "message": "使用者拒絕重載"}

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
    def get_download_uri(
        file_path: Annotated[str, Field(description="要下載的檔案絕對路徑，必須在 allowed_paths 範圍內")],
        ctx: Context,
    ) -> dict[str, Any]:
        """產生指定檔案的臨時 HTTP 下載連結（10 分鐘有效）。
        適用於二進位檔案（圖片、PDF、壓縮檔）或需要用 wget/curl 下載的場景。
        文字檔請直接用 read_file，不需要此工具。
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
    def read_file(
        path: Annotated[str, Field(description="要讀取的檔案絕對路徑")],
        offset: Annotated[int, Field(description="起始行（0-indexed，0 = 從第一行）")] = 0,
        limit: Annotated[int, Field(description="讀取行數（0 = 讀到底；大型檔案建議設定此值）")] = 0,
    ) -> dict[str, Any]:
        """讀取文字檔，回傳帶行號內容（格式：\"{行號}\\t{內容}\"）。
        大型檔案請搭配 offset/limit 分段讀取。
        二進位檔案（圖片、音訊）請改用 fs_read_media_file。
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
        pattern: Annotated[str, Field(description="正則表達式（fixed_strings=True 時為純字串），例如 'TODO'、'def \\w+'")],
        path: Annotated[str, Field(description="搜尋根目錄的絕對路徑，必須在 allowed_paths 範圍內")],
        output_mode: Annotated[str, Field(description='"content"=回傳匹配行與上下文；"files_with_matches"=只回傳檔案清單；"count"=各檔案匹配數')] = "content",
        glob: Annotated[str, Field(description="檔案過濾 glob，例如 '*.py'、'*.{ts,tsx}'；空字串表示不限")] = "",
        file_type: Annotated[str, Field(description="ripgrep 內建檔案類型，例如 'py'、'ts'、'rust'；比 glob 簡潔，空字串表示不限")] = "",
        context_lines: Annotated[int, Field(description="匹配前後對稱顯示行數（等同 -C），預設 0")] = 0,
        before_context: Annotated[int, Field(description="匹配前顯示行數（等同 -B），預設 0")] = 0,
        after_context: Annotated[int, Field(description="匹配後顯示行數（等同 -A），預設 0")] = 0,
        ignore_case: Annotated[bool, Field(description="True 表示忽略大小寫")] = False,
        head_limit: Annotated[int, Field(description="輸出截斷行數/筆數（預設 250；0 = 不限）")] = 250,
        offset: Annotated[int, Field(description="跳過前 N 筆結果，用於分頁（預設 0）")] = 0,
        fixed_strings: Annotated[bool, Field(description="True 表示純字串比對，停用 regex")] = False,
        multiline: Annotated[bool, Field(description="True 表示啟用多行模式（. 可匹配換行）")] = False,
    ) -> dict[str, Any]:
        """以 ripgrep 搜尋檔案內容。自動排除 .git 等版本控制目錄。
        搜尋符合 glob pattern 的檔名請用 glob_files。
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
        # 解析 heading 行取得 filenames。
        # heading 模式下，匹配行格式為 "行號:內容"（純數字開頭後接 :），
        # 分隔行為 "--"，其餘非空行即為檔案名稱。
        # 不能用 ":" not in l 判斷，Windows 路徑本身含磁碟代號冒號（D:\...）。
        _match_line = re.compile(r'^\d+[:-]')
        filenames = [l for l in lines if l and not _match_line.match(l) and not l.startswith("-")]
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
        pattern: Annotated[str, Field(description="glob pattern，例如 '**/*.py'、'src/**/*.ts'、'*.json'")],
        path: Annotated[str, Field(description="搜尋根目錄絕對路徑；留空則使用第一個 allowed_path")] = "",
        limit: Annotated[int, Field(description="回傳結果上限（預設 100）")] = 100,
    ) -> dict[str, Any]:
        """搜尋符合 glob pattern 的檔名，結果依修改時間排序（最新在前）。自動尊重 .gitignore。
        搜尋檔案內容請用 grep_files。
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
        input_path: Annotated[str, Field(description="來源檔案絕對路徑，必須在 allowed_paths 範圍內")],
        output_path: Annotated[str, Field(description="輸出 .md 檔案路徑；留空則自動以同目錄同檔名加 .md 副檔名")] = "",
    ) -> dict[str, Any]:
        """將檔案（PDF、DOCX、PPTX、XLSX、HTML、圖片等）轉換為 Markdown 並寫入磁碟。
        轉換結果寫入 output_path（預設與來源同目錄，副檔名改為 .md）。
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
