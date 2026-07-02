"""Shared CLI helpers — ANSI colors, box drawing, banner, spinner.

Used by setup.py (top-level wizard) and run.py (runtime dashboard).
Pure stdlib, no external dep, cross-platform Mac/Windows/Linux.
"""
from __future__ import annotations

import locale
import os
import platform
import re
import shutil
import sys
import threading
import time
from typing import Iterable

_ANSI_RE = re.compile(r"\x1b\[[0-9;]*[a-zA-Z]")


def _enable_windows_vt() -> None:
    if platform.system() != "Windows":
        return
    try:
        import ctypes
        kernel32 = ctypes.windll.kernel32
        STD_OUTPUT_HANDLE = -11
        ENABLE_PROCESSED_OUTPUT = 0x0001
        ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004
        h = kernel32.GetStdHandle(STD_OUTPUT_HANDLE)
        mode = ctypes.c_ulong()
        if kernel32.GetConsoleMode(h, ctypes.byref(mode)):
            kernel32.SetConsoleMode(
                h,
                mode.value | ENABLE_PROCESSED_OUTPUT | ENABLE_VIRTUAL_TERMINAL_PROCESSING,
            )
    except Exception:
        pass


_enable_windows_vt()


def _can_unicode() -> bool:
    enc = (sys.stdout.encoding or locale.getpreferredencoding(False) or "ascii").lower()
    if "utf" in enc:
        return True
    try:
        "╔─⠋✓⚠✗".encode(enc)
        return True
    except (UnicodeEncodeError, LookupError):
        return False


_USE_UNICODE = _can_unicode()


def _isatty() -> bool:
    try:
        return sys.stdout.isatty()
    except Exception:
        return False


_USE_COLOR = _isatty() and os.environ.get("NO_COLOR", "") == ""


# --- ANSI color codes ----------------------------------------------------

class _C:
    RESET = "\x1b[0m"
    BOLD = "\x1b[1m"
    DIM = "\x1b[2m"
    UNDERLINE = "\x1b[4m"
    CYAN = "\x1b[36m"
    GREEN = "\x1b[32m"
    YELLOW = "\x1b[33m"
    RED = "\x1b[31m"
    BLUE = "\x1b[34m"
    WHITE = "\x1b[37m"
    GREY = "\x1b[2;37m"


def _color(text: str, *codes: str) -> str:
    if not _USE_COLOR:
        return text
    return "".join(codes) + text + _C.RESET


def cyan(t: str) -> str:        return _color(t, _C.CYAN)
def cyan_b(t: str) -> str:      return _color(t, _C.BOLD, _C.CYAN)
def green(t: str) -> str:       return _color(t, _C.GREEN)
def green_b(t: str) -> str:     return _color(t, _C.BOLD, _C.GREEN)
def yellow(t: str) -> str:      return _color(t, _C.YELLOW)
def yellow_b(t: str) -> str:    return _color(t, _C.BOLD, _C.YELLOW)
def red(t: str) -> str:         return _color(t, _C.RED)
def red_b(t: str) -> str:       return _color(t, _C.BOLD, _C.RED)
def grey(t: str) -> str:        return _color(t, _C.GREY)
def underline_cyan(t: str) -> str:
    return _color(t, _C.UNDERLINE, _C.CYAN)


# --- Symbols (UTF-8 with ASCII fallback) ---------------------------------

if _USE_UNICODE:
    SYM_OK = "✓"
    SYM_WARN = "⚠"
    SYM_FAIL = "✗"
    SYM_DOT = "●"
    SYM_PAUSE = "⏸"
    SYM_BULLET = "›"
    SPINNER_FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
    BOX = {
        "tl": "╔", "tr": "╗", "bl": "╚", "br": "╝",
        "h": "═", "v": "║",
    }
else:
    SYM_OK = "[OK]"
    SYM_WARN = "[!]"
    SYM_FAIL = "[X]"
    SYM_DOT = "*"
    SYM_PAUSE = "||"
    SYM_BULLET = ">"
    SPINNER_FRAMES = "|/-\\"
    BOX = {
        "tl": "+", "tr": "+", "bl": "+", "br": "+",
        "h": "-", "v": "|",
    }


# --- Box drawing ----------------------------------------------------------

DEFAULT_BOX_WIDTH = 54


def term_width() -> int:
    try:
        return shutil.get_terminal_size((80, 20)).columns
    except Exception:
        return 80


def _strip_ansi(s: str) -> str:
    return _ANSI_RE.sub("", s)


def _visible_len(s: str) -> int:
    return len(_strip_ansi(s))


def box_top(width: int = DEFAULT_BOX_WIDTH, color_fn=grey) -> str:
    return color_fn(BOX["tl"] + BOX["h"] * (width - 2) + BOX["tr"])


def box_bot(width: int = DEFAULT_BOX_WIDTH, color_fn=grey) -> str:
    return color_fn(BOX["bl"] + BOX["h"] * (width - 2) + BOX["br"])


def box_line(text: str = "", width: int = DEFAULT_BOX_WIDTH,
             color_fn=grey) -> str:
    pad = width - 2 - _visible_len(text)
    if pad < 0:
        plain = _strip_ansi(text)[: width - 2]
        return color_fn(BOX["v"]) + plain + color_fn(BOX["v"])
    return color_fn(BOX["v"]) + text + " " * pad + color_fn(BOX["v"])


def box_section(title: str, lines: Iterable[str],
                width: int = DEFAULT_BOX_WIDTH, color_fn=grey) -> list[str]:
    out = [color_fn(BOX["tl"] + BOX["h"] * 2 + " " + title + " "
                    + BOX["h"] * (width - 5 - len(title)) + BOX["tr"])]
    for ln in lines:
        out.append(box_line(ln, width, color_fn))
    out.append(box_bot(width, color_fn))
    return out


# --- Logo "GGeo" ASCII art ----------------------------------------------

LOGO_LINES = [
    "╔═╗╔═╗┌─┐┌─┐",
    "║ ╦║ ╦├┤ │ │",
    "╚═╝╚═╝└─┘└─┘",
] if _USE_UNICODE else [
    " GG  ",
    "G  e ",
    "GG eo",
]


def banner_setup(version: str, author: str = "by Gpro · badupro",
                 width: int = DEFAULT_BOX_WIDTH) -> list[str]:
    lines = [box_top(width)]
    lines.append(box_line(width=width))
    inset = "   "
    title_pad = "    "
    titles = [
        "Setup Wizard",
        f"v{version} · {author}",
        "Mobile GPS Location Spoofer",
    ]
    for i, lg in enumerate(LOGO_LINES):
        title = titles[i] if i < len(titles) else ""
        line = inset + cyan_b(lg) + title_pad
        if i == 0:
            line += title
        elif i == 1:
            line += grey(title)
        else:
            line += grey(title)
        lines.append(box_line(line, width))
    lines.append(box_line(width=width))
    lines.append(box_bot(width))
    return lines


def banner_runtime(version: str, status: str, urls: dict,
                   author: str = "by Gpro · badupro",
                   width: int = DEFAULT_BOX_WIDTH) -> list[str]:
    lines = [box_top(width)]
    lines.append(box_line(width=width))
    inset = "   "
    title_pad = "    "
    titles = [
        f"GGeo Client v{version}",
        "Mobile GPS Location Spoofer",
        author,
    ]
    for i, lg in enumerate(LOGO_LINES):
        title = titles[i] if i < len(titles) else ""
        line = inset + cyan_b(lg) + title_pad
        if i == 0:
            line += title
        elif i == 1:
            line += grey(title)
        else:
            line += grey(title)
        lines.append(box_line(line, width))
    lines.append(box_line(width=width))
    state, color_fn = _status_color(status)
    lines.append(box_line("   Status     " + color_fn(SYM_DOT + " " + state),
                          width))
    for label, url in urls.items():
        lines.append(box_line(f"   {label:10} " + underline_cyan(url), width))
    lines.append(box_line(width=width))
    lines.append(box_line("   " + grey("Ctrl+C to stop"), width))
    lines.append(box_line(width=width))
    lines.append(box_bot(width))
    return lines


def _status_color(state: str):
    s = state.lower()
    if "running" in s or "ready" in s:
        return state, green_b
    if "reconnecting" in s or "unstable" in s:
        return state, yellow_b
    if "suspended" in s or "stopped" in s or "error" in s:
        return state, red_b
    return state, green_b


# --- Step renderer (compact 1-line) -------------------------------------

STATUS_COLUMN = 40


def step_line(num: int, total: int, label: str, status: str = "",
              width: int = DEFAULT_BOX_WIDTH) -> str:
    left = f"  {cyan(f'[{num}/{total}]')}  {label}"
    if not status:
        return left
    pad = max(2, STATUS_COLUMN - _visible_len(left))
    return left + " " * pad + status


def step_indent() -> str:
    return "          "  # align under step label


# --- Force-close box -----------------------------------------------------

def force_close_box(title: str, lines: list[str],
                    width: int = DEFAULT_BOX_WIDTH) -> list[str]:
    out = [box_top(width, red)]
    out.append(box_line(width=width, color_fn=red))
    out.append(box_line("   " + red_b(SYM_FAIL + "  " + title), width, red))
    out.append(box_line(width=width, color_fn=red))
    for ln in lines:
        out.append(box_line("   " + ln, width, red))
    out.append(box_line(width=width, color_fn=red))
    out.append(box_bot(width, red))
    return out


def error_box_inline(title: str, detail: list[str], prompt: str = "",
                     width: int = DEFAULT_BOX_WIDTH) -> list[str]:
    out = [grey(BOX["tl"] + BOX["h"] * 2 + " " + red_b(title) + " "
                + BOX["h"] * (width - 5 - len(title)) + BOX["tr"])]
    for ln in detail:
        out.append(box_line("  " + ln, width))
    if prompt:
        out.append(box_line(width=width))
        out.append(box_line("  " + prompt, width))
    out.append(box_bot(width))
    return out


# --- Spinner -----------------------------------------------------------

class Spinner:
    """Inline spinner with last-line update. Uses \\r in TTY only."""

    def __init__(self, prefix: str = ""):
        self.prefix = prefix
        self.frames = SPINNER_FRAMES
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()
        self._msg = ""
        self._start_ts = 0.0

    def update(self, msg: str) -> None:
        with self._lock:
            self._msg = msg

    def start(self) -> None:
        if not _isatty():
            return
        self._stop.clear()
        self._start_ts = time.monotonic()
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def _loop(self) -> None:
        i = 0
        while not self._stop.is_set():
            with self._lock:
                msg = self._msg
            elapsed = int(time.monotonic() - self._start_ts)
            char = self.frames[i % len(self.frames)]
            line = f"{self.prefix}{cyan(char)} {msg} {grey(f'({elapsed}s)')}"
            self._render(line)
            time.sleep(0.1)
            i += 1
        self._clear()

    def _render(self, line: str) -> None:
        w = term_width() - 1
        if _visible_len(line) > w:
            # Truncate visible content (rough)
            plain = _strip_ansi(line)
            line = plain[:w]
        sys.stdout.write("\r" + line + " " * max(0, w - _visible_len(line)))
        sys.stdout.flush()

    def _clear(self) -> None:
        w = term_width()
        sys.stdout.write("\r" + " " * (w - 1) + "\r")
        sys.stdout.flush()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2)


# --- Print helpers ------------------------------------------------------

def out(line: str = "") -> None:
    print(line)


def out_lines(lines: Iterable[str]) -> None:
    for ln in lines:
        print(ln)
