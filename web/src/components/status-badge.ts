export function createStatusBadge(status: string): HTMLElement {
  const el = document.createElement('span');
  el.className = 'badge';

  const statusLower = status.toLowerCase();

  const labels: Record<string, string> = {
    planning: '計画中',
    running: '実行中',
    waiting_for_approval: '承認待ち',
    take_control: '介入要求',
    stopped: '一時停止',
    completed: '完了',
    failed: '失敗',
    pending: '承認待ち',
    approved: '承認済み',
    denied: '却下',
    consumed: '実行済み',
    expired: '期限切れ',
  };

  el.textContent = labels[statusLower] || status;

  const colors: Record<string, string> = {
    planning: 'var(--status-pending)',
    running: 'var(--status-active)',
    waiting_for_approval: 'var(--status-pending)',
    take_control: 'var(--status-error)',
    stopped: 'var(--text-secondary)',
    completed: 'var(--status-complete)',
    failed: 'var(--status-error)',
    pending: 'var(--status-pending)',
    approved: 'var(--status-complete)',
    denied: 'var(--status-error)',
    consumed: 'var(--status-complete)',
    expired: 'var(--text-tertiary)',
  };

  const color = colors[statusLower] || 'var(--text-primary)';
  el.style.backgroundColor = `color-mix(in srgb, ${color} 15%, transparent)`;
  el.style.color = color;
  el.style.border = `1px solid color-mix(in srgb, ${color} 30%, transparent)`;

  return el;
}
