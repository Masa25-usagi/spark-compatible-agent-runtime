const ICONS: Record<string, string> = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9 21v-6h6v6"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  shield:
    '<path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6z"/><path d="m9 12 2 2 4-4"/>',
  sparkles:
    '<path d="M12 4l1.7 4.3L18 10l-4.3 1.7L12 16l-1.7-4.3L6 10l4.3-1.7z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
  file:
    '<path d="M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h6"/>',
  help:
    '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.8 2.1c-.8.5-1.3 1-1.3 1.9"/><path d="M12 17h.01"/>',
  plus: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
};

function icon(name: string): string {
  return `<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}

export function renderSidebar(): HTMLElement {
  const nav = document.createElement('div');
  nav.style.display = 'flex';
  nav.style.flexDirection = 'column';
  nav.style.height = '100%';
  nav.style.width = '100%';

  const links = [
    { href: '#/', label: 'ホーム', icon: 'home' },
    { href: '#/tasks', label: 'タスク一覧', icon: 'list' },
    { href: '#/approvals', label: '承認待ち', icon: 'shield' },
    { href: '#/skills', label: 'スキル', icon: 'sparkles' },
    { href: '#/schedules', label: 'スケジュール', icon: 'clock' },
    { href: '#/audit', label: '安全ログ', icon: 'file' },
    { href: '#/help', label: '使い方', icon: 'help' },
  ];

  nav.innerHTML = `
    <div style="padding: 1.25rem 1rem 0.5rem; display: flex; align-items: center; gap: 0.65rem;">
      <div style="background: var(--primary-dim); color: var(--primary); width: 36px; height: 36px; border-radius: var(--radius-md); display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M12 2L9.5 9.5L2 12L9.5 14.5L12 22L14.5 14.5L22 12L14.5 9.5L12 2Z"/></svg>
      </div>
      <div style="min-width: 0;">
        <div style="font-weight: 700; font-size: 1.05rem; color: var(--text-primary); letter-spacing: -0.01em; line-height: 1.2;">Spark Runtime</div>
        <div style="font-size: 0.75rem; color: var(--text-tertiary); margin-top: 0.1rem;">Local task workspace</div>
      </div>
    </div>

    <div style="padding: 0.75rem 1rem 1rem;">
      <a href="#/tasks?new=true" class="btn btn-primary" style="display: flex; width: 100%; justify-content: center; padding: 0.6rem 0; text-decoration: none;">
        新規タスク
      </a>
    </div>

    <div style="display: flex; flex-direction: column; gap: 2px; padding: 0 0.75rem;">
      ${links
        .map(
          (l) => `
        <a href="${l.href}" class="nav-link">
          ${icon(l.icon)}
          <span>${l.label}</span>
        </a>
      `,
        )
        .join('')}
    </div>

    <div style="margin-top: auto; padding: 1rem; border-top: 1px solid var(--border); font-size: 0.8rem; color: var(--text-secondary); display: flex; flex-direction: column; gap: 0.5rem;">
      <div style="display: flex; align-items: center; gap: 0.5rem;">
        <span class="status-dot status-dot-complete" style="width: 8px; height: 8px;"></span>
        <span>ローカル接続: 正常</span>
      </div>
      <div>実行プロバイダー: 作成画面で確認</div>
      <div style="margin-top: 0.25rem;">
        <a href="#/audit" style="color: var(--primary); text-decoration: none; font-weight: 500;">ログを開く</a>
      </div>
    </div>
  `;

  // Highlight active link
  const updateActive = () => {
    const hash = window.location.hash || '#/';
    const path = hash.split('?')[0];
    nav.querySelectorAll('.nav-link').forEach((el) => {
      const a = el as HTMLAnchorElement;
      a.classList.toggle('active', a.getAttribute('href') === path);
    });
  };

  window.addEventListener('hashchange', updateActive);
  setTimeout(updateActive, 0);

  return nav;
}

export function renderBottomNav(): HTMLElement {
  const nav = document.createElement('div');
  nav.style.display = 'flex';
  nav.style.justifyContent = 'space-around';
  nav.style.width = '100%';

  const links = [
    { href: '#/', label: 'ホーム', icon: 'home' },
    { href: '#/tasks', label: 'タスク', icon: 'list' },
    { href: '#/tasks?new=true', label: '新規作成', icon: 'plus' },
    { href: '#/approvals', label: '承認待ち', icon: 'shield' },
    { href: '#/help', label: '使い方', icon: 'help' },
  ];

  nav.innerHTML = links
    .map(
      (l) => `
    <a href="${l.href}" class="mobile-nav-link">
      ${icon(l.icon)}
      <span>${l.label}</span>
    </a>
  `,
    )
    .join('');

  const updateActive = () => {
    const hash = window.location.hash || '#/';
    nav.querySelectorAll('.mobile-nav-link').forEach((el) => {
      const a = el as HTMLAnchorElement;
      const href = a.getAttribute('href')!;
      const isActive = href.includes('?') ? hash === href : hash.split('?')[0] === href;
      a.classList.toggle('active', isActive);
    });
  };

  window.addEventListener('hashchange', updateActive);
  setTimeout(updateActive, 0);

  return nav;
}
