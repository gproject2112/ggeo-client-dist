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
# Hash of the requirements.txt whose install last SUCCEEDED. Lives in the
# gitignored data/ dir so `git reset --hard` can't clobber it.
DEPS_STAMP = PROJECT_ROOT / "data" / ".deps-installed"

PIP_TIMEOUT = 600


def _hash_file(path: Path) -> str:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError:
        return ""


def _ensure_deps() -> bool:
    """Install deps when requirements.txt differs from the last good install.

    Returns True only when pip ran, succeeded, AND the stamp was written —
    i.e. when the caller must re-exec to pick the new libraries up.

    Stamping on success only (instead of diffing requirements.txt across the
    git reset) means a failed or timed-out install is retried on the next
    start. The old diff ran pip exactly once and swallowed the result, so a
    half-finished install stuck forever: the next start was already
    up-to-date, returned early, and never re-ran pip.
    """
    want = _hash_file(REQUIREMENTS)
    if not want or _read_deps_stamp() == want:
        return False

    logger.info("auto-update: dependencies out of date, running pip install ...")
    try:
        rc = subprocess.run(
            [sys.executable, "-m", "pip", "install",
             "-r", str(REQUIREMENTS), "--quiet",
             "--break-system-packages"],
            check=False,
            timeout=PIP_TIMEOUT,
        ).returncode
        detail = "exit %s" % rc
    except subprocess.TimeoutExpired:
        rc, detail = 124, "timeout after %ds" % PIP_TIMEOUT
    except Exception as e:  # noqa: BLE001
        rc, detail = 1, str(e)

    if rc != 0:
        logger.error(
            "auto-update: pip install failed (%s) — device engine may fail to "
            "import. Retrying on next start.", detail,
        )
        return False

    try:
        DEPS_STAMP.parent.mkdir(parents=True, exist_ok=True)
        DEPS_STAMP.write_text(want)
    except OSError as e:
        # No stamp means pip re-runs every start (a few seconds when already
        # satisfied). Deliberately NOT re-execing here — an unwritable stamp
        # plus a re-exec is an infinite restart loop.
        logger.warning(
            "auto-update: deps installed but stamp unwritable (%s); "
            "pip will re-run next start", e,
        )
        return False
    logger.info("auto-update: dependencies installed")
    return True


def _read_deps_stamp() -> str:
    try:
        return DEPS_STAMP.read_text().strip()
    except OSError:
        return ""


def _reexec() -> bool:
    if os.name == "nt":
        # Windows os.execv is CreateProcess + kill-self, not an image swap: the
        # pid changes and the caller exits 0. scripts/menu.py launches the
        # server with a blocking subprocess.call, so it would print "Server
        # stopped" while the server is still booting, and the next Start Server
        # hits "port 8484 already in use". Staying in the wait chain keeps
        # menu.py blocked on a live process. SystemExit is a BaseException, so
        # run.py's `except Exception` passes it through and we exit with the
        # child's real code.
        raise SystemExit(subprocess.call([sys.executable] + sys.argv))
    try:
        os.execv(sys.executable, [sys.executable] + sys.argv)
    except OSError as e:
        logger.warning("auto-update: execv failed (%s); continuing", e)
        return False
    return True


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
        # Code is current but a previous dependency install may have failed.
        # Deliberately no re-exec here: on Windows os.execv spawns a NEW pid
        # and kills this one, so scripts/menu.py — which launches the server
        # with a blocking subprocess.call — would see the server "exit" while
        # a detached copy kept running. The repaired packages are picked up on
        # the next start, which is still strictly better than the old code
        # (it never retried a failed install at all).
        _ensure_deps()
        return False

    logger.info("auto-update: %d commit(s) behind, pulling ...", n)
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

    _ensure_deps()

    logger.info("auto-update: pulled OK, restarting to load new code ...")
    return _reexec()
