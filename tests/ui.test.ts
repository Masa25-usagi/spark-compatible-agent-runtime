import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { RuntimeDaemon, createTaskEventHandler } from '../src/runtime/daemon.js';
import { MockConnectorRegistry } from '../src/runtime/registries.js';
import { EventTriggerEngine, Scheduler } from '../src/runtime/scheduler.js';
import { TaskEngine } from '../src/runtime/task-engine.js';
import { WorkerPool } from '../src/runtime/worker-pool.js';
import { FixedClock } from '../src/shared/clock.js';
import { SQLiteStore } from '../src/storage/sqlite.js';
import { createApprovalUiServer } from '../src/ui/server.js';

describe('Approval UI', () => {
  it('shows full disclosure and executes only after a CSRF-protected approval', async () => {
    const store = new SQLiteStore(':memory:');
    const connectors = new MockConnectorRegistry();
    const engine = new TaskEngine(store, { connectors });
    const task = engine.createTask({ title: 'UI send' });
    const waiting = engine.runAction(task.id, {
      tool: 'gmail.send',
      connector: 'gmail',
      operation: 'send_email',
      target: { thread: 'ui' },
      payload: { body: 'test' },
      before: { status: 'draft' },
      after: { status: 'sent' },
      recipient: 'user-e304929@example.com',
      itemCount: 1,
      reversible: false,
      originatingTask: 'UI send',
    });
    assert.ok(waiting.approval);
    const server = createApprovalUiServer(engine, { csrfToken: 'test-csrf' });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    try {
      const html = await (await fetch(base)).text();
      assert.match(html, /user-e304929@example\.com/);
      assert.match(html, /Before/);
      assert.equal(connectors.mocks.get('gmail')?.calls.length, 0);
      const rejected = await fetch(`${base}/approve`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: base },
        body: new URLSearchParams({ csrf: 'wrong', id: waiting.approval.id }),
      });
      assert.equal(rejected.status, 400);
      const approved = await fetch(`${base}/approve`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: base },
        body: new URLSearchParams({ csrf: 'test-csrf', id: waiting.approval.id }),
      });
      assert.equal(approved.status, 303);
      assert.equal(connectors.mocks.get('gmail')?.calls.length, 1);
      assert.equal(engine.getApproval(waiting.approval.id)?.status, 'consumed');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    }
  });

  it('resumes read-send-read once across approval and SQLite reopen', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'spark-workflow-'));
    const dbPath = join(directory, 'runtime.sqlite');
    const clock = new FixedClock(new Date('2026-07-18T00:00:00.000Z'));
    const connectors = new MockConnectorRegistry();
    let store = new SQLiteStore(dbPath, { clock });
    let workers: WorkerPool | undefined;
    try {
      const firstEngine = new TaskEngine(store, { clock, connectors });
      const event = new EventTriggerEngine(store, clock).enqueue('workflow-task', 'gmail.event', {
        task: { title: 'Durable approval workflow' },
        actions: [
          {
            tool: 'gmail.search',
            connector: 'gmail',
            operation: 'read',
            target: { message: 'before' },
            originatingTask: 'Durable approval workflow',
          },
          {
            tool: 'gmail.send',
            connector: 'gmail',
            operation: 'send_email',
            target: { thread: 'approval' },
            recipient: 'user-ec38c7b@example.com',
            originatingTask: 'Durable approval workflow',
          },
          {
            tool: 'gmail.search',
            connector: 'gmail',
            operation: 'read',
            target: { message: 'after' },
            originatingTask: 'Durable approval workflow',
          },
        ],
      });
      workers = new WorkerPool(store, { clock });
      await new RuntimeDaemon(
        new Scheduler(store, clock),
        workers,
        createTaskEventHandler(firstEngine),
      ).runOnce(clock.now());
      const firstWorkflow = store.getEventWorkflow(event.id);
      assert.equal(firstWorkflow?.nextIndex, 1);
      assert.equal(firstWorkflow?.status, 'waiting_for_approval');
      const firstCalls = connectors.mocks.get('gmail')?.calls ?? [];
      assert.deepEqual(
        firstCalls.map((call) => call.operation),
        ['read'],
      );
      const approvalId = firstEngine.listApprovals()[0]?.id;
      assert.ok(approvalId);
      store.close();

      store = new SQLiteStore(dbPath, { clock });
      const approvalEngine = new TaskEngine(store, { clock, connectors });
      const server = createApprovalUiServer(approvalEngine, { csrfToken: 'workflow-csrf' });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const port = (server.address() as AddressInfo).port;
        const response = await fetch(`http://127.0.0.1:${port}/approve`, {
          method: 'POST',
          redirect: 'manual',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Origin: `http://127.0.0.1:${port}`,
          },
          body: new URLSearchParams({ csrf: 'workflow-csrf', id: approvalId }),
        });
        assert.equal(response.status, 303);
        assert.equal(store.getEventWorkflow(event.id)?.nextIndex, 2);
        assert.equal(store.eventQueueStatus(event.id), 'queued');
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      store.close();

      store = new SQLiteStore(dbPath, { clock });
      const resumedEngine = new TaskEngine(store, { clock, connectors });
      workers = new WorkerPool(store, { clock });
      await new RuntimeDaemon(
        new Scheduler(store, clock),
        workers,
        createTaskEventHandler(resumedEngine),
      ).runOnce(clock.now());
      const calls = connectors.mocks.get('gmail')?.calls ?? [];
      assert.deepEqual(
        calls.map((call) => call.operation),
        ['read', 'send_email', 'read'],
      );
      assert.equal(store.getEventWorkflow(event.id)?.status, 'completed');
      assert.equal(resumedEngine.listTasks()[0]?.status, 'completed');
    } finally {
      workers?.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
