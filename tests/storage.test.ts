import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

describe('packaged SQLite migrations', () => {
  it('initializes a database when the process working directory is outside the package', () => {
    const directory = mkdtempSync(join(tmpdir(), 'spark-migrations-'));
    const dbPath = join(directory, 'runtime.sqlite');
    const storeUrl = new URL('../src/storage/sqlite.js', import.meta.url).href;
    const script = `
      import { SQLiteStore } from ${JSON.stringify(storeUrl)};
      const store = new SQLiteStore(${JSON.stringify(dbPath)});
      console.log(store.listTasks().length);
      store.close();
    `;

    try {
      const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
        cwd: directory,
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), '0');
      assert.equal(existsSync(dbPath), true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
