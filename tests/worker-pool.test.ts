import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { Scheduler } from '../src/runtime/scheduler.js';
import { MAX_CONCURRENT_TASKS, WorkerPool } from '../src/runtime/worker-pool.js';
import { SQLiteStore } from '../src/storage/sqlite.js';
import { FixedClock } from '../src/shared/clock.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('WorkerPool', () => {
  it('keeps an expired lease owned by a live process when enforcing the global limit', () => {
    const clock = new FixedClock(new Date('2026-01-01T00:00:00.000Z'));
    const store = new SQLiteStore(':memory:', { clock });
    const leases: string[] = [];
    try {
      for (let index = 0; index < MAX_CONCURRENT_TASKS; index += 1) {
        const leaseId = `expired-live-${index}`;
        assert.equal(
          store.tryAcquireRuntimeLease(
            leaseId,
            clock.now().toISOString(),
            '2025-12-31T23:59:00.000Z',
          ),
          true,
        );
        leases.push(leaseId);
      }
      assert.equal(
        store.tryAcquireRuntimeLease(
          'expired-live-over-limit',
          clock.now().toISOString(),
          '2025-12-31T23:59:00.000Z',
        ),
        false,
      );
    } finally {
      for (const leaseId of leases) store.releaseRuntimeLease(leaseId);
      store.close();
    }
  });

  it('rejects queued jobs when closed instead of executing them later', async () => {
    const clock = new FixedClock(new Date('2026-01-01T00:00:00.000Z'));
    const store = new SQLiteStore(':memory:', { clock });
    const pool = new WorkerPool(store, { concurrency: 1, clock });
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    let queuedRan = false;
    try {
      const active = pool.enqueue('active-close', () => blocker);
      const queued = pool.enqueue('queued-close', () => {
        queuedRan = true;
      });
      pool.close();
      await assert.rejects(queued, /closed before execution/);
      release();
      await active;
      assert.equal(queuedRan, false);
      assert.equal(pool.getTaskControl('queued-close')?.status, 'failed');
    } finally {
      store.close();
    }
  });
  it('never runs more than fifteen tasks concurrently', async () => {
    const clock = new FixedClock(new Date('2026-01-01T00:00:00.000Z'));
    const store = new SQLiteStore(':memory:', { clock });
    const pool = new WorkerPool(store, { concurrency: 100, clock });
    let running = 0;
    let maximum = 0;

    try {
      const jobs = Array.from({ length: 40 }, (_, index) =>
        pool.enqueue(`task-${index}`, async () => {
          running += 1;
          maximum = Math.max(maximum, running);
          await new Promise<void>((resolve) => setTimeout(resolve, 2));
          running -= 1;
        }),
      );

      await Promise.all(jobs);
      assert.equal(pool.concurrency, MAX_CONCURRENT_TASKS);
      assert.equal(maximum, MAX_CONCURRENT_TASKS);
      assert.equal(pool.activeCount, 0);
      assert.equal(pool.pendingCount, 0);
      assert.equal(
        store.listTaskControls().every((control) => control.status === 'completed'),
        true,
      );
    } finally {
      pool.close();
      store.close();
    }
  });

  it('enforces the fifteen-task limit across independent pools and SQLite connections', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'spark-global-pool-'));
    const path = join(directory, 'runtime.sqlite');
    const clock = new FixedClock(new Date('2026-01-01T00:00:00.000Z'));
    const firstStore = new SQLiteStore(path, { clock });
    const secondStore = new SQLiteStore(path, { clock });
    const firstPool = new WorkerPool(firstStore, { concurrency: 15, clock });
    const secondPool = new WorkerPool(secondStore, { concurrency: 15, clock });
    const gate = deferred();
    let running = 0;
    let maximum = 0;
    try {
      const jobs = Array.from({ length: 30 }, (_, index) => {
        const pool = index % 2 === 0 ? firstPool : secondPool;
        return pool.enqueue(`global-${index}`, async () => {
          running += 1;
          maximum = Math.max(maximum, running);
          await gate.promise;
          running -= 1;
        });
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      assert.equal(maximum, MAX_CONCURRENT_TASKS);
      gate.resolve();
      await Promise.all(jobs);
      assert.equal(maximum, MAX_CONCURRENT_TASKS);
    } finally {
      firstPool.close();
      secondPool.close();
      firstStore.close();
      secondStore.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('pauses queued work and resumes it without blocking other tasks', async () => {
    const clock = new FixedClock(new Date('2026-01-01T00:00:00.000Z'));
    const store = new SQLiteStore(':memory:', { clock });
    const pool = new WorkerPool(store, { concurrency: 1, clock });
    const firstStarted = deferred();
    const firstFinished = deferred();
    let pausedRan = false;

    try {
      const first = pool.enqueue('first', async () => {
        firstStarted.resolve();
        await firstFinished.promise;
      });
      const paused = pool.enqueue('paused', () => {
        pausedRan = true;
      });
      const pausedControl = pool.pause('paused', 'Wait for approval');

      assert.equal(pausedControl.paused, true);
      await firstStarted.promise;
      firstFinished.resolve();
      await first;
      await Promise.resolve();
      assert.equal(pausedRan, false);
      assert.equal(pool.getTaskControl('paused')?.status, 'queued');

      pool.resume('paused');
      await paused;
      assert.equal(pausedRan, true);
    } finally {
      pool.close();
      store.close();
    }
  });

  it('persists a paused task across a worker restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'spark-worker-'));
    const dbPath = join(directory, 'runtime.sqlite');
    const clock = new FixedClock(new Date('2026-01-01T00:00:00.000Z'));
    let firstPool: WorkerPool | undefined;
    let firstStore: SQLiteStore | undefined;
    let secondPool: WorkerPool | undefined;
    let secondStore: SQLiteStore | undefined;

    try {
      firstStore = new SQLiteStore(dbPath, { clock });
      firstPool = new WorkerPool(firstStore, { clock });
      firstPool.pause('restartable', 'Operator pause');
      firstPool.close();
      firstStore.close();
      firstPool = undefined;
      firstStore = undefined;

      secondStore = new SQLiteStore(dbPath, { clock });
      secondPool = new WorkerPool(secondStore, { clock });
      let ran = false;
      const pending = secondPool.enqueue('restartable', () => {
        ran = true;
      });

      await Promise.resolve();
      assert.equal(ran, false);
      assert.equal(secondPool.getTaskControl('restartable')?.paused, true);

      secondPool.resume('restartable');
      await pending;
      assert.equal(ran, true);
      assert.equal(secondPool.getTaskControl('restartable')?.status, 'completed');
      assert.equal(secondPool.getTaskControl('restartable')?.paused, false);
    } finally {
      secondPool?.close();
      secondStore?.close();
      firstPool?.close();
      firstStore?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('lets an active runner cooperatively wait for resume', async () => {
    const clock = new FixedClock(new Date('2026-01-01T00:00:00.000Z'));
    const store = new SQLiteStore(':memory:', { clock });
    const pool = new WorkerPool(store, { concurrency: 1, clock });
    const started = deferred();
    const releaseWait = deferred();
    let resumed = false;

    try {
      const pending = pool.enqueue('cooperative', async (context) => {
        started.resolve();
        await releaseWait.promise;
        await context.waitIfResumed();
        resumed = true;
      });
      await started.promise;
      pool.pause('cooperative', 'Temporarily suspended');
      releaseWait.resolve();
      await Promise.resolve();
      assert.equal(resumed, false);

      pool.resume('cooperative');
      await pending;
      assert.equal(resumed, true);
    } finally {
      pool.close();
      store.close();
    }
  });
});

describe('Scheduler controls', () => {
  it('persists pause and resume state for schedules', () => {
    const directory = mkdtempSync(join(tmpdir(), 'spark-scheduler-'));
    const dbPath = join(directory, 'runtime.sqlite');
    const clock = new FixedClock(new Date('2026-01-01T00:00:00.000Z'));
    let store: SQLiteStore | undefined;
    let reopened: SQLiteStore | undefined;

    try {
      store = new SQLiteStore(dbPath, { clock });
      const scheduler = new Scheduler(store, clock);
      const schedule = scheduler.add(
        'hourly task',
        60_000,
        { taskId: 'scheduled-task' },
        clock.now(),
      );
      const paused = scheduler.pause(schedule.id, 'Maintenance');
      assert.equal(paused.enabled, false);
      assert.equal(scheduler.isPaused(schedule.id), true);
      assert.deepEqual(store.getScheduleControl(schedule.id), {
        scheduleId: schedule.id,
        paused: true,
        enabledBeforePause: true,
        reason: 'Maintenance',
        updatedAt: clock.now().toISOString(),
      });
      store.close();
      store = undefined;

      reopened = new SQLiteStore(dbPath, { clock });
      const reopenedScheduler = new Scheduler(reopened, clock);
      assert.equal(reopened.getSchedule(schedule.id)?.enabled, false);
      assert.equal(reopenedScheduler.tick(clock.now()).length, 0);

      const resumed = reopenedScheduler.resume(schedule.id);
      assert.equal(resumed.enabled, true);
      assert.equal(reopenedScheduler.isPaused(schedule.id), false);
      assert.equal(reopenedScheduler.tick(clock.now()).length, 1);
    } finally {
      reopened?.close();
      store?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps disable distinct from temporary pause', () => {
    const clock = new FixedClock(new Date('2026-01-01T00:00:00.000Z'));
    const store = new SQLiteStore(':memory:', { clock });
    const scheduler = new Scheduler(store, clock);

    try {
      const schedule = scheduler.add('disabled task', 10_000, null, clock.now());
      scheduler.disable(schedule.id);
      assert.equal(scheduler.isPaused(schedule.id), false);
      assert.equal(scheduler.resume(schedule.id).enabled, false);
      assert.equal(scheduler.enable(schedule.id).enabled, true);
    } finally {
      store.close();
    }
  });
});
