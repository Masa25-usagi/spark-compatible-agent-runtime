import { createSkillCard } from '../components/skill-card';
import { createLoadingSpinner } from '../components/loading-spinner';
import { api } from '../api-client';

export async function renderSkills(): Promise<HTMLElement> {
  const container = document.createElement('div');
  container.className = 'animate-fade-in';

  container.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem;">
      <h1 style="margin: 0; color: var(--text-primary); font-size: 1.5rem;">スキル管理</h1>
      <button id="btn-refresh" class="btn btn-secondary" style="font-size: 0.9rem; padding: 0.5rem 1rem;">更新</button>
    </div>
    <div id="skills-grid" class="grid-3"></div>
  `;

  const grid = container.querySelector('#skills-grid')!;
  const refreshBtn = container.querySelector('#btn-refresh')!;

  async function loadSkills() {
    grid.innerHTML = '';
    grid.appendChild(createLoadingSpinner());

    try {
      const skills = await api.getSkills();
      grid.innerHTML = '';

      if (skills.length === 0) {
        grid.innerHTML = `
          <div class="empty-state" style="grid-column: span 3;">
            登録されているスキルはありません。
          </div>
        `;
      } else {
        skills.forEach((s) => grid.appendChild(createSkillCard(s, loadSkills)));
      }
    } catch (e) {
      grid.innerHTML = `
        <div style="color: var(--status-error); padding: 2rem; text-align: center; background: var(--bg-card); border-radius: var(--radius-md); border: 1px solid var(--border); grid-column: span 3;">
          スキル一覧の読み込みに失敗しました。
        </div>
      `;
    }
  }

  refreshBtn.addEventListener('click', loadSkills);

  // Initial load
  loadSkills();

  return container;
}
