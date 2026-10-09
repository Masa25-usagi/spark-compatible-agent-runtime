import type { AuditEvent, AuditEventInput, AuditVerification, JsonValue } from '../domain/types.js';
import { canonicalJson, sha256 } from '../domain/canonical.js';
import { createId } from '../shared/id.js';
import { redactSecrets } from '../security/redaction.js';
import { SQLiteStore } from '../storage/sqlite.js';
import type { Clock } from '../shared/clock.js';
import { systemClock } from '../shared/clock.js';

function hashableEvent(event: Omit<AuditEvent, 'eventHash'>): string {
  return canonicalJson(event);
}

function redactedString(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  return redactSecrets(value) as string;
}

export class AuditLog {
  public constructor(
    private readonly store: SQLiteStore,
    private readonly clock: Clock = systemClock,
  ) {}

  public append(input: AuditEventInput): AuditEvent {
    return this.store.withImmediateTransaction(() => {
      const previousHash = this.store.latestAuditHash();
      const eventWithoutHash: Omit<AuditEvent, 'eventHash'> = {
        id: input.id ?? createId('audit'),
        timestamp: input.timestamp ?? this.clock.now().toISOString(),
        taskId: input.taskId,
        agent: input.agent,
        model: input.model,
        harness: input.harness,
        tool: input.tool,
        args: redactSecrets(input.args),
        approval: input.approval === null ? null : redactSecrets(input.approval),
        decision: input.decision,
        result: input.result === null ? null : redactSecrets(input.result),
        changedTargets: redactSecrets(input.changedTargets) as string[],
        undoGuidance: redactedString(input.undoGuidance),
        previousHash,
      };
      const event: AuditEvent = {
        ...eventWithoutHash,
        eventHash: sha256(hashableEvent(eventWithoutHash)),
      };
      this.store.appendAuditEvent(event);
      return event;
    });
  }

  public list(): AuditEvent[] {
    return this.store.listAuditEvents();
  }

  public verify(): AuditVerification {
    const events = this.store.listAuditEvents();
    let expectedPreviousHash: string | null = null;
    for (const [index, event] of events.entries()) {
      const { eventHash: _eventHash, ...eventWithoutHash } = event;
      if (event.previousHash !== expectedPreviousHash) {
        return {
          valid: false,
          eventCount: events.length,
          firstInvalidSequence: index + 1,
          reason: 'Previous hash linkage is broken.',
        };
      }
      const expectedHash = sha256(hashableEvent(eventWithoutHash));
      if (event.eventHash !== expectedHash) {
        return {
          valid: false,
          eventCount: events.length,
          firstInvalidSequence: index + 1,
          reason: 'Event hash does not match the persisted event contents.',
        };
      }
      expectedPreviousHash = event.eventHash;
    }

    return {
      valid: true,
      eventCount: events.length,
      firstInvalidSequence: null,
      reason: null,
    };
  }
}

export function auditJson(value: JsonValue): JsonValue {
  return redactSecrets(value);
}
