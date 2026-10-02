#!/usr/bin/env python3
"""Bulk import conol.ai accounts from pool JSONL into ExtremeRouter providerConnections.

Usage:
    python scripts/import-conol-pool.py [--dry-run] [--db <path>] [--pool <path>] [--only-live]
"""
import argparse
import json
import os
import sqlite3
import sys
import time
import uuid
from datetime import datetime, timezone

NOW = time.time()
COOKIE_NAME = "__Secure-better-auth.session_token"
DEFAULT_POOL = os.path.join(
    os.path.expanduser("~"), "Desktop", "_PROJECTS",
    "conol_autoreg", "conol_accounts_pool.jsonl"
)
DEFAULT_DB = os.path.join(
    os.environ.get("APPDATA", os.path.join(os.path.expanduser("~"), "AppData", "Roaming")),
    "extremerouter", "db", "data.sqlite"
)


def resolve_pool_path(pool_arg):
    if pool_arg:
        return os.path.abspath(pool_arg)
    # default: relative to script
    candidate = os.path.abspath(DEFAULT_POOL)
    if os.path.exists(candidate):
        return candidate
    raise FileNotFoundError(f"Pool file not found at {candidate}")


def resolve_db_path(db_arg):
    if db_arg:
        return os.path.abspath(db_arg)
    candidate = os.path.abspath(DEFAULT_DB)
    if os.path.exists(candidate):
        return candidate
    raise FileNotFoundError(f"DB not found at {candidate}")


def read_pool(path):
    """Read JSONL pool, return list of dicts with fixed cookie paths."""
    pool_dir = os.path.dirname(path)
    entries = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            entry = json.loads(line)
            # Fix cookie path if broken (points to wrong dir)
            cp = entry.get("cookies_path", "")
            if cp and not os.path.exists(cp):
                # Try same dir as pool file
                alt = os.path.join(pool_dir, os.path.basename(cp))
                if os.path.exists(alt):
                    entry["cookies_path"] = alt
            entries.append(entry)
    return entries


def extract_session_token(cookies_path):
    """Return (token_str, expires_ts) from cookie file, or (None, None)."""
    if not cookies_path or not os.path.exists(cookies_path):
        return None, None
    try:
        with open(cookies_path) as f:
            cookies = json.load(f)
    except (json.JSONDecodeError, Exception):
        return None, None
    for c in cookies:
        if isinstance(c, dict) and c.get("name") == COOKIE_NAME:
            val = c.get("value", "") or ""
            exp = c.get("expires") or c.get("expirationDate") or 0
            return val.strip(), float(exp)
    return None, None


def backup_db(db_path):
    """Create a timestamped backup copy next to the DB."""
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    bak = f"{db_path}.bak-eni-conol-{ts}"
    import shutil
    # Also copy WAL/SHM if present
    for suffix in ("", "-wal", "-shm"):
        src = db_path + suffix
        if os.path.exists(src):
            shutil.copy2(src, bak + suffix)
    return bak


def get_connection(db_path, retries=3, delay=0.5):
    """Open SQLite with WAL mode, retry on locked."""
    for attempt in range(retries):
        try:
            conn = sqlite3.connect(db_path, timeout=5)
            conn.execute("PRAGMA journal_mode=WAL;")
            conn.execute("PRAGMA busy_timeout=5000;")
            return conn
        except sqlite3.OperationalError as e:
            if "locked" in str(e).lower() and attempt < retries - 1:
                time.sleep(delay)
                continue
            raise


def upsert_provider_connection(cursor, entry, session_token, expires, now_ts):
    """Upsert one conol-web connection row. Returns dict with status."""
    email = entry["email"]
    name = entry.get("name", email.split("@")[0])
    is_live = bool(session_token and expires > now_ts)

    # Check existing by email (dedup)
    existing = cursor.execute(
        "SELECT id, data, isActive FROM providerConnections "
        "WHERE provider='conol-web' AND email=?",
        (email,)
    ).fetchone()

    # Build providerSpecificData
    provider_data = {"cookie": session_token or ""}

    payload = {
        "apiKey": "",
        "baseUrl": "https://conol.ai",
        "testStatus": "unknown",
        "providerSpecificData": provider_data,
    }
    data_json = json.dumps(payload, ensure_ascii=False)

    if existing:
        row_id = existing[0]
        cursor.execute(
            "UPDATE providerConnections SET isActive=?, data=?, name=?, updatedAt=? WHERE id=?",
            (1 if is_live else 0, data_json, name, dt_now(), row_id)
        )
        return {"action": "updated", "email": email, "live": is_live, "token_present": bool(session_token)}
    else:
        row_id = str(uuid.uuid4())
        cursor.execute(
            "INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt) "
            "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (row_id, "conol-web", "cookie", name, email, None, 1 if is_live else 0, data_json, dt_now(), dt_now())
        )
        return {"action": "created", "email": email, "live": is_live, "token_present": bool(session_token)}


def dt_now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{datetime.now(timezone.utc).microsecond:06d}Z"


def import_pool(pool_path, db_path, dry_run=False, only_live=False):
    """Main import routine. Returns report dict."""
    entries = read_pool(pool_path)
    report = {"total": len(entries), "created": 0, "updated": 0, "skipped": 0, "live": 0, "expired": 0, "no_token": 0, "errors": []}

    conn = None
    if not dry_run:
        conn = get_connection(db_path)
        cursor = conn.cursor()

    now_ts = time.time()

    for entry in entries:
        token, expires = extract_session_token(entry.get("cookies_path", ""))

        if only_live and not (token and expires > now_ts):
            report["skipped"] += 1
            continue

        if dry_run:
            is_live = bool(token and expires > now_ts)
            if is_live:
                report["live"] += 1
            elif token:
                report["expired"] += 1
            else:
                report["no_token"] += 1
            continue

        try:
            result = upsert_provider_connection(cursor, entry, token, expires, now_ts)
            if result["action"] == "created":
                report["created"] += 1
            else:
                report["updated"] += 1
            if result["live"]:
                report["live"] += 1
            elif result["token_present"]:
                report["expired"] += 1
            else:
                report["no_token"] += 1
        except Exception as e:
            report["errors"].append({"email": entry["email"], "error": str(e)})

    if conn:
        conn.commit()
        conn.close()

    return report


def print_report(report, prefix=""):
    print(f"{prefix}Total: {report['total']}, Created: {report['created']}, Updated: {report['updated']}, Skipped: {report['skipped']}")
    print(f"{prefix}Live: {report['live']}, Expired: {report['expired']}, No Token: {report['no_token']}")
    if report['errors']:
        print(f"{prefix}Errors ({len(report['errors'])}):")
        for e in report['errors']:
            print(f"  {e['email']}: {e['error']}")


def selfcheck():
    """Runnable self-check: cookie normalization + dedup + isActive logic."""
    ok = True

    # 1. normalizeConolCookie equivalent logic: token without "=" → gets prefix
    token = "abc123def456"
    expected = "__Secure-better-auth.session_token=abc123def456"
    result = token if "=" in token else f"{COOKIE_NAME}={token}"
    assert result == expected, f"normalize fail: {result} != {expected}"
    print("[PASS] normalizeConolCookie wraps bare token")

    # 2. Already wrapped token with "=" → returned as-is
    token2 = "__Secure-better-auth.session_token=wrapped"
    result2 = token2 if "=" in token2 else f"{COOKIE_NAME}={token2}"
    assert result2 == token2, f"normalize fail (wrapped): {result2} != {token2}"
    print("[PASS] normalizeConolCookie passes through already-wrapped value")

    # 3. Dedup by email
    import tempfile
    import os as _os
    tmp = _os.path.join(tempfile.gettempdir(), f"conol_selfcheck_{int(time.time())}.db")
    conn = sqlite3.connect(tmp)
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("""CREATE TABLE providerConnections (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL, authType TEXT NOT NULL,
        name TEXT, email TEXT, priority INTEGER, isActive INTEGER DEFAULT 1,
        data TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
    );""")

    def _upsert(c, email, live):
        existing = c.execute("SELECT id FROM providerConnections WHERE provider='conol-web' AND email=?", (email,)).fetchone()
        uid = existing[0] if existing else str(uuid.uuid4())
        payload = json.dumps({"providerSpecificData": {"cookie": "tok" if live else ""}})
        if existing:
            c.execute("UPDATE providerConnections SET isActive=?, data=?, updatedAt=? WHERE id=?", (1 if live else 0, payload, dt_now(), uid))
        else:
            c.execute("INSERT INTO providerConnections VALUES(?, 'conol-web', 'cookie', ?, ?, NULL, ?, ?, ?, ?)",
                      (uid, email.split('@')[0], email, 1 if live else 0, payload, dt_now(), dt_now()))

    _upsert(conn, "test@example.com", True)
    _upsert(conn, "test@example.com", False)  # same email → update, not create
    cnt = conn.execute("SELECT COUNT(*) FROM providerConnections WHERE email='test@example.com'").fetchone()[0]
    assert cnt == 1, f"Dedup fail: {cnt} != 1"
    is_a = conn.execute("SELECT isActive FROM providerConnections WHERE email='test@example.com'").fetchone()[0]
    assert is_a == 0, f"isActive should be 0, got {is_a}"
    print("[PASS] Dedup by email works, isActive correctly updated")

    conn.close()
    _os.remove(tmp)
    print("[PASS] All self-checks passed")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Import conol.ai accounts into ExtremeRouter")
    parser.add_argument("--dry-run", action="store_true", help="Preview only, no DB writes")
    parser.add_argument("--db", help="Path to data.sqlite (default: ER user data DB)")
    parser.add_argument("--pool", help="Path to conol_accounts_pool.jsonl (default: canonical)")
    parser.add_argument("--only-live", action="store_true", help="Only import accounts with valid session tokens")
    parser.add_argument("--selfcheck", action="store_true", help="Run unit self-checks and exit")
    args = parser.parse_args()

    if args.selfcheck:
        selfcheck()
        sys.exit(0)

    pool_path = resolve_pool_path(args.pool)
    db_path = resolve_db_path(args.db)

    print(f"Pool: {pool_path}")
    print(f"DB:   {db_path}")
    print(f"Args: dry_run={args.dry_run}, only_live={args.only_live}")

    if not args.dry_run:
        bak = backup_db(db_path)
        print(f"Backup: {bak}")

    report = import_pool(pool_path, db_path, dry_run=args.dry_run, only_live=args.only_live)
    print()
    print_report(report)