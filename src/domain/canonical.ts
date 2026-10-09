import { createHash } from 'node:crypto';

import type { ActionSpec } from './types.js';

function normalizeForCanonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeForCanonicalJson(item));
  }

  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(object).sort()) {
      const child = object[key];
      if (child !== undefined) {
        normalized[key] = normalizeForCanonicalJson(child);
      }
    }
    return normalized;
  }

  return value;
}

export function canonicalJson(value: unknown): string {
  const encoded = JSON.stringify(normalizeForCanonicalJson(value));
  if (encoded === undefined) {
    throw new Error('Value cannot be represented as canonical JSON');
  }
  return encoded;
}

export function actionDigest(action: ActionSpec): string {
  return createHash('sha256').update(canonicalJson(action), 'utf8').digest('hex');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
