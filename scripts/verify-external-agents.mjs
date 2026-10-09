import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import { createCodexAdapter } from '../dist/src/adapters/codex.js';
import { createClaudeCodeAdapter } from '../dist/src/adapters/claude-code.js';
import { createExternalAgentRequest } from '../dist/src/adapters/types.js';
import { runExternalAgentRoundTrip } from '../dist/src/verification/external-agent-roundtrip.js';

const task = {
  id: 'verification_external_agents',
  title: 'Read-only external agent verification',
  status: 'running',
  profile: 'spark-public-parity',
  agent: 'local-runtime',
  model: 'caller-supplied',
  harness: 'external-agent',
  currentStep: 'Report',
  plannedSteps: ['Report'],
  pendingSteps: ['Report'],
};
const request = createExternalAgentRequest({
  requestId: `verify_external_${Date.now()}`,
  task,
  prompt:
    'Return a short JSON-free acknowledgement. Do not use tools, modify files, access external services, or claim that any mutation occurred.',
});

const verificationCwd = await mkdtemp(join(tmpdir(), 'spark-agent-cwd-'));
await new Promise((resolve, reject) => {
  const child = spawn('git', ['init', '-q', verificationCwd], { shell: false, stdio: 'ignore' });
  child.once('error', reject);
  child.once('close', (code) =>
    code === 0 ? resolve() : reject(new Error(`git init failed: ${code}`)),
  );
});
try {
  const evidence = [];
  evidence.push(
    await runExternalAgentRoundTrip(
      createCodexAdapter({ sandbox: 'read-only', ephemeral: true }),
      request,
      {
        cwd: verificationCwd,
        env: { SPARK_VERIFICATION_MODE: 'readonly' },
        timeoutMs: 120_000,
        maxOutputBytes: 262_144,
      },
    ),
  );
  evidence.push(
    await runExternalAgentRoundTrip(
      createClaudeCodeAdapter({ permissionMode: 'plan', maxTurns: 1 }),
      request,
      {
        cwd: verificationCwd,
        env: { SPARK_VERIFICATION_MODE: 'readonly' },
        noTools: true,
        timeoutMs: 120_000,
        maxOutputBytes: 262_144,
      },
    ),
  );

  console.log(JSON.stringify({ kind: 'external_agent_verification', evidence }));
} finally {
  await rm(verificationCwd, { recursive: true, force: true });
}
