// The remote MCP server's tool argument rules, on a real MCP server and client (in memory): a refused
// target is rejected by the SDK's argument validation, so the tool callback (which is the x402
// payment wrapper in production) never runs and nothing is paid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { INFO_TOOL_ANNOTATIONS, PAID_TOOL_ANNOTATIONS, targetUrl } from '../src/mcp-tools.js';

async function connect() {
  const calls: unknown[] = [];
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  server.registerTool(
    'single',
    { description: 'single', inputSchema: { target: targetUrl }, annotations: PAID_TOOL_ANNOTATIONS },
    async (args) => {
      calls.push(args);
      return { content: [{ type: 'text', text: 'paid handler ran' }] };
    },
  );
  server.registerTool(
    'batch',
    { description: 'batch', inputSchema: { targets: z.array(targetUrl).min(1).max(50) }, annotations: PAID_TOOL_ANNOTATIONS },
    async (args) => {
      calls.push(args);
      return { content: [{ type: 'text', text: 'paid handler ran' }] };
    },
  );
  server.registerTool('info', { description: 'info', inputSchema: {}, annotations: INFO_TOOL_ANNOTATIONS }, async () => ({
    content: [{ type: 'text', text: 'info' }],
  }));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, calls };
}

async function refused(client: Client, name: string, args: Record<string, unknown>) {
  // Depending on the SDK version, invalid arguments come back as an isError result or a thrown error.
  try {
    const r = await client.callTool({ name, arguments: args });
    return r.isError === true;
  } catch {
    return true;
  }
}

test('tools/list publishes the annotations and a target schema with a length cap', async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  const single = tools.find((t) => t.name === 'single')!;
  assert.deepEqual(single.annotations, { ...PAID_TOOL_ANNOTATIONS });
  assert.deepEqual(tools.find((t) => t.name === 'info')!.annotations, { ...INFO_TOOL_ANNOTATIONS });
  const target = (single.inputSchema.properties as Record<string, { maxLength?: number }>).target;
  assert.equal(target.maxLength, 2048);
});

test('a refused target never reaches the tool callback', async () => {
  const { client, calls } = await connect();
  for (const target of ['http://169.254.169.254/latest/meta-data', 'http://localhost:4021/', 'file:///etc/passwd', 'https://u:p@example.com/']) {
    assert.ok(await refused(client, 'single', { target }), `${target} should be refused`);
  }
  assert.ok(await refused(client, 'single', { target: 'https://example.com/' + 'a'.repeat(2100) }));
  assert.ok(await refused(client, 'batch', { targets: ['https://ok.example/x', 'http://10.0.0.1/'] }));
  assert.equal(calls.length, 0, 'the paid callback must not run for a refused target');
});

test('an allowed target reaches the tool callback', async () => {
  const { client, calls } = await connect();
  const r = await client.callTool({ name: 'single', arguments: { target: 'https://x402.goplausible.xyz/examples/weather' } });
  assert.notEqual(r.isError, true);
  const b = await client.callTool({ name: 'batch', arguments: { targets: ['https://a.example/x', 'https://b.example/y'] } });
  assert.notEqual(b.isError, true);
  assert.equal(calls.length, 2);
});

test('windowHours: 24, 168 and 720 reach the tool; other values never do', async () => {
  const { windowHoursArg } = await import('../src/mcp-tools.js');
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  const seen: unknown[] = [];
  server.registerTool('w', { description: 'w', inputSchema: { target: targetUrl, windowHours: windowHoursArg } }, async (args) => {
    seen.push(args.windowHours);
    return { content: [{ type: 'text', text: 'ok' }] };
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'c', version: '0.0.0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const t = 'https://x402.goplausible.xyz/examples/weather';
  for (const w of [undefined, 24, 168, 720]) {
    const r = await client.callTool({ name: 'w', arguments: w === undefined ? { target: t } : { target: t, windowHours: w } });
    assert.notEqual(r.isError, true);
  }
  for (const w of [48, 0, '168']) assert.ok(await refused(client, 'w', { target: t, windowHours: w }), `${w} should be refused`);
  assert.deepEqual(seen, [undefined, 24, 168, 720]);
});
