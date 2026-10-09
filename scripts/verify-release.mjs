import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { forbiddenPath, normalizeEntry } from './release-verify-guards.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const outputDir = process.env.SPARK_RELEASE_OUTPUT_DIR
  ? resolve(process.env.SPARK_RELEASE_OUTPUT_DIR)
  : join(root, 'outputs');
const archive = join(outputDir, `spark-compatible-agent-runtime-v${version}.zip`);
const nestedVerificationEnv = 'SPARK_RELEASE_NESTED_VERIFICATION';
const allowedRoots = ['src', 'tests', 'scripts', 'schemas', 'policies', 'migrations', 'docs', 'web'];
const allowedFiles = [
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'prettier.config.js',
  'README.md',
  'START.command',
];
const outputLimit = 512 * 1024;

async function filesUnder(path, base = root) {
  const relPath = relative(base, path);
  if (relPath && forbiddenPath(relPath)) return [];
  const entries = await readdir(path, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const child = join(path, entry.name);
    const childRel = relative(base, child);
    if (forbiddenPath(childRel)) continue;
    if (entry.isSymbolicLink()) throw new Error(`Release source contains a symlink: ${child}`);
    if (entry.isDirectory()) result.push(...(await filesUnder(child, base)));
    else if (entry.isFile()) result.push(child);
    else throw new Error(`Release source contains an unsupported entry: ${child}`);
  }
  return result;
}

function boundedAppend(state, chunk) {
  state.bytes += chunk.byteLength;
  if (state.textBytes < outputLimit)
    state.chunks.push(chunk.subarray(0, outputLimit - state.textBytes));
  state.textBytes = Math.min(outputLimit, state.textBytes + chunk.byteLength);
  state.exceeded ||= state.bytes > outputLimit;
}

function boundedText(state) {
  return Buffer.concat(state.chunks).toString('utf8');
}

function run(command, args, cwd, timeoutMs = 120_000, env = process.env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = { chunks: [], textBytes: 0, bytes: 0, exceeded: false };
    const stderr = { chunks: [], textBytes: 0, bytes: 0, exceeded: false };
    let settled = false;
    let timeoutTimer;
    let killTimer;
    let forcedSettleTimer;
    const finish = (code, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      clearTimeout(forcedSettleTimer);
      resolve({
        code,
        stdout: boundedText(stdout),
        stderr: boundedText(stderr),
        error,
        outputLimit: stdout.exceeded || stderr.exceeded,
      });
    };
    const terminate = () => {
      if (settled || killTimer !== undefined) return;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 50);
      forcedSettleTimer = setTimeout(() => finish(null, 'process termination timeout'), 1_000);
    };
    child.stdout.on('data', (chunk) => {
      boundedAppend(stdout, chunk);
      if (stdout.exceeded) terminate();
    });
    child.stderr.on('data', (chunk) => {
      boundedAppend(stderr, chunk);
      if (stderr.exceeded) terminate();
    });
    child.once('error', (error) => finish(null, error.message));
    child.once('close', (code) => finish(code));
    timeoutTimer = setTimeout(terminate, timeoutMs);
  });
}

function inspectEntries(entries, label) {
  const normalized = entries.map(normalizeEntry).filter(Boolean);
  for (const entry of normalized) {
    if (forbiddenPath(entry)) throw new Error(`${label} contains a forbidden path: ${entry}`);
  }
  return normalized;
}

const workspace = await mkdtemp(join(tmpdir(), 'spark-release-'));
const stage = join(workspace, 'stage');
const extract = join(workspace, 'extract');
try {
  await mkdir(stage, { recursive: true });
  await mkdir(outputDir, { recursive: true });
  const directoryFiles = (
    await Promise.all(allowedRoots.map((name) => filesUnder(join(root, name), root)))
  ).flat();
  const files = [...allowedFiles, ...directoryFiles.map((file) => relative(root, file))].sort();
  inspectEntries(files, 'release allowlist');
  for (const file of files) {
    const source = join(root, file);
    const destination = join(stage, file);
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination);
  }
  const stagedFiles = (await filesUnder(stage, stage)).map((file) => relative(stage, file)).sort();
  if (JSON.stringify(stagedFiles) !== JSON.stringify(files)) {
    throw new Error('Staged files do not match the explicit release allowlist');
  }

  await rm(archive, { force: true });
  const zip = await run('zip', ['-X', '-q', '-r', archive, '.'], stage, 30_000);
  if (zip.code !== 0 || zip.outputLimit) throw new Error(`zip failed: ${zip.stderr}`);
  const archiveList = await run('unzip', ['-Z1', archive], root, 30_000);
  if (archiveList.code !== 0 || archiveList.outputLimit)
    throw new Error(`archive listing failed: ${archiveList.stderr}`);
  const archiveRawEntries = archiveList.stdout.split(/\r?\n/u).filter((entry) => entry.trim());
  inspectEntries(archiveRawEntries, 'archive');
  const archiveFiles = archiveRawEntries
    .filter((entry) => !entry.endsWith('/'))
    .map(normalizeEntry)
    .sort();
  if (JSON.stringify(archiveFiles) !== JSON.stringify(files)) {
    throw new Error('Archive entries do not match the staged allowlist');
  }

  await mkdir(extract, { recursive: true });
  const unzip = await run('unzip', ['-q', archive, '-d', extract], root, 30_000);
  if (unzip.code !== 0 || unzip.outputLimit) throw new Error(`unzip failed: ${unzip.stderr}`);
  const extractedFiles = (await filesUnder(extract, extract)).map((file) => relative(extract, file)).sort();
  inspectEntries(extractedFiles, 'extracted archive');
  if (JSON.stringify(extractedFiles) !== JSON.stringify(files)) {
    throw new Error('Extracted files do not match the staged allowlist');
  }

  // Verify START.command is present and is a file
  const startCmdPath = join(extract, 'START.command');
  const startCmdStat = await stat(startCmdPath).catch(() => null);
  if (!startCmdStat || !startCmdStat.isFile()) {
    throw new Error('START.command is missing in the extracted archive');
  }

  // Verify web source package.json is present
  const webPkgPath = join(extract, 'web', 'package.json');
  const webPkgStat = await stat(webPkgPath).catch(() => null);
  if (!webPkgStat || !webPkgStat.isFile()) {
    throw new Error('web/package.json is missing in the extracted archive');
  }

  const checks = [];
  for (const [name, args] of [
    ['npm ci', ['ci', '--ignore-scripts']],
    ['web npm ci', ['ci', '--ignore-scripts', '--prefix', 'web']],
    ['web:build', ['run', 'web:build']],
    ['format:check', ['run', 'format:check']],
    ['typecheck', ['run', 'typecheck']],
    ['test', ['test']],
    ['demo', ['run', 'demo']],
  ]) {
    const result = await run('npm', args, extract, 120_000, {
      ...process.env,
      [nestedVerificationEnv]: '1',
    });
    checks.push({
      name,
      code: result.code,
      passed: result.code === 0,
      outputLimit: result.outputLimit,
    });
    if (result.code !== 0 || result.outputLimit) {
      console.error(`\x1b[31mCheck failed: ${name}\x1b[0m`);
      console.error(`stdout:\n${result.stdout}`);
      console.error(`stderr:\n${result.stderr}`);
      throw new Error(`${name} failed`);
    }
  }

  // Verify web build output is generated
  const webDistHtmlPath = join(extract, 'web', 'dist', 'index.html');
  const webDistHtmlStat = await stat(webDistHtmlPath).catch(() => null);
  if (!webDistHtmlStat || !webDistHtmlStat.isFile()) {
    throw new Error('Web build (web/dist/index.html) was not generated after web:build');
  }
  const digest = createHash('sha256')
    .update(await readFile(archive))
    .digest('hex');
  const evidence = {
    kind: 'release_verification_evidence',
    version,
    archive: archive.split(sep).at(-1),
    sha256: digest,
    checks,
    forbiddenPathsExcluded: true,
    symlinksRejected: true,
    archiveVerification: 'repeatable',
  };
  await writeFile(`${archive}.evidence.json`, JSON.stringify(evidence, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify(evidence));
} finally {
  await rm(workspace, { recursive: true, force: true });
}
