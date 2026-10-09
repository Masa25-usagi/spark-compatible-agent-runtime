import { spawn } from 'node:child_process';
import { basename } from 'node:path';

import type { JsonValue } from '../domain/types.js';
import { redactSecrets } from '../security/redaction.js';
import type {
  ExternalAgentAdapter,
  ExternalAgentCorrelation,
  ExternalAgentRequest,
  ExternalAgentResult,
} from '../adapters/types.js';

export type ExternalAgentRoundTripStatus =
  'completed' | 'failed' | 'unavailable' | 'timed_out' | 'output_limit';

export type ExternalAgentRoundTripOptions = {
  transport?: 'stdio' | 'file';
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: Record<string, string>;
  noTools?: boolean;
};

export type ExternalAgentRoundTripEvidence = {
  kind: 'external_agent_roundtrip_evidence';
  protocol: 'spark-runtime-external-agent-v1';
  requestId: string;
  taskId: string;
  agent: ExternalAgentRequest['task']['agent'] | 'codex' | 'claude-code';
  status: ExternalAgentRoundTripStatus;
  transport: 'stdio';
  executable: string;
  exitCode: number | null;
  durationMs: number;
  stdoutBytes: number;
  stderrBytes: number;
  resultStatus: ExternalAgentResult['status'] | null;
  resultSummary: string | null;
  error: string | null;
  externalMutationVerified: false;
};

const ALLOWED_ENV_KEYS = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TERM',
  'SHELL',
  'USER',
  'LOGNAME',
  'PWD',
  '__CF_USER_TEXT_ENCODING',
] as const;

export function buildVerificationEnvironment(
  explicit: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ALLOWED_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  if (environment.PATH === undefined) environment.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  return { ...environment, ...explicit };
}

type Captured = { value: string; bytes: number; exceeded: boolean };

function capture(_limit: number): Captured {
  return { value: '', bytes: 0, exceeded: false };
}

function append(captured: Captured, chunk: Buffer, limit: number): void {
  captured.bytes += chunk.byteLength;
  const capturedBytes = Buffer.byteLength(captured.value, 'utf8');
  if (capturedBytes < limit) {
    const remaining = limit - capturedBytes;
    captured.value += chunk.subarray(0, remaining).toString('utf8');
  }
  if (captured.bytes > limit) {
    captured.exceeded = true;
  }
}

function safeText(value: string | null): string | null {
  if (value === null) return null;
  return redactSecrets(value as JsonValue) as string;
}

export async function runExternalAgentRoundTrip(
  adapter: ExternalAgentAdapter,
  request: ExternalAgentRequest,
  options: ExternalAgentRoundTripOptions = {},
): Promise<ExternalAgentRoundTripEvidence> {
  const transport = options.transport ?? 'stdio';
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxOutputBytes = options.maxOutputBytes ?? 1_048_576;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error('timeoutMs must be positive');
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1) {
    throw new Error('maxOutputBytes must be positive');
  }
  if (transport !== 'stdio') {
    throw new Error('External-agent round-trip verification supports stdio transport only');
  }

  const baseInvocation = adapter.buildInvocation(request, {
    transport: 'stdio',
    cwd: options.cwd,
  });
  const invocation =
    options.noTools && adapter.name === 'claude-code'
      ? {
          ...baseInvocation,
          args: [...baseInvocation.args, '--tools', ''],
          argv: [...baseInvocation.argv, '--tools', ''],
        }
      : baseInvocation;
  const stdout = capture(maxOutputBytes);
  const stderr = capture(maxOutputBytes);
  const started = Date.now();
  const child = spawn(invocation.executable, invocation.args, {
    cwd: invocation.cwd,
    env: buildVerificationEnvironment(options.env),
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let timedOut = false;
  let settled = false;
  let timer: NodeJS.Timeout | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  let forcedSettleTimer: NodeJS.Timeout | undefined;
  let terminateRequested = false;
  const result = await new Promise<{
    exitCode: number | null;
    spawnError: Error | null;
  }>((resolve) => {
    const finish = (exitCode: number | null, spawnError: Error | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (forcedSettleTimer !== undefined) clearTimeout(forcedSettleTimer);
      resolve({ exitCode, spawnError });
    };
    const terminate = (): void => {
      if (terminateRequested || settled) return;
      terminateRequested = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 50);
      forcedSettleTimer = setTimeout(() => finish(null, null), 1_000);
    };
    child.stdout.on('data', (chunk: Buffer) => {
      append(stdout, chunk, maxOutputBytes);
      if (stdout.exceeded) terminate();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      append(stderr, chunk, maxOutputBytes);
      if (stderr.exceeded) terminate();
    });
    child.once('error', (error) => finish(null, error));
    child.once('close', (code) => finish(code, null));
    timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    child.stdin.end(invocation.handoff.stdin ?? '');
  });

  const durationMs = Date.now() - started;
  let parsed: ExternalAgentResult | null = null;
  let parseError: string | null = null;
  if (!timedOut && !stdout.exceeded && result.spawnError === null && stdout.value.trim()) {
    try {
      const correlation: ExternalAgentCorrelation = {
        requestId: request.requestId,
        taskId: request.task.id,
      };
      parsed = adapter.parseResult(
        { exitCode: result.exitCode ?? 1, stdout: stdout.value, stderr: stderr.value },
        correlation,
      );
    } catch (error) {
      parseError = error instanceof Error ? error.message : String(error);
    }
  }

  const status: ExternalAgentRoundTripStatus = timedOut
    ? 'timed_out'
    : stdout.exceeded || stderr.exceeded
      ? 'output_limit'
      : result.spawnError !== null
        ? 'unavailable'
        : parsed?.status === 'completed' && result.exitCode === 0
          ? 'completed'
          : 'failed';
  const error =
    result.spawnError?.message ??
    parseError ??
    parsed?.error ??
    (result.exitCode !== 0
      ? stderr.value.trim() || `Process exited with code ${result.exitCode}.`
      : null);
  return {
    kind: 'external_agent_roundtrip_evidence',
    protocol: 'spark-runtime-external-agent-v1',
    requestId: request.requestId,
    taskId: request.task.id,
    agent: adapter.name,
    status,
    transport: 'stdio',
    executable: basename(invocation.executable),
    exitCode: result.exitCode,
    durationMs,
    stdoutBytes: stdout.bytes,
    stderrBytes: stderr.bytes,
    resultStatus: parsed?.status ?? null,
    resultSummary: safeText(parsed?.summary ?? null),
    error: safeText(error),
    externalMutationVerified: false,
  };
}
