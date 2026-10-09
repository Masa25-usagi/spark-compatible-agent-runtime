export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = {
  [key: string]: JsonValue;
};

export const POLICY_PROFILES = ['spark-public-parity', 'spark-public-parity-plus'] as const;
export type PolicyProfile = (typeof POLICY_PROFILES)[number];

export const TASK_STATUSES = [
  'planning',
  'running',
  'waiting_for_approval',
  'take_control',
  'stopped',
  'completed',
  'failed',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const POLICY_OUTCOMES = ['allow', 'require_approval', 'take_control', 'deny'] as const;
export type PolicyOutcome = (typeof POLICY_OUTCOMES)[number];

export const ACTION_OPERATIONS = [
  'read',
  'search',
  'summarize',
  'analyze',
  'create_file',
  'draft',
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
  'enter_secret',
  'authentication',
  'payment',
  'two_factor',
  'captcha',
  'prohibited',
] as const;
export type ActionOperation = (typeof ACTION_OPERATIONS)[number];

export type Amount = {
  currency: string;
  value: number;
};

export type ActionSpec = {
  id: string;
  taskId: string;
  tool: string;
  connector: string;
  operation: ActionOperation;
  target: JsonValue;
  payload?: JsonValue;
  before?: JsonValue;
  after?: JsonValue;
  itemCount?: number;
  dataSizeBytes?: number;
  recipient?: string;
  amount?: Amount;
  reversible?: boolean;
  undoMethod?: string;
  originatingTask: string;
};

export type ApprovalDisclosure = {
  operation: ActionOperation;
  targetSummary: string;
  beforeSummary: string;
  afterSummary: string;
  itemCount: number;
  dataSizeBytes: number | null;
  recipient: string | null;
  amount: Amount | null;
  reversible: boolean;
  undoMethod: string | null;
  tool: string;
  connector: string;
  originatingTask: string;
};

export type PolicyDecision = {
  outcome: PolicyOutcome;
  profile: PolicyProfile;
  reason: string;
  policyRule: string;
  confirmationRequired: boolean;
  disclosure: ApprovalDisclosure | null;
};

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'consumed' | 'expired';

export type ApprovalRecord = {
  id: string;
  taskId: string;
  actionId: string;
  actionDigest: string;
  action: ActionSpec;
  status: ApprovalStatus;
  confirmationRequired: boolean;
  disclosure: ApprovalDisclosure;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionReason: string | null;
  consumedAt: string | null;
};

export type ConnectorResult = {
  success: boolean;
  simulated: boolean;
  summary: string;
  changedTargets: string[];
  undoGuidance: string | null;
  output: JsonValue;
};

export type TaskRecord = {
  id: string;
  title: string;
  instruction: string | null;
  status: TaskStatus;
  profile: PolicyProfile;
  agent: string;
  model: string;
  harness: string;
  createdAt: string;
  updatedAt: string;
  currentStep: string;
  plannedSteps: string[];
  completedSteps: string[];
  pendingSteps: string[];
  usedSkills: string[];
  usedConnectors: string[];
  filesRead: string[];
  filesCreated: string[];
  filesChanged: string[];
  pendingApprovalIds: string[];
  errors: string[];
  retries: number;
  stopReason: string | null;
  takeControlReason: string | null;
  dispatchMode: 'plan' | 'workspace' | null;
  dispatchStatus:
    | 'not_started'
    | 'queued'
    | 'running'
    | 'responded'
    | 'needs_user'
    | 'failed'
    | 'unavailable'
    | 'timed_out'
    | 'cancelled';
  dispatchSummary: string | null;
  dispatchStartedAt: string | null;
  dispatchFinishedAt: string | null;
};

export type CreateTaskInput = {
  title?: string;
  instruction?: string;
  profile?: PolicyProfile;
  agent?: string;
  model?: string;
  harness?: string;
  plannedSteps?: string[];
  usedSkills?: string[];
};

export type RuntimeEvent = {
  id: string;
  taskId: string;
  kind: string;
  payload: JsonValue;
  occurredAt: string;
};

export type ScheduleRecord = {
  id: string;
  name: string;
  enabled: boolean;
  intervalMs: number;
  nextRunAt: string;
  payload: JsonValue;
  createdAt: string;
  updatedAt: string;
};

export type SkillRecord = {
  name: string;
  description: string;
  instructions: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type AuditEvent = {
  id: string;
  timestamp: string;
  taskId: string;
  agent: string;
  model: string;
  harness: string;
  tool: string;
  args: JsonValue;
  approval: JsonValue | null;
  decision: PolicyOutcome | null;
  result: JsonValue | null;
  changedTargets: string[];
  undoGuidance: string | null;
  previousHash: string | null;
  eventHash: string;
};

export type AuditVerification = {
  valid: boolean;
  eventCount: number;
  firstInvalidSequence: number | null;
  reason: string | null;
};

export type TaskProgress = Pick<
  TaskRecord,
  | 'id'
  | 'title'
  | 'status'
  | 'currentStep'
  | 'plannedSteps'
  | 'completedSteps'
  | 'pendingSteps'
  | 'usedSkills'
  | 'usedConnectors'
  | 'filesRead'
  | 'filesCreated'
  | 'filesChanged'
  | 'pendingApprovalIds'
  | 'errors'
  | 'retries'
>;
