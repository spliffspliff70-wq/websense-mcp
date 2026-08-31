---
name: Bug report
about: A WebSense tool did something wrong (or nothing)
title: ''
labels: bug
assignees: ''
---

**What were you trying to do?**

Which tool, with which arguments — paste the exact call.

**What happened instead?**

Verbatim error text or wrong behavior. If an effect was `suspected_noop` / `unverifiable`, say so.

**Environment**

- OS: Windows / macOS / Linux
- Chrome version:
- MCP client: Claude Desktop / Cline / Cursor / other
- Node version (`node --version`):

**Repro**

- Public URL or minimal HTML page where it happens:
- Was the bound tab the OS-active tab? (yes / no / unknown)
- Did `status {kind:'bridge'}` report `hubConnected:true`?

**Regression tests**

Run `node test-regressions.mjs` — did they pass? (42 expected)
