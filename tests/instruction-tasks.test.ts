import { strict as assert } from 'node:assert';
import { describe, it, before, after } from 'node:test';
import { writeFileSync, chmodSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { SQLiteStore } from '../src/storage/sqlite.js';
import { TaskEngine } from '../src/runtime/task-engine.js';
import { suggestSteps } from '../src/planning/step-planner.js';
import { registerTaskRoutes } from '../src/api/routes/tasks.js';

describe('Instruction-only task planning and creation', () => {
  let tempDir: string;
  let mockPlannerPath: string;
  let fallbackAntigravityPath: string;
  let fallbackCodexPath: string;
  let selectedCodexPath: string;
  let dbPath: string;
  let store: SQLiteStore;
  let engine: TaskEngine;

  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'spark-tests-'));
    dbPath = join(tempDir, 'test.sqlite');
    store = new SQLiteStore(dbPath);
    engine = new TaskEngine(store);

    // Mock planner setup
    mockPlannerPath = join(tempDir, 'mock-planner.js');
    writeFileSync(
      mockPlannerPath,
      `#!/usr/bin/env node
const prompt = process.argv.at(-1) ?? '';
if (!prompt.includes('Do something creative') && !prompt.includes('Generate some steps for me')) process.exit(11);
if (process.env.SPARK_PLANNER_PARENT_SECRET !== undefined) process.exit(12);
console.log(JSON.stringify({
  title: "Mocked Task Title from LLM",
  steps: [
    "Step 1: Perform mock action",
    "Step 2: Complete mock task"
  ]
}));
`,
    );
    chmodSync(mockPlannerPath, 0o755);
    fallbackAntigravityPath = join(tempDir, 'mock-antigravity.js');
    writeFileSync(
      fallbackAntigravityPath,
      `#!/usr/bin/env node
process.stderr.write('quota exhausted for this provider\\n');
process.exit(9);
`,
    );
    chmodSync(fallbackAntigravityPath, 0o755);
    fallbackCodexPath = join(tempDir, 'mock-codex.js');
    writeFileSync(
      fallbackCodexPath,
      `#!/usr/bin/env node
if (!process.argv.includes('--skip-git-repo-check')) process.exit(13);
process.stdout.write(JSON.stringify({type: 'item.completed', item: {type: 'agent_message', text: JSON.stringify({title: 'Codex fallback title', steps: ['Codex fallback step']})}}) + '\\n');
`,
    );
    chmodSync(fallbackCodexPath, 0o755);
    selectedCodexPath = join(tempDir, 'mock-selected-codex.js');
    writeFileSync(
      selectedCodexPath,
      `#!/usr/bin/env node
if (!process.argv.includes('--model') || !process.argv.includes('custom-codex-model')) process.exit(14);
process.stdout.write(JSON.stringify({type: 'item.completed', item: {type: 'agent_message', text: JSON.stringify({title: 'Selected Codex title', steps: ['Selected Codex step']})}}) + '\\n');
`,
    );
    chmodSync(selectedCodexPath, 0o755);
    process.env.SPARK_PLANNER_PARENT_SECRET = 'must-not-be-inherited';
    process.env.PLANNER_COMMAND = mockPlannerPath;
  });

  after(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env.PLANNER_COMMAND;
    delete process.env.ANTIGRAVITY_COMMAND;
    delete process.env.CODEX_COMMAND;
    delete process.env.SPARK_PLANNER_PARENT_SECRET;
  });

  it('generates steps successfully using mock planner', async () => {
    const result = await suggestSteps('Do something creative');
    assert.equal(result.title, 'Mocked Task Title from LLM');
    assert.deepEqual(result.steps, ['Step 1: Perform mock action', 'Step 2: Complete mock task']);
    assert.equal(result.usedLlm, true);
  });

  it('does not expose the planner executable path when the LLM CLI is unavailable', async () => {
    const missingPlannerPath = join(tempDir, 'missing-planner');
    process.env.PLANNER_COMMAND = missingPlannerPath;
    try {
      await assert.rejects(suggestSteps('Do something creative'), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /LLM CLIが利用できません/);
        assert.doesNotMatch(error.message, /missing-planner/);
        return true;
      });
    } finally {
      process.env.PLANNER_COMMAND = mockPlannerPath;
    }
  });

  it('falls back to Codex with the non-git workspace argument when Antigravity quota is exhausted', async () => {
    delete process.env.PLANNER_COMMAND;
    process.env.ANTIGRAVITY_COMMAND = fallbackAntigravityPath;
    process.env.CODEX_COMMAND = fallbackCodexPath;
    try {
      const result = await suggestSteps('Use the Codex fallback');
      assert.equal(result.provider, 'codex');
      assert.deepEqual(result.steps, ['Codex fallback step']);
    } finally {
      process.env.PLANNER_COMMAND = mockPlannerPath;
      delete process.env.ANTIGRAVITY_COMMAND;
      delete process.env.CODEX_COMMAND;
    }
  });

  it('uses only the explicitly selected provider and model', async () => {
    delete process.env.PLANNER_COMMAND;
    process.env.ANTIGRAVITY_COMMAND = fallbackAntigravityPath;
    process.env.CODEX_COMMAND = selectedCodexPath;
    try {
      await assert.rejects(
        suggestSteps('Use Antigravity directly', { provider: 'antigravity', model: 'gemini-test' }),
        /利用上限に達した/u,
      );
      const result = await suggestSteps('Use Codex directly', {
        provider: 'codex',
        model: 'custom-codex-model',
      });
      assert.equal(result.provider, 'codex');
      assert.equal(result.model, 'custom-codex-model');
      assert.deepEqual(result.steps, ['Selected Codex step']);
    } finally {
      process.env.PLANNER_COMMAND = mockPlannerPath;
      delete process.env.ANTIGRAVITY_COMMAND;
      delete process.env.CODEX_COMMAND;
    }
  });

  it('classifies bounded, redacted planner stderr for quota exhaustion', async () => {
    const failingPlannerPath = join(tempDir, 'failing-planner.js');
    writeFileSync(
      failingPlannerPath,
      `#!/usr/bin/env node
process.stderr.write("quota exhausted: " + ['sk', 'live', 'synthetic'.repeat(5)].join('_') + "_not_escape " + 'x'.repeat(10000));
process.exit(3);
`,
    );
    chmodSync(failingPlannerPath, 0o755);
    process.env.PLANNER_COMMAND = failingPlannerPath;
    try {
      await assert.rejects(suggestSteps('Do something creative'), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /利用上限に達した/u);
        assert.doesNotMatch(error.message, /sk_live_should_not_escape/u);
        assert.ok(error.message.length < 5_000);
        return true;
      });
    } finally {
      process.env.PLANNER_COMMAND = mockPlannerPath;
    }
  });

  it('preserves Japanese planner output split across UTF-8 chunk boundaries', async () => {
    const splitUtf8PlannerPath = join(tempDir, 'split-utf8-planner.js');
    writeFileSync(
      splitUtf8PlannerPath,
      `#!/usr/bin/env node
const output = Buffer.from(JSON.stringify({title: '日本語の計画', steps: ['確認する', 'まとめる']}));
process.stdout.write(output.subarray(0, 18));
setTimeout(() => process.stdout.end(output.subarray(18)), 10);
`,
    );
    chmodSync(splitUtf8PlannerPath, 0o755);
    process.env.PLANNER_COMMAND = splitUtf8PlannerPath;
    try {
      const result = await suggestSteps('Do something creative');
      assert.equal(result.title, '日本語の計画');
      assert.deepEqual(result.steps, ['確認する', 'まとめる']);
    } finally {
      process.env.PLANNER_COMMAND = mockPlannerPath;
    }
  });

  it('rejects instruction containing sensitive credentials', async () => {
    await assert.rejects(
      suggestSteps('My API key is ' + ['sk', 'live', 'synthetic'.repeat(5)].join('_')),
      /LLMへ送信できません/,
    );
  });

  it('creates task using instruction-only and auto-generates short title', () => {
    const task = engine.createTask({
      instruction: 'First line of instruction\nSecond line of instruction',
    });
    assert.equal(task.title, 'First line of instruction');
    assert.equal(task.instruction, 'First line of instruction\nSecond line of instruction');
    assert.deepEqual(task.plannedSteps, []);
  });

  it('creates task using legacy title-only input for backward compatibility', () => {
    const task = engine.createTask({
      title: 'Legacy Title Only Task',
    });
    assert.equal(task.title, 'Legacy Title Only Task');
    assert.equal(task.instruction, null);
  });

  it('supports plannedSteps optional status in createTask', () => {
    const task = engine.createTask({
      instruction: 'Run test suite',
      plannedSteps: ['npm test'],
    });
    assert.equal(task.title, 'Run test suite');
    assert.deepEqual(task.plannedSteps, ['npm test']);
  });

  it('handles API route for task creation with instruction-only via POST /api/v1/tasks', async () => {
    const routes = registerTaskRoutes(engine);
    const postRoute = routes.find((r) => r.method === 'POST' && r.pattern.test('/api/v1/tasks'));
    assert.ok(postRoute);

    const payload = {
      instruction: 'API Created Task Instruction',
    };
    const req = Readable.from([JSON.stringify(payload)]) as any;
    let status = 0;
    let body: any = null;
    const res = {
      headersSent: false,
      writeHead(s: number) {
        status = s;
      },
      end(d: string) {
        body = JSON.parse(d);
      },
    } as any;

    await postRoute.handler(req, res, {});

    assert.equal(status, 201);
    assert.equal(body.title, 'API Created Task Instruction');
    assert.equal(body.instruction, 'API Created Task Instruction');
  });

  it('handles API route for legacy title-only creation via POST /api/v1/tasks', async () => {
    const routes = registerTaskRoutes(engine);
    const postRoute = routes.find((r) => r.method === 'POST' && r.pattern.test('/api/v1/tasks'));
    assert.ok(postRoute);

    const payload = {
      title: 'API Legacy Task Title',
    };
    const req = Readable.from([JSON.stringify(payload)]) as any;
    let status = 0;
    let body: any = null;
    const res = {
      headersSent: false,
      writeHead(s: number) {
        status = s;
      },
      end(d: string) {
        body = JSON.parse(d);
      },
    } as any;

    await postRoute.handler(req, res, {});

    assert.equal(status, 201);
    assert.equal(body.title, 'API Legacy Task Title');
    assert.equal(body.instruction, null);
  });

  it('handles API route for suggesting steps via POST /api/v1/tasks/suggest-steps', async () => {
    const routes = registerTaskRoutes(engine);
    const suggestRoute = routes.find(
      (r) => r.method === 'POST' && r.pattern.test('/api/v1/tasks/suggest-steps'),
    );
    assert.ok(suggestRoute);

    const payload = {
      instruction: 'Generate some steps for me',
      provider: 'codex',
      model: 'custom-codex-model',
    };
    const req = Readable.from([JSON.stringify(payload)]) as any;
    let status = 0;
    let body: any = null;
    const res = {
      headersSent: false,
      writeHead(s: number) {
        status = s;
      },
      end(d: string) {
        body = JSON.parse(d);
      },
    } as any;

    process.env.CODEX_COMMAND = selectedCodexPath;
    try {
      await suggestRoute.handler(req, res, {});
    } finally {
      delete process.env.CODEX_COMMAND;
    }

    assert.equal(status, 200);
    assert.equal(body.title, 'Selected Codex title');
    assert.deepEqual(body.steps, ['Selected Codex step']);
    assert.equal(body.provider, 'codex');
    assert.equal(body.model, 'custom-codex-model');
    assert.equal(body.usedLlm, true);
  });

  it('fails API route for suggesting steps when sensitive data is passed', async () => {
    const routes = registerTaskRoutes(engine);
    const suggestRoute = routes.find(
      (r) => r.method === 'POST' && r.pattern.test('/api/v1/tasks/suggest-steps'),
    );
    assert.ok(suggestRoute);

    const payload = {
      instruction: 'My password is ' + ['sk', 'live', 'synthetic'.repeat(5)].join('_'),
    };
    const req = Readable.from([JSON.stringify(payload)]) as any;
    let status = 0;
    let body: any = null;
    const res = {
      headersSent: false,
      writeHead(s: number) {
        status = s;
      },
      end(d: string) {
        body = JSON.parse(d);
      },
    } as any;

    await suggestRoute.handler(req, res, {});

    assert.equal(status, 400);
    assert.match(body.error, /LLMへ送信できません/);
  });
});
