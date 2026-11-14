#!/usr/bin/env python3
"""Drive an official Kimi Code release against a synthetic OpenAI-compatible endpoint.

Runs INSIDE the network-less sandbox that qualify.sh builds: the mock endpoint, a private tmux
server and the CLI share one network namespace, nothing real is read and nothing leaves it.
Hooks are plain `cat` recorders, so the receipts are the payloads the CLI actually delivered.
Stdlib only. Exit code 1 means a documented claim no longer holds for this release.
"""
import json, os, shutil, subprocess, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 18080
EVENTS = ("SessionStart UserPromptSubmit TurnStarted PreToolUse PostToolUse PostToolUseFailure "
          "PermissionRequest PermissionResult Stop StopFailure Interrupt SubagentStart SubagentStop SessionEnd").split()
# Structural fields kept in the retained summary; ids, paths and prompt text are dropped.
KEEP = ("agent_id", "turn_id", "origin_kind", "origin_name", "decision", "reason", "source", "error_type",
        "stop_hook_active", "is_steer", "agent_name", "client_type", "profile")
IDENTITYLESS = ("TurnStarted", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "StopFailure", "Interrupt")
T = ["tmux", "-S", "/tmp/qualify.sock"]


def hook(name, event, extra="timeout = 10\n"):
    return f'\n[[hooks]]\nevent = "{event}"\ncommand = "cat > /tmp/h-{name}/rcpt/$(date +%s%N)-$$.{event}.json"\n{extra}'

# ---------------------------------------------------------------- mock endpoint
REQS = []


def text_of(m):
    c = m.get("content")
    return c if isinstance(c, str) else " ".join(p.get("text", "") for p in c or [] if isinstance(p, dict))


def plan(body):
    msgs, tools = body.get("messages", []), [t["function"]["name"] for t in body.get("tools", [])]
    said = " ".join(text_of(m) for m in msgs if m.get("role") == "user")
    answered = any(m.get("role") == "tool" for m in msgs)
    if msgs and msgs[-1].get("role") == "tool":
        return "text", "tool finished", ""
    if "CHILD-TASK" in said:
        return ("tool", "Bash", '{"command": "echo child-probe"}') if not answered else ("text", "child finished", "")
    if "RUN-AGENT" in said and not answered:
        return "tool", "Agent", json.dumps({"description": "probe child", "prompt": "CHILD-TASK say hi",
                                            "subagent_type": "coder", "run_in_background": "RUN-AGENT-BG" in said})
    if "RUN-TOOL" in said and not answered:
        return "tool", "Bash", '{"command": "echo lazysh-probe"}'
    if "RUN-FAIL" in said:
        return "fail", "", ""
    return ("slow" if "RUN-SLOW" in said else "text"), "mock answer", ""


class Mock(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    log_message = lambda *a: None  # noqa: E731

    def reply(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", "0"))))
        kind, a, b = plan(body)
        REQS.append({"path": self.path, "stream": body.get("stream"), "plan": kind if kind != "tool" else "tool:" + a})
        if kind == "fail":  # 400 is not retried, 5xx is retried for minutes
            return self.reply(400, {"error": {"message": "synthetic upstream failure", "type": "invalid_request_error"}})
        if kind == "slow":
            time.sleep(25)
        if a == "Bash" and "CHILD-TASK" in " ".join(text_of(m) for m in body["messages"] if m.get("role") == "user"):
            time.sleep(2)  # keep the child running after the root's own turn is over
        delta = ({"role": "assistant", "content": a} if kind in ("text", "slow") else
                 {"role": "assistant", "tool_calls": [{"index": 0, "id": "call_" + a.lower(), "type": "function",
                                                       "function": {"name": a, "arguments": b}}]})
        fin = "stop" if kind in ("text", "slow") else "tool_calls"
        base = {"id": "mock", "created": int(time.time()), "model": "mock-model"}
        usage = {"prompt_tokens": 10, "completion_tokens": 3, "total_tokens": 13}
        if not body.get("stream"):
            return self.reply(200, {**base, "object": "chat.completion", "usage": usage,
                                    "choices": [{"index": 0, "message": delta, "finish_reason": fin}]})
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("transfer-encoding", "chunked")
        self.end_headers()
        for ch in ({**base, "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": delta, "finish_reason": None}]},
                   {**base, "object": "chat.completion.chunk", "usage": usage, "choices": [{"index": 0, "delta": {}, "finish_reason": fin}]},
                   "[DONE]"):
            d = ("data: " + (ch if isinstance(ch, str) else json.dumps(ch)) + "\n\n").encode()
            self.wfile.write(f"{len(d):x}\r\n".encode() + d + b"\r\n")
        self.wfile.write(b"0\r\n\r\n")


# ---------------------------------------------------------------- harness
def sh(*cmd, env=None, timeout=60):
    return subprocess.run(cmd, capture_output=True, text=True, env=env, timeout=timeout, cwd="/tmp/proj")


class Profile:
    """A disposable KIMI_CODE_HOME with a strict synthetic config and recording hooks."""

    def __init__(self, name, mode="manual", hooks=None, extra="", foreign=""):
        self.home = f"/tmp/h-{name}"
        shutil.rmtree(self.home, ignore_errors=True)
        os.makedirs(f"{self.home}/rcpt")
        self.env = {"HOME": self.home, "KIMI_CODE_HOME": f"{self.home}/.kimi-code", "PATH": os.environ["PATH"], "TERM": "xterm-256color"}
        hooks = (hooks if hooks is not None else "".join(hook(name, e) for e in EVENTS)) + foreign
        os.makedirs(self.env["KIMI_CODE_HOME"])
        open(f"{self.env['KIMI_CODE_HOME']}/config.toml", "w").write(
            f'default_model = "mock"\ndefault_permission_mode = "{mode}"\ntelemetry = false\n\n'
            f'[providers.mock]\ntype = "openai"\nbase_url = "http://127.0.0.1:{PORT}/v1"\napi_key = "sk-synthetic"\n\n'
            f'[models.mock]\nprovider = "mock"\nmodel = "mock-model"\nmax_context_size = 128000\n{extra}{hooks}')
        REQS.clear()

    def receipts(self):
        out = []
        for f in sorted(os.listdir(f"{self.home}/rcpt")):
            d = json.load(open(f"{self.home}/rcpt/{f}"))
            out.append({"event": d["hook_event_name"], "keys": sorted(d), **{k: d[k] for k in KEEP if k in d}, "_full": d})
        return out

    def wait(self, event, n=1, secs=40):
        end = time.time() + secs
        while time.time() < end:
            if sum(r["event"] == event for r in self.receipts()) >= n:
                return True
            time.sleep(0.25)
        raise SystemExit(f"timeout: {n} x {event} receipts, saw {[r['event'] for r in self.receipts()]}\n{self.pane()}")

    # interactive terminal UI under a private tmux server
    def tui(self):
        sh(*T, "-f", "/dev/null", "new-session", "-d", "-x", "120", "-y", "40", "-s", "p", "kimi", env=self.env)
        self.until("Trust and continue|Welcome to Kimi Code")
        if "Trust and continue" in self.pane():
            self.keys("Enter")
        self.until("Welcome to Kimi Code")
        time.sleep(1.5)

    def pane(self):
        return sh(*T, "capture-pane", "-p", "-t", "p").stdout

    def until(self, pattern, secs=30):
        import re
        end = time.time() + secs
        while time.time() < end:
            if re.search(pattern, self.pane()):
                return
            time.sleep(0.25)
        raise SystemExit(f"timeout waiting for pane: {pattern}\n{self.pane()}")

    def keys(self, *k):
        sh(*T, "send-keys", "-t", "p", *k)
        time.sleep(0.4)

    def say(self, text):
        self.keys(text)
        self.keys("Enter")

    def approve(self, key):
        self.until("Approve once")
        time.sleep(0.8)
        self.keys(key)
        time.sleep(1.5)

    def quit(self):
        self.say("/exit")
        self.wait("SessionEnd", secs=15)
        sh(*T, "kill-server")


STOP_ONCE = ('\n[[hooks]]\nevent = "Stop"\ncommand = "[ -e /tmp/h-stop_blocked_once/once ] || { touch /tmp/h-stop_blocked_once/once; '
             'echo keep going >&2; exit 2; }"\n')


def run(name, drive, **kw):
    p = Profile(name, **kw)
    drive(p)
    return p.receipts(), [r["plan"] for r in REQS]


def drive_prompt(p):  # non-interactive: prompt mode runs in Auto permission mode, so no approval events
    r = sh("kimi", "-p", "RUN-TOOL go", env=p.env, timeout=90)
    p.out = r.stdout


def drive_approve(p, key="1", prompt="RUN-TOOL go"):
    p.tui()
    p.say(prompt)
    p.wait("PermissionRequest")
    p.approve(key)
    p.wait("Stop")
    p.quit()


def drive_interrupt(p):
    p.tui()
    p.say("RUN-SLOW go")
    p.wait("TurnStarted")
    time.sleep(1.5)
    p.keys("Escape")
    p.wait("Interrupt")
    p.quit()


def drive_stop_block(p):  # a foreign Stop hook blocks once, the way a user's own hook may
    p.tui()
    p.say("say hello")
    p.wait("Stop")
    for _ in range(80):  # the continuation is a second model call inside the same turn
        if len(REQS) >= 2:
            break
        time.sleep(0.25)
    time.sleep(3)
    p.quit()


def drive_fail(p):
    p.tui()
    p.say("RUN-FAIL go")
    p.wait("StopFailure")
    p.quit()


def drive_agent(p, prompt="RUN-AGENT go", stops=2):
    p.tui()
    p.say(prompt)
    p.wait("PermissionRequest")
    p.approve("1")
    p.wait("Stop", stops)
    time.sleep(1)
    p.quit()


def strict(name, hooks):
    p = Profile(name, hooks=hooks)  # hooks text names /tmp/h-<name>/rcpt, which Profile has just created
    doctor = sh("kimi", "doctor", env=p.env)
    run_ = sh("kimi", "-p", "say hi", env=p.env, timeout=90)
    return {"doctor_error": "ERROR" in doctor.stdout + doctor.stderr, "prompt_exit": run_.returncode,
            "hooks_ignored": "Ignored invalid config section 'hooks'" in run_.stderr + run_.stdout,
            "receipts": [r["event"] for r in p.receipts()]}


def by(rs, ev):
    return [r["_full"] for r in rs if r["event"] == ev]


def main(out):
    os.makedirs("/tmp/proj", exist_ok=True)
    ThreadingHTTPServer.daemon_threads = True
    ThreadingHTTPServer.handle_error = lambda *a: None  # the CLI drops the socket on interrupt
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Mock)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    version = sh("kimi", "--version").stdout.strip()
    S = {n: strict("strict", h) for n, h in (
        ("valid", hook("strict", "SessionStart")), ("unknown_field", hook("strict", "SessionStart", 'owner = "lazysh"\n')),
        ("unknown_event", hook("strict", "NotAnEvent")), ("timeout_601", hook("strict", "SessionStart", "timeout = 601\n")))}
    scen = {"prompt_auto": drive_prompt, "approve": drive_approve, "reject": lambda p: drive_approve(p, "3"),
            "interrupt": drive_interrupt, "upstream_failure": drive_fail, "stop_blocked_once": drive_stop_block,
            "subagent_foreground": drive_agent, "subagent_background": lambda p: drive_agent(p, "RUN-AGENT-BG go", 3)}
    R = {}
    for n, d in scen.items():
        R[n] = run(n, d, mode="manual", foreign=STOP_ONCE if n == "stop_blocked_once" else "")
        print(f"ran {n}: {[r['event'] for r in R[n][0]]}", flush=True)
    ev = lambda n: [r["event"] for r in R[n][0]]  # noqa: E731
    fg, bg = R["subagent_foreground"][0], R["subagent_background"][0]
    allrs = [r for rs, _ in R.values() for r in rs]
    pr = by(R["approve"][0], "PermissionRequest")[0]
    res = by(R["approve"][0], "PermissionResult")[0]
    child = [d for d in by(fg, "PermissionRequest")]
    names = [r["event"] for r in bg]
    checks = {
        "valid hooks load and record SessionStart": S["valid"]["receipts"] == ["SessionStart"],
        "unknown field, unknown event and timeout above 600 each drop the whole hooks section while the CLI still runs":
            all(S[n]["doctor_error"] and S[n]["hooks_ignored"] and not S[n]["receipts"] and S[n]["prompt_exit"] == 0 for n in ("unknown_field", "unknown_event", "timeout_601")),
        "prompt mode completes a tool turn but emits no approval events (Auto permission mode)":
            ev("prompt_auto")[:3] == ["SessionStart", "UserPromptSubmit", "TurnStarted"] and "PermissionRequest" not in ev("prompt_auto") and "Stop" in ev("prompt_auto"),
        "approved turn: PermissionRequest and PermissionResult share id, turn_id and tool_call_id and name root as main":
            pr["agent_id"] == res["agent_id"] == "main" and pr["id"] == res["id"] and pr["turn_id"] == res["turn_id"] and pr["tool_call_id"] == res["tool_call_id"] and res["decision"] == "approved",
        "rejected turn: result is not approved, the tool fails and the turn still ends with Stop":
            by(R["reject"][0], "PermissionResult")[0]["decision"] != "approved" and "PostToolUseFailure" in ev("reject") and ev("reject").count("Stop") == 1,
        "a blocked Stop continues the turn with a second model call and emits no later Stop":
            ev("stop_blocked_once").count("Stop") == 1 and R["stop_blocked_once"][1] == ["text", "text"],
        "interrupt fires Interrupt in place of Stop": "Interrupt" in ev("interrupt") and "Stop" not in ev("interrupt"),
        "upstream failure fires StopFailure in place of Stop": "StopFailure" in ev("upstream_failure") and "Stop" not in ev("upstream_failure"),
        "SessionEnd reports reason exit in every interactive scenario": all(by(R[n][0], "SessionEnd")[0]["reason"] == "exit" for n in R if n != "prompt_auto"),
        "no identity-less event carries agent_id": not any("agent_id" in r["keys"] for r in allrs if r["event"] in IDENTITYLESS),
        "a sub-agent approval names the child, not main": len(child) == 1 and child[0]["agent_id"] not in (None, "main"),
        "a child turn start is marked origin_kind system_trigger and carries no agent_id":
            [r["origin_kind"] for r in fg if r["event"] == "TurnStarted"] == ["user", "system_trigger"],
        "root and child Stop payloads are identical": len(by(fg, "Stop")) == 2 and by(fg, "Stop")[0] == by(fg, "Stop")[1],
        "background child still runs after the root Stop and asks for approval later":
            names.index("Stop") < names.index("PermissionRequest") and names.count("Stop") == 3,
    }
    line = lambda r: " ".join([r["event"]] + [f"{k}={r[k]}" for k in KEEP if k in r and k != "client_type"])  # noqa: E731
    summary = {"kimi_version": version, "checks": checks,
               "strict_config": {n: " ".join(f"{k}={v}" for k, v in d.items()) for n, d in S.items()},
               "payload_keys": {e: " | ".join(sorted({" ".join(r["keys"]) for r in allrs if r["event"] == e})) for e in EVENTS},
               "scenarios": {n: " > ".join(map(line, rs)) + "  [provider: " + " ".join(plans) + "]" for n, (rs, plans) in R.items()}}
    json.dump(summary, open(out, "w"), indent=1)
    for c, ok in checks.items():
        print(("PASS " if ok else "FAIL ") + c)
    sys.exit(0 if all(checks.values()) else 1)


if __name__ == "__main__":
    main(sys.argv[1])
