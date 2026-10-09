import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { containsSecretMaterial, redactSecrets } from '../security/redaction.js';

const DEFAULT_ANTIGRAVITY_MODEL = 'gemini-3.5-flash-high';
const MAX_OUTPUT_BYTES = 512 * 1024;
const MAX_DIAGNOSTIC_LENGTH = 4_096;
const MAX_STEPS = 12;
const MAX_STEP_LENGTH = 500;
const MAX_TITLE_LENGTH = 120;
const MAX_INSTRUCTION_LENGTH = 20_000;
const PLANNER_TIMEOUT_MS = 90_000;

const SAFE_ENVIRONMENT_KEYS = [
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

export interface PlannerResult {
  title: string;
  steps: string[];
  provider: string;
  model: string;
  usedLlm: boolean;
}

type PlannerCandidate = {
  command: string;
  provider: string;
  model: string | undefined;
  kind: 'antigravity' | 'codex' | 'generic';
};

type ProcessResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

export type PlannerProvider = 'antigravity' | 'codex';

export type PlannerSelection = {
  provider?: PlannerProvider;
  model?: string;
};

function safePlannerEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  if (environment.PATH === undefined) {
    environment.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  }
  return environment;
}

function commandKind(command: string): PlannerCandidate['kind'] {
  const name = basename(command).toLowerCase();
  if (name === 'agy' || name === 'antigravity') return 'antigravity';
  if (name === 'codex') return 'codex';
  return 'generic';
}

function configuredCandidates(selection?: PlannerSelection): PlannerCandidate[] {
  if (selection?.provider !== undefined) {
    const provider = selection.provider;
    const kind = provider;
    const model = selection.model?.trim();
    const command =
      provider === 'antigravity'
        ? process.env.ANTIGRAVITY_COMMAND?.trim() || 'agy'
        : process.env.CODEX_COMMAND?.trim() || 'codex';
    return [
      {
        command,
        provider,
        kind,
        model:
          provider === 'codex'
            ? model === undefined || model === 'default'
              ? undefined
              : model
            : (model ?? DEFAULT_ANTIGRAVITY_MODEL),
      },
    ];
  }

  const configuredCommand = process.env.PLANNER_COMMAND?.trim();
  const configuredModel = process.env.PLANNER_MODEL?.trim() || undefined;
  const configuredProvider = process.env.PLANNER_PROVIDER?.trim() || undefined;
  if (configuredCommand !== undefined && configuredCommand.length > 0) {
    const kind = commandKind(configuredCommand);
    return [
      {
        command: configuredCommand,
        kind,
        provider:
          configuredProvider ??
          (kind === 'antigravity' ? 'antigravity' : kind === 'codex' ? 'codex' : 'custom'),
        model: configuredModel ?? (kind === 'antigravity' ? DEFAULT_ANTIGRAVITY_MODEL : undefined),
      },
    ];
  }

  const antigravityCommand = process.env.ANTIGRAVITY_COMMAND?.trim() || 'agy';
  const codexCommand = process.env.CODEX_COMMAND?.trim() || 'codex';
  return [
    {
      command: antigravityCommand,
      provider: 'antigravity',
      model: configuredModel ?? DEFAULT_ANTIGRAVITY_MODEL,
      kind: 'antigravity',
    },
    {
      command: codexCommand,
      provider: 'codex',
      model: process.env.PLANNER_CODEX_MODEL?.trim() || undefined,
      kind: 'codex',
    },
  ];
}

function plannerPrompt(instruction: string): string {
  return `You are a task planner. Turn the user's instruction into a safe, concrete execution plan.
Do not execute tools, access files, send messages, or make any external changes.
Return ONLY one valid JSON object. Do not use markdown fences or add explanation.
The JSON must have this exact shape:
{
  "title": "a short Japanese task title",
  "steps": ["a concrete Japanese step", "another concrete Japanese step"]
}
Use 2 to 8 ordered steps. Include confirmation before irreversible or external side effects.

<user_instruction>
${instruction}
</user_instruction>`;
}

function commandArgs(
  candidate: PlannerCandidate,
  prompt: string,
): { args: string[]; stdin: string } {
  if (candidate.kind === 'antigravity') {
    return {
      args: [
        '--print',
        prompt,
        '--mode',
        'plan',
        ...(candidate.model === undefined ? [] : ['--model', candidate.model]),
      ],
      stdin: '',
    };
  }
  if (candidate.kind === 'codex') {
    return {
      args: [
        'exec',
        '--json',
        '--skip-git-repo-check',
        '--ephemeral',
        '--sandbox',
        'read-only',
        ...(candidate.model === undefined ? [] : ['--model', candidate.model]),
        '-',
      ],
      stdin: prompt,
    };
  }
  return { args: [prompt], stdin: '' };
}

function runPlanner(candidate: PlannerCandidate, prompt: string): Promise<ProcessResult> {
  const { args, stdin } = commandArgs(candidate, prompt);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(candidate.command, args, {
        cwd: process.cwd(),
        env: safePlannerEnvironment(),
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error: unknown) {
      reject(
        new Error(
          `LLM planner could not start: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      return;
    }

    let stdout = '';
    let stderr = '';
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let killTimeout: NodeJS.Timeout | undefined;

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      if (killTimeout !== undefined) clearTimeout(killTimeout);
      callback();
    };

    const terminate = (error: Error): void => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      child.kill('SIGTERM');
      killTimeout = setTimeout(() => child.kill('SIGKILL'), 100);
      reject(error);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        terminate(new Error('LLM planner output exceeded the 512KB limit.'));
        return;
      }
      stdout += stdoutDecoder.write(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > MAX_OUTPUT_BYTES) {
        terminate(new Error('LLM planner diagnostics exceeded the 512KB limit.'));
        return;
      }
      stderr += stderrDecoder.write(chunk);
    });
    child.once('error', (error) => {
      finish(() => reject(new Error(`LLM planner is unavailable: ${error.message}`)));
    });
    child.once('close', (exitCode) => {
      finish(() => {
        stdout += stdoutDecoder.end();
        stderr += stderrDecoder.end();
        resolve({ stdout, stderr, exitCode });
      });
    });

    timeout = setTimeout(() => {
      terminate(new Error(`LLM planner timed out after ${PLANNER_TIMEOUT_MS / 1_000} seconds.`));
    }, PLANNER_TIMEOUT_MS);
    child.stdin.end(stdin);
  });
}

function safePlannerDiagnostics(stderr: string): string {
  const redacted = redactSecrets(stderr.trim()) as string;
  if (redacted.length <= MAX_DIAGNOSTIC_LENGTH) return redacted;
  return `${redacted.slice(0, MAX_DIAGNOSTIC_LENGTH)}…`;
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/iu.exec(trimmed)?.[1];
  const candidate = (fenced ?? trimmed).trim();
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('JSON object was not found');
    return JSON.parse(candidate.slice(start, end + 1)) as unknown;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function collectText(value: unknown, output: string[]): void {
  if (typeof value === 'string') {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, output);
    return;
  }
  if (!isRecord(value)) return;
  for (const key of ['text', 'message', 'result', 'output', 'content', 'item']) {
    const child: unknown = value[key];
    if (child !== undefined && child !== value) collectText(child, output);
  }
}

function plannerOutputText(output: string, kind: PlannerCandidate['kind']): string {
  if (kind !== 'codex') return output;
  const messages: string[] = [];
  for (const line of output.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      collectText(JSON.parse(trimmed) as unknown, messages);
    } catch {
      // Keep plain text as a last-resort fallback for compatible Codex wrappers.
      messages.push(trimmed);
    }
  }
  return messages.at(-1) ?? output;
}

function parsePlannerResult(output: string, candidate: PlannerCandidate): PlannerResult {
  const parsed = extractJson(plannerOutputText(output, candidate.kind));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('LLM planner returned a non-object result.');
  }
  const record = parsed as Record<string, unknown>;
  const title = typeof record.title === 'string' ? record.title.replace(/\s+/gu, ' ').trim() : '';
  const rawSteps = record.steps;
  if (title.length === 0 || title.length > MAX_TITLE_LENGTH) {
    throw new Error('LLM planner returned an invalid title.');
  }
  if (
    !Array.isArray(rawSteps) ||
    rawSteps.length < 1 ||
    rawSteps.length > MAX_STEPS ||
    !rawSteps.every(
      (step) =>
        typeof step === 'string' && step.trim().length > 0 && step.length <= MAX_STEP_LENGTH,
    )
  ) {
    throw new Error('LLM planner returned an invalid steps list.');
  }
  return {
    title,
    steps: rawSteps.map((step) => (step as string).trim()),
    provider: candidate.provider,
    model: candidate.model ?? 'provider default',
    usedLlm: true,
  };
}

function userFacingPlannerFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed out/iu.test(message)) {
    return 'LLMからの応答が時間内に返りませんでした。';
  }
  if (/exceeded/iu.test(message)) {
    return 'LLMからの応答が大きすぎました。';
  }
  if (
    /quota|rate limit|resource exhausted|too many requests|usage limit|429|billing/iu.test(message)
  ) {
    return 'LLMの利用上限に達したため、手順候補を作成できません。時間を置くか、別のLLMプロバイダーを設定してください。';
  }
  if (/authentication|unauthorized|forbidden|login|ログイン|認証/iu.test(message)) {
    return 'LLM CLIの認証に失敗しました。Antigravity CLIまたはCodex CLIへログインしてください。';
  }
  if (/unavailable|could not start|exited with code|No LLM planner/iu.test(message)) {
    return '手順候補を作るLLM CLIが利用できません。Antigravity CLIまたはCodex CLIの設定を確認してください。';
  }
  if (/returned|JSON object/iu.test(message)) {
    return 'LLMから有効な手順候補を受け取れませんでした。';
  }
  return 'LLMの接続または応答に問題があります。';
}

export async function suggestSteps(
  instruction: string,
  selection?: PlannerSelection,
): Promise<PlannerResult> {
  const trimmed = instruction.trim();
  if (trimmed.length === 0) throw new Error('Instruction is empty');
  if (trimmed.length > MAX_INSTRUCTION_LENGTH) {
    throw new Error(`Instruction must be ${MAX_INSTRUCTION_LENGTH} characters or fewer.`);
  }
  if (containsSecretMaterial(trimmed)) {
    throw new Error(
      '指示文に秘密情報（APIキー、パスワード等）が含まれている可能性があるため、LLMへ送信できません。',
    );
  }

  const prompt = plannerPrompt(trimmed);
  let lastError = 'No LLM planner is configured.';
  for (const candidate of configuredCandidates(selection)) {
    try {
      const result = await runPlanner(candidate, prompt);
      if (result.exitCode !== 0) {
        const diagnostics = safePlannerDiagnostics(result.stderr);
        throw new Error(
          `${candidate.provider} exited with code ${result.exitCode}.${diagnostics.length > 0 ? ` stderr: ${diagnostics}` : ''}`,
        );
      }
      return parsePlannerResult(result.stdout, candidate);
    } catch (error: unknown) {
      lastError = userFacingPlannerFailure(error);
      if (selection?.provider !== undefined || process.env.PLANNER_COMMAND?.trim()) break;
    }
  }
  throw new Error(`LLMによる手順候補を生成できませんでした。${lastError}`);
}
