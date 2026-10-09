import { randomUUID } from 'node:crypto';

import { actionDigest, canonicalJson, sha256 } from '../domain/canonical.js';
import type {
  ActionSpec,
  JsonValue,
  PolicyDecision,
  PolicyProfile,
  TaskRecord,
} from '../domain/types.js';
import { containsSecretMaterial, redactSecrets } from '../security/redaction.js';

export const EXTERNAL_AGENT_PROTOCOL = 'spark-runtime-external-agent-v1' as const;
export const EXTERNAL_AGENT_REQUEST_KIND = 'external_agent_request' as const;
export const EXTERNAL_AGENT_RESULT_KIND = 'external_agent_result' as const;

export const EXTERNAL_AGENT_NAMES = ['codex', 'claude-code'] as const;
export type ExternalAgentName = (typeof EXTERNAL_AGENT_NAMES)[number];

export const EXTERNAL_AGENT_TRANSPORTS = ['file', 'stdio'] as const;
export type ExternalAgentTransport = (typeof EXTERNAL_AGENT_TRANSPORTS)[number];

export const EXTERNAL_AGENT_RESULT_STATUSES = [
  'accepted',
  'completed',
  'needs_user',
  'rejected',
  'failed',
] as const;
export type ExternalAgentResultStatus = (typeof EXTERNAL_AGENT_RESULT_STATUSES)[number];

export type ExternalAgentTaskSnapshot = Pick<
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

export type ExternalAgentActionPayload = {
  action: ActionSpec;
  actionDigest: string;
  policy: PolicyDecision;
};

export type ExternalAgentPayload = {
  task: ExternalAgentTaskSnapshot;
  prompt: string;
  actions: ExternalAgentActionPayload[];
};

export type ExternalAgentRequest = ExternalAgentPayload & {
  protocol: typeof EXTERNAL_AGENT_PROTOCOL;
  kind: typeof EXTERNAL_AGENT_REQUEST_KIND;
  requestId: string;
  createdAt: string;
};

export type ExternalAgentActionInput = {
  action: ActionSpec;
  policy: PolicyDecision;
  actionDigest?: string;
};

export type ExternalAgentRequestInput = {
  task: ExternalAgentTaskSnapshot;
  prompt: string;
  actions?: readonly (ActionSpec | ExternalAgentActionInput)[];
  /** Policies may be supplied by index when actions are supplied as ActionSpec values. */
  policy?: PolicyDecision | readonly PolicyDecision[];
  /** Singular form is convenient for a one-action handoff. */
  action?: ActionSpec | ExternalAgentActionInput;
  requestId?: string;
  createdAt?: string;
};

export type ExternalAgentResult = {
  protocol: typeof EXTERNAL_AGENT_PROTOCOL;
  kind: typeof EXTERNAL_AGENT_RESULT_KIND;
  requestId: string;
  taskId: string;
  agent: ExternalAgentName;
  receivedAt: string;
  status: ExternalAgentResultStatus;
  summary: string;
  output: JsonValue | null;
  error: string | null;
};

export type ExternalAgentResultInput = {
  requestId: string;
  taskId: string;
  agent: ExternalAgentName;
  receivedAt?: string;
  status: ExternalAgentResultStatus;
  summary: string;
  output?: JsonValue | null;
  error?: string | null;
};

export type ExternalAgentCorrelation =
  | (Pick<ExternalAgentRequest, 'requestId'> & { taskId: string })
  | Pick<ExternalAgentRequest, 'requestId' | 'task'>;

export type ExternalAgentHandoffOptions =
  | {
      transport: 'file';
      filePath: string;
    }
  | {
      transport: 'stdio';
    };

export type ExternalAgentHandoff = {
  requestId: string;
  requestDigest: string;
  transport: ExternalAgentTransport;
  serialized: string;
  filePath: string | null;
  stdin: string | null;
};

export type ExternalAgentInvocation = {
  /** The executable is repeated as argv[0] so the vector can be logged or delegated directly. */
  executable: string;
  argv: string[];
  /** Convenience view for APIs such as spawn(executable, args); no process is started here. */
  args: string[];
  cwd: string | undefined;
  transport: ExternalAgentTransport;
  handoff: ExternalAgentHandoff;
};

export type ExternalAgentInvocationOptions = ExternalAgentHandoffOptions & {
  cwd?: string;
};

export interface ExternalAgentAdapter {
  readonly name: ExternalAgentName;
  readonly executable: string;
  buildInvocation(
    request: ExternalAgentRequest,
    options: ExternalAgentInvocationOptions,
  ): ExternalAgentInvocation;
  parseResult(raw: unknown, correlation: ExternalAgentCorrelation): ExternalAgentResult;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]+$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isJsonValue(value: unknown): value is JsonValue {
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

function asJsonValue(value: unknown): JsonValue {
  if (isJsonValue(value)) {
    return value;
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? null : encoded;
}

function isPolicyOutcome(value: unknown): value is PolicyDecision['outcome'] {
  return (
    value === 'allow' ||
    value === 'require_approval' ||
    value === 'take_control' ||
    value === 'deny'
  );
}

function isPolicyProfile(value: unknown): value is PolicyProfile {
  return value === 'spark-public-parity' || value === 'spark-public-parity-plus';
}

function isPolicyDecision(value: unknown): value is PolicyDecision {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isPolicyOutcome(value.outcome) &&
    isPolicyProfile(value.profile) &&
    typeof value.reason === 'string' &&
    typeof value.policyRule === 'string' &&
    typeof value.confirmationRequired === 'boolean' &&
    (value.disclosure === null || isJsonValue(value.disclosure))
  );
}

function cloneTask(task: ExternalAgentTaskSnapshot): ExternalAgentTaskSnapshot {
  return {
    ...task,
    plannedSteps: [...task.plannedSteps],
    pendingSteps: [...task.pendingSteps],
  };
}

function policyValues(
  policy: PolicyDecision | readonly PolicyDecision[] | undefined,
): readonly PolicyDecision[] {
  if (policy === undefined) {
    return [];
  }
  if (Array.isArray(policy)) {
    return policy as readonly PolicyDecision[];
  }
  return [policy as PolicyDecision];
}

function assertRequestId(requestId: string): void {
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    throw new Error(
      'External-agent request IDs may contain only letters, numbers, underscores, and hyphens',
    );
  }
}

export function validateExternalAgentRequest(request: ExternalAgentRequest): void {
  if (
    request.protocol !== EXTERNAL_AGENT_PROTOCOL ||
    request.kind !== EXTERNAL_AGENT_REQUEST_KIND
  ) {
    throw new Error('Unsupported external-agent request envelope');
  }
  assertRequestId(request.requestId);
  if (request.createdAt.trim().length === 0) {
    throw new Error('External-agent request creation time must not be empty');
  }
  if (request.prompt.trim().length === 0) {
    throw new Error('External-agent prompt must not be empty');
  }
  if (!isPolicyProfile(request.task.profile)) {
    throw new Error('External-agent task profile is invalid');
  }
  if (!containsSecretMaterial(asJsonValue(request))) {
    for (const item of request.actions) {
      if (item.action.taskId !== request.task.id) {
        throw new Error(
          `External-agent action ${item.action.id} does not belong to task ${request.task.id}`,
        );
      }
      const expectedDigest = actionDigest(item.action);
      if (item.actionDigest !== expectedDigest) {
        throw new Error(
          `External-agent action ${item.action.id} changed after its handoff digest was created`,
        );
      }
      if (!isPolicyDecision(item.policy)) {
        throw new Error(`External-agent policy for action ${item.action.id} is invalid`);
      }
      if (item.policy.profile !== request.task.profile) {
        throw new Error(
          `External-agent policy profile for action ${item.action.id} does not match the task`,
        );
      }
    }
    canonicalJson(request);
    return;
  }
  throw new Error('Secret material cannot cross the external-agent handoff boundary');
}

export function createExternalAgentRequest(
  input: ExternalAgentRequestInput,
  now: Date = new Date(),
): ExternalAgentRequest {
  if (input.prompt.trim().length === 0) {
    throw new Error('External-agent prompt must not be empty');
  }

  const suppliedPolicies = policyValues(input.policy);
  const suppliedActions = [...(input.actions ?? [])];
  if (input.action !== undefined) {
    suppliedActions.push(input.action);
  }

  const actions = suppliedActions.map((item, index): ExternalAgentActionPayload => {
    const action = 'action' in item ? item.action : item;
    const policy = 'action' in item ? item.policy : suppliedPolicies[index];
    if (policy === undefined) {
      throw new Error(`External-agent policy is required for action ${action.id}`);
    }
    const digest = actionDigest(action);
    if ('actionDigest' in item && item.actionDigest !== undefined && item.actionDigest !== digest) {
      throw new Error(`External-agent action ${action.id} digest does not match its contents`);
    }
    return {
      action,
      actionDigest: digest,
      policy,
    };
  });

  const request: ExternalAgentRequest = {
    protocol: EXTERNAL_AGENT_PROTOCOL,
    kind: EXTERNAL_AGENT_REQUEST_KIND,
    requestId: input.requestId ?? `handoff_${randomUUID()}`,
    createdAt: input.createdAt ?? now.toISOString(),
    task: cloneTask(input.task),
    prompt: input.prompt,
    actions,
  };
  validateExternalAgentRequest(request);
  return request;
}

export function serializeExternalAgentRequest(request: ExternalAgentRequest): string {
  validateExternalAgentRequest(request);
  return canonicalJson(request);
}

function assertHandoffPath(filePath: string): void {
  if (filePath.trim().length === 0 || filePath.includes('\0')) {
    throw new Error('External-agent file handoff path must be a non-empty path without NUL bytes');
  }
}

export function createExternalAgentHandoff(
  request: ExternalAgentRequest,
  options: ExternalAgentHandoffOptions,
): ExternalAgentHandoff {
  const serialized = serializeExternalAgentRequest(request);
  if (options.transport === 'file') {
    assertHandoffPath(options.filePath);
    return {
      requestId: request.requestId,
      requestDigest: sha256(serialized),
      transport: 'file',
      serialized,
      filePath: options.filePath,
      stdin: null,
    };
  }
  return {
    requestId: request.requestId,
    requestDigest: sha256(serialized),
    transport: 'stdio',
    serialized,
    filePath: null,
    stdin: serialized + '\n',
  };
}

export function createExternalAgentInvocation(
  request: ExternalAgentRequest,
  executable: string,
  args: readonly string[],
  options: ExternalAgentInvocationOptions,
): ExternalAgentInvocation {
  if (executable.trim().length === 0 || executable.includes('\0')) {
    throw new Error('External-agent executable must be a non-empty path without NUL bytes');
  }
  const handoff = createExternalAgentHandoff(request, options);
  const invocationArgs = [...args];
  if (invocationArgs.some((arg) => arg.includes('\0'))) {
    throw new Error('External-agent argv values must not contain NUL bytes');
  }
  return {
    executable,
    argv: [executable, ...invocationArgs],
    args: invocationArgs,
    cwd: options.cwd,
    transport: handoff.transport,
    handoff,
  };
}

export function fileHandoffPrompt(filePath: string): string {
  assertHandoffPath(filePath);
  return `Read the complete external-agent handoff JSON from this file: ${filePath}`;
}

export function parseExternalAgentResult(
  value: unknown,
  expected?: Partial<Pick<ExternalAgentResult, 'requestId' | 'taskId' | 'agent'>>,
): ExternalAgentResult {
  let candidate = value;
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      throw new Error('External-agent result must be a JSON object');
    }
  }
  if (!isRecord(candidate)) {
    throw new Error('External-agent result must be a JSON object');
  }
  if (
    candidate.protocol !== EXTERNAL_AGENT_PROTOCOL ||
    candidate.kind !== EXTERNAL_AGENT_RESULT_KIND
  ) {
    throw new Error('Unsupported external-agent result envelope');
  }

  const requestId = candidate.requestId;
  const taskId = candidate.taskId;
  const agent = candidate.agent;
  const receivedAt = candidate.receivedAt;
  const status = candidate.status;
  const summary = candidate.summary;
  const output = candidate.output;
  const error = candidate.error;
  const resultStatus = status as ExternalAgentResultStatus;
  if (
    typeof requestId !== 'string' ||
    typeof taskId !== 'string' ||
    (agent !== 'codex' && agent !== 'claude-code') ||
    typeof receivedAt !== 'string' ||
    !EXTERNAL_AGENT_RESULT_STATUSES.includes(resultStatus) ||
    typeof summary !== 'string' ||
    !isJsonValue(output) ||
    (error !== null && typeof error !== 'string')
  ) {
    throw new Error('External-agent result fields are invalid');
  }
  assertRequestId(requestId);
  if (taskId.trim().length === 0 || receivedAt.trim().length === 0) {
    throw new Error('External-agent result correlation fields must not be empty');
  }
  if (expected?.requestId !== undefined && expected.requestId !== requestId) {
    throw new Error('External-agent result request ID does not match the requested handoff');
  }
  if (expected?.taskId !== undefined && expected.taskId !== taskId) {
    throw new Error('External-agent result task ID does not match the requested handoff');
  }
  if (expected?.agent !== undefined && expected.agent !== agent) {
    throw new Error('External-agent result name does not match the requested adapter');
  }

  return {
    protocol: EXTERNAL_AGENT_PROTOCOL,
    kind: EXTERNAL_AGENT_RESULT_KIND,
    requestId,
    taskId,
    agent,
    receivedAt,
    status: resultStatus,
    summary: redactSecrets(summary) as string,
    output: redactSecrets(output),
    error: error === null ? null : (redactSecrets(error) as string),
  };
}

export function normalizeExternalAgentResult(input: ExternalAgentResultInput): ExternalAgentResult {
  return parseExternalAgentResult(
    {
      protocol: EXTERNAL_AGENT_PROTOCOL,
      kind: EXTERNAL_AGENT_RESULT_KIND,
      requestId: input.requestId,
      taskId: input.taskId,
      agent: input.agent,
      receivedAt: input.receivedAt ?? new Date().toISOString(),
      status: input.status,
      summary: input.summary,
      output: input.output ?? null,
      error: input.error ?? null,
    },
    input,
  );
}

export function correlationFor(
  correlation: ExternalAgentCorrelation,
): Pick<ExternalAgentResult, 'requestId' | 'taskId'> {
  return {
    requestId: correlation.requestId,
    taskId: 'taskId' in correlation ? correlation.taskId : correlation.task.id,
  };
}

export function jsonValueFromUnknown(value: unknown): JsonValue {
  return asJsonValue(value);
}
