import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { ansi } from '../render/ansi.js';

export async function promptLine(question: string): Promise<string> {
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(ansi.cyan('? ') + ansi.bold(question) + ' ');
    return answer.trim();
  } finally {
    rl.close();
  }
}

export async function promptConfirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(ansi.cyan('? ') + ansi.bold(question) + ansi.dim(' (y/N) '));
    return answer.trim().toLowerCase() === 'y';
  } finally {
    rl.close();
  }
}

export async function promptSelect(question: string, options: string[]): Promise<number> {
  const rl = readline.createInterface({ input, output });
  try {
    let q = ansi.cyan('? ') + ansi.bold(question) + '\n';
    options.forEach((opt, i) => {
      q += `  ${ansi.cyan(String(i + 1))}) ${opt}\n`;
    });
    q += ansi.dim('Choose a number: ');

    while (true) {
      const answer = await rl.question(q);
      const idx = parseInt(answer.trim(), 10) - 1;
      if (idx >= 0 && idx < options.length) {
        return idx;
      }
      console.log(ansi.red('Invalid selection. Please try again.'));
    }
  } finally {
    rl.close();
  }
}
