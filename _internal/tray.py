#!/usr/bin/env python3
"""GGeo Tray launcher."""
from __future__ import annotations

import os
import runpy
import sys
from pathlib import Path

SUPPORTED = ("py311", "py312", "py313")

ROOT = Path(__file__).resolve().parent


def _fail(msg: str) -> None:
    print()
    print("=" * 60)
    print(msg)
    print("=" * 60)
    print()
    sys.exit(1)


def main() -> None:
    v = sys.version_info
    py_tag = f"py{v.major}{v.minor}"

    if py_tag not in SUPPORTED:
        _fail(
            f"  GGeo Client requires Python 3.11, 3.12, or 3.13.\n"
            f"  Detected: Python {v.major}.{v.minor}.{v.micro}\n"
            f"  Install from https://python.org/downloads/"
        )

    target = ROOT / py_tag
    entry = target / "tray.py"
    if not entry.exists():
        available = sorted(
            p.name for p in ROOT.iterdir()
            if p.is_dir() and p.name in SUPPORTED and (p / "tray.py").exists()
        )
        if available:
            versions = ", ".join(f"3.{t[3:]}" for t in available)
            _fail(
                f"  This GGeo install has no runtime for Python {v.major}.{v.minor}.\n"
                f"  Installed runtimes support Python: {versions}\n"
                f"  Fix: install Python {versions.split(', ')[0]} from https://python.org/downloads/\n"
                f"  (or run Update from the GGeo menu after a new release ships)"
            )
        _fail(
            f"  Runtime tree missing: {entry}\n"
            f"  The installation looks corrupted. Run Update from the GGeo menu,\n"
            f"  or re-download GGeo."
        )

    sys.path.insert(0, str(target))
    os.chdir(ROOT)

    runpy.run_path(str(entry), run_name="__main__")


if __name__ == "__main__":
    main()
