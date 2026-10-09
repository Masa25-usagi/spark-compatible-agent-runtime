import { readFileSync } from 'node:fs';

import type { JsonObject } from '../domain/types.js';
import { McpStdioClient, type McpStdioConfig } from './mcp-stdio.js';

type RunnerRequest = {
  config: McpStdioConfig;
  tool: string;
  arguments: JsonObject;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseRequest(value: unknown): RunnerRequest {
  if (!isRecord(value) || !isRecord(value.config) || typeof value.tool !== 'string') {
    throw new Error('Invalid MCP runner request');
  }
  if (!isRecord(value.arguments)) throw new Error('MCP runner arguments must be an object');
  return value as RunnerRequest;
}

async function main(): Promise<void> {
  const request = parseRequest(JSON.parse(readFileSync(0, 'utf8')));
  const client = new McpStdioClient(request.config);
  try {
    await client.start();
    const tools = await client.listTools();
    if (!tools.some((tool) => tool.name === request.tool)) {
      throw new Error(`MCP server does not advertise tool ${request.tool}`);
    }
    const result = await client.callTool(request.tool, request.arguments);
    process.stdout.write(JSON.stringify({ ok: true, result }) + '\n');
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(JSON.stringify({ ok: false, error: message }) + '\n');
  process.exitCode = 1;
});
