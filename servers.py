from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Annotated, Any

from pydantic import Field
from fastmcp import FastMCP
from fastmcp.server.context import Context
from markitdown import MarkItDown

from config import (
    _ask_user_confirm,
    _build_shell_args,
    _load_whitelist,
    _parse_composite_command,
)
from ripgrep import _VCS_EXCLUDE_GLOBS

# ── 臨時下載 token 儲存 ────────────────────────────────────────────────────────

_download_tokens: dict[str, tuple[Path, float]] = {}
_session_base_urls: dict[str, str] = {}  # session_id -> "https://host"

DOWNLOAD_TOKEN_TTL = 600  # 秒


def _purge_expired_tokens() -> None:
    now = time.time()
    expired = [k for k, (_, exp) in _download_tokens.items() if now > exp]
    for k in expired:
        del _download_tokens[k]


# ── 命令白名單執行工具 ─────────────────────────────────────────────────────────

def _build_cmd_server(
    allowed_paths: list[Path],
    whitelist: list[str],
    whitelist_filename: str = ".cmd_whitelist.json",
) -> FastMCP:
    cmd_mcp = FastMCP(name="命令白名單執行器")

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
        items = [
            {"command": cmd, "description": cmd_descriptions.get(cmd, "")}
            for cmd in whitelist
        ]
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

        _R = "\033[31m"
        _G = "\033[32m"
        _Y = "\033[33m"
        _B = "\033[1m"
        _0 = "\033[0m"

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


# ── 檔案下載 URI 工具 ─────────────────────────────────────────────────────────

def _build_file_server(
    allowed_paths: list[Path],
    fallback_host: str,
    port: int,
) -> FastMCP:
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

        if not any(path == base or base in path.parents for base in allowed_paths):
            return {"success": False, "error": "檔案不在允許的目錄範圍內"}

        token = str(uuid.uuid4())
        _download_tokens[token] = (path, time.time() + DOWNLOAD_TOKEN_TTL)

        session_id = ctx.session_id
        base_url = _session_base_urls.get(session_id)
        if not base_url:
            display_host = "localhost" if fallback_host in ("0.0.0.0", "") else fallback_host
            base_url = f"http://{display_host}:{port}"

        uri = f"{base_url}/download/{token}"
        return {
            "success": True,
            "uri": uri,
            "expires_in_seconds": DOWNLOAD_TOKEN_TTL,
            "file_name": path.name,
        }

    return file_mcp


# ── 增強文字讀取工具 ──────────────────────────────────────────────────────────

def _build_read_server(allowed_paths: list[Path]) -> FastMCP:
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
        start_line = offset + 1
        content = "\n".join(f"{start_line + i}\t{line}" for i, line in enumerate(chunk))

        return {
            "file_path": str(file_path),
            "content": content,
            "num_lines": len(chunk),
            "start_line": start_line,
            "total_lines": total_lines,
        }

    return read_mcp


# ── ripgrep 搜尋工具 ──────────────────────────────────────────────────────────

def _build_grep_server(allowed_paths: list[Path], rg_path: str) -> FastMCP:
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

        if result.returncode == 1:
            if output_mode == "files_with_matches":
                return {"mode": "files_with_matches", "num_files": 0, "filenames": []}
            elif output_mode == "count":
                return {"mode": "count", "num_matches": 0, "per_file": []}
            else:
                return {"mode": "content", "num_files": 0, "filenames": [],
                        "content": "", "num_lines": 0, "applied_limit": 0, "applied_offset": offset}

        stdout = result.stdout or ""

        if output_mode == "files_with_matches":
            filenames = [f for f in stdout.splitlines() if f]
            if head_limit > 0:
                filenames = filenames[offset: offset + head_limit]
            elif offset:
                filenames = filenames[offset:]
            return {"mode": "files_with_matches", "num_files": len(filenames), "filenames": filenames}

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

        lines = stdout.splitlines()
        _match_line = re.compile(r'^\d+[:-]')
        filenames = [l for l in lines if l and not _match_line.match(l) and not l.startswith("-")]
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


# ── Markitdown 轉換工具 ───────────────────────────────────────────────────────

def _build_markitdown_server(allowed_paths: list[Path]) -> FastMCP:
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
