import type { JsonObject, JsonValue, RuntimeEvent } from '../domain/types.js';
import type { Clock } from '../shared/clock.js';
import { systemClock } from '../shared/clock.js';
import { createId } from '../shared/id.js';
import { SQLiteStore } from '../storage/sqlite.js';

export type GmailPubSubEnvelope = {
  message: {
    data: string;
    messageId: string;
    publishTime?: string;
  };
  subscription?: string;
};

export type GmailNotification = {
  emailAddress: string;
  historyId: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseEnvelope(value: unknown): GmailPubSubEnvelope {
  if (!isRecord(value) || !isRecord(value.message)) {
    throw new Error('Gmail Pub/Sub envelope must contain a message');
  }
  const message = value.message;
  if (typeof message.data !== 'string' || typeof message.messageId !== 'string') {
    throw new Error('Gmail Pub/Sub message must contain data and messageId strings');
  }
  if (message.messageId.trim().length === 0) throw new Error('Gmail messageId is required');
  return {
    message: {
      data: message.data,
      messageId: message.messageId,
      ...(typeof message.publishTime === 'string' ? { publishTime: message.publishTime } : {}),
    },
    ...(typeof value.subscription === 'string' ? { subscription: value.subscription } : {}),
  };
}

function decodeNotification(data: string): GmailNotification {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
  } catch {
    throw new Error('Gmail Pub/Sub data is not valid base64 JSON');
  }
  if (!isRecord(value) || typeof value.emailAddress !== 'string') {
    throw new Error('Gmail notification must contain emailAddress and historyId');
  }
  const { historyId } = value;
  if (typeof historyId === 'string') {
    return { emailAddress: value.emailAddress, historyId };
  }
  if (typeof historyId === 'number' && Number.isSafeInteger(historyId) && historyId >= 0) {
    return { emailAddress: value.emailAddress, historyId: String(historyId) };
  }
  throw new Error('Gmail notification must contain emailAddress and historyId');
}

export class GmailEventTrigger {
  public constructor(
    private readonly store: SQLiteStore,
    private readonly clock: Clock = systemClock,
  ) {}

  public ingest(envelopeValue: unknown, workflow: JsonObject): RuntimeEvent | null {
    const envelope = parseEnvelope(envelopeValue);
    const notification = decodeNotification(envelope.message.data);
    const occurredAt = this.clock.now().toISOString();
    const stored: JsonObject = {
      messageId: envelope.message.messageId,
      emailAddress: notification.emailAddress,
      historyId: notification.historyId,
      publishTime: envelope.message.publishTime ?? null,
    };
    const payload: JsonObject = {
      ...workflow,
      gmail: stored,
    };
    const event: RuntimeEvent = {
      id: createId('event'),
      taskId: `gmail:${notification.emailAddress}`,
      kind: 'gmail.event',
      payload,
      occurredAt,
    };
    if (this.store.claimTriggerAndEnqueue('gmail', envelope.message.messageId, stored, event)) {
      return event;
    }
    const existing = this.store.getTriggerEvent('gmail', envelope.message.messageId);
    if (existing === null) return null;
    return this.store.listPendingEvents(occurredAt).some((event) => event.id === existing.id)
      ? existing
      : null;
  }
}

export function encodeGmailNotification(notification: GmailNotification): string {
  const value: JsonValue = notification;
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}
