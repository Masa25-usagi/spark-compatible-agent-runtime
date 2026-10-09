import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import { ConnectorRegistry } from '../runtime/registries.js';
import { LocalFileConnector } from './local-files.js';
import { McpConnector } from './mcp-connector.js';
import { ACTION_OPERATIONS, type ActionOperation } from '../domain/types.js';

type LocalFilesEntry = {
  kind: 'local-files';
  root: string;
  maxReadBytes?: number;
};

type McpEntry = {
  kind: 'mcp-stdio';
  name: string;
  command: string;
  args?: string[];
  cwd?: string;
  envKeys?: string[];
  allowedTools: string[];
  toolMap: Record<string, { tool: string; operations: ActionOperation[] }>;
  timeoutMs?: number;
  maxMessageBytes?: number;
};

export type RuntimeConnectorsConfig = {
  version: 1;
  connectors: Array<LocalFilesEntry | McpEntry>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${field} must be an array of strings`);
  }
  return value;
}

function optionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value as number;
}

function parseEntry(value: unknown, index: number): LocalFilesEntry | McpEntry {
  if (!isRecord(value)) throw new Error(`connectors[${index}] must be an object`);
  if (value.kind === 'local-files') {
    if (typeof value.root !== 'string' || !isAbsolute(value.root)) {
      throw new Error(`connectors[${index}].root must be an absolute path`);
    }
    return {
      kind: 'local-files',
      root: value.root,
      ...(value.maxReadBytes === undefined
        ? {}
        : { maxReadBytes: optionalPositiveInteger(value.maxReadBytes, 'maxReadBytes') }),
    };
  }
  if (value.kind !== 'mcp-stdio') throw new Error(`connectors[${index}].kind is unsupported`);
  if (typeof value.name !== 'string' || value.name.trim().length === 0) {
    throw new Error(`connectors[${index}].name is required`);
  }
  if (typeof value.command !== 'string' || !isAbsolute(value.command)) {
    throw new Error(`connectors[${index}].command must be an absolute path`);
  }
  if (
    !isRecord(value.toolMap) ||
    Object.keys(value.toolMap).length === 0 ||
    Object.keys(value.toolMap).some((key) => key.trim().length === 0) ||
    !Object.values(value.toolMap).every((route) => {
      if (!isRecord(route) || typeof route.tool !== 'string' || route.tool.trim().length === 0) {
        return false;
      }
      return (
        Array.isArray(route.operations) &&
        route.operations.length > 0 &&
        route.operations.every(
          (operation) =>
            typeof operation === 'string' &&
            ACTION_OPERATIONS.includes(operation as ActionOperation),
        )
      );
    })
  ) {
    throw new Error(`connectors[${index}].toolMap must map strings to strings`);
  }
  if (value.cwd !== undefined && (typeof value.cwd !== 'string' || !isAbsolute(value.cwd))) {
    throw new Error(`connectors[${index}].cwd must be an absolute path`);
  }
  return {
    kind: 'mcp-stdio',
    name: value.name,
    command: value.command,
    args: value.args === undefined ? undefined : stringArray(value.args, 'args'),
    cwd: value.cwd as string | undefined,
    envKeys: value.envKeys === undefined ? undefined : stringArray(value.envKeys, 'envKeys'),
    allowedTools: stringArray(value.allowedTools, 'allowedTools'),
    toolMap: value.toolMap as Record<string, { tool: string; operations: ActionOperation[] }>,
    timeoutMs: optionalPositiveInteger(value.timeoutMs, 'timeoutMs'),
    maxMessageBytes: optionalPositiveInteger(value.maxMessageBytes, 'maxMessageBytes'),
  };
}

export function parseConnectorsConfig(value: unknown): RuntimeConnectorsConfig {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.connectors)) {
    throw new Error('Connector config must have version 1 and a connectors array');
  }
  return { version: 1, connectors: value.connectors.map(parseEntry) };
}

export function loadConnectorRegistry(path: string): ConnectorRegistry {
  const config = parseConnectorsConfig(JSON.parse(readFileSync(path, 'utf8')));
  const registry = new ConnectorRegistry();
  for (const entry of config.connectors) {
    if (entry.kind === 'local-files') {
      registry.register(new LocalFileConnector(entry.root, { maxReadBytes: entry.maxReadBytes }));
      continue;
    }
    const env: Record<string, string> = {};
    for (const key of entry.envKeys ?? []) {
      const value = process.env[key];
      if (value === undefined)
        throw new Error(`Required connector environment variable ${key} is unset`);
      env[key] = value;
    }
    registry.register(
      new McpConnector({
        name: entry.name,
        server: {
          command: entry.command,
          args: entry.args,
          cwd: entry.cwd,
          env,
          allowedTools: entry.allowedTools,
          timeoutMs: entry.timeoutMs,
          maxMessageBytes: entry.maxMessageBytes,
        },
        toolMap: entry.toolMap,
      }),
    );
  }
  return registry;
}
