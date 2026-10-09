export function renderSidebar(): HTMLElement {
  const nav = document.createElement('div');
  nav.style.display = 'flex';
  nav.style.flexDirection = 'column';
  nav.style.height = '100%';
  nav.style.width = '100%';

  const links = [
    { href: '#/', label: 'ホーム' },
    { href: '#/tasks', label: 'タスク一覧' },
    { href: '#/approvals', label: '承認待ち' },
    { href: '#/skills', label: 'スキル' },
    { href: '#/schedules', label: 'スケジュール' },
    { href: '#/audit', label: '安全ログ' },
    { href: '#/help', label: '使い方' },
  ];

  nav.innerHTML = `
    <div style="padding: 1.5rem 1rem 0.25rem;">
      <div style="font-weight: bold; font-size: 1.25rem; color: var(--text-primary);">Spark Runtime</div>
      <div style="font-size: 0.85rem; color: var(--text-secondary); margin-top: 0.1rem;">Local task workspace</div>
    </div>
    
    <div style="padding: 1rem;">
      <a href="#/tasks?new=true" class="btn btn-primary" style="display: flex; width: 100%; justify-content: center; font-weight: bold; padding: 0.6rem 0; border-radius: var(--radius-md); text-decoration: none; color: white;">
        新規タスク
      </a>
    </div>

    <div style="display: flex; flex-direction: column; gap: 0.25rem; padding: 0.5rem 1rem;">
      ${links
        .map(
          (l) => `
        <a href="${l.href}" class="nav-link" style="display: block; padding: 0.6rem 0.75rem; border-radius: var(--radius-md); color: var(--text-primary); transition: background 0.2s; text-decoration: none; font-size: 0.95rem;">
          ${l.label}
        </a>
      `,
        )
        .join('')}
    </div>

    <div style="margin-top: auto; padding: 1.5rem 1rem; border-top: 1px solid var(--border); font-size: 0.85rem; color: var(--text-secondary); display: flex; flex-direction: column; gap: 0.5rem;">
      <div style="display: flex; align-items: center; gap: 0.5rem;">
        <span style="width: 8px; height: 8px; border-radius: 50%; background-color: var(--status-complete); display: inline-block;"></span>
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
      if (a.getAttribute('href') === path) {
        a.style.background = 'var(--primary-dim)';
        a.style.color = 'var(--primary)';
        a.style.fontWeight = 'bold';
      } else {
        a.style.background = 'none';
        a.style.color = 'var(--text-primary)';
        a.style.fontWeight = 'normal';
      }
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
  nav.style.padding = '0.5rem 0';

  const links = [
    { href: '#/', label: 'ホーム' },
    { href: '#/tasks', label: 'タスク' },
    { href: '#/tasks?new=true', label: '新規作成' },
    { href: '#/approvals', label: '承認待ち' },
    { href: '#/help', label: '使い方' },
  ];

  nav.innerHTML = links
    .map(
      (l) => `
    <a href="${l.href}" class="mobile-nav-link" style="display: flex; flex-direction: column; align-items: center; justify-content: center; flex: 1; text-decoration: none; color: var(--text-secondary); font-size: 0.8rem; font-weight: 500;">
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
      if (isActive) {
        a.style.color = 'var(--primary)';
        a.style.fontWeight = 'bold';
      } else {
        a.style.color = 'var(--text-secondary)';
        a.style.fontWeight = '500';
      }
    });
  };

  window.addEventListener('hashchange', updateActive);
  setTimeout(updateActive, 0);

  return nav;
}
