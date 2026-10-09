import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { actionDigest } from '../src/domain/canonical.js';
import type { ConnectorResult } from '../src/domain/types.js';
import { PolicyEngine } from '../src/policy/policy-engine.js';
import { SQLiteStore } from '../src/storage/sqlite.js';
import { FixedClock } from '../src/shared/clock.js';
import { TaskStoppedError, TaskTakeControlError } from '../src/runtime/errors.js';
import { ConnectorRegistry, MockConnectorRegistry } from '../src/runtime/registries.js';
import { TaskEngine, type RunActionInput } from '../src/runtime/task-engine.js';

function createEngine(dbPath = ':memory:') {
  const clock = new FixedClock(new Date('2026-01-01T00:00:00.000Z'));
  const store = new SQLiteStore(dbPath, { clock });
  const connectors = new MockConnectorRegistry();
  const engine = new TaskEngine(store, { clock, connectors });
  return { clock, store, engine, connectors };
}

function action(overrides: Partial<RunActionInput> = {}): RunActionInput {
  return {
    tool: 'test.tool',
    connector: 'files',
    operation: 'read',
    target: { path: '/tmp/example.txt' },
    originatingTask: 'test task',
    ...overrides,
  };
}

function closeEngine(store: SQLiteStore): void {
  store.close();
}

describe('TaskEngine lifecycle', () => {
  it('rejects unknown runtime profile and operation values at the trust boundary', () => {
    const { store, engine } = createEngine();
    try {
      assert.throws(
        () => engine.createTask({ title: 'Bad profile', profile: 'unknown' as never }),
        /Unknown policy profile/,
      );
      const task = engine.createTask({ title: 'Bad operation' });
      assert.throws(
        () => engine.runAction(task.id, action({ operation: 'unknown' as never })),
        /Unknown action operation/,
      );
    } finally {
      closeEngine(store);
    }
  });

  it('enforces the runtime-wide execution lease limit for direct actions', () => {
    const { store, engine } = createEngine();
    const leases: string[] = [];
    try {
      for (let index = 0; index < 15; index += 1) {
        const id = `occupied-${index}`;
        assert.equal(
          store.tryAcquireRuntimeLease(id, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'),
          true,
        );
        leases.push(id);
      }
      const task = engine.createTask({ title: 'Capacity limited' });
      const result = engine.runAction(task.id, action());
      assert.equal(result.connectorResult, null);
      assert.match(result.task.errors.at(-1) ?? '', /concurrency limit/);
    } finally {
      for (const id of leases) store.releaseRuntimeLease(id);
      closeEngine(store);
    }
  });
  it('runs read actions automatically and exposes progress and events', () => {
    const { store, engine, connectors } = createEngine();
    try {
      const task = engine.createTask({
        title: 'Read a local file',
        plannedSteps: ['Read file'],
      });
      const result = engine.runAction(task.id, action({ step: 'Read file' }));

      assert.equal(result.decision.outcome, 'allow');
      assert.equal(result.approval, null);
      assert.equal(result.connectorResult?.simulated, true);
      assert.equal(connectors.mocks.get('files')?.calls.length, 1);
      const progress = engine.getProgress(task.id);
      assert.equal(progress.status, 'running');
      assert.deepEqual(progress.completedSteps, ['Read file']);
      assert.deepEqual(progress.pendingSteps, []);
      assert.deepEqual(progress.filesRead, ['/tmp/example.txt']);
      assert.equal(
        engine.listEvents(task.id).some((event) => event.kind === 'action.executed'),
        true,
      );
    } finally {
      closeEngine(store);
    }
  });

  it('treats a non-throwing connector failure as failed and preserves safe result details', () => {
    const clock = new FixedClock(new Date('2026-01-01T00:00:00.000Z'));
    const store = new SQLiteStore(':memory:', { clock });
    const connectors = new ConnectorRegistry();
    const connectorResult: ConnectorResult = {
      success: false,
      simulated: false,
      summary: 'Provider rejected Bearer abc123.',
      changedTargets: [],
      undoGuidance: 'No change was made for Bearer abc123.',
      output: {
        code: 'provider_rejected',
        token: 'secret-value',
        message: 'Bearer abc123',
      },
    };
    connectors.register({
      name: 'failing',
      execute: () => connectorResult,
    });
    const engine = new TaskEngine(store, { clock, connectors });
    try {
      const task = engine.createTask({
        title: 'Read from a failing provider',
        plannedSteps: ['Read provider'],
      });
      const result = engine.run(
        task.id,
        [
          action({
            tool: 'failing.read',
            connector: 'failing',
            operation: 'read',
            target: { path: '/tmp/provider.txt' },
            step: 'Read provider',
          }),
        ],
        { complete: true },
      );

      const expectedResult = {
        success: false,
        simulated: false,
        summary: 'Provider rejected [REDACTED]',
        changedTargets: [],
        undoGuidance: 'No change was made for [REDACTED]',
        output: {
          code: 'provider_rejected',
          token: '[REDACTED]',
          message: '[REDACTED]',
        },
      };
      assert.equal(result.completed, false);
      assert.equal(result.actions.length, 1);
      assert.deepEqual(result.actions[0]?.connectorResult, expectedResult);
      assert.equal(result.actions[0]?.event.kind, 'action.failed');
      assert.equal(result.task.status, 'failed');
      assert.deepEqual(result.task.completedSteps, []);
      assert.deepEqual(result.task.pendingSteps, ['Read provider']);
      assert.match(result.task.errors.at(-1) ?? '', /Provider rejected \[REDACTED\]/);

      const events = engine.listEvents(task.id);
      assert.equal(
        events.some((event) => event.kind === 'action.executed'),
        false,
      );
      const failureEvent = events.find((event) => event.kind === 'action.failed');
      assert.ok(failureEvent);
      assert.deepEqual((failureEvent.payload as { result: unknown }).result, expectedResult);

      const auditFailure = engine.listAuditEvents().find((event) => event.tool === 'action.failed');
      assert.ok(auditFailure);
      assert.equal(auditFailure.decision, null);
      assert.deepEqual(auditFailure.result, expectedResult);
      assert.equal(
        engine.listAuditEvents().some((event) => event.tool === 'action.execute'),
        false,
      );
    } finally {
      closeEngine(store);
    }
  });

  it('consumes an approval once even when the connector returns a failure result', () => {
    const clock = new FixedClock(new Date('2026-01-01T00:00:00.000Z'));
    const store = new SQLiteStore(':memory:', { clock });
    const connectors = new ConnectorRegistry();
    connectors.register({
      name: 'failing',
      execute: () => ({
        success: false,
        simulated: false,
        summary: 'Provider rejected the message.',
        changedTargets: [],
        undoGuidance: null,
        output: { code: 'provider_rejected' },
      }),
    });
    const engine = new TaskEngine(store, { clock, connectors });
    try {
      const task = engine.createTask({ title: 'Send through a failing provider' });
      const input = action({
        tool: 'failing.send',
        connector: 'failing',
        operation: 'send_email',
        target: { thread: 'thread-1' },
        recipient: 'user-9dc98d0@example.com',
      });
      const waiting = engine.runAction(task.id, input);
      assert.ok(waiting.approval);
      const approved = engine.approve(waiting.approval.id, 'tester');
      const failed = engine.runAction(task.id, input, { approvalId: approved.id });

      assert.equal(failed.connectorResult?.success, false);
      assert.equal(failed.task.status, 'failed');
      assert.equal(engine.getApproval(approved.id)?.status, 'consumed');
      assert.throws(
        () => engine.runAction(task.id, input, { approvalId: approved.id }),
        /failed and cannot run actions/,
      );
    } finally {
      closeEngine(store);
    }
  });

  it('pauses sending for a complete disclosure and consumes approval once', () => {
    const { store, engine, connectors } = createEngine();
    try {
      const task = engine.createTask({ title: 'Send a report' });
      const send = action({
        tool: 'gmail.send',
        connector: 'gmail',
        operation: 'send_email',
        target: { thread: 'thread-1' },
        payload: { subject: 'Report', body: 'Summary' },
        before: { status: 'draft' },
        after: { status: 'sent' },
        itemCount: 1,
        dataSizeBytes: 64,
        recipient: 'user-9dc98d0@example.com',
        amount: { currency: 'USD', value: 0 },
        reversible: false,
        undoMethod: 'No external mutation occurred; this is simulated.',
      });
      const waiting = engine.runAction(task.id, send);

      assert.equal(waiting.decision.outcome, 'require_approval');
      assert.ok(waiting.approval);
      assert.equal(waiting.approval.disclosure.operation, 'send_email');
      assert.equal(waiting.approval.disclosure.targetSummary, '{"thread":"thread-1"}');
      assert.equal(waiting.approval.disclosure.beforeSummary, '{"status":"draft"}');
      assert.equal(waiting.approval.disclosure.afterSummary, '{"status":"sent"}');
      assert.equal(waiting.approval.disclosure.itemCount, 1);
      assert.equal(waiting.approval.disclosure.dataSizeBytes, 64);
      assert.equal(waiting.approval.disclosure.recipient, 'user-9dc98d0@example.com');
      assert.equal(waiting.approval.disclosure.reversible, false);
      assert.equal(connectors.mocks.get('gmail')?.calls.length, 0);
      assert.equal(engine.getTask(task.id)?.status, 'waiting_for_approval');

      const approved = engine.approve(waiting.approval.id, 'tester');
      const executed = engine.runAction(task.id, send, { approvalId: approved.id });
      assert.equal(executed.connectorResult?.simulated, true);
      assert.equal(engine.getApproval(approved.id)?.status, 'consumed');
      assert.equal(connectors.mocks.get('gmail')?.calls.length, 1);
      assert.throws(() => engine.runAction(task.id, send, { approvalId: approved.id }), /consumed/);
    } finally {
      closeEngine(store);
    }
  });

  it('rejects a changed target or payload after approval', () => {
    const { store, engine, connectors } = createEngine();
    try {
      const task = engine.createTask({ title: 'Change-sensitive send' });
      const waiting = engine.runAction(
        task.id,
        action({
          connector: 'gmail',
          tool: 'gmail.send',
          operation: 'send_email',
          target: { recipient: 'user-fe4d5e2@example.com' },
          payload: { body: 'original' },
          recipient: 'user-fe4d5e2@example.com',
        }),
      );
      assert.ok(waiting.approval);
      const approved = engine.approve(waiting.approval.id, 'tester');
      assert.throws(
        () =>
          engine.runAction(
            task.id,
            {
              ...waiting.action,
              target: { recipient: 'user-cd034e0@example.com' },
            },
            { approvalId: approved.id },
          ),
        /digest does not match/,
      );
      assert.equal(engine.getApproval(approved.id)?.status, 'approved');
      assert.equal(connectors.mocks.get('gmail')?.calls.length, 0);
    } finally {
      closeEngine(store);
    }
  });

  it('distinguishes trash and permanent deletion and applies the plus profile exception', () => {
    const policy = new PolicyEngine();
    const base = {
      id: 'action-1',
      taskId: 'task-1',
      tool: 'tasks.update',
      connector: 'google-tasks',
      target: { list: 'inbox' },
      originatingTask: 'Bulk task operation',
    } as const;
    const trash = policy.evaluate(
      { ...base, operation: 'delete_to_trash', itemCount: 1 },
      'spark-public-parity',
    );
    const permanent = policy.evaluate(
      { ...base, operation: 'delete_permanently', itemCount: 1 },
      'spark-public-parity',
    );
    const normalBulk = policy.evaluate(
      { ...base, operation: 'edit_data', itemCount: 3 },
      'spark-public-parity',
    );
    const plusBulk = policy.evaluate(
      { ...base, operation: 'edit_data', itemCount: 3 },
      'spark-public-parity-plus',
    );

    assert.equal(trash.outcome, 'require_approval');
    assert.equal(trash.disclosure?.operation, 'delete_to_trash');
    assert.equal(permanent.outcome, 'require_approval');
    assert.equal(permanent.disclosure?.operation, 'delete_permanently');
    assert.equal(normalBulk.outcome, 'allow');
    assert.equal(normalBulk.policyRule, 'google-tasks-public-parity-exception');
    assert.equal(plusBulk.outcome, 'require_approval');
    assert.equal(plusBulk.confirmationRequired, true);
    assert.equal(plusBulk.policyRule, 'google-tasks-bulk-confirmation');
  });

  it('requires approval for sensitive transmission unless the payload contains secret material', () => {
    const policy = new PolicyEngine();
    const base = {
      id: 'action-transmit-sensitive',
      taskId: 'task-transmit-sensitive',
      tool: 'web.share',
      connector: 'web',
      operation: 'transmit_sensitive',
      target: { recipient: 'user-9dc98d0@example.com' },
      originatingTask: 'Transmit a sensitive report',
    } as const;

    for (const profile of ['spark-public-parity', 'spark-public-parity-plus'] as const) {
      const transmission = policy.evaluate(
        { ...base, payload: { body: 'Sensitive report without credentials' } },
        profile,
      );
      assert.equal(transmission.outcome, 'require_approval');
      assert.equal(transmission.policyRule, 'external-side-effect-approval');
      assert.equal(transmission.disclosure?.operation, 'transmit_sensitive');

      const secretPayload = policy.evaluate(
        { ...base, payload: { body: 'Bearer abc123456789' } },
        profile,
      );
      assert.equal(secretPayload.outcome, 'take_control');
      assert.equal(secretPayload.policyRule, 'secret-and-authentication-boundary');
    }
  });

  it('continues a task run after an approved side effect executes', () => {
    const { store, engine } = createEngine();
    try {
      const task = engine.createTask({
        title: 'Send then read',
        plannedSteps: ['Send', 'Read'],
      });
      const send = action({
        connector: 'gmail',
        tool: 'gmail.send',
        operation: 'send_email',
        target: { thread: 'thread-1' },
        recipient: 'user-9dc98d0@example.com',
        step: 'Send',
      });
      const waiting = engine.runAction(task.id, send, { step: 'Send' });
      assert.ok(waiting.approval);
      const approved = engine.approve(waiting.approval.id, 'tester');

      const result = engine.run(
        task.id,
        [{ ...waiting.action, approvalId: approved.id, step: 'Send' }, action({ step: 'Read' })],
        { complete: true },
      );

      assert.equal(result.actions.length, 2);
      assert.equal(result.completed, true);
      assert.equal(result.task.status, 'completed');
    } finally {
      closeEngine(store);
    }
  });

  it('moves secret-entry work to take-control without calling a connector', () => {
    const { store, engine, connectors } = createEngine();
    try {
      const task = engine.createTask({ title: 'Sign in manually' });
      const result = engine.runAction(
        task.id,
        action({
          connector: 'web',
          tool: 'browser.login',
          operation: 'authentication',
          target: { site: 'example.invalid' },
        }),
      );
      assert.equal(result.decision.outcome, 'take_control');
      assert.equal(engine.getTask(task.id)?.status, 'take_control');
      assert.equal(connectors.mocks.get('web')?.calls.length, 0);
      assert.throws(() => engine.runAction(task.id, action()), TaskTakeControlError);
      const resumed = engine.resume(task.id);
      assert.equal(resumed.status, 'running');
      assert.doesNotThrow(() => engine.runAction(task.id, action()));
    } finally {
      closeEngine(store);
    }
  });

  it('takes control and redacts secret material in the audit chain', () => {
    const { store, engine } = createEngine();
    try {
      const task = engine.createTask({ title: 'Handle an API key' });
      engine.runAction(
        task.id,
        action({
          connector: 'web',
          tool: 'browser.form',
          operation: 'submit_form',
          target: { url: 'https://example.invalid' },
          payload: {
            apiKey: ['sk', 'live', 'synthetic'.repeat(5)].join('_'),
            nested: { password: 'hidden' },
          },
        }),
      );
      const serialized = JSON.stringify(engine.listAuditEvents());
      assert.equal(serialized.includes(['sk', 'live', 'synthetic'.repeat(5)].join('_')), false);
      assert.equal(serialized.includes('hidden'), false);
      assert.equal(engine.verifyAudit().valid, true);
    } finally {
      closeEngine(store);
    }
  });

  it('persists stop state, blocks actions, and resumes from a reopened store', () => {
    const directory = mkdtempSync(join(tmpdir(), 'spark-runtime-'));
    const dbPath = join(directory, 'runtime.sqlite');
    let firstStore: SQLiteStore | null = null;
    let taskId = '';
    try {
      const first = createEngine(dbPath);
      firstStore = first.store;
      const task = first.engine.createTask({ title: 'Persist stop state' });
      taskId = task.id;
      first.engine.runAction(task.id, action());
      const stopped = first.engine.stop(task.id, 'Pause before next step');
      assert.equal(stopped.status, 'stopped');
      firstStore.close();
      firstStore = null;

      const reopened = createEngine(dbPath);
      try {
        assert.equal(reopened.engine.getTask(taskId)?.status, 'stopped');
        assert.throws(() => reopened.engine.runAction(taskId, action()), TaskStoppedError);
        assert.equal(reopened.engine.resume(taskId).status, 'running');
        assert.equal(reopened.engine.runAction(taskId, action()).connectorResult?.simulated, true);
      } finally {
        reopened.store.close();
      }
    } finally {
      firstStore?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('denies prohibited actions and records denial without connector execution', () => {
    const { store, engine, connectors } = createEngine();
    try {
      const task = engine.createTask({ title: 'Do not destroy data' });
      const result = engine.runAction(
        task.id,
        action({
          connector: 'shell',
          tool: 'shell.exec',
          operation: 'prohibited',
          target: '/',
          payload: { command: 'rm -rf /' },
        }),
      );
      assert.equal(result.decision.outcome, 'deny');
      assert.equal(result.task.status, 'failed');
      assert.equal(connectors.mocks.get('shell')?.calls.length, 0);
      assert.equal(
        engine.listEvents(task.id).some((event) => event.kind === 'action.denied'),
        true,
      );
    } finally {
      closeEngine(store);
    }
  });

  it('requires approval for purchase and form submission and supports denial', () => {
    const { store, engine, connectors } = createEngine();
    try {
      const task = engine.createTask({ title: 'Purchase and submit' });
      const purchase = engine.runAction(
        task.id,
        action({
          connector: 'web',
          tool: 'checkout',
          operation: 'purchase',
          target: { product: 'demo' },
          amount: { currency: 'USD', value: 12.5 },
        }),
      );
      assert.equal(purchase.decision.outcome, 'require_approval');
      assert.equal(purchase.approval?.disclosure.amount?.value, 12.5);
      engine.deny(purchase.approval!.id, 'tester', 'User declined purchase');
      assert.equal(engine.getTask(task.id)?.status, 'failed');
      assert.deepEqual(engine.getProgress(task.id).pendingApprovalIds, []);
      assert.equal(connectors.mocks.get('web')?.calls.length, 0);
    } finally {
      closeEngine(store);
    }
  });

  it('detects audit tampering and keeps canonical action digests stable', () => {
    const { store, engine } = createEngine();
    try {
      const task = engine.createTask({ title: 'Audit integrity' });
      const input = action();
      const first = engine.runAction(task.id, input);
      const reordered = {
        ...first.action,
        target: { path: '/tmp/example.txt' },
      };
      assert.equal(actionDigest(first.action), actionDigest(reordered));
      assert.equal(engine.verifyAudit().valid, true);
      store.database.prepare('UPDATE audit_events SET tool = ? WHERE sequence = 1').run('tampered');
      const verification = engine.verifyAudit();
      assert.equal(verification.valid, false);
      assert.equal(verification.firstInvalidSequence, 1);
    } finally {
      closeEngine(store);
    }
  });
});
