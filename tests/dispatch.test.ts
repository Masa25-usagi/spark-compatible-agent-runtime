import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

import { TaskEngine } from '../src/runtime/task-engine.js';
import { SQLiteStore } from '../src/storage/sqlite.js';
import { createApiServer } from '../src/api/server.js';
import {
  dispatchAgent,
  cancelDispatch,
  getAntigravityModels,
  getCodexModels,
  getProviderAvailability,
  getSafeJapaneseError,
  startAgentDispatch,
  parseTimeout,
  shutdownAgentDispatcher,
} from '../src/runtime/agent-dispatcher.js';

describe('Agent Dispatcher tests', () => {
  it('checks provider availability and retrieves models', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'spark-dispatch-models-'));
    const fakeAgyPath = join(tempDir, 'fake-agy');

    const scriptContent = `#!/usr/bin/env node
if (process.argv.includes('--help')) {
  process.exit(0);
}
if (process.argv.includes('models')) {
  console.log(JSON.stringify(['Gemini Custom Model 1', 'Gemini Custom Model 2']));
  process.exit(0);
}
process.exit(1);
`;
    writeFileSync(fakeAgyPath, scriptContent, 'utf8');
    chmodSync(fakeAgyPath, 0o755);

    const oldAgy = process.env.ANTIGRAVITY_COMMAND;
    process.env.ANTIGRAVITY_COMMAND = fakeAgyPath;

    try {
      const avail = getProviderAvailability('antigravity');
      assert.equal(avail, true);

      const models = await getAntigravityModels();
      assert.deepEqual(models, ['Gemini Custom Model 1', 'Gemini Custom Model 2']);
    } finally {
      process.env.ANTIGRAVITY_COMMAND = oldAgy;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('waits for cold model discovery, filters Claude, deduplicates, and caches it', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'spark-dispatch-models-cache-'));
    const fakeAgyPath = join(tempDir, 'fake-agy');
    const invocationLog = join(tempDir, 'invocations.log');

    const scriptContent = `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(invocationLog)}, process.argv.slice(2).join(' ') + '\\n');
if (process.argv.includes('--help')) process.exit(0);
if (process.argv.includes('models')) {
  setTimeout(() => {
    process.stdout.write(JSON.stringify([
      'gemini-3.6-flash-high',
      'claude-3-7-sonnet',
      'gemini-3.6-flash-high',
      'gpt-oss-120b'
    ]));
    process.exit(0);
  }, 3200);
}
`;
    writeFileSync(fakeAgyPath, scriptContent, 'utf8');
    chmodSync(fakeAgyPath, 0o755);

    const oldAgy = process.env.ANTIGRAVITY_COMMAND;
    process.env.ANTIGRAVITY_COMMAND = fakeAgyPath;

    try {
      const first = await getAntigravityModels();
      const second = await getAntigravityModels();

      assert.deepEqual(first, ['gemini-3.6-flash-high', 'gpt-oss-120b']);
      assert.deepEqual(second, first);
      assert.equal(readFileSync(invocationLog, 'utf8').trim().split('\n').length, 1);
    } finally {
      process.env.ANTIGRAVITY_COMMAND = oldAgy;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('returns complete model output promptly and terminates a lingering discovery child', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'spark-dispatch-models-lingering-'));
    const fakeAgyPath = join(tempDir, 'fake-agy');
    const pidPath = join(tempDir, 'models.pid');

    const scriptContent = `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--help')) process.exit(0);
if (process.argv.includes('models')) {
  fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
  process.stdout.write(JSON.stringify([
    'gemini-3.6-flash-high',
    'claude-3-7-sonnet',
    'gpt-oss-120b'
  ]));
  setTimeout(() => process.exit(0), 10000);
}
`;
    writeFileSync(fakeAgyPath, scriptContent, 'utf8');
    chmodSync(fakeAgyPath, 0o755);

    const oldAgy = process.env.ANTIGRAVITY_COMMAND;
    process.env.ANTIGRAVITY_COMMAND = fakeAgyPath;

    try {
      const startedAt = Date.now();
      const models = await getAntigravityModels();
      const elapsedMs = Date.now() - startedAt;

      assert.deepEqual(models, ['gemini-3.6-flash-high', 'gpt-oss-120b']);
      // The child remains alive for ten seconds. Allow CI scheduling variance while
      // ensuring discovery does not wait for that full process lifetime.
      assert.ok(elapsedMs < 7000, `model discovery took ${elapsedMs}ms`);

      const pid = Number(readFileSync(pidPath, 'utf8'));
      let exited = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          process.kill(pid, 0);
        } catch (error: any) {
          if (error.code === 'ESRCH') {
            exited = true;
            break;
          }
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(exited, true, 'model discovery child should not remain running');
    } finally {
      process.env.ANTIGRAVITY_COMMAND = oldAgy;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('lists the visible account-aware Codex models from the local CLI catalog', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'spark-dispatch-codex-models-'));
    const fakeCodexPath = join(tempDir, 'fake-codex');
    const scriptContent = `#!/usr/bin/env node
if (process.argv.includes('--help')) process.exit(0);
if (process.argv[2] === 'debug' && process.argv[3] === 'models') {
  process.stdout.write(JSON.stringify({ models: [
    { slug: 'gpt-5.6-sol', visibility: 'list', supported_in_api: true },
    { slug: 'hidden-model', visibility: 'hide', supported_in_api: true },
    { slug: 'unsupported-model', visibility: 'list', supported_in_api: false },
    { slug: 'gpt-5.6-sol', visibility: 'list', supported_in_api: true },
    { slug: 'gpt-5.6-luna', visibility: 'list', supported_in_api: true }
  ] }));
  process.exit(0);
}
`;
    writeFileSync(fakeCodexPath, scriptContent, 'utf8');
    chmodSync(fakeCodexPath, 0o755);

    const oldCodex = process.env.CODEX_COMMAND;
    process.env.CODEX_COMMAND = fakeCodexPath;
    try {
      assert.deepEqual(await getCodexModels(), ['default', 'gpt-5.6-sol', 'gpt-5.6-luna']);
    } finally {
      process.env.CODEX_COMMAND = oldCodex;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects dispatch when the task instruction contains secrets', async () => {
    const store = new SQLiteStore(':memory:');
    const engine = new TaskEngine(store);

    const task = engine.createTask({
      instruction:
        'This contains ' + ['sk', 'live', 'synthetic'.repeat(5)].join('_') + ' secret key.',
      agent: 'antigravity',
    });

    const oldAgy = process.env.ANTIGRAVITY_COMMAND;
    process.env.ANTIGRAVITY_COMMAND = 'node';

    try {
      await assert.rejects(() => dispatchAgent(engine, task.id), /Secret material cannot cross/);

      const updatedTask = engine.getTask(task.id)!;
      assert.equal(updatedTask.dispatchStatus, 'failed');
      assert.match(updatedTask.dispatchSummary!, /contains recognized secrets/);
    } finally {
      process.env.ANTIGRAVITY_COMMAND = oldAgy;
      store.close();
    }
  });

  it('prevents duplicate dispatch calls', async () => {
    const store = new SQLiteStore(':memory:');
    const engine = new TaskEngine(store);

    const task = engine.createTask({
      instruction: 'Normal instruction',
      agent: 'antigravity',
    });

    // Manually set status to queued
    task.dispatchStatus = 'queued';
    store.updateTask(task);

    const oldAgy = process.env.ANTIGRAVITY_COMMAND;
    process.env.ANTIGRAVITY_COMMAND = 'node';

    try {
      await assert.rejects(() => dispatchAgent(engine, task.id), /already dispatched/);
    } finally {
      process.env.ANTIGRAVITY_COMMAND = oldAgy;
      store.close();
    }
  });

  it('executes process with safe environment, correct args, and output redaction', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'spark-dispatch-exec-'));
    const fakeAgyPath = join(tempDir, 'fake-agy');

    const scriptContent = `#!/usr/bin/env node
const fs = require('node:fs');
const out = {
  env: process.env,
  argv: process.argv,
  dummySecret: ['sk', 'live', 'synthetic'.repeat(5)].join('_')
};
console.log(JSON.stringify(out));
`;
    writeFileSync(fakeAgyPath, scriptContent, 'utf8');
    chmodSync(fakeAgyPath, 0o755);

    const oldAgy = process.env.ANTIGRAVITY_COMMAND;
    process.env.ANTIGRAVITY_COMMAND = fakeAgyPath;

    const store = new SQLiteStore(':memory:');
    const engine = new TaskEngine(store);

    try {
      const task = engine.createTask({
        instruction: 'Translate weekly report',
        agent: 'antigravity',
      });

      await dispatchAgent(engine, task.id, { mode: 'plan' });

      // Poll until finished (max 5 seconds)
      let finished = false;
      for (let i = 0; i < 50; i++) {
        const t = engine.getTask(task.id)!;
        if (t.dispatchStatus === 'responded' || t.dispatchStatus === 'failed') {
          finished = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }

      assert.equal(finished, true, 'Task dispatch process did not finish');
      const finalTask = engine.getTask(task.id)!;
      assert.equal(finalTask.dispatchStatus, 'responded');

      const parsedResult = JSON.parse(finalTask.dispatchSummary!);
      // Assert safe env behavior
      assert.ok(parsedResult.env.PATH);
      assert.equal(parsedResult.env.SECRET_KEY_NOT_ALLOWED, undefined);

      // Assert args passed correctly
      assert.ok(parsedResult.argv.includes('--print'));
      assert.ok(parsedResult.argv.includes('--mode'));
      assert.ok(parsedResult.argv.includes('plan'));

      // Assert summary redaction worked
      assert.ok(
        !finalTask.dispatchSummary!.includes(['sk', 'live', 'synthetic'.repeat(5)].join('_')),
      );
      assert.ok(finalTask.dispatchSummary!.includes('[REDACTED]'));
    } finally {
      process.env.ANTIGRAVITY_COMMAND = oldAgy;
      store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('serves API routes for agent-providers and dispatching/cancelling', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'spark-dispatch-api-'));
    const fakeAgyPath = join(tempDir, 'fake-agy');
    const scriptContent = `#!/usr/bin/env node
console.log('Result completed successfully');
`;
    writeFileSync(fakeAgyPath, scriptContent, 'utf8');
    chmodSync(fakeAgyPath, 0o755);

    const oldAgy = process.env.ANTIGRAVITY_COMMAND;
    process.env.ANTIGRAVITY_COMMAND = fakeAgyPath;

    const store = new SQLiteStore(':memory:');
    const engine = new TaskEngine(store);
    const apiInstance = createApiServer(engine, { port: 0 });

    await new Promise<void>((resolve) =>
      apiInstance.server.listen(0, '127.0.0.1', () => resolve()),
    );
    const port = (apiInstance.server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    try {
      // 1. GET /api/v1/agent-providers
      const provRes = await fetch(`${base}/api/v1/agent-providers`, {
        headers: { Authorization: `Bearer ${apiInstance.token}`, Connection: 'close' },
      });
      assert.equal(provRes.status, 200);
      const provData = (await provRes.json()) as any;
      assert.ok(provData.providers);
      assert.equal(
        provData.providers.some((p: any) => p.id === 'antigravity'),
        true,
      );

      // 2. POST /api/v1/tasks/:id/dispatch
      const task = engine.createTask({
        instruction: 'Process standard task log',
        agent: 'antigravity',
      });

      const dispRes = await fetch(`${base}/api/v1/tasks/${task.id}/dispatch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiInstance.token}`,
          Connection: 'close',
        },
        body: JSON.stringify({ mode: 'plan' }),
      });
      assert.equal(dispRes.status, 202);
      const dispData = (await dispRes.json()) as any;
      assert.equal(dispData.dispatchStatus, 'queued');

      // 3. POST /api/v1/tasks/:id/cancel-dispatch
      const cancelRes = await fetch(`${base}/api/v1/tasks/${task.id}/cancel-dispatch`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiInstance.token}`,
          Connection: 'close',
        },
      });
      assert.equal(cancelRes.status, 200);
      const cancelData = (await cancelRes.json()) as any;
      assert.equal(cancelData.success, true);
      assert.equal(cancelData.task.dispatchStatus, 'cancelled');

      // Wait for task to transition out of queued/running so background activity completes before closing db
      let finalTask = engine.getTask(task.id)!;
      while (['queued', 'running'].includes(finalTask.dispatchStatus)) {
        await new Promise((r) => setTimeout(r, 50));
        finalTask = engine.getTask(task.id)!;
      }
    } finally {
      if (apiInstance.server.closeAllConnections) {
        apiInstance.server.closeAllConnections();
      }
      await new Promise<void>((resolve) => apiInstance.server.close(() => resolve()));
      process.env.ANTIGRAVITY_COMMAND = oldAgy;
      store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('CLI-style await dispatchAgent() resolves only after delayed child finishes', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'spark-dispatch-delay-'));
    const fakeAgyPath = join(tempDir, 'fake-agy');

    const scriptContent = `#!/usr/bin/env node
if (process.argv.includes('--help')) {
  process.exit(0);
}
setTimeout(() => {
  console.log('Delayed output');
}, 300);
`;
    writeFileSync(fakeAgyPath, scriptContent, 'utf8');
    chmodSync(fakeAgyPath, 0o755);

    const oldAgy = process.env.ANTIGRAVITY_COMMAND;
    process.env.ANTIGRAVITY_COMMAND = fakeAgyPath;

    const store = new SQLiteStore(':memory:');
    const engine = new TaskEngine(store);

    try {
      const task = engine.createTask({
        instruction: 'Delayed test',
        agent: 'antigravity',
      });

      let resolved = false;
      const p = dispatchAgent(engine, task.id).then(() => {
        resolved = true;
      });

      // Wait 100ms, should not be resolved yet
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(resolved, false, 'dispatchAgent resolved too early');

      // Wait for it to finish completely
      await p;
      assert.equal(resolved, true);

      const finalTask = engine.getTask(task.id)!;
      assert.ok(['responded', 'failed'].includes(finalTask.dispatchStatus));
    } finally {
      process.env.ANTIGRAVITY_COMMAND = oldAgy;
      store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('startAgentDispatch returns promptly with queued/running state while child continues', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'spark-dispatch-nonblock-'));
    const fakeAgyPath = join(tempDir, 'fake-agy');

    const scriptContent = `#!/usr/bin/env node
if (process.argv.includes('--help')) {
  process.exit(0);
}
setTimeout(() => {
  console.log('Result finished');
}, 300);
`;
    writeFileSync(fakeAgyPath, scriptContent, 'utf8');
    chmodSync(fakeAgyPath, 0o755);

    const oldAgy = process.env.ANTIGRAVITY_COMMAND;
    process.env.ANTIGRAVITY_COMMAND = fakeAgyPath;

    const store = new SQLiteStore(':memory:');
    const engine = new TaskEngine(store);

    try {
      const task = engine.createTask({
        instruction: 'Non-blocking test',
        agent: 'antigravity',
      });

      const handle = startAgentDispatch(engine, task.id);

      // Should return promptly, check that state is queued or running
      const immediateTask = engine.getTask(task.id)!;
      assert.ok(['queued', 'running'].includes(immediateTask.dispatchStatus));

      // Now wait for completion promise
      await handle.promise;

      const finalTask = engine.getTask(task.id)!;
      assert.equal(finalTask.dispatchStatus, 'responded');
    } finally {
      process.env.ANTIGRAVITY_COMMAND = oldAgy;
      store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('immediate cancellation wins and remains cancelled', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'spark-dispatch-cancel-'));
    const fakeAgyPath = join(tempDir, 'fake-agy');

    const scriptContent = `#!/usr/bin/env node
if (process.argv.includes('--help')) {
  process.exit(0);
}
console.log('Result finished');
`;
    writeFileSync(fakeAgyPath, scriptContent, 'utf8');
    chmodSync(fakeAgyPath, 0o755);

    const oldAgy = process.env.ANTIGRAVITY_COMMAND;
    process.env.ANTIGRAVITY_COMMAND = fakeAgyPath;

    const store = new SQLiteStore(':memory:');
    const engine = new TaskEngine(store);

    try {
      const task = engine.createTask({
        instruction: 'Cancel test',
        agent: 'antigravity',
      });

      const handle = startAgentDispatch(engine, task.id);
      const cancelSuccess = await handle.cancel();
      assert.equal(cancelSuccess, true);

      // Wait a moment for any async tasks/close callback to run (to ensure they don't overwrite)
      await new Promise((r) => setTimeout(r, 100));

      const finalTask = engine.getTask(task.id)!;
      assert.equal(finalTask.dispatchStatus, 'cancelled');
    } finally {
      process.env.ANTIGRAVITY_COMMAND = oldAgy;
      store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects unavailable/unknown providers and invalid modes', async () => {
    const store = new SQLiteStore(':memory:');
    const engine = new TaskEngine(store);

    try {
      // 1. Unknown provider
      const task1 = engine.createTask({
        instruction: 'Test',
        agent: 'unknown-provider',
      });
      assert.throws(() => startAgentDispatch(engine, task1.id), /Unsupported provider/);

      // 2. Invalid mode
      const task2 = engine.createTask({
        instruction: 'Test',
        agent: 'antigravity',
      });
      assert.throws(
        () => startAgentDispatch(engine, task2.id, { mode: 'invalid-mode' as any }),
        /Unsupported mode/,
      );

      // 3. Unavailable provider
      const oldAgy = process.env.ANTIGRAVITY_COMMAND;
      process.env.ANTIGRAVITY_COMMAND = '/path/to/non-existent-executable-agy';
      try {
        assert.throws(() => startAgentDispatch(engine, task2.id), /not available/);
      } finally {
        process.env.ANTIGRAVITY_COMMAND = oldAgy;
      }
    } finally {
      store.close();
    }
  });

  it('provider availability probes use noninteractive help args', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'spark-dispatch-probe-'));
    const fakeAgyPath = join(tempDir, 'fake-agy');

    const scriptContent = `#!/usr/bin/env node
if (process.argv.includes('--help')) {
  process.exit(0);
} else {
  process.exit(1);
}
`;
    writeFileSync(fakeAgyPath, scriptContent, 'utf8');
    chmodSync(fakeAgyPath, 0o755);

    const oldAgy = process.env.ANTIGRAVITY_COMMAND;
    process.env.ANTIGRAVITY_COMMAND = fakeAgyPath;

    try {
      const avail = getProviderAvailability('antigravity');
      assert.equal(avail, true, 'Availability probe did not pass --help correctly');

      // Test directory path returns unavailable (false)
      process.env.ANTIGRAVITY_COMMAND = tempDir;
      assert.equal(
        getProviderAvailability('antigravity'),
        false,
        'Directory path should be unavailable',
      );

      // Test non-existent path returns unavailable
      process.env.ANTIGRAVITY_COMMAND = join(tempDir, 'missing-file');
      assert.equal(
        getProviderAvailability('antigravity'),
        false,
        'Non-existent path should be unavailable',
      );

      // Test non-executable path (no execution permissions)
      const nonExecPath = join(tempDir, 'non-exec');
      writeFileSync(nonExecPath, 'not executable code', 'utf8');
      chmodSync(nonExecPath, 0o644);
      process.env.ANTIGRAVITY_COMMAND = nonExecPath;
      assert.equal(
        getProviderAvailability('antigravity'),
        false,
        'Non-executable file path should be unavailable',
      );
    } finally {
      process.env.ANTIGRAVITY_COMMAND = oldAgy;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('checks model fallback and real lowercase ID semantics', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'spark-dispatch-fallback-'));
    const fakeAgyPath = join(tempDir, 'fake-agy');

    const scriptContent = `#!/usr/bin/env node
if (process.argv.includes('models')) {
  process.exit(1);
} else {
  // Probe --help
  process.exit(0);
}
`;
    writeFileSync(fakeAgyPath, scriptContent, 'utf8');
    chmodSync(fakeAgyPath, 0o755);

    const oldAgy = process.env.ANTIGRAVITY_COMMAND;
    process.env.ANTIGRAVITY_COMMAND = fakeAgyPath;

    try {
      const models = await getAntigravityModels();
      assert.deepEqual(models, ['gemini-3.5-flash-high']);
    } finally {
      process.env.ANTIGRAVITY_COMMAND = oldAgy;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('raw stderr failure produces concise non-sensitive saved message', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'spark-dispatch-stderr-'));
    const fakeAgyPath = join(tempDir, 'fake-agy');

    const scriptContent = `#!/usr/bin/env node
if (process.argv.includes('--help')) {
  process.exit(0);
}
process.stderr.write('Fatal error: credential /absolute/path/to/some/file authentication failed\\n');
process.exit(1);
`;
    writeFileSync(fakeAgyPath, scriptContent, 'utf8');
    chmodSync(fakeAgyPath, 0o755);

    const oldAgy = process.env.ANTIGRAVITY_COMMAND;
    process.env.ANTIGRAVITY_COMMAND = fakeAgyPath;

    const store = new SQLiteStore(':memory:');
    const engine = new TaskEngine(store);

    try {
      const task = engine.createTask({
        instruction: 'Stderr test',
        agent: 'antigravity',
      });

      await dispatchAgent(engine, task.id);

      const finalTask = engine.getTask(task.id)!;
      assert.equal(finalTask.dispatchStatus, 'failed');

      // Should not contain the path, credential, or raw stderr
      assert.ok(!finalTask.dispatchSummary!.includes('/absolute/path'));
      assert.ok(!finalTask.dispatchSummary!.includes('credential'));
      // Should be mapped to the safe category
      assert.ok(finalTask.dispatchSummary!.includes('認証情報の取得に失敗したか'));
    } finally {
      process.env.ANTIGRAVITY_COMMAND = oldAgy;
      store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('classifies provider quota and unavailable-model failures without retaining raw diagnostics', () => {
    assert.match(
      getSafeJapaneseError(
        'Error: Individual quota reached. Please upgrade your subscription to increase your limits.',
      ),
      /利用上限に達しました/u,
    );
    assert.match(
      getSafeJapaneseError(
        'Unknown model: ' + ['sk', 'live', 'synthetic'.repeat(5)].join('_') + '_not_escape',
      ),
      /選択したモデル/u,
    );
  });

  it('Antigravity argv includes noninteractive workspace arguments and no auto-approve', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'spark-dispatch-args-'));
    const fakeAgyPath = join(tempDir, 'fake-agy');
    const argvJsonPath = join(tempDir, 'argv.json');

    const scriptContent = `#!/usr/bin/env node
if (process.argv.includes('--help')) {
  process.exit(0);
}
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(argvJsonPath)}, JSON.stringify(process.argv), 'utf8');
console.log('Success');
`;
    writeFileSync(fakeAgyPath, scriptContent, 'utf8');
    chmodSync(fakeAgyPath, 0o755);

    const oldAgy = process.env.ANTIGRAVITY_COMMAND;
    process.env.ANTIGRAVITY_COMMAND = fakeAgyPath;

    const store = new SQLiteStore(':memory:');
    const engine = new TaskEngine(store);

    try {
      const task = engine.createTask({
        instruction: 'Args test',
        agent: 'antigravity',
      });

      await dispatchAgent(engine, task.id, { mode: 'workspace' });

      // Read argv.json
      const argv = JSON.parse(readFileSync(argvJsonPath, 'utf8'));

      assert.ok(argv.includes('--new-project'));
      assert.ok(argv.includes('--add-dir'));
      assert.ok(argv.includes('.'));
      assert.ok(argv.includes('--print-timeout'));

      // Ensure dangerous approval flags are not present
      assert.ok(!argv.includes('--dangerously-skip-permissions'));
      assert.ok(!argv.includes('--yes'));
      assert.ok(!argv.includes('-y'));
    } finally {
      process.env.ANTIGRAVITY_COMMAND = oldAgy;
      store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('Codex receives stdin and summarizes JSONL response correctly', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'spark-dispatch-codex-'));
    const fakeCodexPath = join(tempDir, 'fake-codex');
    const stdinTxtPath = join(tempDir, 'stdin.txt');

    const scriptContent = `#!/usr/bin/env node
if (process.argv.includes('--help')) {
  process.exit(0);
}
const fs = require('node:fs');
let stdin = '';
process.stdin.on('data', (chunk) => {
  stdin += chunk.toString();
});
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(stdinTxtPath)}, stdin, 'utf8');
  console.log(JSON.stringify({ type: 'agent_message', text: 'Step 1 output' }));
  console.log(JSON.stringify({ type: 'agent_message', text: 'Final summary output' }));
  process.exit(0);
});
`;
    writeFileSync(fakeCodexPath, scriptContent, 'utf8');
    chmodSync(fakeCodexPath, 0o755);

    const oldCodex = process.env.CODEX_COMMAND;
    process.env.CODEX_COMMAND = fakeCodexPath;

    const store = new SQLiteStore(':memory:');
    const engine = new TaskEngine(store);

    try {
      const task = engine.createTask({
        instruction: 'Codex input test',
        agent: 'codex',
      });

      await dispatchAgent(engine, task.id);

      // Verify stdin was passed
      const stdinData = readFileSync(stdinTxtPath, 'utf8');

      assert.ok(stdinData.includes('Codex input test'));

      const finalTask = engine.getTask(task.id)!;
      assert.equal(finalTask.dispatchStatus, 'responded');
      // Should summarize the last message
      assert.equal(finalTask.dispatchSummary, 'Final summary output');
    } finally {
      process.env.CODEX_COMMAND = oldCodex;
      store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('malformed timeout environment uses the safe fallback/bounds', () => {
    // Infinity -> 300000
    assert.equal(parseTimeout('Infinity'), 300000);
    // negative -> 300000
    assert.equal(parseTimeout('-1000'), 300000);
    // too small -> 300000
    assert.equal(parseTimeout('29999'), 300000);
    // too large -> 300000
    assert.equal(parseTimeout('900001'), 300000);
    // valid -> keeps value
    assert.equal(parseTimeout('60000'), 60000);
    // undefined -> 300000
    assert.equal(parseTimeout(undefined), 300000);
    assert.equal(parseTimeout(''), 300000);
  });

  it('API-created invalid provider/model is rejected', async () => {
    const store = new SQLiteStore(':memory:');
    const engine = new TaskEngine(store);
    const apiInstance = createApiServer(engine, { port: 0 });

    await new Promise<void>((resolve) =>
      apiInstance.server.listen(0, '127.0.0.1', () => resolve()),
    );
    const port = (apiInstance.server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    try {
      // 1. Invalid provider in body
      const badProviderRes = await fetch(`${base}/api/v1/tasks`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiInstance.token}`,
          Connection: 'close',
        },
        body: JSON.stringify({
          instruction: 'Run invalid provider',
          agent: 'invalid-provider',
        }),
      });
      assert.equal(badProviderRes.status, 400);
      const badProviderData = (await badProviderRes.json()) as any;
      assert.match(badProviderData.error, /Unsupported provider/);

      // 2. Invalid model in body (empty string)
      const badModelRes = await fetch(`${base}/api/v1/tasks`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiInstance.token}`,
          Connection: 'close',
        },
        body: JSON.stringify({
          instruction: 'Run invalid model',
          agent: 'antigravity',
          model: '   ',
        }),
      });
      assert.equal(badModelRes.status, 400);
      const badModelData = (await badModelRes.json()) as any;
      assert.match(badModelData.error, /Invalid model ID/);
    } finally {
      apiInstance.close(() => store.close());
    }
  });

  it('graceful dispatcher shutdown cancels a delayed process and persists cancelled before closing', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'spark-dispatch-shutdown-'));
    const fakeAgyPath = join(tempDir, 'fake-agy');

    const scriptContent = `#!/usr/bin/env node
if (process.argv.includes('--help')) {
  process.exit(0);
}
// Sleep indefinitely
setTimeout(() => {}, 100000);
`;
    writeFileSync(fakeAgyPath, scriptContent, 'utf8');
    chmodSync(fakeAgyPath, 0o755);

    const oldAgy = process.env.ANTIGRAVITY_COMMAND;
    process.env.ANTIGRAVITY_COMMAND = fakeAgyPath;

    const store = new SQLiteStore(':memory:');
    const engine = new TaskEngine(store);

    try {
      const task = engine.createTask({
        instruction: 'Shutdown test',
        agent: 'antigravity',
      });

      startAgentDispatch(engine, task.id);

      // Give it a moment to spawn and become running
      await new Promise((r) => setTimeout(r, 100));

      const startedTask = engine.getTask(task.id)!;
      assert.ok(['queued', 'running'].includes(startedTask.dispatchStatus));

      // Shutdown dispatcher
      await shutdownAgentDispatcher(engine);

      const finalTask = engine.getTask(task.id)!;
      assert.equal(finalTask.dispatchStatus, 'cancelled');
    } finally {
      process.env.ANTIGRAVITY_COMMAND = oldAgy;
      store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('external CLI response audit decision is null/unverified, not policy allow', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'spark-dispatch-audit-'));
    const fakeAgyPath = join(tempDir, 'fake-agy');

    const scriptContent = `#!/usr/bin/env node
if (process.argv.includes('--help')) {
  process.exit(0);
}
console.log('Task completed.');
process.exit(0);
`;
    writeFileSync(fakeAgyPath, scriptContent, 'utf8');
    chmodSync(fakeAgyPath, 0o755);

    const oldAgy = process.env.ANTIGRAVITY_COMMAND;
    process.env.ANTIGRAVITY_COMMAND = fakeAgyPath;

    const store = new SQLiteStore(':memory:');
    const engine = new TaskEngine(store);

    try {
      const task = engine.createTask({
        instruction: 'Audit test',
        agent: 'antigravity',
      });

      await dispatchAgent(engine, task.id);

      // Check audit decision and verification result
      const auditLogs = engine.audit.list();
      const auditRespond = auditLogs.find(
        (a) => a.taskId === task.id && a.tool === 'task.dispatch.respond',
      );
      assert.ok(auditRespond);
      assert.equal(auditRespond.decision, null);
      const resultObj = auditRespond.result as any;
      assert.ok(resultObj);
      assert.equal(resultObj.verification, 'unverified external CLI response');
    } finally {
      process.env.ANTIGRAVITY_COMMAND = oldAgy;
      store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('Codex dispatcher captures argv and asserts flags, sandbox, and stdin', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'spark-dispatch-codex-argv-'));
    const fakeCodexPath = join(tempDir, 'fake-codex');
    const stdinTxtPath = join(tempDir, 'stdin.txt');
    const argvJsonPath = join(tempDir, 'argv.json');

    const scriptContent = `#!/usr/bin/env node
if (process.argv.includes('--help')) {
  process.exit(0);
}
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(argvJsonPath)}, JSON.stringify(process.argv), 'utf8');
let stdin = '';
process.stdin.on('data', (chunk) => {
  stdin += chunk.toString();
});
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(stdinTxtPath)}, stdin, 'utf8');
  console.log(JSON.stringify({ type: 'agent_message', text: 'Step 1' }));
  process.exit(0);
});
`;
    writeFileSync(fakeCodexPath, scriptContent, 'utf8');
    chmodSync(fakeCodexPath, 0o755);

    const oldCodex = process.env.CODEX_COMMAND;
    process.env.CODEX_COMMAND = fakeCodexPath;

    const store = new SQLiteStore(':memory:');
    const engine = new TaskEngine(store);

    try {
      const task = engine.createTask({
        instruction: 'Workspace Codex test',
        agent: 'codex',
      });

      await dispatchAgent(engine, task.id, { mode: 'workspace' });

      // Verify stdin was passed
      const stdinData = readFileSync(stdinTxtPath, 'utf8');
      assert.ok(stdinData.includes('Workspace Codex test'));

      // Verify argv
      const argv = JSON.parse(readFileSync(argvJsonPath, 'utf8'));
      assert.ok(argv.includes('--skip-git-repo-check'));
      assert.ok(argv.includes('--json'));
      assert.ok(argv.includes('--sandbox'));
      assert.ok(argv.includes('workspace-write'));
    } finally {
      process.env.CODEX_COMMAND = oldCodex;
      store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('Codex dispatcher parses nested agent_message, redacts secret and local path, and does not leak metadata or command outputs', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'spark-dispatch-nested-codex-'));
    const fakeCodexPath = join(tempDir, 'fake-codex');

    const scriptContent = `#!/usr/bin/env node
if (process.argv.includes('--help')) {
  process.exit(0);
}
// Emit a command execution event with fake secret, local path, and the word 'confirmation'
console.log(JSON.stringify({
  type: "item.completed",
  item: {
    type: "command_execution",
    aggregated_output: "Running test command... file: /Users/example/private.txt secret: " + ['sk', 'live', 'synthetic'.repeat(5)].join('_')
  }
}));
// Emit the nested agent_message event
console.log(JSON.stringify({
  type: "item.completed",
  item: {
    type: "agent_message",
    text: "Task completed successfully. The file /Users/example/private.txt is processed."
  }
}));
process.exit(0);
`;
    writeFileSync(fakeCodexPath, scriptContent, 'utf8');
    chmodSync(fakeCodexPath, 0o755);

    const oldCodex = process.env.CODEX_COMMAND;
    process.env.CODEX_COMMAND = fakeCodexPath;

    const store = new SQLiteStore(':memory:');
    const engine = new TaskEngine(store);

    try {
      const task = engine.createTask({
        instruction: 'Nested Codex test',
        agent: 'codex',
      });

      await dispatchAgent(engine, task.id);

      const finalTask = engine.getTask(task.id)!;
      // Assert status is responded (even though command execution output had 'confirmation')
      assert.equal(finalTask.dispatchStatus, 'responded');

      // Assert only nested agent message text is stored, and has local paths masked
      assert.equal(
        finalTask.dispatchSummary,
        'Task completed successfully. The file [PATH] is processed.',
      );

      // Assert no raw metadata or command outputs or secrets leaked
      assert.ok(!finalTask.dispatchSummary!.includes('command_execution'));
      assert.ok(!finalTask.dispatchSummary!.includes('sk_live'));
      assert.ok(!finalTask.dispatchSummary!.includes('/Users/example'));
    } finally {
      process.env.CODEX_COMMAND = oldCodex;
      store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('Codex dispatcher stores a safe Japanese message when no agent message was returned', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'spark-dispatch-no-agent-'));
    const fakeCodexPath = join(tempDir, 'fake-codex');

    const scriptContent = `#!/usr/bin/env node
if (process.argv.includes('--help')) {
  process.exit(0);
}
// Emit only command execution event, no agent_message
console.log(JSON.stringify({
  type: "item.completed",
  item: {
    type: "command_execution",
    aggregated_output: "doing some build stuff..."
  }
}));
process.exit(0);
`;
    writeFileSync(fakeCodexPath, scriptContent, 'utf8');
    chmodSync(fakeCodexPath, 0o755);

    const oldCodex = process.env.CODEX_COMMAND;
    process.env.CODEX_COMMAND = fakeCodexPath;

    const store = new SQLiteStore(':memory:');
    const engine = new TaskEngine(store);

    try {
      const task = engine.createTask({
        instruction: 'No agent message Codex test',
        agent: 'codex',
      });

      await dispatchAgent(engine, task.id);

      const finalTask = engine.getTask(task.id)!;
      assert.equal(finalTask.dispatchStatus, 'responded');
      assert.equal(
        finalTask.dispatchSummary,
        'Codex CLI はユーザー向けの最終応答を返しませんでした。',
      );
    } finally {
      process.env.CODEX_COMMAND = oldCodex;
      store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('Antigravity dispatcher masks local absolute paths in its summary output', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'spark-dispatch-path-mask-'));
    const fakeAgyPath = join(tempDir, 'fake-agy');

    const scriptContent = `#!/usr/bin/env node
if (process.argv.includes('--help')) {
  process.exit(0);
}
console.log("Antigravity finished. Work dir was /Users/example/workspace and file:///Users/example/workspace/out.txt");
process.exit(0);
`;
    writeFileSync(fakeAgyPath, scriptContent, 'utf8');
    chmodSync(fakeAgyPath, 0o755);

    const oldAgy = process.env.ANTIGRAVITY_COMMAND;
    process.env.ANTIGRAVITY_COMMAND = fakeAgyPath;

    const store = new SQLiteStore(':memory:');
    const engine = new TaskEngine(store);

    try {
      const task = engine.createTask({
        instruction: 'Path masking test',
        agent: 'antigravity',
      });

      await dispatchAgent(engine, task.id);

      const finalTask = engine.getTask(task.id)!;
      assert.equal(finalTask.dispatchStatus, 'responded');
      assert.equal(
        finalTask.dispatchSummary,
        'Antigravity finished. Work dir was [PATH] and [PATH]',
      );
    } finally {
      process.env.ANTIGRAVITY_COMMAND = oldAgy;
      store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('handles split UTF-8 characters in streaming stdout/stderr without corruption', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'spark-dispatch-utf8-'));
    const fakeAgyPath = join(tempDir, 'fake-agy');

    // Katakana 'プ' UTF-8: 0xe3 0x83 0x97
    const scriptContent = `#!/usr/bin/env node
if (process.argv.includes('--help')) {
  process.exit(0);
}
const chunk1 = Buffer.concat([
  Buffer.from('この'),
  Buffer.from([0xe3])
]);
const chunk2 = Buffer.concat([
  Buffer.from([0x83, 0x97]),
  Buffer.from('ロジェクト')
]);
process.stdout.write(chunk1);
setTimeout(() => {
  process.stdout.write(chunk2);
  process.exit(0);
}, 50);
`;
    writeFileSync(fakeAgyPath, scriptContent, 'utf8');
    chmodSync(fakeAgyPath, 0o755);

    const oldAgy = process.env.ANTIGRAVITY_COMMAND;
    process.env.ANTIGRAVITY_COMMAND = fakeAgyPath;

    const store = new SQLiteStore(':memory:');
    const engine = new TaskEngine(store);

    try {
      const task = engine.createTask({
        instruction: 'Utf8 test',
        agent: 'antigravity',
      });

      await dispatchAgent(engine, task.id);

      const finalTask = engine.getTask(task.id)!;
      assert.equal(finalTask.dispatchStatus, 'responded');
      assert.equal(finalTask.dispatchSummary, 'このプロジェクト');
      // Assert no replacement characters (U+FFFD is \uFFFD)
      assert.ok(!finalTask.dispatchSummary!.includes('\uFFFD'));
    } finally {
      process.env.ANTIGRAVITY_COMMAND = oldAgy;
      store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('handles split UTF-8 characters in models list without corruption', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'spark-dispatch-models-utf8-'));
    const fakeAgyPath = join(tempDir, 'fake-agy');

    const scriptContent = `#!/usr/bin/env node
if (process.argv.includes('--help')) {
  process.exit(0);
}
if (process.argv.includes('models')) {
  // 'ル' in UTF-8 is 0xe3 0x83 0xab
  const chunk1 = Buffer.concat([
    Buffer.from('["モデ'),
    Buffer.from([0xe3])
  ]);
  const chunk2 = Buffer.concat([
    Buffer.from([0x83, 0xab]),
    Buffer.from('"]')
  ]);
  process.stdout.write(chunk1);
  setTimeout(() => {
    process.stdout.write(chunk2);
    process.exit(0);
  }, 50);
}
`;
    writeFileSync(fakeAgyPath, scriptContent, 'utf8');
    chmodSync(fakeAgyPath, 0o755);

    const oldAgy = process.env.ANTIGRAVITY_COMMAND;
    process.env.ANTIGRAVITY_COMMAND = fakeAgyPath;

    try {
      const models = await getAntigravityModels();
      assert.deepEqual(models, ['モデル']);
    } finally {
      process.env.ANTIGRAVITY_COMMAND = oldAgy;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
