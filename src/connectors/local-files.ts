import {
  constants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  closeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';

import type { ActionSpec, ConnectorResult, JsonObject, JsonValue } from '../domain/types.js';

export type LocalFileConnectorOptions = {
  maxReadBytes?: number;
};

type OpenedFile = {
  descriptor: number;
  actualPath: string;
  stat: Stats;
};

type OpenedDirectory = {
  descriptor: number;
  requestedPath: string;
  actualPath: string;
  stat: Stats;
};

const noFollowFlag = constants.O_NOFOLLOW;
const directoryFlag = constants.O_DIRECTORY ?? 0;
const readChunkBytes = 64 * 1024;

function isRecord(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function targetPath(action: ActionSpec): string {
  if (typeof action.target === 'string') return action.target;
  if (isRecord(action.target) && typeof action.target.path === 'string') {
    return action.target.path;
  }
  throw new Error('Local file action target must contain a path');
}

function payloadContent(action: ActionSpec): string {
  if (typeof action.payload === 'string') return action.payload;
  if (
    action.payload !== undefined &&
    isRecord(action.payload) &&
    typeof action.payload.content === 'string'
  ) {
    return action.payload.content;
  }
  throw new Error('Local file create/edit action payload must contain string content');
}

function isWithin(root: string, path: string): boolean {
  const value = relative(root, path);
  return (
    value.length > 0 &&
    value !== '..' &&
    !value.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
    !isAbsolute(value)
  );
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** A synchronous, root-confined connector intended to run behind TaskEngine policy checks. */
export class LocalFileConnector {
  public readonly name = 'files';
  private readonly root: string;
  private readonly maxReadBytes: number;

  public constructor(rootDirectory: string, options: LocalFileConnectorOptions = {}) {
    if (typeof noFollowFlag !== 'number') {
      throw new Error('Local file connector requires O_NOFOLLOW support');
    }
    mkdirSync(rootDirectory, { recursive: true, mode: 0o700 });
    this.root = realpathSync(rootDirectory);
    this.maxReadBytes = options.maxReadBytes ?? 1_048_576;
    if (!Number.isInteger(this.maxReadBytes) || this.maxReadBytes <= 0) {
      throw new Error('maxReadBytes must be a positive integer');
    }
  }

  public execute(action: ActionSpec): ConnectorResult {
    const requested = targetPath(action);
    const lexical = resolve(this.root, requested);
    if (!isWithin(this.root, lexical))
      throw new Error('Local file path escaped the configured root');

    switch (action.operation) {
      case 'read':
        return this.read(lexical);
      case 'create_file':
        return this.create(lexical, payloadContent(action));
      case 'edit_data':
        return this.edit(lexical, payloadContent(action));
      case 'delete_to_trash':
        return this.moveToTrash(lexical);
      case 'delete_permanently':
        return this.deletePermanently(lexical);
      default:
        throw new Error(
          `Operation ${action.operation} is not supported by the local file connector`,
        );
    }
  }

  private read(path: string): ConnectorResult {
    const opened = this.openExistingFile(path, constants.O_RDONLY);
    try {
      if (opened.stat.size > this.maxReadBytes) {
        throw new Error(`Local file exceeds the ${this.maxReadBytes} byte read limit`);
      }
      const { content, bytesRead } = this.readBounded(opened.descriptor);
      return this.result(
        `Read ${bytesRead} bytes from ${this.display(opened.actualPath)}.`,
        [],
        null,
        {
          path: this.display(opened.actualPath),
          sizeBytes: bytesRead,
          content,
        },
      );
    } finally {
      closeSync(opened.descriptor);
    }
  }

  private create(path: string, content: string): ConnectorResult {
    const parent = this.openSafeParent(path);
    let descriptor: number | undefined;
    try {
      this.assertParentStable(parent);
      const createPath = join(parent.actualPath, basename(path));
      descriptor = openSync(
        createPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag,
        0o600,
      );
      const stat = fstatSync(descriptor);
      this.assertRegularFile(stat);
      this.assertSingleLink(stat);
      this.assertParentStable(parent);
      const createdPathStat = lstatSync(createPath);
      if (createdPathStat.isSymbolicLink()) throw new Error('Symbolic links are not allowed');
      if (!sameFile(stat, createdPathStat)) {
        throw new Error('Local file path changed while creating the file');
      }
      writeFileSync(descriptor, content, 'utf8');
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      closeSync(parent.descriptor);
    }
    return this.result(
      `Created ${this.display(path)}.`,
      [this.display(path)],
      `Delete ${this.display(path)} after a fresh approval.`,
      { path: this.display(path), sizeBytes: Buffer.byteLength(content) },
    );
  }

  private edit(path: string, content: string): ConnectorResult {
    const opened = this.openExistingFile(path, constants.O_RDWR);
    try {
      const current = fstatSync(opened.descriptor);
      this.assertRegularFile(current);
      this.assertSingleLink(current);
      const previousSize = current.size;
      ftruncateSync(opened.descriptor, 0);
      writeFileSync(opened.descriptor, content, 'utf8');
      return this.result(
        `Edited ${this.display(opened.actualPath)}.`,
        [this.display(opened.actualPath)],
        'Restore the previous content from a separately maintained backup.',
        {
          path: this.display(opened.actualPath),
          previousSizeBytes: previousSize,
          sizeBytes: Buffer.byteLength(content),
        },
      );
    } finally {
      closeSync(opened.descriptor);
    }
  }

  private moveToTrash(path: string): ConnectorResult {
    const actual = this.existingRegularFile(path);
    const trash = this.safeTrashDirectory();
    const destination = join(trash, `${randomUUID()}-${basename(actual)}`);
    renameSync(actual, destination);
    return this.result(
      `Moved ${this.display(actual)} to the runtime trash.`,
      [this.display(actual), this.display(destination)],
      `Move ${this.display(destination)} back to ${this.display(actual)}.`,
      { originalPath: this.display(actual), trashPath: this.display(destination) },
    );
  }

  private deletePermanently(path: string): ConnectorResult {
    const actual = this.existingRegularFile(path);
    unlinkSync(actual);
    return this.result(
      `Permanently deleted ${this.display(actual)}.`,
      [this.display(actual)],
      null,
      { path: this.display(actual) },
    );
  }

  private existingRegularFile(path: string): string {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error('Symbolic links are not allowed');
    if (!stat.isFile()) throw new Error('Local file connector only supports regular files');
    if (stat.nlink !== 1) throw new Error('Hard-linked files are not allowed');
    const actual = realpathSync(path);
    if (!isWithin(this.root, actual))
      throw new Error('Resolved local file escaped the configured root');
    return actual;
  }

  private openExistingFile(path: string, flags: number): OpenedFile {
    const actualPath = this.existingRegularFile(path);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(path, flags | noFollowFlag);
      const stat = fstatSync(descriptor);
      this.assertRegularFile(stat);
      this.assertSingleLink(stat);

      const currentPathStat = lstatSync(path);
      if (currentPathStat.isSymbolicLink()) throw new Error('Symbolic links are not allowed');
      if (!sameFile(stat, currentPathStat)) {
        throw new Error('Local file path changed while opening the file');
      }
      const currentActualPath = realpathSync(path);
      if (!isWithin(this.root, currentActualPath)) {
        throw new Error('Resolved local file escaped the configured root');
      }
      if (currentActualPath !== actualPath) {
        throw new Error('Local file path changed while opening the file');
      }

      return { descriptor, actualPath, stat };
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      throw error;
    }
  }

  private readBounded(descriptor: number): { content: string; bytesRead: number } {
    const chunks: Buffer[] = [];
    let bytesRead = 0;
    while (bytesRead <= this.maxReadBytes) {
      const remaining = this.maxReadBytes - bytesRead + 1;
      const chunk = Buffer.allocUnsafe(Math.min(readChunkBytes, remaining));
      const chunkBytes = readSync(descriptor, chunk, 0, chunk.length, bytesRead);
      if (chunkBytes === 0) break;
      chunks.push(chunk.subarray(0, chunkBytes));
      bytesRead += chunkBytes;
      if (bytesRead > this.maxReadBytes) {
        throw new Error(`Local file exceeds the ${this.maxReadBytes} byte read limit`);
      }
      if (chunkBytes < chunk.length) break;
    }
    return { content: Buffer.concat(chunks, bytesRead).toString('utf8'), bytesRead };
  }

  private openSafeParent(path: string): OpenedDirectory {
    const requestedPath = dirname(path);
    const actualPath = realpathSync(requestedPath);
    if (actualPath !== this.root && !isWithin(this.root, actualPath)) {
      throw new Error('Resolved local file parent escaped the configured root');
    }

    let descriptor: number | undefined;
    try {
      descriptor = openSync(actualPath, constants.O_RDONLY | directoryFlag | noFollowFlag);
      const stat = fstatSync(descriptor);
      if (!stat.isDirectory()) throw new Error('Local file parent must be a directory');
      this.assertParentStable({ descriptor, requestedPath, actualPath, stat });
      return { descriptor, requestedPath, actualPath, stat };
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      throw error;
    }
  }

  private assertParentStable(parent: OpenedDirectory): void {
    const currentActualPath = realpathSync(parent.requestedPath);
    if (currentActualPath !== parent.actualPath) {
      throw new Error('Local file parent changed while opening the file');
    }
    const currentActualStat = statSync(parent.actualPath);
    if (!sameFile(parent.stat, currentActualStat)) {
      throw new Error('Local file parent changed while opening the file');
    }
    const currentRequestedStat = statSync(parent.requestedPath);
    if (!sameFile(parent.stat, currentRequestedStat)) {
      throw new Error('Local file parent changed while opening the file');
    }
  }

  private assertRegularFile(stat: Stats): void {
    if (!stat.isFile()) throw new Error('Local file connector only supports regular files');
  }

  private assertSingleLink(stat: Stats): void {
    if (stat.nlink !== 1) throw new Error('Hard-linked files are not allowed');
  }

  private safeTrashDirectory(): string {
    const trash = join(this.root, '.spark-trash');
    try {
      const stat = lstatSync(trash);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error('Runtime trash must be a real directory');
      }
    } catch (error) {
      if (
        error === null ||
        typeof error !== 'object' ||
        !('code' in error) ||
        error.code !== 'ENOENT'
      ) {
        throw error;
      }
      mkdirSync(trash, { mode: 0o700 });
    }
    const actual = realpathSync(trash);
    if (!isWithin(this.root, actual)) throw new Error('Runtime trash escaped the configured root');
    return actual;
  }

  private display(path: string): string {
    return relative(this.root, path);
  }

  private result(
    summary: string,
    changedTargets: string[],
    undoGuidance: string | null,
    output: JsonObject,
  ): ConnectorResult {
    return { success: true, simulated: false, summary, changedTargets, undoGuidance, output };
  }
}
