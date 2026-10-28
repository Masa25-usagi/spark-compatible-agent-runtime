const TOAST_ICONS: Record<string, string> = {
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
  success: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.5 2.5 4.5-5"/>',
  error: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5"/><path d="M12 16.5h.01"/>',
};

export function showToast(message: string, type: 'success' | 'error' | 'info' = 'info') {
  const el = document.createElement('div');
  el.className = 'card toast animate-slide-in';

  let iconName = 'info';
  let color = 'var(--primary)';
  if (type === 'success') {
    iconName = 'success';
    color = 'var(--status-complete)';
  }
  if (type === 'error') {
    iconName = 'error';
    color = 'var(--status-error)';
  }

  el.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${TOAST_ICONS[iconName]}</svg>
    <span>${message}</span>
  `;

  document.body.appendChild(el);

  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(10px)';
    el.style.transition = 'all 0.3s ease';
    setTimeout(() => document.body.removeChild(el), 300);
  }, 3000);
}
