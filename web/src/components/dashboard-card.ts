export function createDashboardCard(
  title: string,
  value: string | number,
  icon?: string,
): HTMLElement {
  const el = document.createElement('div');
  el.className = 'card animate-fade-in';
  el.style.display = 'flex';
  el.style.alignItems = 'center';
  el.style.gap = '1rem';

  const iconHtml = icon
    ? `<div style="background: var(--primary-dim); color: var(--primary); padding: 0.75rem; border-radius: 50%; width: 50px; height: 50px; display: flex; align-items: center; justify-content: center;">
        <span style="font-size: 1.5rem;">${icon}</span>
       </div>`
    : '';

  el.innerHTML = `
    ${iconHtml}
    <div>
      <div style="font-size: 0.875rem; color: var(--text-secondary);">${title}</div>
      <div style="font-size: 1.5rem; font-weight: 700; color: var(--text-primary);">${value}</div>
    </div>
  `;
  return el;
}
