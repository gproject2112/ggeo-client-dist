"""Auto-update — fetch + fast-forward pull `main` from GitHub at startup."""
from __future__ import annotations

import hashlib
import logging
import os
import subprocess
import sys
from pathlib import Path

logger = logging.getLogger("ggeo.sync.auto_update")

def _walk_up(start: Path, max_levels: int = 6):
    p = start.resolve()
    for _ in range(max_levels):
        yield p
        if p.parent == p:
            break
        p = p.parent


def _find_repo_root() -> Path:
    for c in _walk_up(Path(__file__).parent, 6):
        if (c / ".git").is_dir():
            return c
    return Path(__file__).resolve().parent.parent.parent


def _find_project_root() -> Path:
    for c in _walk_up(Path(__file__).parent, 6):
        if (c / "VERSION").exists() and (c / "setup.py").exists():
            return c
    return Path(__file__).resolve().parent.parent.parent


REPO_ROOT = _find_repo_root()
PROJECT_ROOT = _find_project_root()
GIT_DIR = REPO_ROOT / ".git"
REQUIREMENTS = PROJECT_ROOT / "requirements.txt"


def _hash_file(path: Path) -> str:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except FileNotFoundError:
        return ""


def _git_cmd_prefix() -> list[str]:
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        sudo_user = os.environ.get("SUDO_USER")
        if sudo_user:
            return ["sudo", "-u", sudo_user]
    return []


def _run(args: list[str], timeout: int = 10) -> tuple[int, str, str]:
    """Run a git command, return (rc, stdout, stderr). Never raises."""
    try:
        proc = subprocess.run(
            _git_cmd_prefix() + ["git", "-C", str(REPO_ROOT)] + args,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return proc.returncode, proc.stdout.strip(), proc.stderr.strip()
    except subprocess.TimeoutExpired:
        return 124, "", f"timeout after {timeout}s"
    except FileNotFoundError:
        return 127, "", "git not in PATH"
    except Exception as e:  # noqa: BLE001
        return 1, "", str(e)


def _has_uncommitted_changes() -> bool:
    rc, out, _ = _run(
        ["status", "--porcelain", "--untracked-files=no"],
        timeout=5,
    )
    return rc == 0 and bool(out)


def _current_branch() -> str:
    rc, out, _ = _run(["rev-parse", "--abbrev-ref", "HEAD"], timeout=5)
    return out if rc == 0 else "HEAD"


def check_and_update() -> bool:
    """Fetch + fast-forward pull main; re-exec on success. Returns False if skipped."""
    if os.environ.get("GGEO_NO_AUTOUPDATE", "").strip() in ("1", "true", "yes"):
        logger.info("auto-update: disabled via GGEO_NO_AUTOUPDATE")
        return False

    if not GIT_DIR.is_dir():
        logger.info("auto-update: not a git checkout, skipping")
        return False

    branch = _current_branch()
    if branch not in ("main", "HEAD"):
        logger.info("auto-update: branch is %r (not main), skipping", branch)
        return False

    if _has_uncommitted_changes():
        logger.info(
            "auto-update: local uncommitted changes detected, skipping pull"
        )
        return False

    logger.info("auto-update: fetching origin/main ...")
    rc, _, err = _run(["fetch", "--quiet", "origin", "main"], timeout=15)
    if rc != 0:
        logger.warning("auto-update: fetch failed (%s); skipping", err or rc)
        return False

    rc, behind, _ = _run(
        ["rev-list", "--count", "HEAD..origin/main"], timeout=5,
    )
    if rc != 0 or not behind.isdigit():
        logger.warning("auto-update: rev-list failed (%s); skipping", behind)
        return False

    n = int(behind)
    if n == 0:
        logger.info("auto-update: already up-to-date")
        return False

    logger.info("auto-update: %d commit(s) behind, pulling ...", n)
    req_hash_before = _hash_file(REQUIREMENTS)
    rc, out, err = _run(
        ["reset", "--hard", "origin/main"], timeout=30,
    )
    if rc != 0:
        logger.warning(
            "auto-update: reset failed (%s); continuing with old code",
            err or rc,
        )
        return False

    if branch == "HEAD":
        _run(["checkout", "-B", "main", "origin/main"], timeout=10)

    if _hash_file(REQUIREMENTS) != req_hash_before:
        logger.info(
            "auto-update: requirements.txt changed, installing dependencies ..."
        )
        try:
            subprocess.run(
                [sys.executable, "-m", "pip", "install",
                 "-r", str(REQUIREMENTS), "--quiet",
                 "--break-system-packages"],
                check=False,
                timeout=600,
            )
        except subprocess.TimeoutExpired:
            logger.warning("auto-update: pip install timeout, continuing")
        except Exception as e:  # noqa: BLE001
            logger.warning("auto-update: pip install raised (%s), continuing", e)

    logger.info("auto-update: pulled OK, restarting to load new code ...")
    try:
        os.execv(sys.executable, [sys.executable] + sys.argv)
    except OSError as e:
        logger.warning("auto-update: execv failed (%s); continuing", e)
        return False
    return True
