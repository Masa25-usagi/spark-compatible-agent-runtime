import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { RuntimeDaemon, createTaskEventHandler } from '../src/runtime/daemon.js';
import { ConnectorRegistry, MockConnectorRegistry } from '../src/runtime/registries.js';
import { EventTriggerEngine, Scheduler } from '../src/runtime/scheduler.js';
import { TaskEngine } from '../src/runtime/task-engine.js';
import { WorkerPool } from '../src/runtime/worker-pool.js';
import { FixedClock } from '../src/shared/clock.js';
import { SQLiteStore } from '../src/storage/sqlite.js';

describe('RuntimeDaemon', () => {
  it('reclaims an expired event claim and rejects stale completion or failure updates', () => {
    const at = new Date('2026-07-18T00:00:00.000Z');
    const clock = new FixedClock(at);
    const store = new SQLiteStore(':memory:', { clock });
    try {
      const event = new EventTriggerEngine(store, clock).enqueue('task-1', 'test.event', {
        actions: [],
      });
      const first = store.claimEvent(event.id, at.toISOString(), 1_000);
      assert.ok(first);

      const exited = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
      assert.equal(typeof exited.pid, 'number');
      store.database
        .prepare('UPDATE event_queue SET claim_owner_pid = ? WHERE event_id = ?')
        .run(exited.pid, event.id);

      clock.advance(2_000);
      const second = store.claimEvent(event.id, clock.now().toISOString(), 1_000);
      assert.ok(second);
      assert.notEqual(first.claimToken, second.claimToken);
      assert.equal(store.completeEvent(first, clock.now().toISOString()), false);
      assert.equal(store.failEvent(first, 'stale failure', clock.now().toISOString()), false);
      assert.equal(store.eventQueueStatus(event.id), 'running');
      assert.equal(store.completeEvent(second, clock.now().toISOString()), true);
      assert.equal(store.eventQueueStatus(event.id), 'completed');
    } finally {
      store.close();
    }
  });

  it('allows the live claimant to complete or fail after its lease expires', () => {
    const at = new Date('2026-07-18T00:00:00.000Z');
    const clock = new FixedClock(at);
    const store = new SQLiteStore(':memory:', { clock });
    try {
      const trigger = new EventTriggerEngine(store, clock);
      const completedEvent = trigger.enqueue('long-task', 'test.completed', { actions: [] });
      const completedClaim = store.claimEvent(completedEvent.id, at.toISOString(), 1_000);
      assert.ok(completedClaim);

      clock.advance(2_000);
      assert.equal(store.completeEvent(completedClaim, clock.now().toISOString()), true);
      assert.equal(store.eventQueueStatus(completedEvent.id), 'completed');

      const failedEvent = trigger.enqueue('long-task-failed', 'test.failed', { actions: [] });
      const failedClaim = store.claimEvent(failedEvent.id, clock.now().toISOString(), 1_000);
      assert.ok(failedClaim);
      clock.advance(2_000);
      assert.equal(
        store.failEvent(failedClaim, 'long-running failure', clock.now().toISOString()),
        true,
      );
      assert.equal(store.eventQueueStatus(failedEvent.id), 'failed');
    } finally {
      store.close();
    }
  });

  it('only reclaims expired claims from dead owners across SQLite connections', () => {
    const directory = mkdtempSync(join(tmpdir(), 'spark-event-claims-'));
    const path = join(directory, 'runtime.sqlite');
    const at = new Date('2026-07-18T00:00:00.000Z');
    const clock = new FixedClock(at);
    const firstStore = new SQLiteStore(path, { clock });
    const secondStore = new SQLiteStore(path, { clock });
    try {
      const event = new EventTriggerEngine(firstStore, clock).enqueue('task-2', 'test.event', {
        actions: [],
      });
      const first = firstStore.claimEvent(event.id, at.toISOString(), 1_000);
      assert.ok(first);
      clock.advance(2_000);

      assert.equal(secondStore.claimEvent(event.id, clock.now().toISOString(), 1_000), null);

      const exited = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
      assert.equal(typeof exited.pid, 'number');
      firstStore.database
        .prepare('UPDATE event_queue SET claim_owner_pid = ? WHERE event_id = ?')
        .run(exited.pid, event.id);

      const recovered = secondStore.claimEvent(event.id, clock.now().toISOString(), 1_000);
      assert.ok(recovered);
      assert.notEqual(first.claimToken, recovered.claimToken);
      assert.equal(secondStore.completeEvent(first, clock.now().toISOString()), false);
      assert.equal(secondStore.completeEvent(recovered, clock.now().toISOString()), true);
    } finally {
      firstStore.close();
      secondStore.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('turns a due schedule into a persisted task execution', async () => {
    const at = new Date('2026-07-18T00:00:00.000Z');
    const clock = new FixedClock(at);
    const store = new SQLiteStore(':memory:', { clock });
    try {
      const connectors = new MockConnectorRegistry();
      const engine = new TaskEngine(store, { clock, connectors });
      const scheduler = new Scheduler(store, clock);
      scheduler.add(
        'read inbox',
        60_000,
        {
          task: { title: 'Scheduled inbox read' },
          actions: [
            {
              tool: 'gmail.search',
              connector: 'gmail',
              operation: 'search',
              target: { folder: 'inbox' },
              originatingTask: 'Scheduled inbox read',
            },
          ],
        },
        at,
      );
      const workers = new WorkerPool(store, { clock });
      const daemon = new RuntimeDaemon(scheduler, workers, createTaskEventHandler(engine));
      const events = await daemon.runOnce(at);
      assert.equal(events.length, 1);
      assert.equal(engine.listTasks().length, 1);
      assert.equal(engine.listTasks()[0]?.status, 'completed');
      assert.equal(connectors.mocks.get('gmail')?.calls.length, 1);
      assert.equal(workers.listTaskControls()[0]?.status, 'completed');
    } finally {
      store.close();
    }
  });

  it('replays a persisted failed event without emitting a duplicate schedule event', async () => {
    const at = new Date('2026-07-18T00:00:00.000Z');
    const clock = new FixedClock(at);
    const store = new SQLiteStore(':memory:', { clock });
    try {
      const scheduler = new Scheduler(store, clock);
      scheduler.add('retry', 60_000, { actions: [] }, at);
      const workers = new WorkerPool(store, { clock });
      let attempts = 0;
      const daemon = new RuntimeDaemon(scheduler, workers, () => {
        attempts += 1;
        if (attempts === 1) throw new Error('temporary failure');
      });
      await assert.rejects(() => daemon.runOnce(at), /scheduled execution/);
      assert.equal(store.listEvents('schedule:' + store.listSchedules()[0]?.id).length, 1);
      const replayed = await daemon.runOnce(at);
      assert.equal(replayed.length, 1);
      assert.equal(attempts, 2);
      assert.equal(store.eventQueueStatus(replayed[0]!.id), 'completed');
    } finally {
      store.close();
    }
  });

  it('retries an event when TaskEngine.run returns a failed action result', async () => {
    const at = new Date('2026-07-18T00:00:00.000Z');
    const clock = new FixedClock(at);
    const store = new SQLiteStore(':memory:', { clock });
    try {
      const connectors = new ConnectorRegistry();
      connectors.register({
        name: 'failing',
        execute: () => ({
          success: false,
          simulated: false,
          summary: 'temporary connector failure',
          changedTargets: [],
          undoGuidance: null,
          output: null,
        }),
      });
      const engine = new TaskEngine(store, { clock, connectors });
      const event = new EventTriggerEngine(store, clock).enqueue('task-failure', 'test.event', {
        task: { title: 'Retry failed workflow' },
        actions: [
          {
            tool: 'failing.read',
            connector: 'failing',
            operation: 'read',
            target: { resource: 'temporary' },
            originatingTask: 'Retry failed workflow',
          },
        ],
      });
      const workers = new WorkerPool(store, { clock });
      const daemon = new RuntimeDaemon(
        schedulerFor(store, clock),
        workers,
        createTaskEventHandler(engine),
      );

      await assert.rejects(() => daemon.runOnce(at), /scheduled execution/);
      assert.equal(store.eventQueueStatus(event.id), 'failed');
      assert.equal(engine.listTasks()[0]?.status, 'failed');
    } finally {
      store.close();
    }
  });

  it('completes event delivery for approval and take-control states without retrying', async () => {
    const at = new Date('2026-07-18T00:00:00.000Z');
    const clock = new FixedClock(at);
    const store = new SQLiteStore(':memory:', { clock });
    let workers: WorkerPool | undefined;
    try {
      const connectors = new MockConnectorRegistry();
      const engine = new TaskEngine(store, { clock, connectors });
      const scheduler = schedulerFor(store, clock);
      workers = new WorkerPool(store, { clock });
      const waitingEvent = new EventTriggerEngine(store, clock).enqueue(
        'task-waiting',
        'approval.event',
        {
          task: { title: 'Approval workflow' },
          actions: [
            {
              tool: 'gmail.send',
              connector: 'gmail',
              operation: 'send_email',
              target: { thread: 'approval' },
              recipient: 'user-852e7b9@example.com',
              originatingTask: 'Approval workflow',
            },
          ],
        },
      );
      const waitingDaemon = new RuntimeDaemon(scheduler, workers, createTaskEventHandler(engine));
      await waitingDaemon.runOnce(at);
      assert.equal(engine.listTasks()[0]?.status, 'waiting_for_approval');
      assert.equal(store.eventQueueStatus(waitingEvent.id), 'completed');

      const takeControlEvent = new EventTriggerEngine(store, clock).enqueue(
        'task-control',
        'control.event',
        {
          task: { title: 'Manual sign-in' },
          actions: [
            {
              tool: 'browser.login',
              connector: 'web',
              operation: 'authentication',
              target: { site: 'example.invalid' },
              originatingTask: 'Manual sign-in',
            },
          ],
        },
      );
      await new RuntimeDaemon(scheduler, workers, createTaskEventHandler(engine)).runOnce(at);
      assert.equal(engine.listTasks()[1]?.status, 'take_control');
      assert.equal(store.eventQueueStatus(takeControlEvent.id), 'completed');
    } finally {
      workers?.close();
      store.close();
    }
  });
});

function schedulerFor(store: SQLiteStore, clock: FixedClock): Scheduler {
  return new Scheduler(store, clock);
}
