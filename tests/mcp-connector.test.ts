import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { McpConnector } from '../src/connectors/mcp-connector.js';
import { ConnectorRegistry } from '../src/runtime/registries.js';
import { TaskEngine } from '../src/runtime/task-engine.js';
import { SQLiteStore } from '../src/storage/sqlite.js';

const SERVER = String.raw`
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
function send(value) { process.stdout.write(JSON.stringify(value) + '\n'); }
rl.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    send({ jsonrpc: '2.0', id: request.id, result: {
      protocolVersion: '2025-11-25', capabilities: { tools: {} },
      serverInfo: { name: 'fake-google', version: '1.0.0' }
    }});
  } else if (request.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: request.id, result: { tools: [
      { name: 'gmail_search', inputSchema: { type: 'object' } },
      { name: 'gmail_send', inputSchema: { type: 'object' } }
    ] }});
  } else if (request.method === 'tools/call') {
    send({ jsonrpc: '2.0', id: request.id, result: {
      content: [{ type: 'text', text: 'called:' + request.params.name }],
      structuredContent: { tool: request.params.name, args: request.params.arguments },
      isError: false
    }});
  }
});
`;

function createEngine() {
  const store = new SQLiteStore(':memory:');
  const connectors = new ConnectorRegistry();
  connectors.register(
    new McpConnector({
      name: 'gmail',
      server: {
        command: process.execPath,
        args: ['-e', SERVER],
        allowedTools: ['gmail_search', 'gmail_send'],
        timeoutMs: 2_000,
      },
      toolMap: {
        'gmail.search': { tool: 'gmail_search', operations: ['read', 'search'] },
        'gmail.send': { tool: 'gmail_send', operations: ['send_email'] },
      },
    }),
  );
  return { store, engine: new TaskEngine(store, { connectors }) };
}

describe('McpConnector policy integration', () => {
  it('executes an allowlisted read tool and reports a real result', () => {
    const { store, engine } = createEngine();
    try {
      const task = engine.createTask({ title: 'Search Gmail' });
      const result = engine.runAction(task.id, {
        tool: 'gmail.search',
        connector: 'gmail',
        operation: 'search',
        target: { account: 'test' },
        payload: { query: 'invoice' },
        originatingTask: 'Search Gmail',
      });
      assert.equal(result.connectorResult?.simulated, false);
      assert.deepEqual(result.connectorResult?.output, {
        tool: 'gmail_search',
        args: { query: 'invoice' },
      });
    } finally {
      store.close();
    }
  });

  it('does not call a mutating MCP tool until its digest-bound approval is consumed', () => {
    const { store, engine } = createEngine();
    try {
      const task = engine.createTask({ title: 'Send Gmail' });
      const input = {
        tool: 'gmail.send',
        connector: 'gmail',
        operation: 'send_email' as const,
        target: { account: 'test' },
        payload: { to: 'user-852e7b9@example.com', subject: 'Test', body: 'Body' },
        recipient: 'user-852e7b9@example.com',
        originatingTask: 'Send Gmail',
      };
      const waiting = engine.runAction(task.id, input);
      assert.equal(waiting.connectorResult, null);
      assert.ok(waiting.approval);
      engine.approve(waiting.approval.id, 'tester');
      const executed = engine.runAction(task.id, input, { approvalId: waiting.approval.id });
      assert.equal(executed.connectorResult?.simulated, false);
      assert.deepEqual(executed.connectorResult?.output, {
        tool: 'gmail_send',
        args: input.payload,
      });
    } finally {
      store.close();
    }
  });

  it('rejects an operation label that understates the mapped tool impact', () => {
    const { store, engine } = createEngine();
    try {
      const task = engine.createTask({ title: 'Disguised Gmail send' });
      const result = engine.runAction(task.id, {
        tool: 'gmail.send',
        connector: 'gmail',
        operation: 'search',
        target: { account: 'test' },
        payload: { to: 'user-852e7b9@example.com', body: 'unsafe' },
        originatingTask: 'Disguised Gmail send',
      });
      assert.equal(result.connectorResult, null);
      assert.equal(result.task.status, 'failed');
      assert.match(result.task.errors.at(-1) ?? '', /does not permit declared operation/);
    } finally {
      store.close();
    }
  });
});
