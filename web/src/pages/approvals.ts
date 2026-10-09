import { createApprovalCard } from '../components/approval-card';
import { createLoadingSpinner } from '../components/loading-spinner';
import { api } from '../api-client';

export async function renderApprovals(): Promise<HTMLElement> {
  const container = document.createElement('div');
  container.className = 'animate-fade-in';

  container.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem;">
      <h1 style="margin: 0; color: var(--text-primary); font-size: 1.5rem;">承認待ちの操作一覧</h1>
      <button id="btn-refresh" class="btn btn-secondary" style="font-size: 0.9rem; padding: 0.5rem 1rem;">更新</button>
    </div>
    <div id="approvals-list" style="display: flex; flex-direction: column; gap: 1rem; max-width: 800px;"></div>
  `;

  const list = container.querySelector('#approvals-list')!;
  const refreshBtn = container.querySelector('#btn-refresh')!;

  async function loadApprovals() {
    list.innerHTML = '';
    list.appendChild(createLoadingSpinner());

    try {
      const approvals = await api.getApprovals('pending');
      list.innerHTML = '';

      if (approvals.length === 0) {
        list.innerHTML = `
          <div class="card" style="padding: 2.5rem; text-align: center; color: var(--text-secondary);">
            <p style="font-size: 1.1rem; margin-bottom: 0.5rem;">承認待ちの操作はありません。</p>
            <p style="font-size: 0.9rem;">エージェントはすべて順調に動いているか、あるいは指示を待っています。</p>
          </div>
        `;
      } else {
        // Sort approvals by creation date descending
        const sorted = [...approvals].sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        );
        sorted.forEach((a) => list.appendChild(createApprovalCard(a, loadApprovals)));
      }
    } catch (e) {
      list.innerHTML = `
        <div style="color: var(--status-error); padding: 2rem; text-align: center; background: var(--bg-card); border-radius: var(--radius-md); border: 1px solid var(--border);">
          承認待ち一覧の読み込みに失敗しました。
        </div>
      `;
    }
  }

  refreshBtn.addEventListener('click', loadApprovals);

  // Initial load
  loadApprovals();

  return container;
}
