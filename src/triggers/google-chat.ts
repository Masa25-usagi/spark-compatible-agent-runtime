import type { JsonObject, RuntimeEvent } from '../domain/types.js';
import type { Clock } from '../shared/clock.js';
import { systemClock } from '../shared/clock.js';
import { createId } from '../shared/id.js';
import { SQLiteStore } from '../storage/sqlite.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const SUPPORTED_EVENT_TYPES = [
  'messageCreated',
  'messageUpdated',
  'messageDeleted',
  'spaceUpdated',
  'membershipUpdated',
] as const;

type SupportedEventType = (typeof SUPPORTED_EVENT_TYPES)[number];

const EVENT_TYPE_MAPPING: Record<string, SupportedEventType> = {
  'google.workspace.chat.message.v1.created': 'messageCreated',
  'google.workspace.chat.message.v1.updated': 'messageUpdated',
  'google.workspace.chat.message.v1.deleted': 'messageDeleted',
  'google.workspace.chat.space.v1.updated': 'spaceUpdated',
  'google.workspace.chat.membership.v1.updated': 'membershipUpdated',
  messageCreated: 'messageCreated',
  messageUpdated: 'messageUpdated',
  messageDeleted: 'messageDeleted',
  spaceUpdated: 'spaceUpdated',
  membershipUpdated: 'membershipUpdated',
};

export class GoogleChatEventTrigger {
  public constructor(
    private readonly store: SQLiteStore,
    private readonly clock: Clock = systemClock,
  ) {}

  public ingest(
    envelopeValue: unknown,
    taskId: string,
    workflow: JsonObject = {},
  ): RuntimeEvent | null {
    if (!isRecord(envelopeValue)) {
      throw new Error('CloudEvent envelope must be an object');
    }

    const { id } = envelopeValue;
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new Error('CloudEvent id is required and cannot be empty');
    }

    const { data } = envelopeValue;
    if (data === undefined || data === null) {
      throw new Error('CloudEvent data is required');
    }
    if (!isRecord(data)) {
      throw new Error('CloudEvent data must be an object');
    }

    const inputType = envelopeValue.eventType || envelopeValue.type;
    if (typeof inputType !== 'string' || inputType.trim().length === 0) {
      throw new Error('CloudEvent type or eventType is required');
    }

    const normalizedEventType = EVENT_TYPE_MAPPING[inputType];
    if (!normalizedEventType) {
      throw new Error(`Unsupported or unknown event type: ${inputType}`);
    }

    if (typeof taskId !== 'string' || taskId.trim().length === 0) {
      throw new Error('taskId is required and cannot be empty');
    }

    // Extract and normalize resource name
    let resourceName: string | null = null;
    if (isRecord(data.message) && typeof data.message.name === 'string') {
      resourceName = data.message.name.trim();
    } else if (isRecord(data.membership) && typeof data.membership.name === 'string') {
      resourceName = data.membership.name.trim();
    } else if (isRecord(data.space) && typeof data.space.name === 'string') {
      resourceName = data.space.name.trim();
    } else if (typeof data.resource === 'string') {
      resourceName = data.resource.trim();
    }

    const resource = resourceName || null;
    const dedupeKey = resource ? `${resource}:${id}` : id;

    // Generate RuntimeEvent and safe payload
    const occurredAt = this.clock.now().toISOString();

    const messageName =
      isRecord(data.message) && typeof data.message.name === 'string'
        ? data.message.name.trim()
        : null;

    const spaceName =
      isRecord(data.space) && typeof data.space.name === 'string'
        ? data.space.name.trim()
        : isRecord(data.message) &&
            isRecord(data.message.space) &&
            typeof data.message.space.name === 'string'
          ? data.message.space.name.trim()
          : null;

    const source = typeof envelopeValue.source === 'string' ? envelopeValue.source.trim() : null;

    // Stored payload in SQLite without any external text content or token
    const storedPayload: JsonObject = {
      eventType: normalizedEventType,
      resource,
      messageName,
      spaceName,
      source,
      eventId: id,
    };

    const payload: JsonObject = {
      ...workflow,
      ...storedPayload,
    };

    const event: RuntimeEvent = {
      id: createId('event'),
      taskId,
      kind: `google-chat.${normalizedEventType}`,
      payload,
      occurredAt,
    };

    if (this.store.claimTriggerAndEnqueue('google-chat', dedupeKey, storedPayload, event)) {
      return event;
    }

    const existing = this.store.getTriggerEvent('google-chat', dedupeKey);
    if (existing === null) return null;

    return this.store.eventQueueStatus(existing.id) === 'failed' ? existing : null;
  }
}
