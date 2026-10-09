export function showToast(message: string, type: 'success' | 'error' | 'info' = 'info') {
  const el = document.createElement('div');
  el.className = 'card animate-slide-in';
  el.style.position = 'fixed';
  el.style.bottom = '2rem';
  el.style.right = '2rem';
  el.style.zIndex = '2000';
  el.style.padding = '1rem 1.5rem';
  el.style.display = 'flex';
  el.style.alignItems = 'center';
  el.style.gap = '0.5rem';

  let icon = 'info';
  let color = 'var(--primary)';
  if (type === 'success') {
    icon = 'check_circle';
    color = 'var(--status-complete)';
  }
  if (type === 'error') {
    icon = 'error';
    color = 'var(--status-error)';
  }

  el.innerHTML = `
    <span class="material-symbols-outlined" style="color: ${color};">${icon}</span>
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
