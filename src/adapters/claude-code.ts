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

export type ClaudeCodePermissionMode =
  'acceptEdits' | 'bypassPermissions' | 'default' | 'delegate' | 'dontAsk' | 'plan';

export type ClaudeCodeCliAdapterOptions = {
  executable?: string;
  cwd?: string;
  model?: string;
  permissionMode?: ClaudeCodePermissionMode;
  maxTurns?: number;
};

function assertOptionValue(name: string, value: string): void {
  if (value.trim().length === 0 || value.includes('\0')) {
    throw new Error(`Claude Code ${name} must be a non-empty value without NUL bytes`);
  }
}

function claudeCodeArgs(
  handoff: ExternalAgentInvocationOptions,
  options: ClaudeCodeCliAdapterOptions,
): string[] {
  const args = ['--print', '--output-format', 'json'];
  if (handoff.transport === 'stdio') {
    args.push('--input-format', 'text');
  }
  if (options.model !== undefined) {
    assertOptionValue('model', options.model);
    args.push('--model', options.model);
  }
  if (options.permissionMode !== undefined) {
    args.push('--permission-mode', options.permissionMode);
  }
  if (options.maxTurns !== undefined) {
    if (!Number.isInteger(options.maxTurns) || options.maxTurns < 1) {
      throw new Error('Claude Code maxTurns must be a positive integer');
    }
    args.push('--max-turns', String(options.maxTurns));
  }
  if (handoff.transport === 'file') {
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
    throw new Error('Claude Code returned an empty result');
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
        // Human-readable diagnostics are not part of the normalized result.
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

  if (typeof value.text === 'string') {
    output.push(value.text);
  }
  for (const key of ['result', 'message', 'content', 'output']) {
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
  if (isRecord(value.error) && typeof value.error.message === 'string') {
    return value.error.message;
  }
  if (typeof value.error_text === 'string') {
    return value.error_text;
  }
  if (value.is_error === true && typeof value.result === 'string') {
    return value.result;
  }
  if (value.type === 'error' && typeof value.message === 'string') {
    return value.message;
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

export function parseClaudeCodeResult(
  raw: unknown,
  correlation: ExternalAgentCorrelation,
): ExternalAgentResult {
  const expected = { ...correlationFor(correlation), agent: 'claude-code' as const };
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
      error: processFailureError('Claude Code', processResult),
    });
  }
  if (lines.some(hasUnsupportedExternalEnvelope)) {
    throw new Error('Unsupported external-agent result envelope');
  }

  const failures = lines.map(errorFrom).filter((message): message is string => message !== null);
  const failed =
    (processResult !== null && processResult.exitCode !== 0) ||
    lines.some(
      (line) =>
        isRecord(line) &&
        (line.is_error === true ||
          line.type === 'error' ||
          (line.type === 'result' && line.subtype !== 'success')),
    );
  const text: string[] = [];
  for (const line of lines) {
    textFrom(line, text);
  }
  const summary = text.at(-1)?.trim() || 'Claude Code completed the handoff without a summary.';
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
          `Claude Code exited with code ${processResult?.exitCode ?? 'unknown'}.`))
      : null,
  });
}

export class ClaudeCodeCliAdapter implements ExternalAgentAdapter {
  public readonly name = 'claude-code' as const;

  public readonly executable: string;

  private readonly options: ClaudeCodeCliAdapterOptions;

  public constructor(options: ClaudeCodeCliAdapterOptions = {}) {
    this.executable = options.executable ?? 'claude';
    this.options = options;
  }

  public buildInvocation(
    request: ExternalAgentRequest,
    options: ExternalAgentInvocationOptions,
  ): ExternalAgentInvocation {
    return createExternalAgentInvocation(
      request,
      this.executable,
      claudeCodeArgs(options, this.options),
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
    return parseClaudeCodeResult(raw, correlation);
  }
}

export function buildClaudeCodeArgv(
  request: ExternalAgentRequest,
  options: ExternalAgentInvocationOptions,
  adapterOptions: ClaudeCodeCliAdapterOptions = {},
): string[] {
  return new ClaudeCodeCliAdapter(adapterOptions).buildArgv(request, options);
}

export function createClaudeCodeAdapter(
  options: ClaudeCodeCliAdapterOptions = {},
): ClaudeCodeCliAdapter {
  return new ClaudeCodeCliAdapter(options);
}

export { ClaudeCodeCliAdapter as ClaudeCodeAdapter };
