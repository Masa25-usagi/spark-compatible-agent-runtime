import type { IncomingMessage, ServerResponse } from 'node:http';
import { jsonResponse } from '../utils.js';

export async function withErrorHandler(
  _req: IncomingMessage,
  res: ServerResponse,
  handler: () => Promise<void>,
): Promise<void> {
  try {
    await handler();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (!res.headersSent) {
      jsonResponse(res, 500, { error: 'Internal Server Error', message });
    }
  }
}
