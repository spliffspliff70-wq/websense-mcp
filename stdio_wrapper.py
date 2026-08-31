"""Stdio wrapper for WebSense MCP server — enforces a single Chrome hub instance on port 38401.

FIXED 2026-08-09: the old forward() read ONE BYTE at a time and logged EVERY line
to disk (32MB+ log, ~ms per byte on large payloads). Now: chunked reads (64KB),
no payload logging, only lifecycle + error events, and a hard 5MB log cap.
"""
import os
import sys
import subprocess
import threading
import datetime
import time
import socket

LOG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "stdio_wrapper.log")
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PORT = 38401
MAX_LOG_BYTES = 5 * 1024 * 1024  # 5MB cap, rotated by truncation
CHUNK = 65536


def log(msg):
    try:
        if os.path.exists(LOG_PATH) and os.path.getsize(LOG_PATH) > MAX_LOG_BYTES:
            # Truncate to the last 512KB to keep the log bounded.
            with open(LOG_PATH, "rb") as f:
                f.seek(-512 * 1024, 2)
                tail = f.read()
            with open(LOG_PATH, "wb") as f:
                f.write(tail)
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(f"{datetime.datetime.now().isoformat()} {msg}\n")
            f.flush()
    except Exception:
        pass


def pids_holding_port(port):
    """Return list of PIDs with a listen socket on the given port."""
    pids = set()
    try:
        out = subprocess.check_output(["netstat", "-ano"], text=True, errors="replace")
        for line in out.splitlines():
            if (f"0.0.0.0:{port}" in line or f"127.0.0.1:{port}" in line) and "LISTENING" in line:
                parts = line.strip().split()
                if parts:
                    pids.add(parts[-1])
    except Exception as e:
        log(f"[wrapper] netstat error: {e}")
    return list(pids)


def kill_pids(pids):
    for pid in pids:
        log(f"[wrapper] killing PID {pid}")
        try:
            result = subprocess.run(["taskkill", "/F", "/PID", pid], check=False, capture_output=True, text=True, errors="replace")
            log(f"[wrapper] taskkill PID {pid} rc={result.returncode}")
        except Exception as e:
            log(f"[wrapper] taskkill error for PID {pid}: {e}")


def ensure_port_free(port, max_wait=5):
    pids = pids_holding_port(port)
    if pids:
        log(f"[wrapper] port {port} held by PIDs {pids}; killing")
        kill_pids(pids)
    for i in range(max_wait * 10):
        if not pids_holding_port(port):
            log(f"[wrapper] port {port} is free")
            return True
        time.sleep(0.1)
    log(f"[wrapper] WARNING: port {port} still in use after waiting {max_wait}s")
    kill_pids(pids_holding_port(port))
    return False


def forward(src, dst, label):
    """Forward bytes from src to dst using raw os.read() — returns whatever is
    available, NOT blocking for a full chunk (BufferedReader.read(n) on a pipe
    blocks until n bytes or EOF, which deadlocks small MCP messages).

    PIPE-BREAK RESILIENCE (2026-08-12): [Errno 22]/[Errno 9] on write means
    the peer end of the pipe closed (gateway MCP client reconnecting). The old
    code exited the wrapper on this, which the gateway read as a crash and
    triggered a reconnect loop (491 restarts in mcp-stderr.log). Now we treat
    a transient pipe error as a RETRYABLE condition: brief backoff, keep the
    node alive (it is NOT the broken thing — the hub stays bound to 38401),
    and keep trying. Only give up after a sustained failure window.
    """
    import time as _t
    _fail_since = None
    while True:
        try:
            chunk = os.read(src.fileno(), CHUNK)
            if not chunk:
                log(f"[{label}] EOF")
                break
            dst.write(chunk)
            dst.flush()
            _fail_since = None
        except (OSError, ValueError) as e:
            now = _t.time()
            if _fail_since is None:
                _fail_since = now
                log(f"[{label}] pipe error {e} — retrying (node stays alive)")
            elif now - _fail_since > 20:
                log(f"[{label}] pipe error persistent ({now-_fail_since:.0f}s) — giving up: {e}")
                break
            _t.sleep(0.5)


def start_server():
    """Start the WebSense node server. Returns Popen object."""
    env = os.environ.copy()
    env["PORT"] = str(PORT)
    return subprocess.Popen(
        ["node", os.path.join(SCRIPT_DIR, "src", "server.js")],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
        bufsize=0,
    )


if __name__ == "__main__":
    log("=== wrapper started ===")

    # ── SHARED-SERVER GUARD (project directive 2026-08-12) ──
    # If the shared HTTP server (node src/server.js --http --http-port 9222)
    # is already serving, this wrapper must NOT spawn a competing node on
    # 38401 — the two fight for the hub port (EADDRINUSE crash loop, the
    # root cause of all multi-model WebSense instability). The gateway may
    # still spawn this wrapper for old-config sessions; the correct action
    # is to exit quietly and let the URL-mode client reach the shared
    # server. If no shared server is up, the wrapper spawns as before.
    import socket as _socket
    _shared_up = False
    try:
        _s = _socket.create_connection(("127.0.0.1", 9222), timeout=1.0)
        _s.close()
        _shared_up = True
    except OSError:
        _shared_up = False
    if _shared_up:
        log("[wrapper] shared HTTP server already on :9222 — refusing to spawn competing node (exit 0)")
        sys.exit(0)

    # Ensure a clean port before starting (kill orphans first — PITFALL 3).
    ensure_port_free(PORT, max_wait=5)

    proc = start_server()
    log(f"[wrapper] started websense PID {proc.pid}")

    t1 = threading.Thread(target=forward, args=(sys.stdin.buffer, proc.stdin, "KIMI->SERVER"), daemon=True)
    t2 = threading.Thread(target=forward, args=(proc.stdout, sys.stdout.buffer, "SERVER->KIMI"), daemon=True)
    t1.start()
    t2.start()

    def log_stderr():
        eaddr_seen = False
        while True:
            line = proc.stderr.readline()
            if not line:
                break
            text = line.decode("utf-8", errors="replace").rstrip()
            # Only log meaningful events — hub client/ready/disconnect/zombie
            # lines and errors. Skip nothing else: server stderr is the ONLY
            # place hub lifecycle shows, and it's low-volume (no payloads).
            if text and not text.startswith(("ping", "pong")):
                log(f"[SERVER-ERR] {text}")
            if "EADDRINUSE" in text:
                eaddr_seen = True
        if eaddr_seen:
            log("[wrapper] server reported EADDRINUSE; will not retry from this wrapper instance")

    t3 = threading.Thread(target=log_stderr, daemon=True)
    t3.start()

    # ── EADDRINUSE self-heal (project directive 2026-08-12) ──
    # Root cause of the recurring WebSense drop: TWO wrappers racing to bind
    # 38401 (gateway spawns a fresh wrapper while an old node still holds the
    # port, or two wrappers start in the same tick). ensure_port_free ran
    # before BOTH of them, so each saw the port free, then one node crashed
    # with EADDRINUSE → gateway counted a failed reconnect → parked the MCP
    # for 300s → ALL sessions lost WebSense tools (PITFALL 22 storm).
    # Fix: if the child dies within 10s with EADDRINUSE, kill whoever holds
    # the port NOW and respawn ONCE. This closes the race inside the wrapper
    # instead of relying on the gateway's slow park/revive cycle.
    import time as _t
    _deadline = _t.time() + 10
    _healed = False
    while _t.time() < _deadline and proc.poll() is None:
        _t.sleep(0.25)
    if proc.poll() is not None:
        _rc = proc.returncode
        _port_pids = pids_holding_port(PORT)
        if _port_pids:
            log(f"[wrapper] child died rc={_rc} but port {PORT} held by {_port_pids} — EADDRINUSE race, killing holder + respawning once")
            kill_pids(_port_pids)
            _t.sleep(0.5)
            ensure_port_free(PORT, max_wait=3)
            proc = start_server()
            log(f"[wrapper] respawned websense PID {proc.pid} (EADDRINUSE self-heal)")
            _healed = True
    if _healed:
        # re-route stdout/stderr of the respawned child
        t2 = threading.Thread(target=forward, args=(proc.stdout, sys.stdout.buffer, "SERVER->KIMI"), daemon=True)
        t2.start()
        t3 = threading.Thread(target=log_stderr, daemon=True)
        t3.start()

    t1.join()
    t2.join()
    t3.join()
    proc.wait()
    log(f"=== wrapper exited, code={proc.returncode} ===")
