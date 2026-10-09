import { strict as assert } from 'node:assert';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { ActionSpec, ActionOperation } from '../src/domain/types.js';
import { LocalFileConnector } from '../src/connectors/local-files.js';

function action(operation: ActionOperation, path: string, content?: string): ActionSpec {
  return {
    id: `action-${operation}`,
    taskId: 'task-files',
    tool: 'files.local',
    connector: 'files',
    operation,
    target: { path },
    ...(content === undefined ? {} : { payload: { content } }),
    originatingTask: 'local file test',
  };
}

describe('LocalFileConnector', () => {
  it('creates, reads, edits, trashes, and permanently deletes regular files', () => {
    const root = mkdtempSync(join(tmpdir(), 'spark-files-'));
    try {
      const connector = new LocalFileConnector(root);
      assert.equal(connector.execute(action('create_file', 'note.txt', 'one')).simulated, false);
      const read = connector.execute(action('read', 'note.txt'));
      assert.equal((read.output as { content: string }).content, 'one');
      connector.execute(action('edit_data', 'note.txt', 'two'));
      assert.equal(readFileSync(join(root, 'note.txt'), 'utf8'), 'two');
      const trashed = connector.execute(action('delete_to_trash', 'note.txt'));
      assert.match((trashed.output as { trashPath: string }).trashPath, /^\.spark-trash\//);

      writeFileSync(join(root, 'erase.txt'), 'erase', { mode: 0o600 });
      connector.execute(action('delete_permanently', 'erase.txt'));
      assert.throws(() => readFileSync(join(root, 'erase.txt')), /ENOENT/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects traversal and symbolic-link escapes', () => {
    const root = mkdtempSync(join(tmpdir(), 'spark-files-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'spark-files-outside-'));
    try {
      const connector = new LocalFileConnector(root);
      writeFileSync(join(outside, 'secret.txt'), 'secret');
      symlinkSync(outside, join(root, 'escape'));
      assert.throws(
        () => connector.execute(action('create_file', '../outside.txt', 'bad')),
        /escaped/,
      );
      assert.throws(() => connector.execute(action('read', 'escape/secret.txt')), /escaped/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects a symlinked trash directory and files with outside hard links', () => {
    const root = mkdtempSync(join(tmpdir(), 'spark-files-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'spark-files-outside-'));
    try {
      const connector = new LocalFileConnector(root);
      writeFileSync(join(root, 'trash-me.txt'), 'content');
      symlinkSync(outside, join(root, '.spark-trash'));
      assert.throws(
        () => connector.execute(action('delete_to_trash', 'trash-me.txt')),
        /real directory/,
      );

      writeFileSync(join(outside, 'shared.txt'), 'shared');
      linkSync(join(outside, 'shared.txt'), join(root, 'shared.txt'));
      assert.throws(() => connector.execute(action('read', 'shared.txt')), /Hard-linked/);
      assert.throws(
        () => connector.execute(action('edit_data', 'shared.txt', 'changed')),
        /Hard-linked/,
      );
      assert.equal(readFileSync(join(outside, 'shared.txt'), 'utf8'), 'shared');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('uses the fd for bounded reads and rejects final symlinks', () => {
    const root = mkdtempSync(join(tmpdir(), 'spark-files-root-'));
    try {
      writeFileSync(join(root, 'too-large.txt'), '12345');
      writeFileSync(join(root, 'target.txt'), 'safe');
      symlinkSync(join(root, 'target.txt'), join(root, 'alias.txt'));
      const connector = new LocalFileConnector(root, { maxReadBytes: 4 });

      assert.throws(() => connector.execute(action('read', 'too-large.txt')), /4 byte read limit/);
      assert.throws(() => connector.execute(action('read', 'alias.txt')), /Symbolic links/);
      assert.throws(
        () => connector.execute(action('edit_data', 'alias.txt', 'changed')),
        /Symbolic links/,
      );
      assert.equal(readFileSync(join(root, 'target.txt'), 'utf8'), 'safe');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('confines create to a stable parent directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'spark-files-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'spark-files-outside-'));
    try {
      const connector = new LocalFileConnector(root);
      symlinkSync(outside, join(root, 'outside-parent'));
      assert.throws(
        () => connector.execute(action('create_file', 'outside-parent/created.txt', 'bad')),
        /parent escaped the configured root/,
      );
      assert.equal(existsSync(join(outside, 'created.txt')), false);

      mkdirSync(join(root, 'nested'));
      symlinkSync(join(root, 'nested'), join(root, 'inside-parent'));
      connector.execute(action('create_file', 'inside-parent/created.txt', 'good'));
      assert.equal(readFileSync(join(root, 'nested', 'created.txt'), 'utf8'), 'good');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
