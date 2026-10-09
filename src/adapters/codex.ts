import type { JsonValue } from '../domain/types.js';
import {
  correlationFor,
  createExternalAgentInvocation,
  fileHandoffPrompt,
  jsonValueFromUnknown,
  normalizeExternalAgentResult,
  parseExternalAgentResult,
  type ExternalAgentAdapter,
  type ExternalAgentCorrelation,
  type ExternalAgentInvocation,
  type ExternalAgentInvocationOptions,
  type ExternalAgentRequest,
  type ExternalAgentResult,
} from './types.js';

export type CodexSandbox = 'read-only' | 'workspace-write' | 'danger-full-access';

export type CodexCliAdapterOptions = {
  executable?: string;
  cwd?: string;
  model?: string;
  sandbox?: CodexSandbox;
  ephemeral?: boolean;
};

type CodexArgvOptions = {
  model?: string;
  sandbox?: CodexSandbox;
  ephemeral?: boolean;
};

function assertOptionValue(name: string, value: string): void {
  if (value.trim().length === 0 || value.includes('\0')) {
    throw new Error(`Codex ${name} must be a non-empty value without NUL bytes`);
  }
}

function codexArgs(handoff: ExternalAgentInvocationOptions, options: CodexArgvOptions): string[] {
  const args = ['exec', '--json', '--skip-git-repo-check'];
  if (options.ephemeral !== false) {
    args.push('--ephemeral');
  }
  if (options.model !== undefined) {
    assertOptionValue('model', options.model);
    args.push('--model', options.model);
  }
  if (options.sandbox !== undefined) {
    args.push('--sandbox', options.sandbox);
  }
  if (handoff.transport === 'stdio') {
    args.push('-');
  } else {
    args.push(fileHandoffPrompt(handoff.filePath));
  }
  return args;
}

function providerLines(raw: unknown): unknown[] {
  if (typeof raw !== 'string') {
    return [raw];
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error('Codex returned an empty result');
  }
  try {
    return [JSON.parse(trimmed) as unknown];
  } catch {
    const parsed: unknown[] = [];
    for (const line of trimmed.split(/\r?\n/u)) {
      const candidate = line.trim();
      if (candidate.length === 0) {
        continue;
      }
      try {
        parsed.push(JSON.parse(candidate) as unknown);
      } catch {
        // Codex may emit a human-readable line around JSONL events. The raw text
        // remains available as the normalized output if no event can be parsed.
      }
    }
    return parsed.length > 0 ? parsed : [raw];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isExternalResult(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    value.protocol === 'spark-runtime-external-agent-v1' &&
    value.kind === 'external_agent_result'
  );
}

function hasUnsupportedExternalEnvelope(value: unknown): boolean {
  return isRecord(value) && value.protocol === 'spark-runtime-external-agent-v1';
}

function textFrom(value: unknown, output: string[]): void {
  if (typeof value === 'string') {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      textFrom(item, output);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }

  if (value.type === 'agent_message' && typeof value.text === 'string') {
    output.push(value.text);
  }
  if (typeof value.text === 'string') {
    output.push(value.text);
  }
  for (const key of ['item', 'message', 'result', 'output', 'content']) {
    const child: unknown = value[key];
    if (child !== undefined && child !== value) {
      textFrom(child, output);
    }
  }
}

function errorFrom(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.error === 'string') {
    return value.error;
  }
  if (isRecord(value.error)) {
    const message = value.error.message;
    if (typeof message === 'string') {
      return message;
    }
  }
  if (value.type === 'turn.failed' || value.type === 'error') {
    const message = value.message;
    if (typeof message === 'string') {
      return message;
    }
  }
  return null;
}

function resultTimestamp(lines: readonly unknown[]): string | undefined {
  for (const line of [...lines].reverse()) {
    if (!isRecord(line)) {
      continue;
    }
    for (const key of ['receivedAt', 'created_at', 'timestamp']) {
      const value = line[key];
      if (typeof value === 'string' && value.trim().length > 0) {
        return value;
      }
    }
  }
  return undefined;
}

function processFailureError(
  provider: string,
  processResult: { exitCode: number; stderr: string },
): string {
  const exitMessage = `${provider} exited with code ${processResult.exitCode}.`;
  const stderr = processResult.stderr.trim();
  return stderr.length > 0 ? `${stderr} (${exitMessage})` : exitMessage;
}

export function parseCodexResult(
  raw: unknown,
  correlation: ExternalAgentCorrelation,
): ExternalAgentResult {
  const expected = { ...correlationFor(correlation), agent: 'codex' as const };
  const processResult =
    isRecord(raw) && typeof raw.exitCode === 'number' && 'stdout' in raw
      ? {
          exitCode: raw.exitCode,
          stdout: raw.stdout,
          stderr: typeof raw.stderr === 'string' ? raw.stderr : '',
        }
      : null;
  const lines = providerLines(processResult?.stdout ?? raw);
  const normalized = lines.find(isExternalResult);
  if (normalized !== undefined) {
    const result = parseExternalAgentResult(normalized, expected);
    if (processResult === null || processResult.exitCode === 0) {
      return result;
    }
    return normalizeExternalAgentResult({
      ...result,
      status: 'failed',
      error: processFailureError('Codex', processResult),
    });
  }
  if (lines.some(hasUnsupportedExternalEnvelope)) {
    throw new Error('Unsupported external-agent result envelope');
  }

  const failures = lines.map(errorFrom).filter((message): message is string => message !== null);
  const failed =
    (processResult !== null && processResult.exitCode !== 0) ||
    failures.length > 0 ||
    lines.some((line) => isRecord(line) && line.type === 'turn.failed');
  const text: string[] = [];
  for (const line of lines) {
    textFrom(line, text);
  }
  const summary = text.at(-1)?.trim() || 'Codex completed the handoff without a summary.';
  const output: JsonValue = jsonValueFromUnknown(lines.length === 1 ? lines[0] : lines);
  return normalizeExternalAgentResult({
    ...expected,
    receivedAt: resultTimestamp(lines),
    status: failed ? 'failed' : 'completed',
    summary,
    output,
    error: failed
      ? (failures.at(-1) ??
        (processResult?.stderr.trim() ||
          `Codex exited with code ${processResult?.exitCode ?? 'unknown'}.`))
      : null,
  });
}

export class CodexCliAdapter implements ExternalAgentAdapter {
  public readonly name = 'codex' as const;

  public readonly executable: string;

  private readonly options: CodexCliAdapterOptions;

  public constructor(options: CodexCliAdapterOptions = {}) {
    this.executable = options.executable ?? 'codex';
    this.options = options;
  }

  public buildInvocation(
    request: ExternalAgentRequest,
    options: ExternalAgentInvocationOptions,
  ): ExternalAgentInvocation {
    return createExternalAgentInvocation(
      request,
      this.executable,
      codexArgs(options, this.options),
      {
        ...options,
        cwd: options.cwd ?? this.options.cwd,
      },
    );
  }

  public buildArgv(
    request: ExternalAgentRequest,
    options: ExternalAgentInvocationOptions,
  ): string[] {
    return this.buildInvocation(request, options).argv;
  }

  public parseResult(raw: unknown, correlation: ExternalAgentCorrelation): ExternalAgentResult {
    return parseCodexResult(raw, correlation);
  }
}

export function buildCodexArgv(
  request: ExternalAgentRequest,
  options: ExternalAgentInvocationOptions,
  adapterOptions: CodexCliAdapterOptions = {},
): string[] {
  return new CodexCliAdapter(adapterOptions).buildArgv(request, options);
}

export function createCodexAdapter(options: CodexCliAdapterOptions = {}): CodexCliAdapter {
  return new CodexCliAdapter(options);
}

export { CodexCliAdapter as CodexAdapter };
