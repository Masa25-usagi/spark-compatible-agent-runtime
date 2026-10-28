import { SkillRecord } from '../types';
import { api } from '../api-client';
import { escapeHtml } from '../render-utils';

export function createSkillCard(skill: SkillRecord, onToggle?: () => void): HTMLElement {
  const el = document.createElement('div');
  el.className = 'card animate-slide-in';

  el.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 0.5rem; gap: 0.75rem;">
      <h3 style="margin: 0; display: flex; align-items: center; gap: 0.5rem; color: var(--text-primary); font-size: 1.05rem; font-weight: 600;">
        ${escapeHtml(skill.name)}
      </h3>
      <label class="toggle">
        <input type="checkbox" id="toggle-skill-${encodeURIComponent(skill.name)}" ${skill.enabled ? 'checked' : ''}>
        <span class="toggle-track" style="${skill.enabled ? 'background-color: var(--primary); border-color: var(--primary);' : ''}">
          <span class="toggle-thumb" style="transform: translateX(${skill.enabled ? '20px' : '0'});"></span>
        </span>
      </label>
    </div>
    <p style="color: var(--text-secondary); font-size: 0.875rem; margin: 0; margin-bottom: 0.5rem;">${escapeHtml(skill.description)}</p>
    <div style="font-size: 0.7rem; color: var(--text-tertiary); font-family: monospace; overflow-wrap: anywhere; word-break: break-all;">
      ${skill.instructions ? `指示例: ${escapeHtml(skill.instructions.substring(0, 100))}${skill.instructions.length > 100 ? '...' : ''}` : ''}
    </div>
  `;

  const checkbox = el.querySelector('input')!;
  const track = el.querySelector('.toggle-track') as HTMLElement;
  const thumb = el.querySelector('.toggle-thumb') as HTMLElement;
  checkbox.addEventListener('change', async () => {
    try {
      await api.toggleSkill(skill.name);
      if (checkbox.checked) {
        thumb.style.transform = 'translateX(20px)';
        track.style.backgroundColor = 'var(--primary)';
        track.style.borderColor = 'var(--primary)';
      } else {
        thumb.style.transform = 'translateX(0)';
        track.style.backgroundColor = '';
        track.style.borderColor = '';
      }
      if (onToggle) onToggle();
    } catch (e) {
      checkbox.checked = !checkbox.checked; // revert
      alert(`スキルの切り替えに失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  return el;
}
