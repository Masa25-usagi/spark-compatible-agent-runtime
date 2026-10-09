import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { jsonResponse } from '../utils.js';

let serverToken = '';
let serverTokenBuf: Buffer = Buffer.alloc(0);

export function initAuthToken(): string {
  serverToken = randomBytes(32).toString('hex');
  serverTokenBuf = Buffer.from(serverToken, 'utf8');
  return serverToken;
}

export function getAuthToken(): string {
  return serverToken;
}

export async function authMiddleware(
  req: IncomingMessage,
  res: ServerResponse,
  next: () => Promise<void>,
): Promise<void> {
  const authHeader = req.headers['authorization'];
  if (authHeader === undefined || !authHeader.startsWith('Bearer ')) {
    jsonResponse(res, 401, { error: 'Unauthorized: Bearer token required' });
    return;
  }
  const provided = Buffer.from(authHeader.slice(7), 'utf8');
  // Use timingSafeEqual to prevent timing attacks; pad if lengths differ.
  const expected = serverTokenBuf;
  const match = provided.length === expected.length && timingSafeEqual(provided, expected);
  if (!match) {
    jsonResponse(res, 403, { error: 'Forbidden: Invalid token' });
    return;
  }
  return next();
}
