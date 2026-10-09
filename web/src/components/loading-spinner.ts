export function createLoadingSpinner(): HTMLElement {
  const el = document.createElement('div');
  el.style.display = 'flex';
  el.style.alignItems = 'center';
  el.style.justifyContent = 'center';
  el.style.padding = '2rem';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-label', '読み込み中');

  el.innerHTML = '<div class="loading-spinner" aria-hidden="true"></div>';
  return el;
}
