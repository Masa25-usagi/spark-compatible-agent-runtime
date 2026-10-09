import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { ActionSpec, PolicyDecision } from '../src/domain/types.js';
import { PolicyEngine } from '../src/policy/policy-engine.js';
import { ClaudeCodeCliAdapter, parseClaudeCodeResult } from '../src/adapters/claude-code.js';
import { CodexCliAdapter, parseCodexResult } from '../src/adapters/codex.js';
import {
  EXTERNAL_AGENT_PROTOCOL,
  EXTERNAL_AGENT_RESULT_KIND,
  createExternalAgentRequest,
  createExternalAgentHandoff,
  parseExternalAgentResult,
  serializeExternalAgentRequest,
  type ExternalAgentRequest,
  type ExternalAgentTaskSnapshot,
} from '../src/adapters/types.js';

const task: ExternalAgentTaskSnapshot = {
  id: 'task_adapter_1',
  title: 'Review the workspace',
  status: 'running',
  profile: 'spark-public-parity',
  agent: 'local-runtime',
  model: 'caller-supplied',
  harness: 'external-agent-test',
  currentStep: 'Inspect',
  plannedSteps: ['Inspect', 'Report'],
  pendingSteps: ['Report'],
};

const action: ActionSpec = {
  id: 'action_adapter_1',
  taskId: task.id,
  tool: 'files.read',
  connector: 'files',
  operation: 'read',
  target: { path: '/tmp/adapter-fixture.txt' },
  payload: { encoding: 'utf8' },
  originatingTask: task.title,
};

const policy: PolicyDecision = new PolicyEngine().evaluate(action, task.profile);

function request(): ExternalAgentRequest {
  return createExternalAgentRequest({
    task,
    prompt: 'Inspect the task and return a normalized result. $HOME; && echo unsafe',
    actions: [action],
    policy,
    requestId: 'handoff_adapter_1',
    createdAt: '2026-07-18T00:00:00.000Z',
  });
}

describe('external-agent adapter compatibility', () => {
  it('hands the same task/action/policy payload to both CLIs', () => {
    const externalRequest = request();
    const codex = new CodexCliAdapter({
      executable: '/opt/tools/codex;do-not-split',
      model: 'model with spaces;$(touch unsafe)',
      sandbox: 'read-only',
    });
    const claude = new ClaudeCodeCliAdapter({
      executable: '/opt/tools/claude;do-not-split',
      model: 'model with spaces;$(touch unsafe)',
      permissionMode: 'plan',
    });
    const filePath = '/tmp/external agent;$(touch unsafe)/request.json';

    const codexFile = codex.buildInvocation(externalRequest, {
      transport: 'file',
      filePath,
    });
    const claudeFile = claude.buildInvocation(externalRequest, {
      transport: 'file',
      filePath,
    });
    const codexStdio = codex.buildInvocation(externalRequest, { transport: 'stdio' });
    const claudeStdio = claude.buildInvocation(externalRequest, { transport: 'stdio' });
    const serialized = serializeExternalAgentRequest(externalRequest);

    assert.equal(codexFile.handoff.serialized, serialized);
    assert.equal(claudeFile.handoff.serialized, serialized);
    assert.equal(codexStdio.handoff.stdin, serialized + '\n');
    assert.equal(claudeStdio.handoff.stdin, serialized + '\n');
    assert.equal(codexFile.handoff.requestDigest, claudeFile.handoff.requestDigest);
    assert.equal(JSON.parse(serialized).actions[0].policy.policyRule, 'automatic-safe-operations');

    assert.deepEqual(codexStdio.argv.slice(0, 4), [
      '/opt/tools/codex;do-not-split',
      'exec',
      '--json',
      '--skip-git-repo-check',
    ]);
    assert.equal(codexStdio.argv.at(-1), '-');
    const inputFormatIndex = claudeStdio.argv.indexOf('--input-format');
    assert.ok(inputFormatIndex >= 0);
    assert.equal(claudeStdio.argv[inputFormatIndex + 1], 'text');
    assert.equal(
      codexFile.argv.at(-1),
      `Read the complete external-agent handoff JSON from this file: ${filePath}`,
    );
    assert.equal(
      claudeFile.argv.at(-1),
      `Read the complete external-agent handoff JSON from this file: ${filePath}`,
    );
    assert.equal(codexFile.argv.includes('sh'), false);
    assert.equal(claudeFile.argv.includes('sh'), false);
    assert.deepEqual(codexFile.args, codexFile.argv.slice(1));
    assert.deepEqual(claudeFile.args, claudeFile.argv.slice(1));
  });

  it('supports a caller-owned file handoff without writing or executing it', () => {
    const externalRequest = request();
    const handoff = createExternalAgentHandoff(externalRequest, {
      transport: 'file',
      filePath: '/tmp/request.json',
    });

    assert.equal(handoff.filePath, '/tmp/request.json');
    assert.equal(handoff.stdin, null);
    assert.equal(handoff.serialized, serializeExternalAgentRequest(externalRequest));
    assert.equal('execute' in new CodexCliAdapter(), false);
    assert.equal('execute' in new ClaudeCodeCliAdapter(), false);
  });

  it('rejects changed actions, mismatched policy profiles, and recognized secrets', () => {
    const changed = request();
    const changedAction = changed.actions.at(0);
    assert.ok(changedAction);
    changedAction.action.payload = { encoding: 'ascii' };
    assert.throws(
      () => new CodexCliAdapter().buildInvocation(changed, { transport: 'stdio' }),
      /changed after its handoff digest/,
    );

    const mismatchedPolicy = request();
    const mismatchedAction = mismatchedPolicy.actions.at(0);
    assert.ok(mismatchedAction);
    mismatchedAction.policy = {
      ...mismatchedAction.policy,
      profile: 'spark-public-parity-plus',
    };
    assert.throws(
      () => serializeExternalAgentRequest(mismatchedPolicy),
      /policy profile.*does not match/,
    );

    assert.throws(
      () =>
        createExternalAgentRequest({
          task,
          prompt: 'Use Bearer abc123 only for this request',
          action,
          policy,
          requestId: 'handoff_secret_prompt',
        }),
      /Secret material cannot cross/,
    );
    assert.throws(
      () =>
        createExternalAgentRequest({
          task,
          prompt: 'Inspect safely',
          action: {
            ...action,
            payload: { password: 'not-for-handoff' },
          },
          policy,
          requestId: 'handoff_secret_payload',
        }),
      /Secret material cannot cross/,
    );
  });

  it('normalizes Codex JSONL and Claude Code JSON results', () => {
    const externalRequest = request();
    const codexResult = parseCodexResult(
      [
        JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: 'Codex inspected the task.' },
        }),
        JSON.stringify({ type: 'turn.completed' }),
      ].join('\n'),
      externalRequest,
    );
    const claudeResult = parseClaudeCodeResult(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'Claude Code inspected the task.',
        session_id: 'session-1',
      }),
      externalRequest,
    );

    assert.equal(codexResult.protocol, EXTERNAL_AGENT_PROTOCOL);
    assert.equal(codexResult.kind, EXTERNAL_AGENT_RESULT_KIND);
    assert.equal(codexResult.agent, 'codex');
    assert.equal(codexResult.status, 'completed');
    assert.equal(codexResult.summary, 'Codex inspected the task.');
    assert.equal(claudeResult.agent, 'claude-code');
    assert.equal(claudeResult.status, 'completed');
    assert.equal(claudeResult.summary, 'Claude Code inspected the task.');
  });

  it('uses process exit status so plain-text CLI failures are not reported as completed', () => {
    const correlation = { requestId: 'handoff_adapter_1', taskId: task.id };
    const codex = parseCodexResult(
      { stdout: 'plain failure', stderr: 'codex failed', exitCode: 2 },
      correlation,
    );
    const claude = parseClaudeCodeResult(
      { stdout: 'plain failure', stderr: 'claude failed', exitCode: 3 },
      correlation,
    );
    assert.equal(codex.status, 'failed');
    assert.equal(codex.error, 'codex failed');
    assert.equal(claude.status, 'failed');
    assert.equal(claude.error, 'claude failed');
  });

  it('fails normalized Codex and Claude results when the process exits nonzero', () => {
    const externalRequest = request();
    const codex = parseCodexResult(
      {
        stdout: JSON.stringify({
          protocol: EXTERNAL_AGENT_PROTOCOL,
          kind: EXTERNAL_AGENT_RESULT_KIND,
          requestId: externalRequest.requestId,
          taskId: externalRequest.task.id,
          agent: 'codex',
          receivedAt: '2026-07-18T00:02:00.000Z',
          status: 'completed',
          summary: 'Codex produced a result before exiting.',
          output: { value: 'codex' },
          error: null,
        }),
        stderr: 'codex process failed',
        exitCode: 2,
      },
      externalRequest,
    );
    const claude = parseClaudeCodeResult(
      {
        stdout: JSON.stringify({
          protocol: EXTERNAL_AGENT_PROTOCOL,
          kind: EXTERNAL_AGENT_RESULT_KIND,
          requestId: externalRequest.requestId,
          taskId: externalRequest.task.id,
          agent: 'claude-code',
          receivedAt: '2026-07-18T00:03:00.000Z',
          status: 'completed',
          summary: 'Claude Code produced a result before exiting.',
          output: { value: 'claude' },
          error: null,
        }),
        stderr: 'claude process failed',
        exitCode: 3,
      },
      externalRequest,
    );

    assert.equal(codex.requestId, externalRequest.requestId);
    assert.equal(codex.taskId, externalRequest.task.id);
    assert.equal(codex.agent, 'codex');
    assert.equal(codex.status, 'failed');
    assert.equal(codex.summary, 'Codex produced a result before exiting.');
    assert.match(codex.error ?? '', /codex process failed/);
    assert.match(codex.error ?? '', /Codex exited with code 2/);

    assert.equal(claude.requestId, externalRequest.requestId);
    assert.equal(claude.taskId, externalRequest.task.id);
    assert.equal(claude.agent, 'claude-code');
    assert.equal(claude.status, 'failed');
    assert.equal(claude.summary, 'Claude Code produced a result before exiting.');
    assert.match(claude.error ?? '', /claude process failed/);
    assert.match(claude.error ?? '', /Claude Code exited with code 3/);
  });

  it('accepts normalized envelopes, redacts result secrets, and checks correlation', () => {
    const externalRequest = request();
    const normalized = {
      protocol: EXTERNAL_AGENT_PROTOCOL,
      kind: EXTERNAL_AGENT_RESULT_KIND,
      requestId: externalRequest.requestId,
      taskId: externalRequest.task.id,
      agent: 'codex',
      receivedAt: '2026-07-18T00:01:00.000Z',
      status: 'completed',
      summary: 'Done with Bearer abc123',
      output: { apiKey: 'hidden', value: 'ok' },
      error: null,
    } as const;
    const result = parseExternalAgentResult(normalized, {
      requestId: externalRequest.requestId,
      taskId: externalRequest.task.id,
      agent: 'codex',
    });

    assert.equal(result.summary, 'Done with [REDACTED]');
    assert.deepEqual(result.output, { apiKey: '[REDACTED]', value: 'ok' });
    assert.throws(
      () => parseExternalAgentResult(normalized, { ...externalRequest, taskId: 'task_other' }),
      /task ID does not match/,
    );
  });
});
