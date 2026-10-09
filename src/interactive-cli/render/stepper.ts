import { ansi } from './ansi.js';
import { renderSpinner } from './progress.js';

export function renderStepper(
  planned: string[],
  completed: string[],
  current: string | null,
  frame: number = 0,
): string {
  const output: string[] = [];

  for (const step of planned) {
    if (completed.includes(step)) {
      output.push(`${ansi.green('[done]')} ${step}`);
    } else if (step === current) {
      output.push(
        `${ansi.magenta('[active]')} ${ansi.bold(step)} ${ansi.magenta(renderSpinner(frame))}`,
      );
    } else {
      output.push(`${ansi.gray('[pending]')} ${ansi.dim(step)}`);
    }
  }

  return output.join('\n');
}
