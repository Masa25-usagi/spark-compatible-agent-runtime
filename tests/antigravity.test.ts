import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';

import {
  createHandoffRequest,
  FileHandoffAdapter,
  HANDOFF_PROTOCOL,
  StdioHandoffAdapter,
} from '../src/adapters/antigravity.js';
import type { TaskRecord } from '../src/domain/types.js';

const task: TaskRecord = {
  id: 'task-antigravity',
  title: 'Antigravity task',
  instruction: null,
  status: 'running',
  profile: 'spark-public-parity',
  agent: 'test',
  model: 'test',
  harness: 'test',
  createdAt: '2026-07-18T00:00:00.000Z',
  updatedAt: '2026-07-18T00:00:00.000Z',
  currentStep: '',
  plannedSteps: [],
  completedSteps: [],
  pendingSteps: [],
  usedSkills: [],
  usedConnectors: [],
  filesRead: [],
  filesCreated: [],
  filesChanged: [],
  pendingApprovalIds: [],
  errors: [],
  retries: 0,
  stopReason: null,
  takeControlReason: null,
  dispatchMode: null,
  dispatchStatus: 'not_started',
  dispatchSummary: null,
  dispatchStartedAt: null,
  dispatchFinishedAt: null,
};

function response(requestId: string, taskId: string) {
  return {
    protocol: HANDOFF_PROTOCOL,
    kind: 'handoff_response' as const,
    requestId,
    taskId,
    receivedAt: '2026-07-18T00:00:01.000Z',
    status: 'completed' as const,
    summary: 'done',
    output: null,
    error: null,
  };
}

describe('Antigravity handoff correlation', () => {
  it('rejects a file response correlated to a different task', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'spark-antigravity-'));
    try {
      const adapter = new FileHandoffAdapter(directory);
      const request = createHandoffRequest({ task, prompt: 'Review task', requestId: 'request-1' });
      await adapter.send(request);
      writeFileSync(
        join(directory, 'response-request-1.json'),
        JSON.stringify(response('request-1', 'different-task')),
      );
      await assert.rejects(() => adapter.readResponse('request-1'), /task ID does not match/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects a stdio response correlated to a different task', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const adapter = new StdioHandoffAdapter(input, output);
    try {
      const request = createHandoffRequest({ task, prompt: 'Review task', requestId: 'request-2' });
      await adapter.send(request);
      input.write(JSON.stringify(response('request-2', 'different-task')) + '\n');
      await assert.rejects(() => adapter.readResponse('request-2'), /task ID does not match/);
    } finally {
      adapter.close();
    }
  });
});
