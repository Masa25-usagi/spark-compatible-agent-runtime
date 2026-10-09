import type { IncomingMessage, ServerResponse } from 'node:http';

export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
) => Promise<void>;

export type Route = {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
};

export type ApiServerOptions = {
  port?: number;
  host?: string;
  webRoot?: string;
};
