#!/usr/bin/env python3
"""GGeo unified menu launcher — invoked by top-level GGeo.command/.bat."""
from __future__ import annotations

import json
import os
import platform
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
INTERNAL = ROOT / "_internal"

try:
    VERSION = (ROOT / "VERSION").read_text().strip()
except Exception:
    VERSION = "?"

if platform.system() == "Windows":
    try:
        import ctypes
        kernel32 = ctypes.windll.kernel32
        h = kernel32.GetStdHandle(-11)
        mode = ctypes.c_ulong()
        if kernel32.GetConsoleMode(h, ctypes.byref(mode)):
            kernel32.SetConsoleMode(h, mode.value | 0x0001 | 0x0004)
    except Exception:
        pass

C = "\x1b[36m"
CB = "\x1b[1;36m"
G = "\x1b[1;32m"
Y = "\x1b[33m"
R = "\x1b[1;31m"
DIM = "\x1b[2;37m"
BLUE = "\x1b[2;34m"
RST = "\x1b[0m"


def clear_screen() -> None:
    if platform.system() == "Windows":
        os.system("cls")
    else:
        sys.stdout.write("\x1b[2J\x1b[H")
        sys.stdout.flush()


def venv_python() -> Path:
    if platform.system() == "Windows":
        return INTERNAL / "venv" / "Scripts" / "python.exe"
    return INTERNAL / "venv" / "bin" / "python"


def detect_default() -> str:
    has_config = (INTERNAL / "data" / "client.json").exists()
    has_venv = venv_python().exists()
    if not has_config or not has_venv:
        return "1"
    return "4"


def render_banner(action_title: str = None) -> str:
    width = 54
    inner = width - 2
    inset = "   "
    sep = "    "
    logo_width = 12
    avail = inner - len(inset) - logo_width - len(sep)

    if action_title:
        titles = [
            (action_title, None),
            (f"v{VERSION} · by Gpro · badupro", DIM),
            ("Mobile GPS Location Spoofer", DIM),
        ]
    else:
        titles = [
            (f"GGeo Client v{VERSION}", None),
            ("Mobile GPS Location Spoofer", DIM),
            ("by Gpro · badupro", DIM),
        ]
    logos = ["╔═╗╔═╗┌─┐┌─┐", "║ ╦║ ╦├┤ │ │", "╚═╝╚═╝└─┘└─┘"]

    lines = ["", BLUE + "╔" + "═" * inner + "╗" + RST,
             BLUE + "║" + " " * inner + "║" + RST]
    for logo, (title, style) in zip(logos, titles):
        pad = max(0, avail - len(title))
        styled = (style + title + RST) if style else title
        lines.append(
            BLUE + "║" + RST
            + inset + CB + logo + RST + sep + styled + " " * pad
            + BLUE + "║" + RST
        )
    lines.append(BLUE + "║" + " " * inner + "║" + RST)
    lines.append(BLUE + "╚" + "═" * inner + "╝" + RST)
    return "\n".join(lines) + "\n"


def banner() -> str:
    return render_banner()


def render_closing(message: str) -> str:
    width = 54
    inner = width - 2
    pad_msg = max(0, inner - 4 - len(message))
    return (
        f"\n{BLUE}╔{'═' * inner}╗{RST}\n"
        f"{BLUE}║{' ' * inner}║{RST}\n"
        f"{BLUE}║{RST}  {G}✓{RST} {message}{' ' * pad_msg}{BLUE}║{RST}\n"
        f"{BLUE}║{' ' * inner}║{RST}\n"
        f"{BLUE}╚{'═' * inner}╝{RST}\n"
    )


def step_line(num: int, total: int, label: str, status: str = "") -> str:
    left = f"  {C}[{num}/{total}]{RST}  {label}"
    if not status:
        return left
    visible_left = 2 + 2 + len(str(num)) + 1 + len(str(total)) + 1 + 2 + len(label)
    pad = max(2, 40 - visible_left)
    return left + " " * pad + status


def step_print(num, total, label, status=""):
    print(step_line(num, total, label, status))


def step_overwrite(num, total, label, status):
    sys.stdout.write("\x1b[F\x1b[2K")
    sys.stdout.flush()
    print(step_line(num, total, label, status))


def ok_inline(msg=""):
    return f"{G}✓{RST}" + (" " + msg if msg else "")


def warn_inline(msg=""):
    return f"{Y}⚠{RST}" + (" " + msg if msg else "")


def fail_inline(msg=""):
    return f"{R}✗{RST}" + (" " + msg if msg else "")


def print_menu(default: str) -> None:
    items = [
        ("1", "Setup"),
        ("2", "Network"),
        ("3", "Start"),
        ("4", "Start + log"),
        ("5", "Logs"),
        ("6", "Update"),
        ("7", "Uninstall"),
        ("q", "Quit"),
    ]
    print("  Choose an action:\n")
    for num, label in items:
        if num == default:
            print(f"   {CB}[{num}]{RST}  {label}  {DIM}← default{RST}")
        else:
            print(f"   {C}[{num}]{RST}  {label}")
    print()


def request_sudo_upfront() -> bool:
    if platform.system() == "Windows":
        return True
    if os.geteuid() == 0:
        return True
    rc = subprocess.run(["sudo", "-n", "-v"], capture_output=True).returncode
    if rc == 0:
        return True
    print()
    print(f"  {DIM}Admin password required (one-time, cached for this session):{RST}")
    print()
    rc = subprocess.call(["sudo", "-v"])
    return rc == 0


def kill_port_8484() -> None:
    if platform.system() == "Windows":
        try:
            res = subprocess.run(
                ["netstat", "-ano"], capture_output=True, text=True, timeout=5,
            )
            for line in res.stdout.splitlines():
                if ":8484" in line and "LISTENING" in line:
                    pid = line.split()[-1]
                    subprocess.run(["taskkill", "/F", "/PID", pid],
                                   capture_output=True)
        except Exception:
            pass
    else:
        try:
            res = subprocess.run(
                ["lsof", "-iTCP:8484", "-sTCP:LISTEN", "-t", "-P"],
                capture_output=True, text=True, timeout=3,
            )
            pids = [p.strip() for p in res.stdout.split() if p.strip()]
            if not pids:
                return
        except Exception:
            return
        subprocess.run(
            ["sudo", "-n", "kill", "-9", *pids],
            capture_output=True,
        )
        time.sleep(0.3)


def quick_auto_update_check() -> None:
    if not (ROOT / ".git").is_dir():
        return
    if not shutil.which("git"):
        return
    try:
        if platform.system() != "Windows":
            subprocess.run(
                ["sudo", "-n", "chown", "-R",
                 f"{os.getuid()}:{os.getgid()}", str(ROOT)],
                capture_output=True,
            )
        res = subprocess.run(
            ["git", "-C", str(ROOT), "fetch", "--quiet", "origin", "main"],
            capture_output=True, timeout=15,
        )
        if res.returncode != 0:
            return
        res = subprocess.run(
            ["git", "-C", str(ROOT), "rev-list", "--count", "HEAD..origin/main"],
            capture_output=True, text=True, timeout=5,
        )
        if res.returncode != 0 or not res.stdout.strip().isdigit():
            return
        n = int(res.stdout.strip())
        if n == 0:
            return
        print(f"  {DIM}New version available, applying...{RST}")
        res = subprocess.run(
            ["git", "-C", str(ROOT), "reset", "--hard", "origin/main"],
            capture_output=True, timeout=30,
        )
        if res.returncode != 0:
            return
        branch = subprocess.run(
            ["git", "-C", str(ROOT), "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True, text=True, timeout=5,
        )
        if branch.returncode == 0 and branch.stdout.strip() == "HEAD":
            subprocess.run(
                ["git", "-C", str(ROOT), "checkout", "-B", "main", "origin/main"],
                capture_output=True, timeout=10,
            )
        py = venv_python()
        req = INTERNAL / "requirements.txt"
        if py.exists() and req.exists():
            subprocess.run(
                [str(py), "-m", "pip", "install", "--quiet", "-r", str(req)],
                capture_output=True, timeout=600,
            )
        try:
            new_ver = (ROOT / "VERSION").read_text().strip()
            print(f"  {ok_inline()} Updated to v{new_ver}")
        except Exception:
            pass
    except Exception:
        pass


def action_setup() -> None:
    clear_screen()
    setup_py = INTERNAL / "setup.py"
    if platform.system() == "Windows":
        rc = subprocess.call([sys.executable, str(setup_py)])
    else:
        rc = subprocess.call(["sudo", sys.executable, str(setup_py)])
    if rc != 0:
        print(f"\n  {fail_inline(f'Setup exited with code {rc}')}")
    input("\n  Press Enter to return to menu...")


def action_start_server() -> None:
    clear_screen()
    py = venv_python()
    if not py.exists():
        print(render_banner("Start"))
        print()
        print(f"  {fail_inline()} Environment not initialised")
        print(f"    {DIM}Run Setup first.{RST}")
        input("\n  Press Enter to return to menu...")
        return
    quick_auto_update_check()
    py = venv_python()
    run_py = INTERNAL / "run.py"
    if platform.system() == "Windows":
        rc = subprocess.call([str(py), str(run_py)])
    else:
        rc = subprocess.call(["sudo", "-E", str(py), str(run_py)])
    print()
    print(f"  {DIM}Server stopped (exit {rc}).{RST}")
    input("\n  Press Enter to return to menu...")


def action_start_with_log() -> None:
    clear_screen()
    log_path = INTERNAL / "data" / "ggeo.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_path.touch()
    self_path = Path(__file__).resolve()
    if platform.system() == "Darwin":
        applescript = (
            f'tell application "Terminal" to do script '
            f'"python3 \\"{self_path}\\" --view-log"'
        )
        subprocess.Popen(["osascript", "-e", applescript])
    elif platform.system() == "Windows":
        subprocess.Popen(
            ["cmd", "/C", "start", "cmd", "/K",
             sys.executable, str(self_path), "--view-log"],
            shell=False,
        )
    time.sleep(1)
    action_start_server()


def action_view_log() -> None:
    clear_screen()
    print(render_banner("Logs"))
    log_path = INTERNAL / "data" / "ggeo.log"
    if not log_path.exists():
        print()
        print(f"  {warn_inline()} Log file not yet created")
        print(f"    {DIM}{log_path}{RST}")
        print()
        print(f"  {DIM}Start the server first.{RST}")
        input("\n  Press Enter to return to menu...")
        return
    print()
    print(f"  {DIM}{log_path}{RST}")
    print()
    print(f"  {DIM}Press Ctrl+C to exit{RST}")
    print()
    if platform.system() == "Windows":
        subprocess.call(
            ["powershell", "-NoProfile", "-Command",
             f"Get-Content '{log_path}' -Wait -Tail 50"]
        )
    else:
        subprocess.call(["tail", "-f", str(log_path)])


def action_update() -> None:
    clear_screen()
    print(render_banner("Update"))
    print()
    print(f"  {DIM}Fetch the latest release and rebuild the environment.{RST}")
    print()
    ans = input("  Continue? [Y/n] ").strip().lower()
    if ans == "n":
        print(f"\n  {DIM}Cancelled.{RST}")
        input("  Press Enter to return to menu...")
        return
    print()

    total = 5

    kill_port_8484()
    step_print(1, total, "Stopping server", ok_inline())

    if platform.system() != "Windows":
        subprocess.run(
            ["sudo", "-n", "chown", "-R",
             f"{os.getuid()}:{os.getgid()}", str(ROOT)],
            capture_output=True,
        )

    res = subprocess.run(
        ["git", "-C", str(ROOT), "fetch", "origin", "main"],
        capture_output=True, text=True,
    )
    if res.returncode != 0:
        err = (res.stderr or res.stdout).strip()[:200]
        step_print(2, total, "Fetching latest", fail_inline("fetch failed"))
        print(f"\n  {DIM}{err}{RST}")
        input("\n  Press Enter to return to menu...")
        return
    res = subprocess.run(
        ["git", "-C", str(ROOT), "reset", "--hard", "origin/main"],
        capture_output=True, text=True,
    )
    if res.returncode != 0:
        err = (res.stderr or res.stdout).strip()[:200]
        step_print(2, total, "Fetching latest", fail_inline("reset failed"))
        print(f"\n  {DIM}{err}{RST}")
        input("\n  Press Enter to return to menu...")
        return
    step_print(2, total, "Fetching latest", ok_inline())

    venv_dir = INTERNAL / "venv"
    if platform.system() == "Windows":
        shutil.rmtree(venv_dir, ignore_errors=True)
    else:
        subprocess.run(["sudo", "rm", "-rf", str(venv_dir)], capture_output=True)
    rc = subprocess.run(
        [sys.executable, "-m", "venv", str(venv_dir)],
        capture_output=True, text=True,
    ).returncode
    if rc != 0:
        step_print(3, total, "Rebuilding environment", fail_inline("venv create"))
        input("\n  Press Enter to return to menu...")
        return
    step_print(3, total, "Rebuilding environment", ok_inline())

    py = venv_python()
    subprocess.run([str(py), "-m", "pip", "install", "--upgrade", "pip",
                    "--quiet"], capture_output=True)
    rc = subprocess.run(
        [str(py), "-m", "pip", "install", "--quiet", "-r",
         str(INTERNAL / "requirements.txt")],
        capture_output=True, text=True,
    ).returncode
    if rc != 0:
        step_print(4, total, "Installing dependencies", fail_inline("pip"))
        input("\n  Press Enter to return to menu...")
        return
    step_print(4, total, "Installing dependencies", ok_inline())

    print()
    print(f"  {DIM}Refreshing shortcut and autostart...{RST}")
    env = os.environ.copy()
    env["GGEO_AUTO_MODE"] = "1"
    setup_py = INTERNAL / "setup.py"
    if platform.system() == "Windows":
        setup_cmd = [sys.executable, str(setup_py)]
    else:
        setup_cmd = ["sudo", "-E", sys.executable, str(setup_py)]
    rc = subprocess.run(setup_cmd, env=env).returncode
    if rc != 0:
        step_print(5, total, "Refreshing shortcut",
                   warn_inline(f"setup rc={rc}"))
    else:
        step_print(5, total, "Refreshing shortcut", ok_inline())

    new_ver = (ROOT / "VERSION").read_text().strip() if (ROOT / "VERSION").exists() else "?"
    print(render_closing(f"Updated to v{new_ver}"))
    input("\n  Press Enter to return to menu...")


def action_edit_network() -> None:
    clear_screen()
    print(render_banner("Network"))
    print()

    cfg_path = INTERNAL / "data" / "client.json"
    if not cfg_path.exists():
        print(f"  {fail_inline()} Configuration not found")
        print(f"    {DIM}Run Setup first.{RST}")
        input("\n  Press Enter to return to menu...")
        return

    try:
        cfg = json.loads(cfg_path.read_text())
    except Exception as e:
        print(f"  {fail_inline()} Failed to read config: {e}")
        input("\n  Press Enter to return to menu...")
        return

    current_port = cfg.get("port") or 8484
    current_mdns = cfg.get("mdns_hostname") or "ggeo-client.local"

    print(f"  {DIM}Current:{RST}")
    print(f"    Port           {C}{current_port}{RST}")
    print(f"    mDNS hostname  {C}{current_mdns}{RST}")
    print()
    print(f"  {DIM}Press Enter to keep current value.{RST}")
    print()

    try:
        new_port = input(f"  New port           [{current_port}]: ").strip()
        new_mdns = input(f"  New mDNS hostname  [{current_mdns}]: ").strip()
    except (EOFError, KeyboardInterrupt):
        print()
        return

    changed = False
    if new_port:
        try:
            port_int = int(new_port)
            if not (1 <= port_int <= 65535):
                raise ValueError("must be 1-65535")
            cfg["port"] = port_int
            changed = True
        except ValueError as e:
            print(f"\n  {fail_inline()} Invalid port: {e}")
            input("\n  Press Enter to return to menu...")
            return

    if new_mdns:
        if "." not in new_mdns:
            new_mdns = new_mdns + ".local"
        cfg["mdns_hostname"] = new_mdns
        changed = True

    if not changed:
        print(f"\n  {DIM}No changes.{RST}")
        input("\n  Press Enter to return to menu...")
        return

    try:
        cfg_path.write_text(json.dumps(cfg, indent=2) + "\n")
        try:
            os.chmod(cfg_path, 0o600)
        except OSError:
            pass
    except OSError as e:
        print(f"\n  {fail_inline()} Save failed: {e}")
        input("\n  Press Enter to return to menu...")
        return

    print()
    print(f"  {ok_inline('Saved.')}")
    print()
    print(f"  {DIM}Restart the server to apply changes.{RST}")
    input("\n  Press Enter to return to menu...")


def action_uninstall() -> None:
    clear_screen()
    print(render_banner("Uninstall"))
    print()
    print(f"  {DIM}The following will be removed:{RST}")
    print(f"    {DIM}• Running server (if any){RST}")
    print(f"    {DIM}• Autostart entry{RST}")
    print(f"    {DIM}• Desktop shortcut{RST}")
    print(f"    {DIM}• Install folder ({ROOT}){RST}")
    print()
    ans = input("  Continue? [y/N] ").strip().lower()
    if ans != "y":
        print(f"\n  {DIM}Cancelled.{RST}")
        input("  Press Enter to return to menu...")
        return
    print()

    kill_port_8484()
    step_print(1, 4, "Stopping server", ok_inline())

    if platform.system() == "Windows":
        try:
            import winreg
            with winreg.OpenKey(
                winreg.HKEY_CURRENT_USER,
                r"Software\Microsoft\Windows\CurrentVersion\Run",
                0, winreg.KEY_ALL_ACCESS,
            ) as k:
                names = []
                i = 0
                while True:
                    try:
                        n, _, _ = winreg.EnumValue(k, i)
                    except OSError:
                        break
                    if "ggeo" in n.lower() or "gpro" in n.lower():
                        names.append(n)
                    i += 1
                for n in names:
                    winreg.DeleteValue(k, n)
        except Exception:
            pass
        step_print(2, 4, "Removing autostart", ok_inline())

        for desktop in (
            Path(os.environ.get("USERPROFILE", str(Path.home()))) / "Desktop",
            Path(os.environ.get("USERPROFILE", str(Path.home()))) / "OneDrive" / "Desktop",
        ):
            if desktop.is_dir():
                for lnk in list(desktop.glob("GGeo*Client*.lnk")) + list(desktop.glob("GGEO*Client*.lnk")):
                    try:
                        lnk.unlink()
                    except Exception:
                        pass
        step_print(3, 4, "Removing desktop shortcut", ok_inline())

        os.system(
            f'start /B cmd /C "timeout /t 2 /nobreak > nul && rd /s /q "{ROOT}""'
        )
        step_print(4, 4, "Removing install folder", ok_inline("scheduled"))
    else:
        subprocess.run(["sudo", "pkill", "-9", "-f", "_internal/run.py"],
                       capture_output=True)
        subprocess.run(["sudo", "pkill", "-9", "-f", "_internal/tray.py"],
                       capture_output=True)
        agents = Path.home() / "Library" / "LaunchAgents"
        if agents.is_dir():
            for plist in agents.glob("com.ggeo.tray.*.plist"):
                label = plist.stem
                subprocess.run(["launchctl", "bootout",
                                f"gui/{os.getuid()}/{label}"],
                               capture_output=True)
                subprocess.run(["sudo", "launchctl", "bootout",
                                f"system/{label}"], capture_output=True)
                try:
                    plist.unlink()
                except Exception:
                    pass
        step_print(2, 4, "Removing autostart", ok_inline())

        for app in list((Path.home() / "Desktop").glob("*GGeo*Client*.app")) + \
                   list((Path.home() / "Desktop").glob("*GGEO*Client*.app")):
            shutil.rmtree(app, ignore_errors=True)
        step_print(3, 4, "Removing desktop shortcut", ok_inline())

        trash = f"/tmp/.ggeo-trash-{os.getpid()}"
        subprocess.run(["sudo", "mv", str(ROOT), trash], capture_output=True)
        subprocess.Popen(["sudo", "rm", "-rf", trash])
        step_print(4, 4, "Removing install folder", ok_inline())

    print(render_closing("Uninstall complete"))
    input("\n  Press Enter to close...")


def main() -> None:
    if "--view-log" in sys.argv:
        action_view_log()
        return

    clear_screen()
    print(banner())
    if not request_sudo_upfront():
        print(f"\n  {fail_inline('Authentication cancelled.')}")
        input("\n  Press Enter to close...")
        return

    actions = {
        "1": action_setup,
        "2": action_edit_network,
        "3": action_start_server,
        "4": action_start_with_log,
        "5": action_view_log,
        "6": action_update,
        "7": action_uninstall,
    }

    while True:
        clear_screen()
        print(banner())
        default = detect_default()
        print_menu(default)
        try:
            choice = input(f"  Enter choice [{default}]: ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            print()
            return
        if not choice:
            choice = default

        if choice == "q":
            print(f"  {DIM}Bye.{RST}")
            return

        fn = actions.get(choice)
        if not fn:
            print(f"  {fail_inline('Invalid choice')}")
            time.sleep(1)
            continue

        try:
            fn()
        except KeyboardInterrupt:
            print()

        if choice == "6":
            return


if __name__ == "__main__":
    main()
