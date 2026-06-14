from __future__ import annotations

import platform
import shutil
import tarfile
import urllib.request
import zipfile
from pathlib import Path

_RG_LOCAL_DIR = Path(__file__).parent / "bin"
_RG_GITHUB_VERSION = "15.1.0"

_VCS_EXCLUDE_GLOBS = ["!.svn", "!.hg", "!.jj", "!.bzr"]


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
