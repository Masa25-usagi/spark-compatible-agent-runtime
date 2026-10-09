import { spawnSync } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  ActionOperation,
  ActionSpec,
  ConnectorResult,
  JsonObject,
  JsonValue,
} from '../domain/types.js';
import type { Connector } from '../runtime/registries.js';
import type { McpStdioConfig, McpToolResult } from './mcp-stdio.js';

export type McpToolRoute = {
  tool: string;
  operations: readonly ActionOperation[];
};

export type McpToolMap = Readonly<Record<string, McpToolRoute>>;

export type McpConnectorConfig = {
  name: string;
  server: McpStdioConfig;
  toolMap: McpToolMap;
  maxOutputBytes?: number;
};

type RunnerResponse = { ok: true; result: McpToolResult } | { ok: false; error: string };

const MUTATING_OPERATIONS = new Set<ActionOperation>([
  'send_email',
  'send_message',
  'publish_post',
  'edit_data',
  'delete_to_trash',
  'delete_permanently',
  'submit_form',
  'purchase',
  'contract',
  'charge',
  'edit_shared_document',
  'transmit_sensitive',
  'shell',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function argumentsFor(action: ActionSpec): JsonObject {
  if (action.payload !== undefined && isRecord(action.payload)) return action.payload as JsonObject;
  const result: JsonObject = { target: action.target };
  if (action.payload !== undefined) result.payload = action.payload;
  if (action.before !== undefined) result.before = action.before;
  if (action.after !== undefined) result.after = action.after;
  if (action.itemCount !== undefined) result.itemCount = action.itemCount;
  if (action.dataSizeBytes !== undefined) result.dataSizeBytes = action.dataSizeBytes;
  if (action.recipient !== undefined) result.recipient = action.recipient;
  if (action.amount !== undefined) result.amount = action.amount;
  return result;
}

function parseRunnerResponse(stdout: string): RunnerResponse {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim());
  } catch {
    throw new Error('MCP runner returned invalid JSON');
  }
  if (!isRecord(value) || typeof value.ok !== 'boolean') {
    throw new Error('MCP runner returned an invalid envelope');
  }
  if (value.ok === false) {
    if (typeof value.error !== 'string') throw new Error('MCP runner omitted its error');
    return { ok: false, error: value.error };
  }
  if (!isRecord(value.result) || !Array.isArray(value.result.content)) {
    throw new Error('MCP runner omitted its tool result');
  }
  return { ok: true, result: value.result as McpToolResult };
}

function summary(result: McpToolResult, tool: string): string {
  for (const item of result.content) {
    if (isRecord(item) && item.type === 'text' && typeof item.text === 'string') {
      return item.text.slice(0, 1_000);
    }
  }
  return `MCP tool ${tool} completed.`;
}

export class McpConnector implements Connector {
  public readonly name: string;
  private readonly maxOutputBytes: number;

  public constructor(private readonly config: McpConnectorConfig) {
    if (config.name.trim().length === 0) throw new Error('MCP connector name is required');
    if (!isAbsolute(config.server.command)) {
      throw new Error('MCP server command must be an absolute path');
    }
    this.name = config.name;
    this.maxOutputBytes = config.maxOutputBytes ?? 4_194_304;
  }

  public execute(action: ActionSpec): ConnectorResult {
    const route = this.config.toolMap[action.tool];
    if (route === undefined) {
      throw new Error(`No MCP tool mapping exists for ${action.tool}`);
    }
    if (!route.operations.includes(action.operation)) {
      throw new Error(
        `MCP tool ${action.tool} does not permit declared operation ${action.operation}`,
      );
    }
    const tool = route.tool;
    if (!this.config.server.allowedTools.includes(tool)) {
      throw new Error(`Mapped MCP tool ${tool} is not allowlisted`);
    }

    const runner = fileURLToPath(new URL('./mcp-runner.js', import.meta.url));
    const child = spawnSync(process.execPath, [runner], {
      input: JSON.stringify({
        config: this.config.server,
        tool,
        arguments: argumentsFor(action),
      }),
      encoding: 'utf8',
      timeout: (this.config.server.timeoutMs ?? 30_000) + 5_000,
      maxBuffer: this.maxOutputBytes,
      shell: false,
      env: process.env,
    });
    if (child.error !== undefined) throw child.error;
    const response = parseRunnerResponse(child.stdout);
    if (!response.ok) throw new Error(response.error);
    const result = response.result;
    const changed = MUTATING_OPERATIONS.has(action.operation)
      ? [`${this.name}:${JSON.stringify(action.target)}`]
      : [];
    const output: JsonValue = result.structuredContent ?? result.content;
    return {
      success: !result.isError,
      simulated: false,
      summary: summary(result, tool),
      changedTargets: changed,
      undoGuidance: changed.length === 0 ? null : (action.undoMethod ?? null),
      output,
    };
  }
}
