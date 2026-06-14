from __future__ import annotations

import json
import logging
import os
import platform
import re
import sys
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 8100
DEFAULT_WHITELIST_FILENAME = ".cmd_whitelist.json"

_COMPOSITE_SEP = re.compile(r"\s*;\s*")


def _load_config(cli_config: str | None) -> dict[str, Any]:
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
    raw = config.get("allowed_paths")
    if not raw:
        return [Path.cwd().resolve()]
    return [Path(p).resolve() for p in raw]


def _load_whitelist(allowed_paths: list[Path], filename: str) -> list[str]:
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
    """在終端印出提示並等待使用者輸入 y/N。非互動式 stdin 時預設拒絕。"""
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
    if platform.system() == "Windows":
        return ["powershell", "-NoProfile", "-NonInteractive", "-Command", command]
    return ["/bin/sh", "-c", command]


def _parse_composite_command(command: str) -> list[str]:
    parts = _COMPOSITE_SEP.split(command)
    return [p.strip() for p in parts if p.strip()]
