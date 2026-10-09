export function createCountdownTimer(targetDate: string): HTMLElement {
  const el = document.createElement('span');
  el.style.fontFamily = 'monospace';
  el.style.color = 'var(--status-pending)';

  const target = new Date(targetDate).getTime();

  const update = () => {
    const now = new Date().getTime();
    const diff = target - now;
    if (diff <= 0) {
      el.textContent = 'Expired';
      return;
    }
    const m = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    const s = Math.floor((diff % (1000 * 60)) / 1000);
    el.textContent = `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    requestAnimationFrame(update);
  };

  update();
  return el;
}
