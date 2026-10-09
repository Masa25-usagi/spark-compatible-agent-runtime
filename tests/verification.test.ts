import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createClaudeCodeAdapter } from '../src/adapters/claude-code.js';
import { createCodexAdapter } from '../src/adapters/codex.js';
import { createExternalAgentRequest } from '../src/adapters/types.js';
import {
  buildVerificationEnvironment,
  runExternalAgentRoundTrip,
} from '../src/verification/external-agent-roundtrip.js';

const NESTED_RELEASE_VERIFICATION = 'SPARK_RELEASE_NESTED_VERIFICATION';

function isNestedReleaseVerification(value: string | undefined): boolean {
  return value === '1';
}

function request() {
  return createExternalAgentRequest({
    requestId: 'verification_test_request',
    task: {
      id: 'verification_test_task',
      title: 'Verification',
      status: 'running',
      profile: 'spark-public-parity',
      agent: 'local-runtime',
      model: 'test',
      harness: 'test',
      currentStep: 'Report',
      plannedSteps: ['Report'],
      pendingSteps: ['Report'],
    },
    prompt: 'Acknowledge without tools or mutations.',
  });
}

test('external round trip is shell-free, correlated, and redacted', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'spark-verification-'));
  const executable = join(directory, 'fake-agent');
  await writeFile(
    executable,
    '#!/usr/bin/env node\nprocess.stdin.resume(); process.stdin.on("end", () => process.stdout.write(JSON.stringify({protocol:"spark-runtime-external-agent-v1",kind:"external_agent_result",requestId:"verification_test_request",taskId:"verification_test_task",agent:"codex",receivedAt:new Date().toISOString(),status:"completed",summary:"Bearer abc123",output:{authorization:"hidden"},error:null})));\n',
    'utf8',
  );
  await chmod(executable, 0o755);
  try {
    const evidence = await runExternalAgentRoundTrip(
      createCodexAdapter({ executable, sandbox: 'read-only' }),
      request(),
    );
    assert.equal(evidence.status, 'completed');
    assert.equal(evidence.requestId, 'verification_test_request');
    assert.equal(evidence.externalMutationVerified, false);
    assert.equal(evidence.resultSummary, '[REDACTED]');
    assert.equal(evidence.executable, 'fake-agent');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('external round trip uses an environment allowlist and explicit overlay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'spark-verification-'));
  const executable = join(directory, 'env-agent');
  const sentinel = 'SPARK_PARENT_SENTINEL';
  process.env[sentinel] = 'parent-secret';
  await writeFile(
    executable,
    '#!/usr/bin/env node\nprocess.stdin.resume(); process.stdin.on("end", () => process.stdout.write(JSON.stringify({protocol:"spark-runtime-external-agent-v1",kind:"external_agent_result",requestId:"verification_test_request",taskId:"verification_test_task",agent:"codex",receivedAt:new Date().toISOString(),status:"completed",summary:JSON.stringify({sentinel:process.env.SPARK_PARENT_SENTINEL,explicit:process.env.SPARK_EXPLICIT_VALUE}),output:null,error:null})));\n',
    'utf8',
  );
  await chmod(executable, 0o755);
  try {
    const environment = buildVerificationEnvironment({ SPARK_EXPLICIT_VALUE: 'present' });
    assert.equal(environment[sentinel], undefined);
    const evidence = await runExternalAgentRoundTrip(
      createCodexAdapter({ executable, sandbox: 'read-only' }),
      request(),
      { env: { SPARK_EXPLICIT_VALUE: 'present' } },
    );
    assert.equal(evidence.status, 'completed');
    assert.doesNotMatch(evidence.resultSummary ?? '', /sentinel/u);
    assert.match(evidence.resultSummary ?? '', /"explicit":"present"/u);
  } finally {
    delete process.env[sentinel];
    await rm(directory, { recursive: true, force: true });
  }
});

test('external round trip rejects unsupported file transport', async () => {
  await assert.rejects(
    runExternalAgentRoundTrip(createCodexAdapter({ sandbox: 'read-only' }), request(), {
      transport: 'file',
    }),
    /stdio transport only/u,
  );
});

test('Claude no-tools verification adds an explicit empty tools argument', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'spark-verification-'));
  const executable = join(directory, 'argv-agent');
  await writeFile(
    executable,
    '#!/usr/bin/env node\nprocess.stdin.resume(); process.stdin.on("end", () => process.stdout.write(JSON.stringify({protocol:"spark-runtime-external-agent-v1",kind:"external_agent_result",requestId:"verification_test_request",taskId:"verification_test_task",agent:"claude-code",receivedAt:new Date().toISOString(),status:"completed",summary:process.argv.slice(2).join("|"),output:null,error:null})));\n',
    'utf8',
  );
  await chmod(executable, 0o755);
  try {
    const evidence = await runExternalAgentRoundTrip(
      createClaudeCodeAdapter({ executable, permissionMode: 'plan', maxTurns: 1 }),
      request(),
      { noTools: true },
    );
    assert.equal(evidence.status, 'completed');
    assert.match(evidence.resultSummary ?? '', /--tools\|$/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('external round trip reports unavailable executables without throwing', async () => {
  const evidence = await runExternalAgentRoundTrip(
    createCodexAdapter({ executable: '/definitely/missing/codex', sandbox: 'read-only' }),
    request(),
  );
  assert.equal(evidence.status, 'unavailable');
  assert.equal(evidence.exitCode, null);
  assert.match(evidence.error ?? '', /missing|spawn/i);
});

test('external round trip enforces a bounded output budget', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'spark-verification-'));
  const executable = join(directory, 'noisy-agent');
  await writeFile(
    executable,
    '#!/usr/bin/env node\nprocess.stdout.write("x".repeat(10000));\n',
    'utf8',
  );
  await chmod(executable, 0o755);
  try {
    const evidence = await runExternalAgentRoundTrip(
      createCodexAdapter({ executable, sandbox: 'read-only' }),
      request(),
      { maxOutputBytes: 128 },
    );
    assert.equal(evidence.status, 'output_limit');
    assert.equal(evidence.stdoutBytes, 10000);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('external round trip kills a timed-out child and settles', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'spark-verification-'));
  const executable = join(directory, 'stuck-agent');
  await writeFile(
    executable,
    '#!/usr/bin/env node\nprocess.on("SIGTERM", () => {}); setInterval(() => {}, 1000);\n',
    'utf8',
  );
  await chmod(executable, 0o755);
  try {
    const started = Date.now();
    const evidence = await runExternalAgentRoundTrip(
      createCodexAdapter({ executable, sandbox: 'read-only' }),
      request(),
      { timeoutMs: 25 },
    );
    assert.equal(evidence.status, 'timed_out');
    assert.ok(Date.now() - started < 2_000);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('release guard rejects secrets, hidden metadata, and runtime databases', async () => {
  const script =
    'import { forbiddenPath } from "./scripts/release-verify-guards.mjs"; console.log(JSON.stringify(process.argv.slice(1).map(forbiddenPath)));';
  const values = [
    '.env.local',
    '.npmrc',
    'credentials.json',
    'private.key',
    'cert.pem',
    'runtime.sqlite-wal',
    'data/file.txt',
    'src/index.ts',
  ];
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, ...values], {
      cwd: process.cwd(),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    child.once('error', reject);
    child.once('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(stderr))));
  });
  assert.deepEqual(JSON.parse(output), [true, true, true, true, true, true, true, false]);
});

test('nested release marker has an explicit, testable guard', () => {
  assert.equal(isNestedReleaseVerification('1'), true);
  assert.equal(isNestedReleaseVerification(undefined), false);
});

test(
  'release verification replaces a stale archive in an explicit temp output dir',
  { skip: isNestedReleaseVerification(process.env[NESTED_RELEASE_VERIFICATION]) },
  async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'spark-release-output-'));
    const archive = join(outputDir, 'spark-compatible-agent-runtime-v0.1.0.zip');
    const evidence = `${archive}.evidence.json`;
    await writeFile(archive, 'stale archive entry', 'utf8');
    try {
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, ['scripts/verify-release.mjs'], {
          cwd: process.cwd(),
          env: {
            ...process.env,
            SPARK_RELEASE_OUTPUT_DIR: outputDir,
          },
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
        child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
        child.once('error', reject);
        child.once('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(stderr))));
      });
      assert.equal((await stat(archive)).isFile(), true);
      assert.equal((await stat(evidence)).isFile(), true);
      assert.notEqual(await readFile(archive, 'utf8'), 'stale archive entry');
      assert.match(output, /release_verification_evidence/u);
    } finally {
      await rm(archive, { force: true });
      await rm(evidence, { force: true });
      await rm(outputDir, { recursive: true, force: true });
    }
  },
);
