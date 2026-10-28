import { createScheduleCard } from '../components/schedule-card';
import { createLoadingSpinner } from '../components/loading-spinner';
import { api } from '../api-client';

export async function renderSchedules(): Promise<HTMLElement> {
  const container = document.createElement('div');
  container.className = 'animate-fade-in';

  container.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem;">
      <h1 style="margin: 0; color: var(--text-primary); font-size: 1.5rem;">定期実行スケジュール</h1>
      <button id="btn-refresh" class="btn btn-secondary" style="font-size: 0.9rem; padding: 0.5rem 1rem;">更新</button>
    </div>
    <div id="schedules-grid" class="grid-2"></div>
  `;

  const grid = container.querySelector('#schedules-grid')!;
  const refreshBtn = container.querySelector('#btn-refresh')!;

  async function loadSchedules() {
    grid.innerHTML = '';
    grid.appendChild(createLoadingSpinner());

    try {
      const schedules = await api.getSchedules();
      grid.innerHTML = '';

      if (schedules.length === 0) {
        grid.innerHTML = `
          <div class="empty-state" style="grid-column: span 2;">
            登録されている定期実行スケジュールはありません。
          </div>
        `;
      } else {
        schedules.forEach((s) => grid.appendChild(createScheduleCard(s, loadSchedules)));
      }
    } catch (e) {
      grid.innerHTML = `
        <div style="color: var(--status-error); padding: 2rem; text-align: center; background: var(--bg-card); border-radius: var(--radius-md); border: 1px solid var(--border); grid-column: span 2;">
          スケジュール一覧の読み込みに失敗しました。
        </div>
      `;
    }
  }

  refreshBtn.addEventListener('click', loadSchedules);

  // Initial load
  loadSchedules();

  return container;
}
