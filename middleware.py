from __future__ import annotations

import logging
from pathlib import Path

import mcp.types as mt
from fastmcp.server.middleware import Middleware, MiddlewareContext
from fastmcp.server.middleware.middleware import CallNext, ToolResult

logger = logging.getLogger(__name__)

_TOOLS_WITH_EXCLUDE = {"fs_directory_tree"}
_FS_TOOLS_EXCLUDED = {"fs_read_file", "fs_read_text_file", "fs_search_files"}


def _gitignore_to_minimatch(pattern: str) -> list[str]:
    p = pattern.strip()
    if not p or p.startswith("#"):
        return []

    is_dir = p.endswith("/")
    p = p.rstrip("/")

    # 負向 pattern（!）暫不支援，略過
    if p.startswith("!"):
        return []

    # 有開頭 / 表示只匹配根目錄
    if p.startswith("/"):
        base = p.lstrip("/")
        if is_dir:
            return [base, f"{base}/**"]
        return [base]

    # 含 / 但不是開頭：視為相對路徑，直接用
    if "/" in p:
        if is_dir:
            return [p, f"{p}/**"]
        return [p]

    # 無 /：任何層級都匹配，加 **/ 前綴
    if is_dir:
        return [f"**/{p}", f"**/{p}/**"]
    return [f"**/{p}"]


def _load_gitignore_patterns(allowed_paths: list[Path]) -> list[str]:
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
                merged = list(dict.fromkeys(existing + patterns))
                new_args = {**(params.arguments or {}), "excludePatterns": merged}
                new_params = mt.CallToolRequestParams(name=params.name, arguments=new_args)
                context = context.copy(message=new_params)
        return await call_next(context)


class ToolFilterMiddleware(Middleware):
    """隱藏被自訂工具取代的 fs_* 工具。"""

    async def on_list_tools(self, context, call_next):
        tools = await call_next(context)
        return [t for t in tools if t.name not in _FS_TOOLS_EXCLUDED]

    async def on_call_tool(
        self,
        context: MiddlewareContext[mt.CallToolRequestParams],
        call_next: CallNext[mt.CallToolRequestParams, ToolResult],
    ) -> ToolResult:
        if context.message.name in _FS_TOOLS_EXCLUDED:
            alternatives = {
                "fs_read_file": "read_file",
                "fs_read_text_file": "read_file",
                "fs_search_files": "glob_files",
            }
            alt = alternatives.get(context.message.name, "read_file")
            raise ValueError(
                f"工具 '{context.message.name}' 已停用。請改用：{alt}。"
            )
        return await call_next(context)
