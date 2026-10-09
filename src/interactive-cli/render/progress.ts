import { ansi } from './ansi.js';
import type { TaskStatus } from '../../domain/types.js';

export function renderProgressBar(current: number, total: number, width: number = 20): string {
  const percentage = total > 0 ? Math.min(1, current / total) : 0;
  const filledCount = Math.round(percentage * width);
  const emptyCount = width - filledCount;

  const filled = ansi.green('#'.repeat(filledCount));
  const empty = ansi.gray('-'.repeat(emptyCount));

  return `${filled}${empty}`;
}

const frames = ['|', '/', '-', '\\'];
export function renderSpinner(frame: number): string {
  return frames[frame % frames.length] ?? '|';
}

export function renderStatusBadge(status: TaskStatus): string {
  switch (status) {
    case 'planning':
      return ansi.dim(ansi.white('[planning]'));
    case 'running':
      return ansi.bold(ansi.blue('[running]'));
    case 'waiting_for_approval':
      return ansi.bold(ansi.yellow('[waiting_for_approval]'));
    case 'take_control':
      return ansi.bold(ansi.magenta('[take_control]'));
    case 'stopped':
      return ansi.bold(ansi.red('[stopped]'));
    case 'completed':
      return ansi.bold(ansi.green('[completed]'));
    case 'failed':
      return ansi.bold(ansi.red('[failed]'));
    default:
      return status;
  }
}
