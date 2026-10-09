import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
  linkSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import { actionDigest, canonicalJson, sha256 } from '../domain/canonical.js';
import type { ActionSpec, JsonValue, TaskRecord } from '../domain/types.js';
import { containsSecretMaterial, redactSecrets } from '../security/redaction.js';

export const HANDOFF_PROTOCOL = 'spark-runtime-handoff-v1' as const;
export const HANDOFF_REQUEST_KIND = 'handoff_request' as const;
export const HANDOFF_RESPONSE_KIND = 'handoff_response' as const;

type HandoffTaskSnapshot = Pick<
  TaskRecord,
  | 'id'
  | 'title'
  | 'status'
  | 'profile'
  | 'agent'
  | 'model'
  | 'harness'
  | 'currentStep'
  | 'plannedSteps'
  | 'pendingSteps'
> & {
  instruction?: string | null;
};

export type HandoffAction = {
  action: ActionSpec;
  actionDigest: string;
};

export type AntigravityHandoffRequest = {
  protocol: typeof HANDOFF_PROTOCOL;
  kind: typeof HANDOFF_REQUEST_KIND;
  requestId: string;
  createdAt: string;
  task: HandoffTaskSnapshot;
  prompt: string;
  actions: HandoffAction[];
};

export type HandoffResponseStatus = 'accepted' | 'completed' | 'needs_user' | 'rejected';

export type AntigravityHandoffResponse = {
  protocol: typeof HANDOFF_PROTOCOL;
  kind: typeof HANDOFF_RESPONSE_KIND;
  requestId: string;
  taskId: string;
  receivedAt: string;
  status: HandoffResponseStatus;
  summary: string;
  output: JsonValue | null;
  error: string | null;
};

export type HandoffRequestInput = {
  task: HandoffTaskSnapshot;
  prompt: string;
  actions?: ActionSpec[];
  requestId?: string;
  createdAt?: string;
};

export type HandoffReceipt = {
  requestId: string;
  requestDigest: string;
  transport: 'file' | 'stdio';
  requestPath: string | null;
};

export interface AntigravityAdapter {
  readonly name: 'antigravity-file' | 'antigravity-stdio';
  send(request: AntigravityHandoffRequest): Promise<HandoffReceipt>;
  readResponse(requestId: string): Promise<AntigravityHandoffResponse | null>;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]+$/u;

function asJsonValue(value: unknown): JsonValue {
  return value as JsonValue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item));
  }
  if (isRecord(value)) {
    return Object.values(value).every((item) => isJsonValue(item));
  }
  return false;
}

function safeRedactedString(value: string): string {
  return redactSecrets(value) as string;
}

function assertRequestId(requestId: string): void {
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    throw new Error(
      'Handoff request IDs may contain only letters, numbers, underscores, and hyphens',
    );
  }
}

function assertSafeRequest(request: AntigravityHandoffRequest): void {
  if (request.protocol !== HANDOFF_PROTOCOL || request.kind !== HANDOFF_REQUEST_KIND) {
    throw new Error('Unsupported handoff request envelope');
  }
  assertRequestId(request.requestId);
  if (request.prompt.trim().length === 0) {
    throw new Error('Handoff prompt must not be empty');
  }
  if (!containsSecretMaterial(asJsonValue(request))) {
    for (const item of request.actions) {
      const expectedDigest = actionDigest(item.action);
      if (item.actionDigest !== expectedDigest) {
        throw new Error(
          'Action ' + item.action.id + ' changed after its handoff digest was created',
        );
      }
    }
    if (JSON.stringify(request) === undefined) {
      throw new Error('Handoff request cannot be represented as JSON');
    }
    return;
  }
  throw new Error('Secret material cannot cross the Antigravity handoff boundary');
}

function parseResponse(value: unknown): AntigravityHandoffResponse {
  if (!isRecord(value)) {
    throw new Error('Handoff response must be a JSON object');
  }
  if (value.protocol !== HANDOFF_PROTOCOL || value.kind !== HANDOFF_RESPONSE_KIND) {
    throw new Error('Unsupported handoff response envelope');
  }

  const requestId = value.requestId;
  const taskId = value.taskId;
  const receivedAt = value.receivedAt;
  const status = value.status;
  const summary = value.summary;
  const output = value.output;
  const error = value.error;

  if (
    typeof requestId !== 'string' ||
    typeof taskId !== 'string' ||
    typeof receivedAt !== 'string' ||
    typeof summary !== 'string' ||
    !isJsonValue(output) ||
    (error !== null && typeof error !== 'string') ||
    (status !== 'accepted' &&
      status !== 'completed' &&
      status !== 'needs_user' &&
      status !== 'rejected')
  ) {
    throw new Error('Handoff response fields are invalid');
  }
  assertRequestId(requestId);

  return {
    protocol: HANDOFF_PROTOCOL,
    kind: HANDOFF_RESPONSE_KIND,
    requestId,
    taskId,
    receivedAt,
    status,
    summary: safeRedactedString(summary),
    output: redactSecrets(output),
    error: error === null ? null : safeRedactedString(error),
  };
}

function requestDigest(request: AntigravityHandoffRequest): string {
  return sha256(canonicalJson(request));
}

export function createHandoffRequest(
  input: HandoffRequestInput,
  now: Date = new Date(),
): AntigravityHandoffRequest {
  if (input.prompt.trim().length === 0) {
    throw new Error('Handoff prompt must not be empty');
  }

  const request: AntigravityHandoffRequest = {
    protocol: HANDOFF_PROTOCOL,
    kind: HANDOFF_REQUEST_KIND,
    requestId: input.requestId ?? 'handoff_' + randomUUID(),
    createdAt: input.createdAt ?? now.toISOString(),
    task: {
      ...input.task,
      plannedSteps: [...input.task.plannedSteps],
      pendingSteps: [...input.task.pendingSteps],
    },
    prompt: input.prompt,
    actions: (input.actions ?? []).map((action) => ({
      action,
      actionDigest: actionDigest(action),
    })),
  };
  assertSafeRequest(request);
  return request;
}

function ensureDirectory(directory: string): string {
  const root = resolve(directory);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!lstatSync(root).isDirectory()) {
    throw new Error('Handoff path is not a directory: ' + root);
  }
  return root;
}

function safePath(directory: string, kind: 'request' | 'response', requestId: string): string {
  assertRequestId(requestId);
  const root = resolve(directory);
  const path = resolve(root, kind + '-' + requestId + '.json');
  const relativePath = relative(root, path);
  if (
    relativePath.length === 0 ||
    relativePath === '..' ||
    relativePath.startsWith('..' + '/') ||
    isAbsolute(relativePath)
  ) {
    throw new Error('Handoff file path escaped the configured directory');
  }
  return path;
}

function writeJsonExclusively(path: string, value: unknown): void {
  const temporaryPath = path + '.tmp-' + randomUUID();
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new Error('Handoff value cannot be represented as JSON');
  }

  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    const bytes = Buffer.from(encoded + '\n', 'utf8');
    let offset = 0;
    while (offset < bytes.length) {
      offset += writeSync(descriptor, bytes, offset);
    }
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;

    linkSync(temporaryPath, path);
    unlinkSync(temporaryPath);
  } catch (error) {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The temporary file may already have been linked and removed.
    }
    throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

export class FileHandoffAdapter implements AntigravityAdapter {
  public readonly name = 'antigravity-file' as const;

  private readonly directory: string;

  public constructor(directory: string) {
    this.directory = ensureDirectory(directory);
  }

  public async send(request: AntigravityHandoffRequest): Promise<HandoffReceipt> {
    assertSafeRequest(request);
    const path = safePath(this.directory, 'request', request.requestId);
    writeJsonExclusively(path, request);
    return {
      requestId: request.requestId,
      requestDigest: requestDigest(request),
      transport: 'file',
      requestPath: path,
    };
  }

  public async readResponse(requestId: string): Promise<AntigravityHandoffResponse | null> {
    const path = safePath(this.directory, 'response', requestId);
    let raw: string;
    try {
      if (!lstatSync(path).isFile()) {
        throw new Error('Handoff response path is not a regular file: ' + path);
      }
      raw = readFileSync(path, 'utf8');
    } catch (error) {
      if (isMissingFile(error)) {
        return null;
      }
      throw error;
    }
    const response = parseResponse(JSON.parse(raw) as unknown);
    if (response.requestId !== requestId) {
      throw new Error('Handoff response request ID does not match the requested response');
    }
    const requestPath = safePath(this.directory, 'request', requestId);
    const requestValue = JSON.parse(readFileSync(requestPath, 'utf8')) as unknown;
    if (
      !isRecord(requestValue) ||
      !isRecord(requestValue.task) ||
      typeof requestValue.task.id !== 'string' ||
      response.taskId !== requestValue.task.id
    ) {
      throw new Error('Handoff response task ID does not match the originating request');
    }
    return response;
  }
}

function writeLine(output: Writable, value: unknown): Promise<void> {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    return Promise.reject(new Error('Handoff value cannot be represented as JSON'));
  }
  return new Promise<void>((resolvePromise, reject) => {
    try {
      output.write(encoded + '\n', 'utf8', (error?: Error | null) => {
        if (error === undefined || error === null) {
          resolvePromise();
        } else {
          reject(error);
        }
      });
    } catch (error) {
      reject(error);
    }
  });
}

export class StdioHandoffAdapter implements AntigravityAdapter {
  public readonly name = 'antigravity-stdio' as const;

  private readonly lineInterface: Interface;

  private readonly lines: AsyncIterator<string>;

  private readonly pendingResponses = new Map<string, AntigravityHandoffResponse>();

  private readonly expectedTaskIds = new Map<string, string>();

  private readOperation: Promise<void> | null = null;

  public constructor(
    input: Readable,
    private readonly output: Writable,
  ) {
    this.lineInterface = createInterface({
      input,
      crlfDelay: Infinity,
    });
    this.lines = this.lineInterface[Symbol.asyncIterator]();
  }

  public async send(request: AntigravityHandoffRequest): Promise<HandoffReceipt> {
    assertSafeRequest(request);
    await writeLine(this.output, request);
    this.expectedTaskIds.set(request.requestId, request.task.id);
    return {
      requestId: request.requestId,
      requestDigest: requestDigest(request),
      transport: 'stdio',
      requestPath: null,
    };
  }

  public async readResponse(requestId: string): Promise<AntigravityHandoffResponse | null> {
    assertRequestId(requestId);
    const expectedTaskId = this.expectedTaskIds.get(requestId);
    if (expectedTaskId === undefined) {
      throw new Error('No originating handoff request exists for this response');
    }
    const buffered = this.pendingResponses.get(requestId);
    if (buffered !== undefined) {
      this.pendingResponses.delete(requestId);
      this.expectedTaskIds.delete(requestId);
      if (buffered.taskId !== expectedTaskId) {
        throw new Error('Handoff response task ID does not match the originating request');
      }
      return buffered;
    }

    while (!this.pendingResponses.has(requestId)) {
      await this.consumeUntil(requestId);
    }
    const response = this.pendingResponses.get(requestId);
    if (response === undefined) {
      return null;
    }
    this.pendingResponses.delete(requestId);
    this.expectedTaskIds.delete(requestId);
    if (response.taskId !== expectedTaskId) {
      throw new Error('Handoff response task ID does not match the originating request');
    }
    return response;
  }

  public close(): void {
    this.lineInterface.close();
  }

  private async consumeUntil(requestId: string): Promise<void> {
    if (this.readOperation !== null) {
      await this.readOperation;
      return;
    }

    const operation = this.readLinesUntil(requestId);
    this.readOperation = operation;
    try {
      await operation;
    } finally {
      if (this.readOperation === operation) {
        this.readOperation = null;
      }
    }
  }

  private async readLinesUntil(requestId: string): Promise<void> {
    for (;;) {
      const next = await this.lines.next();
      if (next.done) {
        throw new Error('Stdio input ended before response ' + requestId + ' arrived');
      }
      const line = next.value.trim();
      if (line.length === 0) {
        continue;
      }
      const response = parseResponse(JSON.parse(line) as unknown);
      this.pendingResponses.set(response.requestId, response);
      if (response.requestId === requestId) {
        return;
      }
    }
  }
}
