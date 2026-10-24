"""Bounded local event snapshots. No server, transcript scraping, or approval injection."""

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sqlite3
import sys
import time

MAX_INPUT = 256 * 1024
STATES = {"working", "needs_attention", "done"}
CLAUDE_STATES = {
    "UserPromptSubmit": "working",
    "PreToolUse": "working",
    "PostToolUse": "working",
    "PostToolUseFailure": "working",
    "PermissionRequest": "needs_attention",
    "Stop": "done",
    "SessionEnd": "done",
}


def text(value, name, maximum=512, optional=False):
    if value is None and optional:
        return None
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ValueError(f"{name} must be nonempty text of at most {maximum} characters")
    if any(ord(c) < 32 for c in value):
        raise ValueError(f"{name} contains control characters")
    return value


def normalize(payload, agent):
    if not isinstance(payload, dict):
        raise ValueError("event must be a JSON object")
    if agent == "claude":
        kind = payload.get("hook_event_name")
        if kind == "Notification":
            # Informational notifications must not masquerade as pending approvals.
            state = "needs_attention" if payload.get("notification_type") in {
                "permission_prompt", "idle_prompt", "elicitation_dialog"
            } else None
        else:
            state = CLAUDE_STATES.get(kind)
        if state is None:
            return None
        summary = payload.get("tool_name") or {
            "Stop": "Turn finished", "SessionEnd": "Session ended",
            "PermissionRequest": "Permission requested",
            "Notification": "Agent needs attention",
            "UserPromptSubmit": "Working on your prompt",
        }.get(kind, str(kind))
        return {
            "sessionId": text(payload.get("session_id"), "session_id", 256),
            "agent": "Claude Code",
            "project": text(payload.get("cwd"), "cwd", 4096),
            "state": state,
            "summary": text(summary, "summary"),
            "paneId": text(os.environ.get("TMUX_PANE"), "TMUX_PANE", 256, True),
        }
    if type(payload.get("schemaVersion")) is not int or payload["schemaVersion"] != 1:
        raise ValueError("generic events require schemaVersion: 1")
    state = payload.get("state")
    if state not in STATES:
        raise ValueError("state must be working, needs_attention, or done")
    return {
        "sessionId": text(payload.get("sessionId"), "sessionId", 256),
        "agent": text(payload.get("agent"), "agent", 80),
        "project": text(payload.get("project"), "project", 4096),
        "state": state,
        "summary": text(payload.get("summary"), "summary"),
        "paneId": text(payload.get("paneId"), "paneId", 256, True),
    }


def database():
    base = Path(os.environ.get("LAZYSH_STATE_DIR", str(Path.home() / ".local/state/lazysh")))
    if base.is_symlink():
        raise ValueError("state directory must not be a symlink")
    base.mkdir(parents=True, exist_ok=True, mode=0o700)
    if os.name != "nt":
        base.chmod(0o700)
    path = base / "events.sqlite3"
    # Create with restrictive permissions before SQLite opens the file.
    descriptor = os.open(path, os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
    os.close(descriptor)
    if os.name != "nt":
        path.chmod(0o600)
    conn = sqlite3.connect(path, timeout=3)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA journal_size_limit=1048576")
    conn.execute("""CREATE TABLE IF NOT EXISTS sessions (
        agent TEXT NOT NULL, session_id TEXT NOT NULL, project TEXT NOT NULL,
        state TEXT NOT NULL, summary TEXT NOT NULL, pane_id TEXT,
        updated_at REAL NOT NULL, event_count INTEGER NOT NULL,
        PRIMARY KEY (agent, session_id))""")
    return conn


def ingest(conn, event, now=None):
    now = time.time() if now is None else now
    with conn:
        conn.execute("""INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, 1)
            ON CONFLICT(agent, session_id) DO UPDATE SET
            project=excluded.project, state=excluded.state, summary=excluded.summary,
            pane_id=excluded.pane_id, updated_at=excluded.updated_at,
            event_count=sessions.event_count+1""", (
            event["agent"], event["sessionId"], event["project"], event["state"],
            event["summary"], event["paneId"], now,
        ))
        conn.execute("DELETE FROM sessions WHERE updated_at < ?", (now - 86400 * 7,))
        conn.execute("""DELETE FROM sessions WHERE rowid NOT IN
            (SELECT rowid FROM sessions ORDER BY updated_at DESC, rowid DESC LIMIT 100)""")


def snapshot(conn, limit):
    # Retention also applies when no new events arrive.
    with conn:
        conn.execute("DELETE FROM sessions WHERE updated_at < ?", (time.time() - 86400 * 7,))
    rows = conn.execute("""SELECT session_id, agent, project, state, updated_at,
        summary, pane_id, event_count FROM sessions ORDER BY updated_at DESC LIMIT ?""", (limit,))
    return {"schemaVersion": 1, "sessions": [dict(zip(
        ("sessionId", "agent", "project", "state", "updatedAt", "summary", "paneId", "eventCount"),
        (row[0], row[1], row[2], row[3],
         datetime.fromtimestamp(row[4], timezone.utc).isoformat(), *row[5:]),
    )) for row in rows]}


def claude_config():
    # Only print a fragment. Never change another agent's settings implicitly.
    return {"hooks": {kind: [{"hooks": [{
        "type": "command", "command": "lazysh-agent ingest --agent claude", "timeout": 5,
    }]}] for kind in [*CLAUDE_STATES, "Notification"]}}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    reader = sub.add_parser("ingest", help="read one lifecycle event from stdin")
    reader.add_argument("--agent", choices=["claude", "generic"], required=True)
    view = sub.add_parser("snapshot", help="print a bounded JSON status snapshot")
    view.add_argument("--limit", type=int, default=50, choices=range(1, 101), metavar="1..100")
    sub.add_parser("claude-config", help="print hook configuration to merge into your settings")
    args = parser.parse_args(argv)
    try:
        if args.command == "claude-config":
            print(json.dumps(claude_config(), indent=2))
            return 0
        if args.command == "ingest":
            data = sys.stdin.buffer.read(MAX_INPUT + 1)
            if len(data) > MAX_INPUT:
                raise ValueError("event exceeds 256 KiB")
            event = normalize(json.loads(data), args.agent)
            if event is None:
                return 0
            with database() as conn:
                ingest(conn, event)
            return 0
        with database() as conn:
            print(json.dumps(snapshot(conn, args.limit), separators=(",", ":")))
        return 0
    except (ValueError, OSError, sqlite3.Error) as exc:
        # Report a class, never echo a payload containing prompts or secrets.
        print(f"lazysh-agent: {type(exc).__name__}: invalid event or unavailable local state", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
