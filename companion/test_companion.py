import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor

SCRIPT = Path(__file__).with_name("lazysh_agent.py")


class CompanionTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.env = {**os.environ, "LAZYSH_STATE_DIR": self.tmp.name, "TMUX_PANE": "%7"}

    def tearDown(self):
        self.tmp.cleanup()

    def run_cli(self, *args, payload=None):
        return subprocess.run([sys.executable, str(SCRIPT), *args],
                              input=json.dumps(payload) if payload is not None else "",
                              text=True, capture_output=True, env=self.env)

    def event(self, session, state):
        return {"schemaVersion": 1, "sessionId": session, "agent": "Test Agent",
                "project": "/work/app", "state": state, "summary": "A turn", "paneId": "%1"}

    def test_distinct_sessions_and_latest_state(self):
        for session, state in [("a", "working"), ("b", "done"), ("a", "needs_attention")]:
            self.assertEqual(self.run_cli("ingest", "--agent", "generic", payload=self.event(session, state)).returncode, 0)
        result = self.run_cli("snapshot", "--limit", "10")
        self.assertEqual(result.returncode, 0)
        sessions = {e["sessionId"]: e for e in json.loads(result.stdout)["sessions"]}
        self.assertEqual(len(sessions), 2)
        self.assertEqual(sessions["a"]["state"], "needs_attention")
        self.assertEqual(sessions["a"]["eventCount"], 2)
        self.assertEqual(sessions["b"]["state"], "done")

    def test_claude_never_stores_prompt_or_tool_arguments(self):
        result = self.run_cli("ingest", "--agent", "claude", payload={
            "hook_event_name": "PreToolUse", "session_id": "s1", "cwd": "/work",
            "tool_name": "Bash", "tool_input": {"command": "SECRET-TOKEN"}, "prompt": "PRIVATE",
        })
        self.assertEqual(result.returncode, 0)
        snapshot = self.run_cli("snapshot").stdout
        self.assertNotIn("SECRET-TOKEN", snapshot)
        self.assertNotIn("PRIVATE", snapshot)
        self.assertEqual(json.loads(snapshot)["sessions"][0]["paneId"], "%7")

    def test_invalid_events_fail_without_side_effects_or_secret_echo(self):
        for payload in [[], {"password": "SECRET"}, self.event("a", "approved"), self.event("a\ncmd", "done")]:
            result = self.run_cli("ingest", "--agent", "generic", payload=payload)
            self.assertEqual(result.returncode, 1)
            self.assertNotIn("SECRET", result.stderr)
            self.assertEqual(list(Path(self.tmp.name).iterdir()), [])

    def test_informational_notification_does_not_create_approval(self):
        result = self.run_cli("ingest", "--agent", "claude", payload={
            "hook_event_name": "Notification", "notification_type": "auth_success",
            "session_id": "a", "cwd": "/work",
        })
        self.assertEqual(result.returncode, 0)
        self.assertEqual(list(Path(self.tmp.name).iterdir()), [])

    def test_bounded_snapshot_and_restrictive_permissions(self):
        from lazysh_agent import database, ingest, snapshot
        old = os.environ.get("LAZYSH_STATE_DIR")
        os.environ["LAZYSH_STATE_DIR"] = self.tmp.name
        try:
            with database() as conn:
                for i in range(120):
                    ingest(conn, self.event(str(i), "done"))
                self.assertEqual(len(snapshot(conn, 100)["sessions"]), 100)
                self.assertEqual(len(snapshot(conn, 2)["sessions"]), 2)
            if os.name != "nt":
                self.assertEqual((Path(self.tmp.name) / "events.sqlite3").stat().st_mode & 0o777, 0o600)
        finally:
            if old is None:
                os.environ.pop("LAZYSH_STATE_DIR")
            else:
                os.environ["LAZYSH_STATE_DIR"] = old

    def test_config_is_print_only(self):
        result = self.run_cli("claude-config")
        config = json.loads(result.stdout)
        self.assertEqual(config["hooks"]["Stop"][0]["hooks"][0]["type"], "command")
        self.assertEqual(list(Path(self.tmp.name).iterdir()), [])

    def test_concurrent_hooks_preserve_each_event(self):
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: self.run_cli("ingest", "--agent", "generic", payload=self.event("same", "working")), range(16)))
        self.assertTrue(all(result.returncode == 0 for result in results))
        sessions = json.loads(self.run_cli("snapshot").stdout)["sessions"]
        self.assertEqual(len(sessions), 1)
        self.assertEqual(sessions[0]["eventCount"], 16)

    def test_oversized_events_fail_before_creating_state(self):
        result = self.run_cli("ingest", "--agent", "generic", payload={**self.event("a", "working"), "unused": "x" * (256 * 1024)})
        self.assertEqual(result.returncode, 1)
        self.assertEqual(list(Path(self.tmp.name).iterdir()), [])


if __name__ == "__main__":
    unittest.main()
