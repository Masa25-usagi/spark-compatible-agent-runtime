export function createModal(content: HTMLElement | string, onClose?: () => void): HTMLElement {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'modal-card animate-fade-in';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'modal-close-btn';
  closeBtn.textContent = '閉じる';
  closeBtn.setAttribute('aria-label', '閉じる');
  closeBtn.onclick = () => {
    if (overlay.parentNode) {
      overlay.parentNode.removeChild(overlay);
    }
    if (onClose) onClose();
  };

  modal.appendChild(closeBtn);

  const contentContainer = document.createElement('div');
  contentContainer.style.marginTop = '1.5rem';
  if (typeof content === 'string') {
    contentContainer.innerHTML = content;
  } else {
    contentContainer.appendChild(content);
  }

  modal.appendChild(contentContainer);
  overlay.appendChild(modal);

  // Close when clicking overlay (light dismiss)
  overlay.onclick = (e) => {
    if (e.target === overlay) {
      if (overlay.parentNode) {
        overlay.parentNode.removeChild(overlay);
      }
      if (onClose) onClose();
    }
  };

  return overlay;
}
