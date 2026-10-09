const env = process.env;

export function supportsColor(): boolean {
  if (env.NO_COLOR) return false;
  if (env.TERM === 'dumb') return false;
  if (env.FORCE_COLOR) return true;
  return process.stdout.isTTY || false;
}

const colorEnabled = supportsColor();

export const ansi = {
  red: (s: string) => (colorEnabled ? `\x1b[31m${s}\x1b[0m` : s),
  green: (s: string) => (colorEnabled ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s: string) => (colorEnabled ? `\x1b[33m${s}\x1b[0m` : s),
  blue: (s: string) => (colorEnabled ? `\x1b[34m${s}\x1b[0m` : s),
  magenta: (s: string) => (colorEnabled ? `\x1b[35m${s}\x1b[0m` : s),
  cyan: (s: string) => (colorEnabled ? `\x1b[36m${s}\x1b[0m` : s),
  white: (s: string) => (colorEnabled ? `\x1b[37m${s}\x1b[0m` : s),
  gray: (s: string) => (colorEnabled ? `\x1b[90m${s}\x1b[0m` : s),
  bold: (s: string) => (colorEnabled ? `\x1b[1m${s}\x1b[22m` : s),
  dim: (s: string) => (colorEnabled ? `\x1b[2m${s}\x1b[22m` : s),
  underline: (s: string) => (colorEnabled ? `\x1b[4m${s}\x1b[24m` : s),
  reset: (s: string) => (colorEnabled ? `\x1b[0m${s}` : s),
};

export function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

export const box = {
  topLeft: '┌',
  topRight: '┐',
  bottomLeft: '└',
  bottomRight: '┘',
  horizontal: '─',
  vertical: '│',
  tDown: '┬',
  tUp: '┴',
  tRight: '├',
  tLeft: '┤',
  cross: '┼',
};
