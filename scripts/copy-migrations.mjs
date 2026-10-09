import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'migrations');
const destination = join(root, 'dist', 'migrations');
mkdirSync(destination, { recursive: true });
for (const name of readdirSync(source).filter((value) => /^\d+_.+\.sql$/u.test(value))) {
  cpSync(join(source, name), join(destination, name));
}
