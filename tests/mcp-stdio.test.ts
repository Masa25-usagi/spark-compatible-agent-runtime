import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { McpStdioClient } from '../src/connectors/mcp-stdio.js';

const SERVER = String.raw`
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
function send(value) { process.stdout.write(JSON.stringify(value) + '\n'); }
rl.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    send({ jsonrpc: '2.0', id: request.id, result: {
      protocolVersion: '2025-11-25', capabilities: { tools: {} },
      serverInfo: { name: 'fake', version: '1.0.0' }
    }});
  } else if (request.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: request.id, result: { tools: [{
      name: 'gmail_search', description: 'Search test mail',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } }
    }] }});
  } else if (request.method === 'tools/call') {
    send({ jsonrpc: '2.0', id: request.id, result: {
      content: [{ type: 'text', text: 'found:' + request.params.arguments.query }],
      structuredContent: { count: 1 }, isError: false
    }});
  }
});
`;

describe('McpStdioClient', () => {
  it('negotiates, lists tools, and calls only allowlisted tools', async () => {
    const client = new McpStdioClient({
      command: process.execPath,
      args: ['-e', SERVER],
      allowedTools: ['gmail_search'],
      timeoutMs: 2_000,
    });
    try {
      await client.start();
      const tools = await client.listTools();
      assert.deepEqual(
        tools.map((tool) => tool.name),
        ['gmail_search'],
      );
      const result = await client.callTool('gmail_search', { query: 'invoice' });
      assert.equal(result.isError, false);
      assert.deepEqual(result.structuredContent, { count: 1 });
      assert.equal((result.content[0] as { text: string }).text, 'found:invoice');
      await assert.rejects(() => client.callTool('gmail_send', {}), /not allowlisted/);
    } finally {
      await client.close();
    }
  });

  it('accepts the MCP protocol version 2024-11-05', async () => {
    const client = new McpStdioClient({
      command: process.execPath,
      args: [
        '-e',
        SERVER.replace("protocolVersion: '2025-11-25'", "protocolVersion: '2024-11-05'"),
      ],
      allowedTools: ['gmail_search'],
      timeoutMs: 2_000,
    });
    try {
      await client.start();
      const tools = await client.listTools();
      assert.equal(tools[0]?.name, 'gmail_search');
    } finally {
      await client.close();
    }
  });

  it('does not leak parent environment variables when an explicit environment is configured', async () => {
    process.env.SPARK_RUNTIME_TEST_SECRET = 'must-not-cross-boundary';
    const client = new McpStdioClient({
      command: process.execPath,
      args: [
        '-e',
        SERVER.replace(
          'structuredContent: { count: 1 }',
          'structuredContent: { count: 1, leaked: process.env.SPARK_RUNTIME_TEST_SECRET || null }',
        ),
      ],
      env: {},
      allowedTools: ['gmail_search'],
      timeoutMs: 2_000,
    });
    try {
      await client.start();
      const result = await client.callTool('gmail_search', { query: 'safe' });
      assert.equal(result.structuredContent?.leaked, null);
    } finally {
      await client.close();
      delete process.env.SPARK_RUNTIME_TEST_SECRET;
    }
  });

  it('can close cleanly after the server executable fails to spawn', async () => {
    const client = new McpStdioClient({
      command: '/definitely/missing/mcp-server',
      allowedTools: ['none'],
      timeoutMs: 200,
    });
    await assert.rejects(() => client.start());
    await client.close();
  });
});
