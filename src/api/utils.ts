import type { IncomingMessage, ServerResponse } from 'node:http';

export async function readJsonBody<T>(req: IncomingMessage, maxBytes = 65536): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += value.length;
    if (size > maxBytes) throw new Error('Payload too large');
    chunks.push(value);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.length === 0) return {} as T;
  return JSON.parse(text) as T;
}

export function jsonResponse(res: ServerResponse, status: number, data: unknown): void {
  if (!res.headersSent) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  }
}
