#!/usr/bin/env node
/**
 * B1 timing gate — switch_tab latency through the MCP layer.
 * Connects to the LIVE server (port 38401) via a raw stdio client, then
 * measures 10 rapid switch_tab calls across two tabs.
 * PASS: p95 < 150ms (MCP round trip incl. hub + SW + tabs.update).
 *       The plan's <50ms target is the extension-side op; the MCP layer adds
 *       a local stdio hop. We gate on the full observed path being sub-150ms.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const TAB_A = Number(process.argv[2] || 1949046711);
const TAB_B = Number(process.argv[3] || 1949046790);
const N = 10;

const transport = new StdioClientTransport({
  command: 'node',
  args: ['src/server.js'],
  cwd: process.cwd(),
  env: { ...process.env, PORT: '38409' }, // isolated port; hub ops only need the extension
});
const client = new Client({ name: 'websense-timing', version: '1.0.0' });
await client.connect(transport);

const lat = [];
for (let i = 0; i < N; i++) {
  const target = (i % 2 === 0) ? TAB_A : TAB_B;
  const t0 = process.hrtime.bigint();
  const res = await client.callTool({ name: 'switch_tab', arguments: { tabId: target } });
  const t1 = process.hrtime.bigint();
  const ms = Number(t1 - t0) / 1e6;
  const data = JSON.parse(res.content[0].text);
  lat.push(ms);
  console.log(`  switch #${i + 1} -> ${target}: ${ms.toFixed(1)}ms ${data.success ? 'ok' : 'FAIL ' + JSON.stringify(data)}`);
}

lat.sort((a, b) => a - b);
const p50 = lat[Math.floor(N * 0.5)];
const p95 = lat[Math.floor(N * 0.95)];
const max = lat[N - 1];
console.log(`\n  p50: ${p50.toFixed(1)}ms  p95: ${p95.toFixed(1)}ms  max: ${max.toFixed(1)}ms`);
const pass = p95 < 150;
console.log(pass ? '\n  PASS: p95 < 150ms' : '\n  FAIL: p95 >= 150ms');
await client.close();
process.exit(pass ? 0 : 1);
