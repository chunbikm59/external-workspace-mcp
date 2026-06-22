from __future__ import annotations

import platform
import shutil
from pathlib import Path

# 對齊 GUI 版 soffice.ts 的候選路徑（不含 electron 打包的 portable 版）
_WINDOWS_CANDIDATES = [
    r"C:\Program Files\LibreOffice\program\soffice.exe",
    r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
]

_MACOS_CANDIDATES = ["/Applications/LibreOffice.app/Contents/MacOS/soffice"]

_LINUX_CANDIDATES = [
    "/usr/bin/soffice",
    "/usr/lib/libreoffice/program/soffice",
    "/opt/libreoffice/program/soffice",
]

SOFFICE_NOT_FOUND_MESSAGE = (
    "找不到 LibreOffice（soffice）。此功能需要安裝 LibreOffice 才能將 PPT/PPTX 轉換為圖片，"
    "請至 https://www.libreoffice.org/download/ 安裝後重試。"
)

_UNSET = object()  # sentinel：尚未偵測
_cached: str | None | object = _UNSET


def find_soffice() -> str | None:
    """偵測 soffice 執行檔路徑，找不到回傳 None。結果會快取。"""
    global _cached
    if _cached is not _UNSET:
        return _cached  # type: ignore[return-value]

    system = platform.system()
    if system == "Windows":
        candidates = _WINDOWS_CANDIDATES
    elif system == "Darwin":
        candidates = _MACOS_CANDIDATES
    else:
        candidates = _LINUX_CANDIDATES

    # Windows 上 shutil.which("soffice") 會依 PATHEXT 命中 soffice.COM（GUI 包裝器），
    # 但 --convert-to 應使用 soffice.exe，故優先找 .exe。
    if system == "Windows":
        found = shutil.which("soffice.exe")
        if found and Path(found).is_file():
            _cached = found
            return _cached
    else:
        found = shutil.which("soffice")
        if found and Path(found).is_file():
            _cached = found
            return _cached

    for candidate in candidates:
        if Path(candidate).is_file():
            _cached = candidate
            return _cached

    _cached = None
    return _cached
