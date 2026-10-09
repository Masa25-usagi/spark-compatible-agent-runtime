import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { FixedClock } from '../src/shared/clock.js';
import { SQLiteStore } from '../src/storage/sqlite.js';
import { GoogleChatEventTrigger } from '../src/triggers/google-chat.js';

describe('GoogleChatEventTrigger', () => {
  it('accepts valid events for all supported event types and generates runtime events', () => {
    const clock = new FixedClock(new Date('2026-07-26T15:00:00.000Z'));
    const store = new SQLiteStore(':memory:', { clock });
    try {
      const trigger = new GoogleChatEventTrigger(store, clock);
      const eventTypes = [
        { type: 'google.workspace.chat.message.v1.created', expected: 'messageCreated' },
        { type: 'google.workspace.chat.message.v1.updated', expected: 'messageUpdated' },
        { type: 'google.workspace.chat.message.v1.deleted', expected: 'messageDeleted' },
        { type: 'google.workspace.chat.space.v1.updated', expected: 'spaceUpdated' },
        { type: 'google.workspace.chat.membership.v1.updated', expected: 'membershipUpdated' },
        // Direct event types
        { type: 'messageCreated', expected: 'messageCreated' },
      ];

      for (const { type, expected } of eventTypes) {
        const envelope = {
          id: `evt-id-${type}`,
          type,
          source: '//workspaceevents.googleapis.com/subscriptions/sub1',
          data: {
            message: {
              name: 'spaces/spaceA/messages/msgB',
              text: 'This is a message body text that should be omitted',
              space: {
                name: 'spaces/spaceA',
              },
            },
          },
        };

        const event = trigger.ingest(envelope, 'caller-task-id', { extraWorkflowData: 'test' });
        assert.ok(event);
        assert.equal(event.taskId, 'caller-task-id');
        assert.equal(event.kind, `google-chat.${expected}`);
        assert.deepEqual(event.payload, {
          extraWorkflowData: 'test',
          eventType: expected,
          resource: 'spaces/spaceA/messages/msgB',
          messageName: 'spaces/spaceA/messages/msgB',
          spaceName: 'spaces/spaceA',
          source: '//workspaceevents.googleapis.com/subscriptions/sub1',
          eventId: `evt-id-${type}`,
        });
      }
    } finally {
      store.close();
    }
  });

  it('rejects empty or missing CloudEvent id', () => {
    const store = new SQLiteStore(':memory:');
    try {
      const trigger = new GoogleChatEventTrigger(store);
      const emptyIds = [undefined, null, '', '   '];

      for (const id of emptyIds) {
        assert.throws(() => {
          trigger.ingest(
            {
              id,
              type: 'messageCreated',
              data: { resource: 'spaces/spaceA' },
            },
            'task-id',
          );
        }, /CloudEvent id is required and cannot be empty/);
      }
    } finally {
      store.close();
    }
  });

  it('rejects unsupported or unknown event types', () => {
    const store = new SQLiteStore(':memory:');
    try {
      const trigger = new GoogleChatEventTrigger(store);
      const invalidTypes = ['google.workspace.chat.message.v1.invalid', 'invalidType'];
      assert.throws(
        () => trigger.ingest({ id: 'missing-type', type: '', data: {} }, 'task-id'),
        /CloudEvent type or eventType is required/,
      );

      for (const type of invalidTypes) {
        assert.throws(() => {
          trigger.ingest(
            {
              id: 'evt-123',
              type,
              data: { resource: 'spaces/spaceA' },
            },
            'task-id',
          );
        }, /Unsupported or unknown event type/);
      }
    } finally {
      store.close();
    }
  });

  it('does not store external text content (message body) or token in the payload', () => {
    const store = new SQLiteStore(':memory:');
    try {
      const trigger = new GoogleChatEventTrigger(store);
      const envelope = {
        id: 'evt-text-omit',
        type: 'messageCreated',
        data: {
          message: {
            name: 'spaces/spaceA/messages/msgB',
            text: 'SECRET_TEXT_BODY',
            argumentText: 'ARGUMENT_TEXT',
            annotations: [{ type: 'USER_MENTION' }],
          },
          token: 'OAUTH_TOKEN_ABC',
        },
      };

      const event = trigger.ingest(envelope, 'task-id');
      assert.ok(event);
      const payloadStr = JSON.stringify(event.payload);
      assert.ok(!payloadStr.includes('SECRET_TEXT_BODY'));
      assert.ok(!payloadStr.includes('ARGUMENT_TEXT'));
      assert.ok(!payloadStr.includes('OAUTH_TOKEN_ABC'));
    } finally {
      store.close();
    }
  });

  it('deduplicates events via claimTriggerAndEnqueue and returns null on duplicates', () => {
    const clock = new FixedClock(new Date('2026-07-26T15:00:00.000Z'));
    const store = new SQLiteStore(':memory:', { clock });
    try {
      const trigger = new GoogleChatEventTrigger(store, clock);
      const envelope = {
        id: 'evt-dedupe-1',
        type: 'messageCreated',
        data: {
          message: {
            name: 'spaces/spaceA/messages/msgB',
          },
        },
      };

      const event1 = trigger.ingest(envelope, 'task-id');
      assert.ok(event1);

      const event2 = trigger.ingest(envelope, 'task-id');
      assert.equal(event2, null);
    } finally {
      store.close();
    }
  });

  it('allows retrying a failed event', () => {
    const clock = new FixedClock(new Date('2026-07-26T15:00:00.000Z'));
    const store = new SQLiteStore(':memory:', { clock });
    try {
      const trigger = new GoogleChatEventTrigger(store, clock);
      const envelope = {
        id: 'evt-retry-1',
        type: 'messageCreated',
        data: {
          message: {
            name: 'spaces/spaceA/messages/msgB',
          },
        },
      };

      const event = trigger.ingest(envelope, 'task-id');
      assert.ok(event);

      const claim = store.claimEvent(event.id, clock.now().toISOString());
      assert.ok(claim);
      assert.equal(store.failEvent(claim, 'temporary failure', clock.now().toISOString()), true);

      const eventRetry = trigger.ingest(envelope, 'task-id');
      assert.ok(eventRetry);
      assert.equal(eventRetry.id, event.id);
    } finally {
      store.close();
    }
  });
});
