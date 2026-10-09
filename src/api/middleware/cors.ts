import type { IncomingMessage, ServerResponse } from 'node:http';

const ALLOWED_ORIGIN_RE = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/u;

export async function corsMiddleware(
  req: IncomingMessage,
  res: ServerResponse,
  next: () => Promise<void>,
): Promise<void> {
  const origin = req.headers.origin ?? '';
  if (ALLOWED_ORIGIN_RE.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Spark-CSRF');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  return next();
}
