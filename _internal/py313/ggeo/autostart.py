"""Cross-platform autostart helpers (no GUI dependencies)."""
from __future__ import annotations

import logging
import platform
import subprocess
import sys
from pathlib import Path

logger = logging.getLogger("ggeo.autostart")

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"


def _venv_python() -> str:
    """Return path to venv python if it exists, else sys.executable."""
    if platform.system() == "Windows":
        candidate = ROOT / "venv" / "Scripts" / "python.exe"
    else:
        candidate = ROOT / "venv" / "bin" / "python"
    return str(candidate) if candidate.exists() else sys.executable


def _launch_cmd() -> list[str]:
    """Command to launch the tray app."""
    return [_venv_python(), str(ROOT / "tray.py")]


def install_autostart() -> tuple[bool, str]:
    """Install platform-specific autostart. Returns (success, message)."""
    system = platform.system()
    try:
        if system == "Darwin":
            plist_dir = Path.home() / "Library" / "LaunchAgents"
            plist_dir.mkdir(parents=True, exist_ok=True)
            plist = plist_dir / "com.ggeo.tray.plist"
            cmd = _launch_cmd()
            content = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.ggeo.tray</string>
    <key>ProgramArguments</key>
    <array>
        <string>{cmd[0]}</string>
        <string>{cmd[1]}</string>
    </array>
    <key>WorkingDirectory</key><string>{ROOT}</string>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><false/>
    <key>StandardOutPath</key><string>{DATA_DIR / 'tray.stdout.log'}</string>
    <key>StandardErrorPath</key><string>{DATA_DIR / 'tray.stderr.log'}</string>
</dict>
</plist>
"""
            plist.write_text(content)
            subprocess.run(
                ["launchctl", "load", str(plist)],
                capture_output=True, check=False,
            )
            return True, f"LaunchAgent installed: {plist}"
        elif system == "Windows":
            startup = (
                Path.home() / "AppData" / "Roaming" / "Microsoft"
                / "Windows" / "Start Menu" / "Programs" / "Startup"
            )
            startup.mkdir(parents=True, exist_ok=True)
            bat = startup / "GGEO.bat"
            cmd = _launch_cmd()
            bat.write_text(
                f'@echo off\ncd /d "{ROOT}"\nstart "" "{cmd[0]}" "{cmd[1]}"\n'
            )
            return True, f"Startup shortcut: {bat}"
        elif system == "Linux":
            autostart_dir = Path.home() / ".config" / "autostart"
            autostart_dir.mkdir(parents=True, exist_ok=True)
            desktop = autostart_dir / "ggeo.desktop"
            cmd = _launch_cmd()
            desktop.write_text(
                "[Desktop Entry]\n"
                "Type=Application\n"
                "Name=GGEO\n"
                f"Exec={cmd[0]} {cmd[1]}\n"
                f"Path={ROOT}\n"
                "X-GNOME-Autostart-enabled=true\n"
            )
            return True, f"Autostart file: {desktop}"
    except Exception as e:
        logger.error("install_autostart failed: %s", e)
        return False, str(e)
    return False, "Unsupported platform"


def remove_autostart() -> tuple[bool, str]:
    """Remove autostart config. Returns (success, message)."""
    system = platform.system()
    try:
        if system == "Darwin":
            plist = (
                Path.home() / "Library" / "LaunchAgents"
                / "com.ggeo.tray.plist"
            )
            if plist.exists():
                subprocess.run(
                    ["launchctl", "unload", str(plist)],
                    capture_output=True, check=False,
                )
                plist.unlink()
                return True, "LaunchAgent removed"
        elif system == "Windows":
            bat = (
                Path.home() / "AppData" / "Roaming" / "Microsoft"
                / "Windows" / "Start Menu" / "Programs" / "Startup"
                / "GGEO.bat"
            )
            if bat.exists():
                bat.unlink()
                return True, "Startup shortcut removed"
        elif system == "Linux":
            desktop = (
                Path.home() / ".config" / "autostart" / "ggeo.desktop"
            )
            if desktop.exists():
                desktop.unlink()
                return True, "Autostart file removed"
    except Exception as e:
        return False, str(e)
    return True, "Not installed"


def autostart_installed() -> bool:
    """Check if autostart is currently installed."""
    system = platform.system()
    if system == "Darwin":
        return (
            Path.home() / "Library" / "LaunchAgents"
            / "com.ggeo.tray.plist"
        ).exists()
    if system == "Windows":
        return (
            Path.home() / "AppData" / "Roaming" / "Microsoft"
            / "Windows" / "Start Menu" / "Programs" / "Startup"
            / "GGEO.bat"
        ).exists()
    if system == "Linux":
        return (
            Path.home() / ".config" / "autostart" / "ggeo.desktop"
        ).exists()
    return False
