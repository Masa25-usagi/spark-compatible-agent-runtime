import type {
  ActionOperation,
  ActionSpec,
  ApprovalDisclosure,
  JsonValue,
  PolicyDecision,
  PolicyProfile,
} from '../domain/types.js';
import { containsSecretMaterial, safeSummary } from '../security/redaction.js';

const APPROVAL_OPERATIONS = new Set<ActionOperation>([
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
]);

const TAKE_CONTROL_OPERATIONS = new Set<ActionOperation>([
  'enter_secret',
  'authentication',
  'payment',
  'two_factor',
  'captcha',
]);

const SAFE_OPERATIONS = new Set<ActionOperation>([
  'read',
  'search',
  'summarize',
  'analyze',
  'create_file',
  'draft',
]);

const HARMFUL_SHELL_PATTERNS = [
  /rm\s+-(?:[a-z]*r[a-z]*f|[a-z]*f[a-z]*r)\s+(?:\/|~|\$HOME)(?:\s|$)/i,
  /mkfs(?:\.|\s)/i,
  /diskutil\s+eraseDisk/i,
  /\bdd\s+if=/i,
  /shutdown\b|reboot\b|poweroff\b/i,
  /:\(\)\s*\{[^}]*:\|[^}]*&[^}]*\}/,
];

const APPROVAL_SHELL_PATTERNS = [
  /\bsudo\b/i,
  /\brm\b|\brmdir\b/i,
  /\b(?:npm|pnpm|yarn|pip|brew)\s+install\b/i,
  /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sh|bash|zsh)\b/i,
  /\bgit\s+(?:reset\s+--hard|rebase|filter-branch|filter-repo)\b/i,
  /\b(?:diskutil|fdisk)\b/i,
  /\b(?:defaults\s+write|networksetup)\b/i,
  /\b(?:curl|wget|scp|rsync)\b/i,
];

function getCommand(payload: JsonValue | undefined): string {
  if (
    payload !== undefined &&
    payload !== null &&
    typeof payload === 'object' &&
    !Array.isArray(payload)
  ) {
    const command = payload.command;
    return typeof command === 'string' ? command : safeSummary(payload);
  }
  return typeof payload === 'string' ? payload : safeSummary(payload);
}

function buildDisclosure(action: ActionSpec): ApprovalDisclosure {
  return {
    operation: action.operation,
    targetSummary: safeSummary(action.target),
    beforeSummary: safeSummary(action.before),
    afterSummary: safeSummary(action.after),
    itemCount: action.itemCount ?? 1,
    dataSizeBytes: action.dataSizeBytes ?? null,
    recipient: action.recipient ?? null,
    amount: action.amount ?? null,
    reversible: action.reversible ?? false,
    undoMethod: action.undoMethod ?? null,
    tool: action.tool,
    connector: action.connector,
    originatingTask: action.originatingTask,
  };
}

function approvalDecision(
  action: ActionSpec,
  profile: PolicyProfile,
  reason: string,
  policyRule: string,
  confirmationRequired: boolean,
): PolicyDecision {
  return {
    outcome: 'require_approval',
    profile,
    reason,
    policyRule,
    confirmationRequired,
    disclosure: buildDisclosure(action),
  };
}

export class PolicyEngine {
  public evaluate(action: ActionSpec, profile: PolicyProfile): PolicyDecision {
    if (action.operation === 'prohibited') {
      return {
        outcome: 'deny',
        profile,
        reason: 'The requested operation is explicitly prohibited by the safety policy.',
        policyRule: 'prohibited-actions',
        confirmationRequired: false,
        disclosure: null,
      };
    }

    if (TAKE_CONTROL_OPERATIONS.has(action.operation)) {
      return {
        outcome: 'take_control',
        profile,
        reason:
          'The task requires the user to enter or handle authentication, payment, or secret data.',
        policyRule: 'secret-and-authentication-boundary',
        confirmationRequired: false,
        disclosure: null,
      };
    }

    if (action.payload !== undefined && containsSecretMaterial(action.payload)) {
      return {
        outcome: 'take_control',
        profile,
        reason: 'Sensitive credentials or secret material must remain under user control.',
        policyRule: 'secret-and-authentication-boundary',
        confirmationRequired: false,
        disclosure: null,
      };
    }

    if (action.operation === 'shell') {
      const command = getCommand(action.payload);
      if (HARMFUL_SHELL_PATTERNS.some((pattern) => pattern.test(command))) {
        return {
          outcome: 'deny',
          profile,
          reason: 'The shell command matches a prohibited destructive or harmful pattern.',
          policyRule: 'prohibited-shell-operations',
          confirmationRequired: false,
          disclosure: null,
        };
      }
      if (APPROVAL_SHELL_PATTERNS.some((pattern) => pattern.test(command))) {
        return approvalDecision(
          action,
          profile,
          `Shell approval is required for the full command and its impact: ${command}`,
          'dangerous-shell-operations',
          false,
        );
      }
    }

    const isBulkGoogleTasksOperation =
      action.connector === 'google-tasks' &&
      (action.itemCount ?? 1) > 1 &&
      new Set<ActionOperation>(['edit_data', 'delete_to_trash', 'delete_permanently']).has(
        action.operation,
      );

    if (isBulkGoogleTasksOperation) {
      if (profile === 'spark-public-parity') {
        return {
          outcome: 'allow',
          profile,
          reason:
            'The public-parity profile preserves the documented Google Tasks bulk-operation exception.',
          policyRule: 'google-tasks-public-parity-exception',
          confirmationRequired: false,
          disclosure: null,
        };
      }
      return approvalDecision(
        action,
        profile,
        'Bulk Google Tasks updates and deletions require explicit confirmation in the plus profile.',
        'google-tasks-bulk-confirmation',
        true,
      );
    }

    if (APPROVAL_OPERATIONS.has(action.operation)) {
      return approvalDecision(
        action,
        profile,
        `The ${action.operation} operation changes or transmits external state.`,
        'external-side-effect-approval',
        false,
      );
    }

    if (SAFE_OPERATIONS.has(action.operation)) {
      return {
        outcome: 'allow',
        profile,
        reason: 'The operation is local, read-only, analytical, or a draft action.',
        policyRule: 'automatic-safe-operations',
        confirmationRequired: false,
        disclosure: null,
      };
    }

    return {
      outcome: 'deny',
      profile,
      reason: `No policy rule permits operation ${action.operation}.`,
      policyRule: 'default-deny',
      confirmationRequired: false,
      disclosure: null,
    };
  }
}
