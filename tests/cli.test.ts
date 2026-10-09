import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

type JsonRecord = Record<string, any>;

function runCli(dbPath: string, ...argumentsList: string[]): JsonRecord {
  const output = execFileSync(
    process.execPath,
    [resolve('dist/cli.js'), ...argumentsList, '--db', dbPath],
    {
      cwd: resolve('.'),
      encoding: 'utf8',
    },
  );
  return JSON.parse(output) as JsonRecord;
}

describe('CLI lifecycle', () => {
  it('supports create, show, approve, deny, stop, resume, audit verify, and demo', () => {
    const directory = mkdtempSync(join(tmpdir(), 'spark-cli-'));
    const dbPath = join(directory, 'runtime.sqlite');
    try {
      const created = runCli(
        dbPath,
        'task',
        'create',
        '--title',
        'CLI task',
        '--steps',
        'step one',
      );
      const taskId = created.id as string;
      assert.ok(taskId.startsWith('task_'));

      const shown = runCli(dbPath, 'task', 'show', '--task-id', taskId);
      assert.equal(shown.task.id, taskId);
      assert.equal(shown.progress.status, 'planning');

      const waiting = runCli(
        dbPath,
        'action',
        '--task-id',
        taskId,
        '--operation',
        'send_email',
        '--connector',
        'gmail',
        '--tool',
        'gmail.send',
        '--target',
        '{"thread":"cli-thread"}',
        '--payload',
        '{"body":"simulated"}',
        '--recipient',
        'user-ebb1624@example.com',
      );
      const approvalId = waiting.approval.id as string;
      const actionId = waiting.action.id as string;
      assert.equal(waiting.task.status, 'waiting_for_approval');

      const approved = runCli(dbPath, 'approve', '--approval-id', approvalId, '--by', 'cli-tester');
      assert.equal(approved.status, 'approved');
      const resumed = runCli(dbPath, 'resume', '--task-id', taskId);
      assert.equal(resumed.status, 'running');

      const executed = runCli(
        dbPath,
        'action',
        '--task-id',
        taskId,
        '--approval-id',
        approvalId,
        '--action-id',
        actionId,
        '--operation',
        'send_email',
        '--connector',
        'gmail',
        '--tool',
        'gmail.send',
        '--target',
        '{"thread":"cli-thread"}',
        '--payload',
        '{"body":"simulated"}',
        '--recipient',
        'user-ebb1624@example.com',
      );
      assert.equal(executed.connectorResult.simulated, true);

      const waitingToDeny = runCli(
        dbPath,
        'action',
        '--task-id',
        taskId,
        '--operation',
        'submit_form',
        '--connector',
        'web',
        '--target',
        '{"form":"demo"}',
      );
      const denied = runCli(
        dbPath,
        'deny',
        '--approval-id',
        waitingToDeny.approval.id as string,
        '--reason',
        'CLI denial',
      );
      assert.equal(denied.status, 'denied');

      const stopTask = runCli(dbPath, 'task', 'create', '--title', 'CLI stop task');
      const stopped = runCli(
        dbPath,
        'stop',
        '--task-id',
        stopTask.id as string,
        '--reason',
        'pause',
      );
      assert.equal(stopped.status, 'stopped');
      const resumedStopped = runCli(dbPath, 'resume', '--task-id', stopTask.id as string);
      assert.equal(resumedStopped.status, 'running');

      const audit = runCli(dbPath, 'audit', 'verify');
      assert.equal(audit.valid, true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }

    const demo = execFileSync(process.execPath, [resolve('dist/cli.js'), 'demo'], {
      cwd: resolve('.'),
      encoding: 'utf8',
    });
    const demoJson = JSON.parse(demo) as JsonRecord;
    assert.equal(demoJson.simulated, true);
    assert.equal(demoJson.audit.valid, true);
    assert.equal(demoJson.completed.status, 'completed');
  });

  it('manages persistent skills and schedules', () => {
    const directory = mkdtempSync(join(tmpdir(), 'spark-cli-manage-'));
    const dbPath = join(directory, 'runtime.sqlite');
    try {
      const skill = runCli(
        dbPath,
        'skill',
        'create',
        '--name',
        'inbox-review',
        '--description',
        'Review inbox',
        '--instructions',
        'Summarize unread mail',
      );
      assert.equal(skill.name, 'inbox-review');
      assert.equal(runCli(dbPath, 'skill', 'list')[0].enabled, true);
      assert.equal(
        runCli(
          dbPath,
          'skill',
          'update',
          '--name',
          'inbox-review',
          '--description',
          'Review priority inbox',
        ).description,
        'Review priority inbox',
      );
      assert.equal(runCli(dbPath, 'skill', 'disable', '--name', 'inbox-review').enabled, false);
      assert.equal(runCli(dbPath, 'skill', 'enable', '--name', 'inbox-review').enabled, true);

      const schedule = runCli(
        dbPath,
        'schedule',
        'create',
        '--name',
        'poll-inbox',
        '--interval-ms',
        '60000',
        '--first-run-at',
        '2026-07-18T00:00:00.000Z',
        '--payload',
        '{"taskId":"gmail-poll"}',
      );
      assert.equal(runCli(dbPath, 'schedule', 'pause', '--id', schedule.id).enabled, false);
      assert.equal(runCli(dbPath, 'schedule', 'resume', '--id', schedule.id).enabled, true);
      const events = runCli(dbPath, 'schedule', 'tick', '--at', '2026-07-18T00:00:00.000Z');
      assert.equal(events[0].kind, 'schedule.due');
      assert.equal(runCli(dbPath, 'schedule', 'disable', '--id', schedule.id).enabled, false);
      assert.equal(runCli(dbPath, 'schedule', 'enable', '--id', schedule.id).enabled, true);
      assert.equal(runCli(dbPath, 'skill', 'delete', '--name', 'inbox-review').deleted, true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('prints usage and exits with code 0 when called with --help', () => {
    const output = execFileSync(process.execPath, [resolve('dist/cli.js'), '--help'], {
      cwd: resolve('.'),
      encoding: 'utf8',
    });
    assert.match(output, /^Usage: task create|show|run|pause|resume/);
  });
});
