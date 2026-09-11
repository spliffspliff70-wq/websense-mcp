"""WebSense live benchmark harness.

Measures the MCP server directly over its HTTP transport (:9222/mcp) so the
numbers are pure tool latency — no LLM turn overhead in the measurement.

Usage:
    python ws_bench.py --schemas          dump the schemas of the ops we bench
    python ws_bench.py --battery          run the full light/heavy battery
    python ws_bench.py --battery --reps 5
"""
import argparse
import json
import statistics
import sys
import time
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:9222/mcp"
HDRS = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
}


class Mcp:
    """Minimal streamable-HTTP MCP client."""

    def __init__(self):
        self.sid = None
        self._id = 0

    def _post(self, payload, timeout=120):
        h = dict(HDRS)
        if self.sid:
            h["mcp-session-id"] = self.sid
        req = urllib.request.Request(BASE, json.dumps(payload).encode(), h)
        t0 = time.perf_counter()
        with urllib.request.urlopen(req, timeout=timeout) as r:
            sid = r.headers.get("mcp-session-id")
            raw = r.read().decode("utf-8", "replace")
        return (time.perf_counter() - t0), sid, raw

    @staticmethod
    def _unwrap(raw):
        """Pull the JSON-RPC message out of an SSE frame (or plain JSON)."""
        for line in raw.splitlines():
            if line.startswith("data: "):
                return json.loads(line[6:])
        raw = raw.strip()
        if raw.startswith("{"):
            return json.loads(raw)
        return {}

    def init(self):
        _, sid, _ = self._post({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                       "clientInfo": {"name": "ws-bench", "version": "1.0"}},
        })
        self.sid = sid
        self._post({"jsonrpc": "2.0", "method": "notifications/initialized",
                    "params": {}})
        return sid

    def tools(self):
        _, _, raw = self._post({
            "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
        return self._unwrap(raw).get("result", {}).get("tools", [])

    def call(self, name, args=None, timeout=120):
        """Return (seconds, raw_response_bytes, parsed_payload)."""
        self._id += 1
        dt, _, raw = self._post({
            "jsonrpc": "2.0", "id": self._id, "method": "tools/call",
            "params": {"name": name, "arguments": args or {}}}, timeout=timeout)
        msg = self._unwrap(raw)
        res = msg.get("result") or {}
        text = ""
        for c in (res.get("content") or []):
            if c.get("type") == "text":
                text += c.get("text", "")
        payload = None
        try:
            payload = json.loads(text)
        except Exception:
            payload = text
        return dt, len(raw.encode("utf-8")), payload, res.get("isError", False)


# ── metrics extraction ──────────────────────────────────────────────────────

def payload_shape(p):
    """Best-effort size/shape commentary on a response payload."""
    if not isinstance(p, dict):
        return {"kind": type(p).__name__, "chars": len(str(p))}
    out = {}
    if isinstance(p.get("actions"), list):
        out["actions"] = len(p["actions"])
    if isinstance(p.get("forms"), list):
        out["forms"] = len(p["forms"])
    for k in ("content", "text", "markdown", "body_text", "bodyText"):
        v = p.get(k)
        if isinstance(v, str):
            out[k + "_chars"] = len(v)
    for k in ("totalActions", "total_actions", "omittedActions",
              "omitted_actions", "truncated"):
        if k in p:
            out[k] = p[k]
    d = p.get("data")
    if isinstance(d, dict):
        if isinstance(d.get("wsDebug"), list):
            out["wsDebug"] = len(d["wsDebug"])
        if "hubConnected" in d:
            out["hubConnected"] = d["hubConnected"]
        if "pageConnected" in d:
            out["pageConnected"] = d["pageConnected"]
    if isinstance(p.get("meta"), dict):
        out["meta_keys"] = len(p["meta"])
    return out


def run_battery(mcp, targets, reps):
    report = {"started": time.strftime("%Y-%m-%dT%H:%M:%S"), "targets": []}

    for t in targets:
        label, url = t["label"], t["url"]
        print(f"\n=== {label}  {url}")
        rec = {"label": label, "url": url, "ops": [], "navigate": {}}

        # navigate + settle. NOTE: navigate returns optimistically — it does NOT
        # wait for the navigation to commit, so an immediate read can still see
        # the OLD page. Poll readyState AND url-change, and record both.
        t0 = time.perf_counter()
        dt_nav, nb, npay, err = mcp.call("navigate", {"url": url, "newTab": False})
        settle = None
        for _ in range(40):
            _, _, pay, _ = mcp.call("status", {"kind": "page"})
            d = pay.get("data") if isinstance(pay, dict) else None
            if isinstance(d, dict) and d.get("readyState") == "complete" \
                    and (d.get("url") or "").startswith(url.split("?")[0][:40]):
                settle = round(time.perf_counter() - t0, 3)
                rec["csBuild"] = d.get("csBuild")
                rec["viewport"] = d.get("viewport")
                rec["wsDebug_len"] = len(d.get("wsDebug") or [])
                rec["nav_beforeunload"] = d.get("hasBeforeUnload")
                break
            time.sleep(0.25)
        rec["navigate"] = {"http_s": round(dt_nav, 3), "to_committed_s": settle,
                           "bytes": nb, "err": err}
        print(f"  navigate: http={dt_nav:.3f}s  ->committed={settle}s  "
              f"csBuild={rec.get('csBuild')}")
        time.sleep(1.0)

        ops = [
            ("status(page)", "status", {"kind": "page"}),
            ("status(bridge)", "status", {"kind": "bridge"}),
            ("read(content)", "read", {"format": "content"}),
            ("read(text)", "read", {"format": "text"}),
            ("explore(full)", "explore_page", {}),
            ("explore(compact)", "explore_page", {"compact": True}),
            ("explore(incremental)", "explore_page", {"incremental": True}),
            ("screenshot", "screenshot", {}),
            ("scroll(down,2)", "scroll", {"direction": "down", "amount": 2}),
        ]
        for opname, tool, args in ops:
            lat, sizes, errs, shapes = [], [], 0, []
            for i in range(reps):
                try:
                    dt, nbytes, pay, err = mcp.call(tool, args)
                    lat.append(dt)
                    sizes.append(nbytes)
                    if err:
                        errs += 1
                    if i == 0:
                        shapes.append(payload_shape(pay))
                except Exception as e:
                    errs += 1
                    lat.append(float("nan"))
                    sizes.append(0)
                time.sleep(0.35)
            good = [x for x in lat if x == x]
            if not good:
                print(f"  {opname:20s} FAILED x{reps} (errors={errs})")
                rec["ops"].append({"op": opname, "failed": reps, "errors": errs})
                continue
            row = {
                "op": opname,
                "n": len(good),
                "errors": errs,
                "p50_s": round(statistics.median(good), 3),
                "min_s": round(min(good), 3),
                "max_s": round(max(good), 3),
                "mean_s": round(statistics.fmean(good), 3),
                "bytes_p50": int(statistics.median(sizes)),
                "shape": shapes[0] if shapes else {},
            }
            if len(good) > 1:
                row["stdev_s"] = round(statistics.stdev(good), 3)
            rec["ops"].append(row)
            print(f"  {opname:20s} p50={row['p50_s']:>7.3f}s "
                  f"max={row['max_s']:>7.3f}s  bytes={row['bytes_p50']:>7d}  "
                  f"err={errs}  {row['shape']}")

        report["targets"].append(rec)

    report["finished"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    return report


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--schemas", action="store_true")
    ap.add_argument("--battery", action="store_true")
    ap.add_argument("--reps", type=int, default=3)
    ap.add_argument("--out", default="bench/bench_results.json")
    args = ap.parse_args()

    mcp = Mcp()
    sid = mcp.init()
    print(f"mcp session: {sid}")

    if args.schemas:
        want = {"status", "read", "explore_page", "screenshot", "scroll",
                "inspect", "navigate", "click", "type_text", "tabs", "session",
                "wait", "ax", "extract_text"}
        for t in mcp.tools():
            if t["name"] in want:
                print(f"\n── {t['name']}\n   {t.get('description','')[:160]}")
                props = (t.get("inputSchema") or {}).get("properties") or {}
                for k, v in props.items():
                    print(f"     {k}: {str(v.get('description',''))[:90]}")
        return 0

    if args.battery:
        targets = [
            {"label": "LIGHT  example.com", "url": "https://example.com/"},
            {"label": "HEAVY  x.com search", "url": "https://x.com/search?q=0x18570ea663ec4cc4b1611b11eb10fabf8691e1f7&f=live"},
        ]
        rep = run_battery(mcp, targets, args.reps)
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(rep, f, indent=2)
        print(f"\nwrote {args.out}")
        return 0

    ap.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
