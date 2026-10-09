export function normalizeEntry(value) {
  return value.replace(/^\.\//u, '').replace(/\/$/u, '');
}

export function forbiddenPath(value) {
  const path = normalizeEntry(value);
  const lower = path.toLowerCase();
  const segments = path.split('/');
  const base = segments.at(-1)?.toLowerCase() ?? '';
  if (segments.some((segment) => segment === '..' || segment.startsWith('.'))) return true;
  if (/(?:^|\/)(?:data|outputs?|dist|node_modules|credentials?|secrets?)(?:\/|$)/iu.test(path))
    return true;
  if (base === 'design-tokens.css') return false;
  if (
    /(?:^|[._-])(?:env|npmrc|yarnrc|token|tokens|credential|credentials|secret|secrets|certificate|cert|private|key|keys)(?:[._-]|$)/iu.test(
      base,
    )
  )
    return true;
  return (
    /(?:\.sqlite(?:-(?:shm|wal))?|\.db(?:-[^.]*)?|\.pem|\.p12|\.pfx|\.crt|\.cer|\.der|\.jks|\.keystore)$/iu.test(
      lower,
    ) || base === 'id_rsa'
  );
}
