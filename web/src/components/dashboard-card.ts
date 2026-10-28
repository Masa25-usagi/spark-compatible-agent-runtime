const STAT_ICONS: Record<string, string> = {
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  activity: '<path d="M3 12h4l3 8 4-16 3 8h4"/>',
  shield:
    '<path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6z"/><path d="m9 12 2 2 4-4"/>',
};

export function createDashboardCard(
  title: string,
  value: string | number,
  icon?: string,
): HTMLElement {
  const el = document.createElement('div');
  el.className = 'card stat-card animate-fade-in';

  const iconPath = icon ? STAT_ICONS[icon] : undefined;
  const iconHtml = iconPath
    ? `<div class="stat-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPath}</svg>
       </div>`
    : '';

  el.innerHTML = `
    ${iconHtml}
    <div>
      <div class="stat-label">${title}</div>
      <div class="stat-value">${value}</div>
    </div>
  `;
  return el;
}
