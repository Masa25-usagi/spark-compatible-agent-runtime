import { renderSidebar, renderBottomNav } from './nav-bar';

export function renderAppShell(): HTMLElement {
  const shell = document.createElement('div');
  shell.className = 'app-container';

  shell.innerHTML = `
    <aside class="sidebar" id="sidebar"></aside>
    <main class="main-content" id="main-content"></main>
    <nav class="bottom-nav" id="bottom-nav"></nav>
  `;

  const sidebar = shell.querySelector('#sidebar')!;
  const bottomNav = shell.querySelector('#bottom-nav')!;

  sidebar.appendChild(renderSidebar());
  bottomNav.appendChild(renderBottomNav());

  return shell;
}
