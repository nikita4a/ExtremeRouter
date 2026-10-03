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
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_HOME_CANDIDATES = [
    os.environ.get("USERPROFILE"),
    os.path.expanduser("~"),
    # <home>/tmp/er-fork/ExtremeRouter/scripts -> <home>
    os.path.abspath(os.path.join(_SCRIPT_DIR, "..", "..", "..", "..")),
]
_HOME_CANDIDATES = [h for h in _HOME_CANDIDATES if h]


def _first_existing(rel_parts):
    """Resolve a path under the user home, tolerating a broken expanduser('~')."""
    for home in _HOME_CANDIDATES:
        candidate = os.path.abspath(os.path.join(home, *rel_parts))
        if os.path.exists(candidate):
            return candidate
    return os.path.abspath(os.path.join(_HOME_CANDIDATES[0], *rel_parts))


DEFAULT_POOL = _first_existing(
    ("Desktop", "_PROJECTS", "conol_autoreg", "conol_accounts_pool.jsonl")
)
DEFAULT_DB = _first_existing(
    ("AppData", "Roaming", "extremerouter", "db", "data.sqlite")
)


def resolve_pool_path(pool_arg):
    if pool_arg:
        return os.path.abspath(pool_arg)
    if os.path.exists(DEFAULT_POOL):
        return DEFAULT_POOL
    raise FileNotFoundError(f"Pool file not found at {DEFAULT_POOL}; pass --pool")


def resolve_db_path(db_arg):
    if db_arg:
        return os.path.abspath(db_arg)
    if os.path.exists(DEFAULT_DB):
        return DEFAULT_DB
    raise FileNotFoundError(f"DB not found at {DEFAULT_DB}; pass --db")


def read_pool(path):
    """Read JSONL pool, return list of dicts with fixed cookie paths."""
    pool_dir = os.path.dirname(path)
    entries = []
    skipped = 0
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                # A live registrar appends to this file, so a sync can land
                # mid-write. Skip the torn trailing line instead of failing the
                # whole import — the next run picks that account up.
                skipped += 1
                continue
            if not isinstance(entry, dict) or not entry.get("email"):
                skipped += 1
                continue
            # Fix cookie path if broken (points to a pre-move directory)
            cp = entry.get("cookies_path", "")
            if cp and not os.path.exists(cp):
                alt = os.path.join(pool_dir, os.path.basename(cp))
                if os.path.exists(alt):
                    entry["cookies_path"] = alt
            entries.append(entry)
    if skipped:
        print(f"  ! skipped {skipped} unparsable/incomplete pool line(s)", file=sys.stderr)
    return entries


def extract_session_token(cookies_path):
    """Return (token_str, expires_ts) from cookie file, or (None, None)."""
    if not cookies_path or not os.path.exists(cookies_path):
        return None, None
    try:
        with open(cookies_path, encoding="utf-8") as f:
            cookies = json.load(f)
    except (json.JSONDecodeError, OSError, UnicodeDecodeError) as exc:
        # Narrow on purpose: an unreadable cookie file must not masquerade as an
        # expired token (which would silently import the row with isActive=0).
        print(f"  ! cannot read cookies {cookies_path}: {exc}", file=sys.stderr)
        return None, None
    if not isinstance(cookies, list):
        print(f"  ! unexpected cookie file shape {cookies_path}: {type(cookies).__name__}", file=sys.stderr)
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


def load_audit(path):
    """Load per-account liveness verdicts from conol_audit_live.py's report.

    Two rules, both paid for in production:

    1. `isActive` derived from a cookie file's `expires` is NOT liveness —
       save_cookies fabricates `expires = now + 7 days`, so a token that never
       authenticated still looks valid. Pass --audit to mark isActive from the oracle.
    2. Only DECISIVE verdicts may move isActive. A 429/403/5xx means conol refused to
       answer, which is the auditor's own traffic and not the account's state;
       honouring such verdicts deactivated 11 working accounts on 2026-10-03.
       Inconclusive rows are dropped here so they keep the expiry heuristic — and
       "dead" only counts when conol actually answered 200 with no user.
    """
    if not path:
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError, UnicodeDecodeError) as exc:
        print(f"  ! cannot read audit {path}: {exc}", file=sys.stderr)
        return {}
    verdicts, inconclusive = {}, 0
    for item in data.get("details", []):
        email = item.get("email")
        if not email:
            continue
        state = item.get("state")
        if state == "live":
            verdicts[email] = "live"
        elif state in ("dead", "no_token", "email_mismatch"):
            # Dead credential, no credential, or a row holding somebody else's
            # credential: never route to it.
            verdicts[email] = "dead"
        else:
            # rate_limited / network_error: conol never answered, so the verdict says
            # nothing about the account. "keep" leaves the stored isActive untouched —
            # neither parking a working account (the 2026-10-03 incident: 14 rows were
            # deactivated off HTTP 429) nor resurrecting one ER parked for cause via
            # markAccountUnavailable, which the expiry heuristic would happily do.
            verdicts[email] = "keep"
            inconclusive += 1
    decisive = sum(1 for v in verdicts.values() if v != "keep")
    print(f"  audit: {decisive} decisive + {inconclusive} inconclusive verdicts from "
          f"{os.path.basename(path)} ({data.get('audited_at', 'undated')})")
    return verdicts


def upsert_provider_connection(cursor, entry, session_token, expires, now_ts, live_override=None):
    """Upsert one conol-web connection row. Returns dict with status.

    live_override is this account's verdict from conol_audit_live.py: "live", "dead",
    "keep" (inconclusive — preserve what ER already stores) or None (no audit supplied,
    fall back to the cookie-expiry heuristic). A decisive verdict wins over the
    heuristic, which only proves a cookie file was written.
    """
    email = entry["email"]
    name = entry.get("name", email.split("@")[0])
    # is_live is decided AFTER the dedup lookup, because "keep" needs the stored value.

    # Check existing by email (dedup)
    existing = cursor.execute(
        "SELECT id, data, isActive FROM providerConnections "
        "WHERE provider='conol-web' AND email=?",
        (email,)
    ).fetchone()
    heuristic_live = bool(session_token and expires > now_ts)
    if live_override == "keep":
        is_live = bool(existing[2]) if existing else heuristic_live
    elif live_override is not None:
        is_live = live_override == "live"
    else:
        is_live = heuristic_live

    # The cookie credential is stored in `apiKey`, deliberately NOT in
    # `providerSpecificData.cookie`, because of RESOLUTION PRECEDENCE:
    # resolveConolCredentials() reads providerSpecificData.cookie BEFORE
    # credentials.apiKey, so anything written to apiKey later would be shadowed
    # by a stale value in providerSpecificData.
    #
    # Note (corrects this file's earlier rationale): open-sse/executors/conol-web.js
    # implements NO refreshedCookie / refreshCredentials, so chatCore.js's
    # auto-refresh branch never fires for this provider — ER does not renew conol
    # cookies. Tokens die 7 days after issue (Max-Age=604800); on expiry the
    # executor 401s, markAccountUnavailable parks the connection, and it stays
    # parked until an external refresh (conol_refresh.py) plus a re-run of this
    # importer. Schedule that pair at an interval safely under 7 days.
    # MERGE with the existing row instead of replacing `data` wholesale. ER keeps
    # runtime state inside that same JSON blob:
    #   - lastUsedAt / consecutiveUseCount  → sticky-LRU selection (auth.js:215-234)
    #   - lastError / errorCode / modelLockUntil → set by markAccountUnavailable
    #   - connectionProxy* / connectionProxyPoolId → per-connection proxy config
    # A wholesale write reset rotation history and, worse, un-parked accounts that
    # ER had correctly locked after rate limiting — on every single re-import.
    merged = {}
    if existing and existing[1]:
        try:
            loaded = json.loads(existing[1])
            if isinstance(loaded, dict):
                merged = loaded
        except (json.JSONDecodeError, TypeError, ValueError):
            print(f"  ! unparseable data JSON for {email}; rebuilding it", file=sys.stderr)

    # Drop every key resolveConolCredentials() ranks ABOVE apiKey, otherwise a
    # stale cookie there would shadow the token we are importing.
    merged.pop("cookie", None)
    provider_data = dict(merged.get("providerSpecificData") or {})
    for shadowing_key in ("cookie", COOKIE_NAME, "sessionToken"):
        provider_data.pop(shadowing_key, None)

    token_changed = (merged.get("apiKey") or "") != (session_token or "")
    if token_changed:
        # Credential-health state describes the DEAD token. isModelLockActive()
        # (open-sse/services/accountFallback.js:191-196) reads the flat
        # modelLock_<model> / modelLock___all keys off this same JSON, so keeping
        # them would leave a freshly refreshed account parked — which defeats the
        # refresh + re-import cadence that is the only way these tokens renew.
        # Account-level state (lastUsedAt, proxy config) is about the account, not
        # the credential, so it survives.
        for stale_key in list(merged):
            if stale_key.startswith("modelLock_"):
                merged.pop(stale_key, None)
        for stale_key in ("lastError", "lastErrorType", "errorCode", "backoffLevel",
                          "consecutiveUseCount", "status",
                          "quotaExhaustedAt", "quotaResetsAt"):
            merged.pop(stale_key, None)
    merged.update({
        "apiKey": session_token or "",
        "baseUrl": merged.get("baseUrl") or "https://conol.ai",
        # Reset the verdict only when the token actually changed: idempotent
        # re-runs must not wipe a result that providers/test-batch wrote for a
        # token that is still in place.
        "testStatus": "unknown" if token_changed else merged.get("testStatus", "unknown"),
        "providerSpecificData": provider_data,
    })
    data_json = json.dumps(merged, ensure_ascii=False)

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
    now = datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond:06d}Z"


ROTATION_PROVIDER = "conol-web"
ROTATION_STRATEGY = "round-robin"


def ensure_rotation_setting(conn):
    """Keep conol-web on round-robin, repairing it if a dashboard save dropped it.

    settings(id=1) is one JSON blob. updateSettings() merges providerStrategies only
    one level deep (NESTED_SETTING_KEYS), so saving some OTHER field of the conol-web
    entry replaces the whole entry and silently drops fallbackStrategy — the pool
    reverts to fill-first, one account burns its 100 daily credits while the rest
    idle, and nothing logs it. The importer already runs on the mandatory sub-7-day
    maintenance cadence, so this is the cheapest place to detect and repair it.
    """
    row = conn.execute("SELECT data FROM settings WHERE id = 1").fetchone()
    try:
        data = json.loads(row[0]) if row and row[0] else {}
    except (json.JSONDecodeError, TypeError):
        print("  ! settings(id=1) is not valid JSON — leaving it untouched", file=sys.stderr)
        return
    if not isinstance(data, dict):
        print("  ! settings(id=1) is not an object — leaving it untouched", file=sys.stderr)
        return

    strategies = data.get("providerStrategies")
    if not isinstance(strategies, dict):
        strategies = {}
    entry = strategies.get(ROTATION_PROVIDER)
    if not isinstance(entry, dict):
        entry = {}

    if entry.get("fallbackStrategy") == ROTATION_STRATEGY:
        print(f"  rotation: {ROTATION_PROVIDER} already {ROTATION_STRATEGY}")
        return

    print(f"  rotation: {ROTATION_PROVIDER}.fallbackStrategy was "
          f"{entry.get('fallbackStrategy')!r} — restoring {ROTATION_STRATEGY}")
    entry["fallbackStrategy"] = ROTATION_STRATEGY
    strategies[ROTATION_PROVIDER] = entry
    data["providerStrategies"] = strategies
    blob = json.dumps(data, ensure_ascii=False)
    if row:
        conn.execute("UPDATE settings SET data = ? WHERE id = 1", (blob,))
    else:
        conn.execute("INSERT INTO settings(id, data) VALUES(1, ?)", (blob,))


def import_pool(pool_path, db_path, dry_run=False, only_live=False, audit=None):
    """Main import routine. Returns report dict."""
    entries = read_pool(pool_path)
    audit = audit or {}
    report = {"total": len(entries), "created": 0, "updated": 0, "skipped": 0, "live": 0, "expired": 0, "no_token": 0, "errors": []}

    conn = None
    if not dry_run:
        conn = get_connection(db_path)
        cursor = conn.cursor()

    now_ts = time.time()

    for entry in entries:
        token, expires = extract_session_token(entry.get("cookies_path", ""))
        verdict = audit.get(entry.get("email"))
        is_live = (verdict == "live") if verdict is not None else bool(token and expires > now_ts)

        if only_live and not is_live:
            report["skipped"] += 1
            continue

        if dry_run:
            if is_live:
                report["live"] += 1
            elif token:
                report["expired"] += 1
            else:
                report["no_token"] += 1
            continue

        try:
            result = upsert_provider_connection(cursor, entry, token, expires, now_ts,
                                                live_override=verdict)
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
        # Cosmetic setting repair must never roll back the account import: a missing or
        # locked settings table would otherwise abort before conn.commit() and lose every
        # row just written. Log and move on — rotation can be re-applied on the next run.
        try:
            ensure_rotation_setting(conn)
        except sqlite3.Error as exc:
            print(f"  ! rotation setting not applied ({exc}); account rows still committed",
                  file=sys.stderr)
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
    """Runnable checks against the SHIPPED upsert path. Three checks, no more.

    Cookie normalisation is deliberately NOT tested here: `normalizeConolCookie`
    lives in open-sse/services/conolAuth.js, so a Python re-implementation of it can
    only fail on a typo in the expectation string — it passes forever regardless of
    what ER actually does, which is worse than no test because it reads as coverage.
    That behaviour is covered by scripts/check-conol-cred.mjs, which imports the
    production module and resolves a real database row through it. Two such
    tautological checks (and an earlier private `_upsert` stub) were removed here
    after being cited as "selfcheck 5/5 PASS".
    """

    # 3. Dedup + isActive, driven through the REAL upsert_provider_connection.
    #    A private re-implementation would prove nothing about the shipped code —
    #    an earlier version of this check did exactly that and kept passing after
    #    the credential placement changed underneath it.
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
    cur = conn.cursor()
    entry = {"email": "test@example.com", "name": "testacct"}

    upsert_provider_connection(cur, entry, "tok1", time.time() + 604800, time.time())
    upsert_provider_connection(cur, entry, "tok1", time.time() - 10, time.time())
    conn.commit()
    cnt = conn.execute(
        "SELECT COUNT(*) FROM providerConnections WHERE email='test@example.com'").fetchone()[0]
    assert cnt == 1, f"Dedup fail: {cnt} != 1"
    is_a = conn.execute(
        "SELECT isActive FROM providerConnections WHERE email='test@example.com'").fetchone()[0]
    assert is_a == 0, f"an expired token must set isActive=0, got {is_a}"
    print("[PASS] dedup + isActive via the real upsert_provider_connection")

    # 4. Re-import must MERGE, and must clear health state that described a dead token.
    conn.execute("DELETE FROM providerConnections")
    seed = json.dumps({
        "apiKey": "OLDTOKEN", "baseUrl": "https://conol.ai", "testStatus": "active",
        # account-level: must survive a token change
        "lastUsedAt": "2026-10-01T00:00:00.000Z",
        # credential-health: describes OLDTOKEN, must be dropped when it changes
        "consecutiveUseCount": 2, "lastError": {"status": 429}, "errorCode": 429,
        "modelLock_gpt-5.6-luna": "2026-10-09T00:00:00.000Z",
        "modelLock___all": "2026-10-09T00:00:00.000Z",
        # every key resolveConolCredentials ranks above apiKey
        "cookie": "TOP_LEVEL_SHADOW",
        "providerSpecificData": {
            "cookie": "PSD_SHADOW",
            "sessionToken": "SESSION_SHADOW",
            "connectionProxyEnabled": False,
            "connectionProxyUrl": "http://proxy.local:8080",
        },
    })
    conn.execute(
        "INSERT INTO providerConnections VALUES(?, 'conol-web', 'cookie', ?, ?, NULL, 1, ?, ?, ?)",
        ("merge-id", "mergeacct", "merge@example.com", seed, dt_now(), dt_now()),
    )
    upsert_provider_connection(conn.cursor(), {"email": "merge@example.com", "name": "mergeacct"},
                               "NEWTOKEN", time.time() + 600, time.time())
    conn.commit()
    after = json.loads(conn.execute(
        "SELECT data FROM providerConnections WHERE email='merge@example.com'").fetchone()[0])
    psd = after["providerSpecificData"]
    assert after["apiKey"] == "NEWTOKEN", f"token not imported: {after['apiKey']}"
    for shadow in ("cookie",):
        assert shadow not in after, f"top-level {shadow} would shadow apiKey"
    for shadow in ("cookie", COOKIE_NAME, "sessionToken"):
        assert shadow not in psd, f"providerSpecificData.{shadow} would shadow apiKey"
    assert psd.get("connectionProxyEnabled") is False, "proxy config lost"
    assert psd.get("connectionProxyUrl") == "http://proxy.local:8080", "proxy url lost"
    assert after["lastUsedAt"] == "2026-10-01T00:00:00.000Z", "account-level LRU history lost"
    for gone in ("consecutiveUseCount", "lastError", "errorCode",
                 "modelLock_gpt-5.6-luna", "modelLock___all"):
        assert gone not in after, f"{gone} describes the dead token and must be cleared"
    assert after["testStatus"] == "unknown", "verdict for a replaced token must reset"
    print("[PASS] token change: credential merged, shadows dropped, account config kept, "
          "dead-token health state cleared")

    # 5. Same token again → nothing about health may be touched (a legitimate
    #    rate-limit lock must not be lifted by an idempotent re-import).
    reseed = dict(after, testStatus="active", consecutiveUseCount=3,
                  modelLock___all="2026-10-09T00:00:00.000Z")
    conn.execute("UPDATE providerConnections SET data=? WHERE email='merge@example.com'",
                 (json.dumps(reseed),))
    upsert_provider_connection(conn.cursor(), {"email": "merge@example.com", "name": "mergeacct"},
                               "NEWTOKEN", time.time() + 600, time.time())
    conn.commit()
    kept = json.loads(conn.execute(
        "SELECT data FROM providerConnections WHERE email='merge@example.com'").fetchone()[0])
    assert kept["testStatus"] == "active", "idempotent re-run must not wipe a live verdict"
    assert kept["consecutiveUseCount"] == 3, "idempotent re-run must not reset sticky state"
    assert kept["modelLock___all"] == "2026-10-09T00:00:00.000Z", \
        "idempotent re-run must not lift a legitimate lock"
    print("[PASS] unchanged token: verdict, sticky counter and locks preserved")

    conn.close()
    _os.remove(tmp)
    print("[PASS] 3/3 self-checks: dedup+isActive, merge with health-state clearing, "
          "unchanged-token preservation")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Import conol.ai accounts into ExtremeRouter")
    parser.add_argument("--dry-run", action="store_true", help="Preview only, no DB writes")
    parser.add_argument("--db", help="Path to data.sqlite (default: ER user data DB)")
    parser.add_argument("--pool", help="Path to conol_accounts_pool.jsonl (default: canonical)")
    parser.add_argument("--only-live", action="store_true", help="Only import accounts with valid session tokens")
    parser.add_argument("--audit", help="conol_audit_live.json — mark isActive from real get-session verdicts instead of cookie expiry")
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

    report = import_pool(pool_path, db_path, dry_run=args.dry_run, only_live=args.only_live,
                         audit=load_audit(args.audit))
    print()
    print_report(report)