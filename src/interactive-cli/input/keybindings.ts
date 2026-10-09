export function enableRawMode(): void {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
  }
}

export function disableRawMode(): void {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}

export function onKeyPress(callback: (key: string) => void): () => void {
  const handler = (chunk: Buffer) => {
    const key = chunk.toString();
    if (key === '\u0003') {
      // Ctrl+C
      disableRawMode();
      process.exit(0);
    }
    callback(key);
  };

  process.stdin.on('data', handler);
  return () => {
    process.stdin.removeListener('data', handler);
  };
}
