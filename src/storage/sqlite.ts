import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import { WORKER_TASK_STATUSES } from '../domain/types.js';
import type {
  ApprovalRecord,
  ApprovalStatus,
  AuditEvent,
  JsonValue,
  PolicyProfile,
  RuntimeEvent,
  ScheduleControlRecord,
  ScheduleRecord,
  SkillRecord,
  TaskControlRecord,
  TaskRecord,
  TaskStatus,
  WorkerTaskStatus,
  DispatchMode,
  DispatchStatus,
} from '../domain/types.js';
import type { Clock } from '../shared/clock.js';
import { systemClock } from '../shared/clock.js';

type SqlRow = Record<string, unknown>;

type TaskRow = {
  id: string;
  title: string;
  instruction: string | null;
  status: TaskStatus;
  profile: PolicyProfile;
  agent: string;
  model: string;
  harness: string;
  created_at: string;
  updated_at: string;
  current_step: string;
  planned_steps_json: string;
  completed_steps_json: string;
  pending_steps_json: string;
  used_skills_json: string;
  used_connectors_json: string;
  files_read_json: string;
  files_created_json: string;
  files_changed_json: string;
  pending_approval_ids_json: string;
  errors_json: string;
  retries: number;
  stop_reason: string | null;
  take_control_reason: string | null;
};

type ScheduleRow = {
  id: string;
  name: string;
  enabled: number;
  interval_ms: number;
  next_run_at: string;
  payload_json: string;
  created_at: string;
  updated_at: string;
};

type SkillRow = {
  name: string;
  description: string;
  instructions: string;
  enabled: number;
  created_at: string;
  updated_at: string;
};

type EventRow = {
  id: string;
  task_id: string;
  kind: string;
  payload_json: string;
  occurred_at: string;
};

type EventWorkflowRow = {
  event_id: string;
  task_id: string;
  actions_json: string;
  next_index: number;
  expected_approval_action_id: string | null;
  status: EventWorkflowStatus;
  updated_at: string;
};

type ApprovalRow = {
  id: string;
  task_id: string;
  action_id: string;
  action_digest: string;
  action_json: string;
  status: ApprovalStatus;
  confirmation_required: number;
  disclosure_json: string;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
  decided_by: string | null;
  decision_reason: string | null;
  consumed_at: string | null;
};

type AuditRow = {
  sequence: number;
  id: string;
  timestamp: string;
  task_id: string;
  agent: string;
  model: string;
  harness: string;
  tool: string;
  args_json: string;
  approval_json: string | null;
  decision: AuditEvent['decision'];
  result_json: string | null;
  changed_targets_json: string;
  undo_guidance: string | null;
  previous_hash: string | null;
  event_hash: string;
};

type SqliteStoreOptions = {
  migrationDir?: string;
  clock?: Clock;
};

export type EventClaim = {
  eventId: string;
  claimToken: string;
  claimOwnerPid: number;
  claimExpiresAt: string;
};

export type EventWorkflowStatus =
  'running' | 'waiting_for_approval' | 'completed' | 'failed' | 'take_control' | 'denied';

export type EventWorkflowRecord = {
  eventId: string;
  taskId: string;
  actions: JsonValue[];
  nextIndex: number;
  expectedApprovalActionId: string | null;
  status: EventWorkflowStatus;
  updatedAt: string;
};

export const DEFAULT_EVENT_CLAIM_LEASE_MS = 5 * 60 * 1_000;

function jsonEncode(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new Error('Value cannot be persisted as JSON');
  }
  return encoded;
}

function jsonDecode<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function stringValue(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') {
    throw new Error(`SQLite row field ${key} is not a string`);
  }
  return value;
}

function nullableStringValue(row: SqlRow, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(`SQLite row field ${key} is not a nullable string`);
  }
  return value;
}

function numberValue(row: SqlRow, key: string): number {
  const value = row[key];
  if (typeof value !== 'number') {
    throw new Error(`SQLite row field ${key} is not a number`);
  }
  return value;
}

function ownerProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code =
      error !== null && typeof error === 'object' && 'code' in error
        ? (error.code as unknown)
        : null;
    // Only ESRCH proves that the owner is gone. Permission and platform errors are unknown.
    return code !== 'ESRCH';
  }
}

function workerTaskStatusValue(row: SqlRow, key: string): WorkerTaskStatus {
  const value = stringValue(row, key);
  if (!(WORKER_TASK_STATUSES as readonly string[]).includes(value)) {
    throw new Error(`SQLite row field ${key} is not a valid worker task status`);
  }
  return value as WorkerTaskStatus;
}

function taskFromRow(row: SqlRow): TaskRecord {
  return {
    id: stringValue(row, 'id'),
    title: stringValue(row, 'title'),
    instruction: nullableStringValue(row, 'instruction'),
    status: stringValue(row, 'status') as TaskStatus,
    profile: stringValue(row, 'profile') as PolicyProfile,
    agent: stringValue(row, 'agent'),
    model: stringValue(row, 'model'),
    harness: stringValue(row, 'harness'),
    createdAt: stringValue(row, 'created_at'),
    updatedAt: stringValue(row, 'updated_at'),
    currentStep: stringValue(row, 'current_step'),
    plannedSteps: jsonDecode(stringValue(row, 'planned_steps_json'), []),
    completedSteps: jsonDecode(stringValue(row, 'completed_steps_json'), []),
    pendingSteps: jsonDecode(stringValue(row, 'pending_steps_json'), []),
    usedSkills: jsonDecode(stringValue(row, 'used_skills_json'), []),
    usedConnectors: jsonDecode(stringValue(row, 'used_connectors_json'), []),
    filesRead: jsonDecode(stringValue(row, 'files_read_json'), []),
    filesCreated: jsonDecode(stringValue(row, 'files_created_json'), []),
    filesChanged: jsonDecode(stringValue(row, 'files_changed_json'), []),
    pendingApprovalIds: jsonDecode(stringValue(row, 'pending_approval_ids_json'), []),
    errors: jsonDecode(stringValue(row, 'errors_json'), []),
    retries: numberValue(row, 'retries'),
    stopReason: nullableStringValue(row, 'stop_reason'),
    takeControlReason: nullableStringValue(row, 'take_control_reason'),
    dispatchMode: nullableStringValue(row, 'dispatch_mode') as DispatchMode | null,
    dispatchStatus: (stringValue(row, 'dispatch_status') ?? 'not_started') as DispatchStatus,
    dispatchSummary: nullableStringValue(row, 'dispatch_summary'),
    dispatchStartedAt: nullableStringValue(row, 'dispatch_started_at'),
    dispatchFinishedAt: nullableStringValue(row, 'dispatch_finished_at'),
  };
}

function scheduleFromRow(row: SqlRow): ScheduleRecord {
  return {
    id: stringValue(row, 'id'),
    name: stringValue(row, 'name'),
    enabled: numberValue(row, 'enabled') === 1,
    intervalMs: numberValue(row, 'interval_ms'),
    nextRunAt: stringValue(row, 'next_run_at'),
    payload: jsonDecode<JsonValue>(stringValue(row, 'payload_json'), null),
    createdAt: stringValue(row, 'created_at'),
    updatedAt: stringValue(row, 'updated_at'),
  };
}

function skillFromRow(row: SqlRow): SkillRecord {
  return {
    name: stringValue(row, 'name'),
    description: stringValue(row, 'description'),
    instructions: stringValue(row, 'instructions'),
    enabled: numberValue(row, 'enabled') === 1,
    createdAt: stringValue(row, 'created_at'),
    updatedAt: stringValue(row, 'updated_at'),
  };
}

function taskControlFromRow(row: SqlRow): TaskControlRecord {
  return {
    taskId: stringValue(row, 'task_id'),
    status: workerTaskStatusValue(row, 'status'),
    paused: numberValue(row, 'paused') === 1,
    pauseReason: nullableStringValue(row, 'pause_reason'),
    enqueuedAt: stringValue(row, 'enqueued_at'),
    startedAt: nullableStringValue(row, 'started_at'),
    finishedAt: nullableStringValue(row, 'finished_at'),
    updatedAt: stringValue(row, 'updated_at'),
    error: nullableStringValue(row, 'error'),
  };
}

function scheduleControlFromRow(row: SqlRow): ScheduleControlRecord {
  return {
    scheduleId: stringValue(row, 'schedule_id'),
    paused: numberValue(row, 'paused') === 1,
    enabledBeforePause: numberValue(row, 'enabled_before_pause') === 1,
    reason: nullableStringValue(row, 'reason'),
    updatedAt: stringValue(row, 'updated_at'),
  };
}

function eventFromRow(row: SqlRow): RuntimeEvent {
  return {
    id: stringValue(row, 'id'),
    taskId: stringValue(row, 'task_id'),
    kind: stringValue(row, 'kind'),
    payload: jsonDecode<JsonValue>(stringValue(row, 'payload_json'), null),
    occurredAt: stringValue(row, 'occurred_at'),
  };
}

function eventWorkflowFromRow(row: SqlRow): EventWorkflowRecord {
  const status = stringValue(row, 'status') as EventWorkflowStatus;
  const nextIndex = numberValue(row, 'next_index');
  const actions = jsonDecode<JsonValue[]>(stringValue(row, 'actions_json'), []);
  if (!Array.isArray(actions) || nextIndex < 0 || nextIndex > actions.length) {
    throw new Error('SQLite event workflow contains an invalid action index');
  }
  return {
    eventId: stringValue(row, 'event_id'),
    taskId: stringValue(row, 'task_id'),
    actions,
    nextIndex,
    expectedApprovalActionId: nullableStringValue(row, 'expected_approval_action_id'),
    status,
    updatedAt: stringValue(row, 'updated_at'),
  };
}

function approvalFromRow(row: SqlRow): ApprovalRecord {
  return {
    id: stringValue(row, 'id'),
    taskId: stringValue(row, 'task_id'),
    actionId: stringValue(row, 'action_id'),
    actionDigest: stringValue(row, 'action_digest'),
    action: jsonDecode<ApprovalRecord['action']>(
      stringValue(row, 'action_json'),
      {} as ApprovalRecord['action'],
    ),
    status: stringValue(row, 'status') as ApprovalStatus,
    confirmationRequired: numberValue(row, 'confirmation_required') === 1,
    disclosure: jsonDecode<ApprovalRecord['disclosure']>(
      stringValue(row, 'disclosure_json'),
      {} as ApprovalRecord['disclosure'],
    ),
    createdAt: stringValue(row, 'created_at'),
    expiresAt: stringValue(row, 'expires_at'),
    decidedAt: nullableStringValue(row, 'decided_at'),
    decidedBy: nullableStringValue(row, 'decided_by'),
    decisionReason: nullableStringValue(row, 'decision_reason'),
    consumedAt: nullableStringValue(row, 'consumed_at'),
  };
}

function auditFromRow(row: SqlRow): AuditEvent {
  return {
    id: stringValue(row, 'id'),
    timestamp: stringValue(row, 'timestamp'),
    taskId: stringValue(row, 'task_id'),
    agent: stringValue(row, 'agent'),
    model: stringValue(row, 'model'),
    harness: stringValue(row, 'harness'),
    tool: stringValue(row, 'tool'),
    args: jsonDecode<JsonValue>(stringValue(row, 'args_json'), null),
    approval:
      row['approval_json'] === null
        ? null
        : jsonDecode<JsonValue>(stringValue(row, 'approval_json'), null),
    decision:
      row['decision'] === null ? null : (stringValue(row, 'decision') as AuditEvent['decision']),
    result:
      row['result_json'] === null
        ? null
        : jsonDecode<JsonValue>(stringValue(row, 'result_json'), null),
    changedTargets: jsonDecode<string[]>(stringValue(row, 'changed_targets_json'), []),
    undoGuidance: nullableStringValue(row, 'undo_guidance'),
    previousHash: nullableStringValue(row, 'previous_hash'),
    eventHash: stringValue(row, 'event_hash'),
  };
}

export class SQLiteStore {
  public readonly database: DatabaseSync;

  private readonly clock: Clock;

  public constructor(dbPath: string, options: SqliteStoreOptions = {}) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(resolve(dbPath)), { recursive: true });
    }
    this.database = new DatabaseSync(dbPath);
    this.database.exec('PRAGMA busy_timeout = 5000');
    if (dbPath !== ':memory:') this.database.exec('PRAGMA journal_mode = WAL');
    this.clock = options.clock ?? systemClock;
    this.applyMigrations(options.migrationDir);
  }

  public close(): void {
    this.database.close();
  }

  public withImmediateTransaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  public createTask(task: TaskRecord): void {
    this.database
      .prepare(
        `INSERT INTO tasks (
          id, title, instruction, status, profile, agent, model, harness, created_at, updated_at,
          current_step, planned_steps_json, completed_steps_json, pending_steps_json,
          used_skills_json, used_connectors_json, files_read_json, files_created_json,
          files_changed_json, pending_approval_ids_json, errors_json, retries,
          stop_reason, take_control_reason,
          dispatch_mode, dispatch_status, dispatch_summary, dispatch_started_at, dispatch_finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.title,
        task.instruction,
        task.status,
        task.profile,
        task.agent,
        task.model,
        task.harness,
        task.createdAt,
        task.updatedAt,
        task.currentStep,
        jsonEncode(task.plannedSteps),
        jsonEncode(task.completedSteps),
        jsonEncode(task.pendingSteps),
        jsonEncode(task.usedSkills),
        jsonEncode(task.usedConnectors),
        jsonEncode(task.filesRead),
        jsonEncode(task.filesCreated),
        jsonEncode(task.filesChanged),
        jsonEncode(task.pendingApprovalIds),
        jsonEncode(task.errors),
        task.retries,
        task.stopReason,
        task.takeControlReason,
        task.dispatchMode,
        task.dispatchStatus,
        task.dispatchSummary,
        task.dispatchStartedAt,
        task.dispatchFinishedAt,
      );
  }

  public getTask(id: string): TaskRecord | null {
    const row = this.database.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as
      SqlRow | undefined;
    return row === undefined ? null : taskFromRow(row);
  }

  public listTasks(): TaskRecord[] {
    return (this.database.prepare('SELECT * FROM tasks ORDER BY created_at').all() as SqlRow[]).map(
      taskFromRow,
    );
  }

  public updateTask(task: TaskRecord): void {
    this.database
      .prepare(
        `UPDATE tasks SET
          title = ?, instruction = ?, status = ?, profile = ?, agent = ?, model = ?, harness = ?,
          updated_at = ?, current_step = ?, planned_steps_json = ?, completed_steps_json = ?,
          pending_steps_json = ?, used_skills_json = ?, used_connectors_json = ?,
          files_read_json = ?, files_created_json = ?, files_changed_json = ?,
          pending_approval_ids_json = ?, errors_json = ?, retries = ?, stop_reason = ?,
          take_control_reason = ?,
          dispatch_mode = ?, dispatch_status = ?, dispatch_summary = ?,
          dispatch_started_at = ?, dispatch_finished_at = ?
        WHERE id = ?`,
      )
      .run(
        task.title,
        task.instruction,
        task.status,
        task.profile,
        task.agent,
        task.model,
        task.harness,
        task.updatedAt,
        task.currentStep,
        jsonEncode(task.plannedSteps),
        jsonEncode(task.completedSteps),
        jsonEncode(task.pendingSteps),
        jsonEncode(task.usedSkills),
        jsonEncode(task.usedConnectors),
        jsonEncode(task.filesRead),
        jsonEncode(task.filesCreated),
        jsonEncode(task.filesChanged),
        jsonEncode(task.pendingApprovalIds),
        jsonEncode(task.errors),
        task.retries,
        task.stopReason,
        task.takeControlReason,
        task.dispatchMode,
        task.dispatchStatus,
        task.dispatchSummary,
        task.dispatchStartedAt,
        task.dispatchFinishedAt,
        task.id,
      );
  }

  public createTaskControl(control: TaskControlRecord): void {
    this.database
      .prepare(
        `INSERT INTO worker_tasks (
          task_id, status, paused, pause_reason, enqueued_at, started_at, finished_at,
          updated_at, error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        control.taskId,
        control.status,
        control.paused ? 1 : 0,
        control.pauseReason,
        control.enqueuedAt,
        control.startedAt,
        control.finishedAt,
        control.updatedAt,
        control.error,
      );
  }

  public upsertTaskControl(control: TaskControlRecord): void {
    this.database
      .prepare(
        `INSERT INTO worker_tasks (
          task_id, status, paused, pause_reason, enqueued_at, started_at, finished_at,
          updated_at, error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET
          status = excluded.status,
          paused = excluded.paused,
          pause_reason = excluded.pause_reason,
          enqueued_at = excluded.enqueued_at,
          started_at = excluded.started_at,
          finished_at = excluded.finished_at,
          updated_at = excluded.updated_at,
          error = excluded.error`,
      )
      .run(
        control.taskId,
        control.status,
        control.paused ? 1 : 0,
        control.pauseReason,
        control.enqueuedAt,
        control.startedAt,
        control.finishedAt,
        control.updatedAt,
        control.error,
      );
  }

  public getTaskControl(taskId: string): TaskControlRecord | null {
    const row = this.database
      .prepare('SELECT * FROM worker_tasks WHERE task_id = ?')
      .get(taskId) as SqlRow | undefined;
    return row === undefined ? null : taskControlFromRow(row);
  }

  public listTaskControls(): TaskControlRecord[] {
    return (
      this.database
        .prepare('SELECT * FROM worker_tasks ORDER BY enqueued_at, task_id')
        .all() as SqlRow[]
    ).map(taskControlFromRow);
  }

  public updateTaskControl(control: TaskControlRecord): void {
    this.database
      .prepare(
        `UPDATE worker_tasks SET
          status = ?, paused = ?, pause_reason = ?, enqueued_at = ?, started_at = ?,
          finished_at = ?, updated_at = ?, error = ?
        WHERE task_id = ?`,
      )
      .run(
        control.status,
        control.paused ? 1 : 0,
        control.pauseReason,
        control.enqueuedAt,
        control.startedAt,
        control.finishedAt,
        control.updatedAt,
        control.error,
        control.taskId,
      );
  }

  public deleteTaskControl(taskId: string): void {
    this.database.prepare('DELETE FROM worker_tasks WHERE task_id = ?').run(taskId);
  }

  public setTaskPaused(
    taskId: string,
    paused: boolean,
    now: string,
    reason: string | null = null,
  ): TaskControlRecord {
    const current = this.getTaskControl(taskId);
    if (current === null) {
      const created: TaskControlRecord = {
        taskId,
        status: 'queued',
        paused,
        pauseReason: paused ? reason : null,
        enqueuedAt: now,
        startedAt: null,
        finishedAt: null,
        updatedAt: now,
        error: null,
      };
      this.createTaskControl(created);
      return created;
    }

    const updated: TaskControlRecord = {
      ...current,
      paused,
      pauseReason: paused ? reason : null,
      updatedAt: now,
    };
    this.updateTaskControl(updated);
    return updated;
  }

  public isTaskPaused(taskId: string): boolean {
    return this.getTaskControl(taskId)?.paused ?? false;
  }

  public recoverRunningTaskControls(now: string): number {
    const result = this.database
      .prepare(
        `UPDATE worker_tasks SET
          status = 'failed', finished_at = ?, updated_at = ?,
          error = 'Worker process exited before completion; runner must be explicitly rehydrated'
        WHERE status = 'running'`,
      )
      .run(now, now);
    return Number(result.changes);
  }

  public appendEvent(event: RuntimeEvent): void {
    this.database
      .prepare(
        `INSERT INTO runtime_events (id, task_id, kind, payload_json, occurred_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(event.id, event.taskId, event.kind, jsonEncode(event.payload), event.occurredAt);
  }

  public listEvents(taskId: string): RuntimeEvent[] {
    return (
      this.database
        .prepare('SELECT * FROM runtime_events WHERE task_id = ? ORDER BY occurred_at, rowid')
        .all(taskId) as SqlRow[]
    ).map(eventFromRow);
  }

  public getEvent(id: string): RuntimeEvent | null {
    const row = this.database.prepare('SELECT * FROM runtime_events WHERE id = ?').get(id) as
      SqlRow | undefined;
    return row === undefined ? null : eventFromRow(row);
  }

  public getEventWorkflow(eventId: string): EventWorkflowRecord | null {
    const row = this.database
      .prepare('SELECT * FROM event_workflows WHERE event_id = ?')
      .get(eventId) as SqlRow | undefined;
    return row === undefined ? null : eventWorkflowFromRow(row);
  }

  public getEventWorkflowForApproval(taskId: string, actionId: string): EventWorkflowRecord | null {
    const row = this.database
      .prepare(
        `SELECT * FROM event_workflows
         WHERE task_id = ? AND expected_approval_action_id = ?
           AND status = 'waiting_for_approval'`,
      )
      .get(taskId, actionId) as SqlRow | undefined;
    return row === undefined ? null : eventWorkflowFromRow(row);
  }

  public getWaitingEventWorkflow(taskId: string): EventWorkflowRecord | null {
    const row = this.database
      .prepare(
        `SELECT * FROM event_workflows
         WHERE task_id = ? AND status = 'waiting_for_approval'
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(taskId) as SqlRow | undefined;
    return row === undefined ? null : eventWorkflowFromRow(row);
  }

  public createEventWorkflow(
    eventId: string,
    taskId: string,
    actions: JsonValue[],
    now = this.clock.now().toISOString(),
  ): EventWorkflowRecord {
    return this.withImmediateTransaction(() => {
      this.database
        .prepare(
          `INSERT OR IGNORE INTO event_workflows
             (event_id, task_id, actions_json, next_index,
              expected_approval_action_id, status, updated_at)
           VALUES (?, ?, ?, 0, NULL, 'running', ?)`,
        )
        .run(eventId, taskId, jsonEncode(actions), now);
      const workflow = this.getEventWorkflow(eventId);
      if (workflow === null) throw new Error(`Event workflow ${eventId} was not created`);
      if (
        workflow.taskId !== taskId ||
        JSON.stringify(workflow.actions) !== JSON.stringify(actions)
      ) {
        throw new Error(`Event workflow ${eventId} does not match the event payload`);
      }
      return workflow;
    });
  }

  public advanceEventWorkflow(
    eventId: string,
    taskId: string,
    expectedIndex: number,
    now = this.clock.now().toISOString(),
  ): EventWorkflowRecord {
    return this.withImmediateTransaction(() => {
      const workflow = this.getEventWorkflow(eventId);
      if (
        workflow === null ||
        workflow.taskId !== taskId ||
        workflow.status !== 'running' ||
        workflow.nextIndex !== expectedIndex ||
        expectedIndex >= workflow.actions.length
      ) {
        throw new Error(`Event workflow ${eventId} cannot advance at index ${expectedIndex}`);
      }
      const nextIndex = expectedIndex + 1;
      const status: EventWorkflowStatus =
        nextIndex >= workflow.actions.length ? 'completed' : 'running';
      const result = this.database
        .prepare(
          `UPDATE event_workflows
           SET next_index = ?, expected_approval_action_id = NULL, status = ?, updated_at = ?
           WHERE event_id = ? AND task_id = ? AND status = 'running' AND next_index = ?`,
        )
        .run(nextIndex, status, now, eventId, taskId, expectedIndex);
      if (Number(result.changes) !== 1) {
        throw new Error(`Event workflow ${eventId} advance was lost`);
      }
      return this.getEventWorkflow(eventId)!;
    });
  }

  public waitForEventWorkflowApproval(
    eventId: string,
    taskId: string,
    expectedIndex: number,
    actionId: string,
    now = this.clock.now().toISOString(),
  ): EventWorkflowRecord {
    return this.withImmediateTransaction(() => {
      const result = this.database
        .prepare(
          `UPDATE event_workflows
           SET expected_approval_action_id = ?, status = 'waiting_for_approval', updated_at = ?
           WHERE event_id = ? AND task_id = ? AND status = 'running' AND next_index = ?`,
        )
        .run(actionId, now, eventId, taskId, expectedIndex);
      if (Number(result.changes) !== 1) {
        throw new Error(`Event workflow ${eventId} cannot wait for approval`);
      }
      return this.getEventWorkflow(eventId)!;
    });
  }

  public setEventWorkflowStatus(
    eventId: string,
    taskId: string,
    status: EventWorkflowStatus,
    expectedApprovalActionId: string | null = null,
    now = this.clock.now().toISOString(),
  ): EventWorkflowRecord {
    return this.withImmediateTransaction(() => {
      const result = this.database
        .prepare(
          `UPDATE event_workflows
           SET status = ?, expected_approval_action_id = NULL, updated_at = ?
           WHERE event_id = ? AND task_id = ?
             AND status IN ('running', 'waiting_for_approval')
             AND ((? IS NULL AND expected_approval_action_id IS NULL)
               OR expected_approval_action_id = ?)`,
        )
        .run(status, now, eventId, taskId, expectedApprovalActionId, expectedApprovalActionId);
      if (Number(result.changes) !== 1) {
        throw new Error(`Event workflow ${eventId} status transition was rejected`);
      }
      return this.getEventWorkflow(eventId)!;
    });
  }

  public approveEventWorkflow(
    eventId: string,
    taskId: string,
    expectedActionId: string,
    now = this.clock.now().toISOString(),
  ): EventWorkflowRecord {
    return this.withImmediateTransaction(() => {
      const workflow = this.getEventWorkflow(eventId);
      if (
        workflow === null ||
        workflow.taskId !== taskId ||
        workflow.status !== 'waiting_for_approval' ||
        workflow.expectedApprovalActionId !== expectedActionId
      ) {
        throw new Error(`Event workflow ${eventId} approval action does not match`);
      }
      const nextIndex = workflow.nextIndex + 1;
      const status: EventWorkflowStatus =
        nextIndex >= workflow.actions.length ? 'completed' : 'running';
      const updated = this.database
        .prepare(
          `UPDATE event_workflows
           SET next_index = ?, expected_approval_action_id = NULL, status = ?, updated_at = ?
           WHERE event_id = ? AND task_id = ? AND status = 'waiting_for_approval'
             AND next_index = ? AND expected_approval_action_id = ?`,
        )
        .run(nextIndex, status, now, eventId, taskId, workflow.nextIndex, expectedActionId);
      if (Number(updated.changes) !== 1) {
        throw new Error(`Event workflow ${eventId} approval advance was lost`);
      }

      if (status === 'running') {
        const queued = this.database
          .prepare(
            `UPDATE event_queue SET status = 'queued', error = NULL,
               claim_token = NULL, claim_owner_pid = NULL, claim_expires_at = NULL, updated_at = ?
             WHERE event_id = ? AND status IN ('queued', 'running', 'failed', 'completed')`,
          )
          .run(now, eventId);
        if (Number(queued.changes) !== 1) {
          throw new Error(`Event ${eventId} could not be requeued after approval`);
        }
      } else {
        this.database
          .prepare(
            `UPDATE event_queue SET status = 'completed', error = NULL,
               claim_token = NULL, claim_owner_pid = NULL, claim_expires_at = NULL, updated_at = ?
             WHERE event_id = ? AND status IN ('queued', 'running', 'failed', 'completed')`,
          )
          .run(now, eventId);
      }
      return this.getEventWorkflow(eventId)!;
    });
  }

  public enqueueEvent(event: RuntimeEvent): void {
    this.withImmediateTransaction(() => {
      this.appendEvent(event);
      this.database
        .prepare(
          `INSERT INTO event_queue (event_id, status, attempts, error, updated_at)
           VALUES (?, 'queued', 0, NULL, ?)`,
        )
        .run(event.id, event.occurredAt);
    });
  }

  public listPendingEvents(now = this.clock.now().toISOString()): RuntimeEvent[] {
    return (
      this.database
        .prepare(
          `SELECT events.* FROM runtime_events AS events
           JOIN event_queue AS queue ON queue.event_id = events.id
           WHERE queue.status IN ('queued', 'failed')
              OR (queue.status = 'running' AND
                  queue.claim_owner_pid IS NOT NULL AND queue.claim_expires_at IS NOT NULL AND
                  queue.claim_expires_at <= ?)
           ORDER BY queue.updated_at, events.occurred_at`,
        )
        .all(now) as SqlRow[]
    ).map(eventFromRow);
  }

  public claimEvent(
    eventId: string,
    now: string,
    leaseMs = DEFAULT_EVENT_CLAIM_LEASE_MS,
  ): EventClaim | null {
    if (!Number.isInteger(leaseMs) || leaseMs <= 0) {
      throw new Error('Event claim lease must be a positive integer in milliseconds');
    }
    const claimToken = `event_claim_${process.pid}_${randomUUID()}`;
    const claimOwnerPid = process.pid;
    const claimExpiresAt = new Date(new Date(now).getTime() + leaseMs).toISOString();
    return this.withImmediateTransaction(() => {
      const result = this.database
        .prepare(
          `UPDATE event_queue SET status = 'running', attempts = attempts + 1,
             error = NULL, claim_token = ?, claim_owner_pid = ?, claim_expires_at = ?,
             updated_at = ?
           WHERE event_id = ? AND status IN ('queued', 'failed')`,
        )
        .run(claimToken, claimOwnerPid, claimExpiresAt, now, eventId);
      if (Number(result.changes) === 1) {
        return { eventId, claimToken, claimOwnerPid, claimExpiresAt };
      }

      const running = this.database
        .prepare(
          `SELECT claim_token, claim_owner_pid, claim_expires_at
           FROM event_queue
           WHERE event_id = ? AND status = 'running'
             AND claim_expires_at IS NOT NULL AND claim_expires_at <= ?`,
        )
        .get(eventId, now) as SqlRow | undefined;
      if (running === undefined) return null;
      const previousToken = nullableStringValue(running, 'claim_token');
      const previousOwner = running['claim_owner_pid'];
      if (previousToken === null || typeof previousOwner !== 'number') return null;
      if (ownerProcessIsAlive(previousOwner)) return null;

      const reclaimed = this.database
        .prepare(
          `UPDATE event_queue SET status = 'running', attempts = attempts + 1,
             error = NULL, claim_token = ?, claim_owner_pid = ?, claim_expires_at = ?,
             updated_at = ?
           WHERE event_id = ? AND status = 'running' AND claim_token = ?
             AND claim_owner_pid = ? AND claim_expires_at <= ?`,
        )
        .run(
          claimToken,
          claimOwnerPid,
          claimExpiresAt,
          now,
          eventId,
          previousToken,
          previousOwner,
          now,
        );
      return Number(reclaimed.changes) === 1
        ? { eventId, claimToken, claimOwnerPid, claimExpiresAt }
        : null;
    });
  }

  public completeEvent(claim: EventClaim, now: string): boolean {
    const result = this.database
      .prepare(
        `UPDATE event_queue SET status = 'completed', error = NULL,
         claim_token = NULL, claim_owner_pid = NULL, claim_expires_at = NULL, updated_at = ?
         WHERE event_id = ? AND status = 'running' AND claim_token = ?`,
      )
      .run(now, claim.eventId, claim.claimToken);
    return Number(result.changes) === 1;
  }

  public failEvent(claim: EventClaim, error: string, now: string): boolean {
    const result = this.database
      .prepare(
        `UPDATE event_queue SET status = 'failed', error = ?,
         claim_token = NULL, claim_owner_pid = NULL, claim_expires_at = NULL, updated_at = ?
         WHERE event_id = ? AND status = 'running' AND claim_token = ?`,
      )
      .run(error, now, claim.eventId, claim.claimToken);
    return Number(result.changes) === 1;
  }

  public eventQueueStatus(eventId: string): string | null {
    const row = this.database
      .prepare('SELECT status FROM event_queue WHERE event_id = ?')
      .get(eventId) as SqlRow | undefined;
    return row === undefined ? null : stringValue(row, 'status');
  }

  public createSchedule(schedule: ScheduleRecord): void {
    this.database
      .prepare(
        `INSERT INTO schedules (
          id, name, enabled, interval_ms, next_run_at, payload_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        schedule.id,
        schedule.name,
        schedule.enabled ? 1 : 0,
        schedule.intervalMs,
        schedule.nextRunAt,
        jsonEncode(schedule.payload),
        schedule.createdAt,
        schedule.updatedAt,
      );
  }

  public getSchedule(id: string): ScheduleRecord | null {
    const row = this.database.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as
      SqlRow | undefined;
    return row === undefined ? null : scheduleFromRow(row);
  }

  public listSchedules(): ScheduleRecord[] {
    return (
      this.database.prepare('SELECT * FROM schedules ORDER BY created_at').all() as SqlRow[]
    ).map(scheduleFromRow);
  }

  public updateSchedule(schedule: ScheduleRecord): void {
    this.database
      .prepare(
        `UPDATE schedules SET
          name = ?, enabled = ?, interval_ms = ?, next_run_at = ?, payload_json = ?,
          updated_at = ?
        WHERE id = ?`,
      )
      .run(
        schedule.name,
        schedule.enabled ? 1 : 0,
        schedule.intervalMs,
        schedule.nextRunAt,
        jsonEncode(schedule.payload),
        schedule.updatedAt,
        schedule.id,
      );
  }

  public claimDueSchedule(
    schedule: ScheduleRecord,
    event: RuntimeEvent,
    nextRunAt: string,
    now: string,
  ): boolean {
    return this.withImmediateTransaction(() => {
      const control = this.getScheduleControl(schedule.id);
      if (control?.paused) return false;
      const result = this.database
        .prepare(
          `UPDATE schedules SET next_run_at = ?, updated_at = ?
           WHERE id = ? AND enabled = 1 AND next_run_at = ? AND next_run_at <= ?`,
        )
        .run(nextRunAt, now, schedule.id, schedule.nextRunAt, now);
      if (Number(result.changes) !== 1) return false;
      this.appendEvent(event);
      this.database
        .prepare(
          `INSERT INTO event_queue (event_id, status, attempts, error, updated_at)
           VALUES (?, 'queued', 0, NULL, ?)`,
        )
        .run(event.id, now);
      return true;
    });
  }

  public getScheduleControl(scheduleId: string): ScheduleControlRecord | null {
    const row = this.database
      .prepare('SELECT * FROM schedule_controls WHERE schedule_id = ?')
      .get(scheduleId) as SqlRow | undefined;
    return row === undefined ? null : scheduleControlFromRow(row);
  }

  public upsertScheduleControl(control: ScheduleControlRecord): void {
    this.database
      .prepare(
        `INSERT INTO schedule_controls (
          schedule_id, paused, enabled_before_pause, reason, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(schedule_id) DO UPDATE SET
          paused = excluded.paused,
          enabled_before_pause = excluded.enabled_before_pause,
          reason = excluded.reason,
          updated_at = excluded.updated_at`,
      )
      .run(
        control.scheduleId,
        control.paused ? 1 : 0,
        control.enabledBeforePause ? 1 : 0,
        control.reason,
        control.updatedAt,
      );
  }

  public deleteScheduleControl(scheduleId: string): void {
    this.database.prepare('DELETE FROM schedule_controls WHERE schedule_id = ?').run(scheduleId);
  }

  public createSkill(skill: SkillRecord): void {
    this.database
      .prepare(
        `INSERT INTO skills (name, description, instructions, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        skill.name,
        skill.description,
        skill.instructions,
        skill.enabled ? 1 : 0,
        skill.createdAt,
        skill.updatedAt,
      );
  }

  public upsertSkill(skill: SkillRecord): void {
    this.database
      .prepare(
        `INSERT INTO skills (name, description, instructions, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           description = excluded.description,
           instructions = excluded.instructions,
           enabled = excluded.enabled,
           updated_at = excluded.updated_at`,
      )
      .run(
        skill.name,
        skill.description,
        skill.instructions,
        skill.enabled ? 1 : 0,
        skill.createdAt,
        skill.updatedAt,
      );
  }

  public getSkill(name: string): SkillRecord | null {
    const row = this.database.prepare('SELECT * FROM skills WHERE name = ?').get(name) as
      SkillRow | undefined;
    return row === undefined ? null : skillFromRow(row as unknown as SqlRow);
  }

  public listSkills(): SkillRecord[] {
    return (this.database.prepare('SELECT * FROM skills ORDER BY name').all() as SqlRow[]).map(
      skillFromRow,
    );
  }

  public deleteSkill(name: string): boolean {
    return Number(this.database.prepare('DELETE FROM skills WHERE name = ?').run(name).changes) > 0;
  }

  public claimTriggerEvent(
    source: string,
    eventKey: string,
    payload: JsonValue,
    receivedAt: string,
  ): boolean {
    const result = this.database
      .prepare(
        `INSERT OR IGNORE INTO trigger_events (source, event_key, payload_json, received_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(source, eventKey, jsonEncode(payload), receivedAt);
    return Number(result.changes) === 1;
  }

  public claimTriggerAndEnqueue(
    source: string,
    eventKey: string,
    triggerPayload: JsonValue,
    event: RuntimeEvent,
  ): boolean {
    return this.withImmediateTransaction(() => {
      const result = this.database
        .prepare(
          `INSERT OR IGNORE INTO trigger_events
             (source, event_key, payload_json, received_at, event_id)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(source, eventKey, jsonEncode(triggerPayload), event.occurredAt, event.id);
      if (Number(result.changes) !== 1) return false;
      this.appendEvent(event);
      this.database
        .prepare(
          `INSERT INTO event_queue (event_id, status, attempts, error, updated_at)
           VALUES (?, 'queued', 0, NULL, ?)`,
        )
        .run(event.id, event.occurredAt);
      return true;
    });
  }

  public getTriggerEvent(source: string, eventKey: string): RuntimeEvent | null {
    const row = this.database
      .prepare('SELECT event_id FROM trigger_events WHERE source = ? AND event_key = ?')
      .get(source, eventKey) as SqlRow | undefined;
    if (row === undefined) return null;
    const eventId = nullableStringValue(row, 'event_id');
    return eventId === null ? null : this.getEvent(eventId);
  }

  public tryAcquireRuntimeLease(
    leaseId: string,
    now: string,
    expiresAt: string,
    limit = 15,
  ): boolean {
    return this.withImmediateTransaction(() => {
      const rows = this.database
        .prepare('SELECT lease_id, owner_pid FROM runtime_leases')
        .all() as SqlRow[];
      for (const row of rows) {
        const owner = numberValue(row, 'owner_pid');
        if (!ownerProcessIsAlive(owner)) {
          this.database
            .prepare('DELETE FROM runtime_leases WHERE lease_id = ?')
            .run(stringValue(row, 'lease_id'));
        }
      }
      const countRow = this.database
        .prepare('SELECT COUNT(*) AS count FROM runtime_leases')
        .get() as SqlRow;
      if (numberValue(countRow, 'count') >= limit) return false;
      this.database
        .prepare(
          `INSERT INTO runtime_leases (lease_id, owner_pid, acquired_at, expires_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(leaseId, process.pid, now, expiresAt);
      return true;
    });
  }

  public releaseRuntimeLease(leaseId: string): void {
    this.database
      .prepare('DELETE FROM runtime_leases WHERE lease_id = ? AND owner_pid = ?')
      .run(leaseId, process.pid);
  }

  public createApproval(approval: ApprovalRecord): void {
    this.database
      .prepare(
        `INSERT INTO approvals (
          id, task_id, action_id, action_digest, action_json, status, confirmation_required,
          disclosure_json, created_at, expires_at, decided_at, decided_by, decision_reason,
          consumed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        approval.id,
        approval.taskId,
        approval.actionId,
        approval.actionDigest,
        jsonEncode(approval.action),
        approval.status,
        approval.confirmationRequired ? 1 : 0,
        jsonEncode(approval.disclosure),
        approval.createdAt,
        approval.expiresAt,
        approval.decidedAt,
        approval.decidedBy,
        approval.decisionReason,
        approval.consumedAt,
      );
  }

  public getApproval(id: string): ApprovalRecord | null {
    const row = this.database.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as
      SqlRow | undefined;
    return row === undefined ? null : approvalFromRow(row);
  }

  public listApprovals(taskId?: string): ApprovalRecord[] {
    const rows = (
      taskId === undefined
        ? this.database.prepare('SELECT * FROM approvals ORDER BY created_at').all()
        : this.database
            .prepare('SELECT * FROM approvals WHERE task_id = ? ORDER BY created_at')
            .all(taskId)
    ) as SqlRow[];
    return rows.map(approvalFromRow);
  }

  public markApprovalExpired(id: string, now: string): ApprovalRecord | null {
    this.database
      .prepare(
        `UPDATE approvals SET status = 'expired', decided_at = ?, decision_reason = ?
         WHERE id = ? AND status IN ('pending', 'approved') AND expires_at <= ?`,
      )
      .run(now, 'Approval expired before use', id, now);
    return this.getApproval(id);
  }

  public expireApprovals(now: string): number {
    const result = this.database
      .prepare(
        `UPDATE approvals SET status = 'expired', decided_at = ?, decision_reason = ?
         WHERE status IN ('pending', 'approved') AND expires_at <= ?`,
      )
      .run(now, 'Approval expired before use', now);
    return Number(result.changes);
  }

  public decideApproval(
    id: string,
    status: 'approved' | 'denied',
    decidedBy: string,
    reason: string,
    now: string,
  ): ApprovalRecord {
    const decided = this.withImmediateTransaction<ApprovalRecord | null>(() => {
      const current = this.getApproval(id);
      if (current === null) throw new Error(`Approval ${id} was not found`);
      if (current.status !== 'pending') {
        throw new Error(`Approval ${id} is ${current.status}, not pending`);
      }
      if (current.expiresAt <= now) {
        this.markApprovalExpired(id, now);
        return null;
      }

      const result = this.database
        .prepare(
          `UPDATE approvals SET status = ?, decided_at = ?, decided_by = ?, decision_reason = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .run(status, now, decidedBy, reason, id);
      if (Number(result.changes) !== 1) {
        throw new Error(`Approval ${id} was already decided concurrently`);
      }
      const updated = this.getApproval(id);
      if (updated === null || updated.status !== status) {
        throw new Error(`Approval ${id} decision did not persist atomically`);
      }
      return updated;
    });
    if (decided === null) throw new Error(`Approval ${id} has expired`);
    return decided;
  }

  public consumeApproval(id: string, digest: string, now: string): ApprovalRecord {
    let committed = false;
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const current = this.database.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as
        SqlRow | undefined;
      if (current === undefined) {
        throw new Error(`Approval ${id} was not found`);
      }
      const approval = approvalFromRow(current);
      if (approval.status !== 'approved') {
        throw new Error(`Approval ${id} is ${approval.status}, not approved`);
      }
      if (approval.actionDigest !== digest) {
        throw new Error(`Approval ${id} digest does not match the action`);
      }
      if (approval.expiresAt <= now) {
        this.database
          .prepare(
            `UPDATE approvals SET status = 'expired', decided_at = ?, decision_reason = ?
             WHERE id = ? AND status = 'approved'`,
          )
          .run(now, 'Approval expired before use', id);
        this.database.exec('COMMIT');
        committed = true;
        throw new Error(`Approval ${id} has expired`);
      }

      const result = this.database
        .prepare(
          `UPDATE approvals SET status = 'consumed', consumed_at = ?
           WHERE id = ? AND action_digest = ? AND status = 'approved'`,
        )
        .run(now, id, digest);
      if (Number(result.changes) !== 1) {
        throw new Error(`Approval ${id} was already consumed or changed`);
      }
      this.database.exec('COMMIT');
      committed = true;
      const updated = this.getApproval(id);
      if (updated === null) {
        throw new Error(`Approval ${id} disappeared after consumption`);
      }
      return updated;
    } catch (error) {
      if (!committed) {
        this.database.exec('ROLLBACK');
      }
      throw error;
    }
  }

  public appendAuditEvent(event: AuditEvent): void {
    this.database
      .prepare(
        `INSERT INTO audit_events (
          id, timestamp, task_id, agent, model, harness, tool, args_json, approval_json,
          decision, result_json, changed_targets_json, undo_guidance, previous_hash, event_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.timestamp,
        event.taskId,
        event.agent,
        event.model,
        event.harness,
        event.tool,
        jsonEncode(event.args),
        event.approval === null ? null : jsonEncode(event.approval),
        event.decision,
        event.result === null ? null : jsonEncode(event.result),
        jsonEncode(event.changedTargets),
        event.undoGuidance,
        event.previousHash,
        event.eventHash,
      );
  }

  public listAuditEvents(): AuditEvent[] {
    return (
      this.database.prepare('SELECT * FROM audit_events ORDER BY sequence').all() as SqlRow[]
    ).map(auditFromRow);
  }

  public latestAuditHash(): string | null {
    const row = this.database
      .prepare('SELECT event_hash FROM audit_events ORDER BY sequence DESC LIMIT 1')
      .get() as SqlRow | undefined;
    return row === undefined ? null : stringValue(row, 'event_hash');
  }

  private applyMigrations(migrationDir?: string): void {
    this.database.exec(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )`,
    );

    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      migrationDir,
      resolve(moduleDir, '../../migrations'),
      resolve(moduleDir, '../migrations'),
      resolve(process.cwd(), 'migrations'),
    ].filter((candidate): candidate is string => candidate !== undefined);
    const selected = candidates.find((candidate) => {
      try {
        return readdirSync(candidate).some((name) => /^001_.+\.sql$/u.test(name));
      } catch {
        return false;
      }
    });
    if (selected === undefined) {
      throw new Error('No migrations directory found');
    }

    const migrations = readdirSync(selected)
      .filter((name) => /^\d+_.+\.sql$/u.test(name))
      .sort(
        (left, right) =>
          Number(/^([0-9]+)_/.exec(left)?.[1]) - Number(/^([0-9]+)_/.exec(right)?.[1]),
      );
    for (const name of migrations) {
      const match = /^(\d+)_/.exec(name);
      if (match === null) {
        continue;
      }
      const version = Number(match[1]);
      const alreadyApplied = this.database
        .prepare('SELECT 1 FROM schema_migrations WHERE version = ?')
        .get(version);
      if (alreadyApplied !== undefined) {
        continue;
      }
      const sql = readFileSync(join(selected, name), 'utf8');
      this.database.exec('BEGIN');
      try {
        this.database.exec(sql);
        this.database
          .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
          .run(version, name, this.clock.now().toISOString());
        this.database.exec('COMMIT');
      } catch (error) {
        this.database.exec('ROLLBACK');
        throw error;
      }
    }
  }
}

export type SqlInput = SQLInputValue;
