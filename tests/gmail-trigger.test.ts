import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createTaskEventHandler } from '../src/runtime/daemon.js';
import { MockConnectorRegistry } from '../src/runtime/registries.js';
import { TaskEngine } from '../src/runtime/task-engine.js';
import { FixedClock } from '../src/shared/clock.js';
import { SQLiteStore } from '../src/storage/sqlite.js';
import { encodeGmailNotification, GmailEventTrigger } from '../src/triggers/gmail.js';

describe('GmailEventTrigger', () => {
  it('accepts a safe integer historyId and normalizes it to a string', () => {
    const store = new SQLiteStore(':memory:');
    try {
      const trigger = new GmailEventTrigger(store);
      const data = Buffer.from(
        JSON.stringify({ emailAddress: 'user-852e7b9@example.com', historyId: 1234 }),
        'utf8',
      ).toString('base64');

      const event = trigger.ingest(
        { message: { messageId: 'numeric-history-id', data } },
        { actions: [] },
      );

      assert.ok(event);
      assert.ok(
        event.payload !== null &&
          typeof event.payload === 'object' &&
          !Array.isArray(event.payload),
      );
      assert.deepEqual(event.payload.gmail, {
        messageId: 'numeric-history-id',
        emailAddress: 'user-852e7b9@example.com',
        historyId: '1234',
        publishTime: null,
      });
    } finally {
      store.close();
    }
  });

  it('rejects invalid numeric historyId values', () => {
    const invalidHistoryIds = [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY];

    for (const historyId of invalidHistoryIds) {
      const store = new SQLiteStore(':memory:');
      try {
        const trigger = new GmailEventTrigger(store);
        const data = Buffer.from(
          JSON.stringify({ emailAddress: 'user-852e7b9@example.com', historyId }),
          'utf8',
        ).toString('base64');

        assert.throws(
          () =>
            trigger.ingest(
              { message: { messageId: `invalid-${historyId}`, data } },
              { actions: [] },
            ),
          /Gmail notification must contain emailAddress and historyId/,
        );
      } finally {
        store.close();
      }
    }
  });

  it('deduplicates Pub/Sub messages and feeds a workflow into the task engine', () => {
    const clock = new FixedClock(new Date('2026-07-18T00:00:00.000Z'));
    const store = new SQLiteStore(':memory:', { clock });
    try {
      const connectors = new MockConnectorRegistry();
      const engine = new TaskEngine(store, { clock, connectors });
      const trigger = new GmailEventTrigger(store, clock);
      const envelope = {
        message: {
          messageId: 'message-1',
          data: encodeGmailNotification({
            emailAddress: 'user-852e7b9@example.com',
            historyId: '1234',
          }),
        },
      };
      const workflow = {
        task: { title: 'Gmail notification' },
        actions: [
          {
            tool: 'gmail.search',
            connector: 'gmail',
            operation: 'search',
            target: { historyId: '1234' },
            originatingTask: 'Gmail notification',
          },
        ],
      };
      const event = trigger.ingest(envelope, workflow);
      assert.ok(event);
      const claim = store.claimEvent(event.id, clock.now().toISOString());
      assert.ok(claim);
      createTaskEventHandler(engine)(event);
      assert.equal(store.completeEvent(claim, clock.now().toISOString()), true);
      assert.equal(engine.listTasks()[0]?.status, 'completed');
      assert.equal(connectors.mocks.get('gmail')?.calls.length, 1);
      assert.equal(trigger.ingest(envelope, workflow), null);
    } finally {
      store.close();
    }
  });

  it('returns a failed notification for retry instead of suppressing it as a duplicate', () => {
    const clock = new FixedClock(new Date('2026-07-18T00:00:00.000Z'));
    const store = new SQLiteStore(':memory:', { clock });
    try {
      const trigger = new GmailEventTrigger(store, clock);
      const envelope = {
        message: {
          messageId: 'retry-message',
          data: encodeGmailNotification({
            emailAddress: 'user-0b5c4cf@example.com',
            historyId: '5678',
          }),
        },
      };
      const event = trigger.ingest(envelope, { actions: [] });
      assert.ok(event);
      const claim = store.claimEvent(event.id, clock.now().toISOString());
      assert.ok(claim);
      assert.equal(store.failEvent(claim, 'temporary failure', clock.now().toISOString()), true);
      assert.equal(trigger.ingest(envelope, { actions: [] })?.id, event.id);
    } finally {
      store.close();
    }
  });
});
