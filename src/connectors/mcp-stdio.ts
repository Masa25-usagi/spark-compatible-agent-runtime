import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import type { JsonObject, JsonValue } from '../domain/types.js';

export const MCP_PROTOCOL_VERSION = '2025-11-25' as const;
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  '2024-11-05',
  '2025-03-26',
  '2025-06-18',
  MCP_PROTOCOL_VERSION,
]);

export type McpStdioConfig = {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  allowedTools: string[];
  timeoutMs?: number;
  maxMessageBytes?: number;
};

export type McpToolDefinition = {
  name: string;
  description?: string;
  inputSchema: JsonObject;
};

export type McpToolResult = {
  content: JsonValue[];
  structuredContent?: JsonObject;
  isError: boolean;
};

type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function asObject(value: unknown, context: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${context} must be a JSON object`);
  return value;
}

function parseToolResult(value: unknown): McpToolResult {
  const result = asObject(value, 'MCP tool result');
  const content = result.content;
  if (!Array.isArray(content) || !content.every(isJsonValue)) {
    throw new Error('MCP tool result content must be a JSON array');
  }
  const structured = result.structuredContent;
  if (structured !== undefined && !isRecord(structured)) {
    throw new Error('MCP structuredContent must be a JSON object');
  }
  return {
    content,
    ...(structured === undefined ? {} : { structuredContent: structured as JsonObject }),
    isError: result.isError === true,
  };
}

/** Minimal MCP stdio client. It never invokes a tool outside the configured allowlist. */
export class McpStdioClient {
  private process: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private stdoutBuffer = '';
  private stderrTail = '';
  private readonly pending = new Map<number, PendingRequest>();
  private initialized = false;
  private closing = false;
  private readonly allowedTools: ReadonlySet<string>;
  private readonly timeoutMs: number;
  private readonly maxMessageBytes: number;

  public constructor(private readonly config: McpStdioConfig) {
    if (config.command.trim().length === 0) throw new Error('MCP command is required');
    if (config.allowedTools.length === 0) throw new Error('At least one MCP tool must be allowed');
    this.allowedTools = new Set(config.allowedTools);
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.maxMessageBytes = config.maxMessageBytes ?? 4_194_304;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error('MCP timeout must be a positive integer');
    }
    if (!Number.isInteger(this.maxMessageBytes) || this.maxMessageBytes <= 0) {
      throw new Error('MCP message limit must be a positive integer');
    }
  }

  public async start(): Promise<void> {
    if (this.initialized) return;
    if (this.process !== null) throw new Error('MCP client is already starting');

    const child = spawn(this.config.command, [...(this.config.args ?? [])], {
      cwd: this.config.cwd,
      env: { ...(this.config.env ?? {}) },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.process = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.consumeStdout(chunk));
    child.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4_096);
    });
    child.once('error', (error) => {
      this.failAll(error);
      this.process = null;
      this.initialized = false;
    });
    child.once('exit', (code, signal) => {
      if (!this.closing) {
        this.failAll(
          new Error(
            `MCP server exited before close (code=${String(code)}, signal=${String(signal)})${
              this.stderrTail.length === 0 ? '' : `: ${this.stderrTail.trim()}`
            }`,
          ),
        );
      }
      this.process = null;
      this.initialized = false;
    });

    const response = asObject(
      await this.request('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'spark-compatible-agent-runtime', version: '0.2.0' },
      }),
      'MCP initialize result',
    );
    if (
      typeof response.protocolVersion !== 'string' ||
      !SUPPORTED_PROTOCOL_VERSIONS.has(response.protocolVersion)
    ) {
      await this.close();
      throw new Error('MCP server returned an unsupported protocol version');
    }
    this.notify('notifications/initialized', {});
    this.initialized = true;
  }

  public async listTools(): Promise<McpToolDefinition[]> {
    this.assertInitialized();
    const result = asObject(await this.request('tools/list', {}), 'MCP tools/list result');
    if (!Array.isArray(result.tools)) throw new Error('MCP tools/list result omitted tools');
    return result.tools.map((value) => {
      const tool = asObject(value, 'MCP tool definition');
      if (typeof tool.name !== 'string' || !isRecord(tool.inputSchema)) {
        throw new Error('MCP tool definition is invalid');
      }
      return {
        name: tool.name,
        ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
        inputSchema: tool.inputSchema as JsonObject,
      };
    });
  }

  public async callTool(name: string, argumentsObject: JsonObject): Promise<McpToolResult> {
    this.assertInitialized();
    if (!this.allowedTools.has(name)) throw new Error(`MCP tool ${name} is not allowlisted`);
    return parseToolResult(await this.request('tools/call', { name, arguments: argumentsObject }));
  }

  public async close(): Promise<void> {
    const child = this.process;
    if (child === null) return;
    this.closing = true;
    this.failAll(new Error('MCP client closed'));
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      const force = setTimeout(() => child.kill('SIGKILL'), 1_000);
      child.once('exit', () => {
        clearTimeout(force);
        resolve();
      });
    });
    this.process = null;
    this.initialized = false;
    this.closing = false;
  }

  private assertInitialized(): void {
    if (!this.initialized || this.process === null)
      throw new Error('MCP client is not initialized');
  }

  private request(method: string, params: JsonObject): Promise<unknown> {
    const child = this.process;
    if (child === null) return Promise.reject(new Error('MCP server is not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request ${method} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      const message = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      child.stdin.write(message + '\n', (error) => {
        if (error === null || error === undefined) return;
        const pending = this.pending.get(id);
        if (pending === undefined) return;
        clearTimeout(pending.timeout);
        this.pending.delete(id);
        pending.reject(error);
      });
    });
  }

  private notify(method: string, params: JsonObject): void {
    const child = this.process;
    if (child === null) throw new Error('MCP server is not running');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    if (Buffer.byteLength(this.stdoutBuffer, 'utf8') > this.maxMessageBytes) {
      this.failAll(new Error('MCP server stdout message exceeded the configured limit'));
      this.process?.kill('SIGTERM');
      return;
    }
    for (;;) {
      const newline = this.stdoutBuffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.length === 0) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        this.failAll(new Error('MCP server wrote non-JSON data to stdout'));
        return;
      }
      if (
        !isRecord(value) ||
        value.jsonrpc !== '2.0' ||
        typeof value.id !== 'number' ||
        !Number.isInteger(value.id)
      )
        continue;
      const response = value as JsonRpcResponse;
      const pending = this.pending.get(response.id);
      if (pending === undefined) continue;
      clearTimeout(pending.timeout);
      this.pending.delete(response.id);
      if (response.error !== undefined) {
        pending.reject(new Error(`MCP error ${response.error.code}: ${response.error.message}`));
      } else {
        pending.resolve(response.result);
      }
    }
  }

  private failAll(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    this.pending.clear();
  }
}
