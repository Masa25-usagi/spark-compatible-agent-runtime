import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { TaskEngine } from '../src/runtime/task-engine.js';
import { SQLiteStore } from '../src/storage/sqlite.js';
import { MockConnectorRegistry } from '../src/runtime/registries.js';
import { createApiServer } from '../src/api/server.js';

describe('Beginner Handoff Local Runtime Tests', () => {
  it('serves static files or index.html fallback, and injects the bearer token', async () => {
    const store = new SQLiteStore(':memory:');
    const engine = new TaskEngine(store);
    const apiInstance = createApiServer(engine, { port: 0 });

    await new Promise<void>((resolve) =>
      apiInstance.server.listen(0, '127.0.0.1', () => resolve()),
    );
    const port = (apiInstance.server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    try {
      // 1. Fetch root page / and check token injection
      const res = await fetch(`${base}/`, { headers: { Connection: 'close' } });
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes(apiInstance.token) || text.includes('spark-token'));

      // 2. Directory traversal attempt using encoded segments to bypass client normalization
      const traversalRes = await fetch(`${base}/%2e%2e%2f%2e%2e%2fpackage.json`, {
        headers: { Connection: 'close' },
      });
      assert.equal(traversalRes.status, 403);
    } finally {
      if (apiInstance.server.closeAllConnections) {
        apiInstance.server.closeAllConnections();
      }
      await new Promise<void>((resolve) => apiInstance.server.close(() => resolve()));
      store.close();
    }
  });

  it('executes approvals and returns execution results via API', async () => {
    const store = new SQLiteStore(':memory:');
    const connectors = new MockConnectorRegistry();
    const engine = new TaskEngine(store, { connectors });
    const task = engine.createTask({ title: 'API approve test' });

    // Trigger action requiring approval
    const waiting = engine.runAction(task.id, {
      tool: 'gmail.send',
      connector: 'gmail',
      operation: 'send_email',
      target: { thread: 'api' },
      payload: { body: 'api-test' },
      before: { status: 'draft' },
      after: { status: 'sent' },
      recipient: 'user-2f36f12@example.com',
      itemCount: 1,
      reversible: false,
      originatingTask: 'API approve test',
    });

    assert.ok(waiting.approval);

    const apiInstance = createApiServer(engine, { port: 0 });
    await new Promise<void>((resolve) =>
      apiInstance.server.listen(0, '127.0.0.1', () => resolve()),
    );
    const port = (apiInstance.server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    try {
      // Call approve API
      const res = await fetch(`${base}/api/v1/approvals/${waiting.approval.id}/approve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiInstance.token}`,
          Connection: 'close',
        },
        body: JSON.stringify({ confirm: true }),
      });

      assert.equal(res.status, 200);
      const data = (await res.json()) as any;

      // Verify execution result is returned
      assert.ok(data.approval);
      assert.equal(data.approval.status, 'consumed');
      assert.ok(data.executionResult);
      assert.equal(data.executionResult.success, true);
      assert.equal(connectors.mocks.get('gmail')?.calls.length, 1);
    } finally {
      if (apiInstance.server.closeAllConnections) {
        apiInstance.server.closeAllConnections();
      }
      await new Promise<void>((resolve) => apiInstance.server.close(() => resolve()));
      store.close();
    }
  });

  it('validates release guard forbidden paths correctly', async () => {
    // Dynamic import to support correct runtime path resolution in tsc dist output
    const guardUrl = new URL('../../scripts/release-verify-guards.mjs', import.meta.url).href;
    const { forbiddenPath } = (await import(guardUrl)) as {
      forbiddenPath: (path: string) => boolean;
    };

    // These paths should be forbidden
    assert.equal(forbiddenPath('.env'), true);
    assert.equal(forbiddenPath('.env.local'), true);
    assert.equal(forbiddenPath('data/db.sqlite'), true);
    assert.equal(forbiddenPath('node_modules/vite/package.json'), true);
    assert.equal(forbiddenPath('web/dist/index.html'), true);
    assert.equal(forbiddenPath('dist/styles.css'), true);
    assert.equal(forbiddenPath('web/src/styles/design-tokens.css'), false);
    assert.equal(forbiddenPath('credentials.json'), true);

    // These paths should be allowed (clean source files)
    assert.equal(forbiddenPath('src/api/server.ts'), false);
    assert.equal(forbiddenPath('web/src/main.ts'), false);
    assert.equal(forbiddenPath('START.command'), false);
  });
});
