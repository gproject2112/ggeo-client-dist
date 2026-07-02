"""GGEO — GPS Location Spoofer for iPhone."""

import logging
import os
from logging.handlers import RotatingFileHandler
from pathlib import Path

from ggeo.config import LOG_LEVEL, LOG_FILE, LOG_MAX_BYTES, LOG_BACKUP_COUNT, PROJECT_ROOT

_LOG_PATH = PROJECT_ROOT / LOG_FILE

# Ensure data/ directory exists
os.makedirs(_LOG_PATH.parent, exist_ok=True)


def _setup_logger():
    """Configure root ggeo logger with file + stdout handlers."""
    root = logging.getLogger("ggeo")
    if getattr(root, "_ggeo_configured", False):
        return  # Already set up

    level = getattr(logging, LOG_LEVEL.upper(), logging.INFO)
    root.setLevel(level)

    fmt = logging.Formatter(
        fmt="%(asctime)s | %(levelname)-7s | %(name)s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    # File handler with rotation (5 MB, 3 backups)
    try:
        file_handler = RotatingFileHandler(
            str(_LOG_PATH),
            maxBytes=LOG_MAX_BYTES,
            backupCount=LOG_BACKUP_COUNT,
            encoding="utf-8",
        )
        file_handler.setFormatter(fmt)
        file_handler.setLevel(level)
        root.addHandler(file_handler)
    except Exception as e:
        # Don't crash if log file can't be opened — fall back to stdout only
        print("Warning: could not open log file %s: %s" % (_LOG_PATH, e))

    # Stdout handler (visible in terminal / tray subprocess pipe)
    stream_handler = logging.StreamHandler()
    stream_handler.setFormatter(fmt)
    stream_handler.setLevel(level)
    root.addHandler(stream_handler)

    root.propagate = False
    root._ggeo_configured = True


_setup_logger()
