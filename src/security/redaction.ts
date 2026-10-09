import type { JsonObject, JsonValue } from '../domain/types.js';

const SENSITIVE_KEY_PATTERN =
  /(?:password|passphrase|secret|token|api[._-]?key|authorization|cookie|credential|private[._-]?key|client[._-]?secret|card[._-]?(?:number|pan)|cvv|cvc|security[._-]?code|otp|one[._-]?time[._-]?pass|2fa|captcha|payment[._-]?(?:data|details?))/i;

const INLINE_SECRET_PATTERNS = [
  /bearer\s+[a-z0-9._~+/=-]+/gi,
  /(?:sk|pk)_(?:live|test)_[a-z0-9]+/gi,
  /AKIA[0-9A-Z]{12,}/g,
  /-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g,
];

const SECRET_MATERIAL_PATTERN =
  /(?:bearer\s+[a-z0-9._~+/=-]+|(?:sk|pk)_(?:live|test)_[a-z0-9]+|AKIA[0-9A-Z]{12,}|-----BEGIN [^-]+ PRIVATE KEY-----)/i;

function redactString(value: string): string {
  return INLINE_SECRET_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, '[REDACTED]'),
    value,
  );
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

export function containsSecretMaterial(value: JsonValue): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsSecretMaterial(item));
  }

  if (value !== null && typeof value === 'object') {
    return Object.entries(value).some(
      ([key, child]) => isSensitiveKey(key) || containsSecretMaterial(child),
    );
  }

  return typeof value === 'string' && SECRET_MATERIAL_PATTERN.test(value);
}

export function redactSecrets(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item));
  }

  if (value !== null && typeof value === 'object') {
    const redacted: JsonObject = {};
    for (const [key, child] of Object.entries(value)) {
      redacted[key] = isSensitiveKey(key) ? '[REDACTED]' : redactSecrets(child);
    }
    return redacted;
  }

  return typeof value === 'string' ? redactString(value) : value;
}

export function safeSummary(value: JsonValue | undefined): string {
  if (value === undefined) {
    return '(not provided)';
  }

  const redacted = redactSecrets(value);
  const encoded = JSON.stringify(redacted);
  return encoded === undefined ? '(unavailable)' : encoded;
}
