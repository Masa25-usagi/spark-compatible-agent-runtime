import { TaskRecord } from '../types';
import { escapeHtml } from '../render-utils';

export function createTaskStepper(task: TaskRecord): HTMLElement {
  const el = document.createElement('div');
  el.className = 'card';
  el.style.border = '1px solid var(--border)';

  const steps = task.plannedSteps || [];

  let stepsHtml = '';
  if (steps.length === 0) {
    stepsHtml = `<p style="color: var(--text-secondary); font-size: 0.9rem;">手順は設定されていません。</p>`;
  } else {
    stepsHtml = steps
      .map((step, i) => {
        let statusLabel = '待機中';
        let statusColor = 'var(--text-secondary)';

        if (task.completedSteps && task.completedSteps.includes(step)) {
          statusLabel = '完了';
          statusColor = 'var(--status-complete)';
        } else if (step === task.currentStep) {
          if (task.status === 'running') {
            statusLabel = '実行中';
            statusColor = 'var(--status-active)';
          } else if (task.status === 'waiting_for_approval') {
            statusLabel = '承認確認待ち';
            statusColor = 'var(--status-pending)';
          } else if (task.status === 'stopped') {
            statusLabel = '一時停止中';
            statusColor = 'var(--text-tertiary)';
          } else if (task.status === 'failed') {
            statusLabel = '失敗';
            statusColor = 'var(--status-error)';
          } else {
            statusLabel = '実行中';
            statusColor = 'var(--status-active)';
          }
        }

        return `
        <div style="display: flex; gap: 1rem; margin-bottom: 1.25rem; align-items: flex-start;">
          <div style="background: var(--primary-dim); color: var(--primary); width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 0.85rem; font-weight: bold; flex-shrink: 0; border: 1px solid var(--border);">
            ${i + 1}
          </div>
          <div>
            <div style="font-weight: bold; color: var(--text-primary); font-size: 0.95rem;">${escapeHtml(step)}</div>
            <div style="font-size: 0.8rem; color: ${statusColor}; margin-top: 0.25rem;">${statusLabel}</div>
          </div>
        </div>
      `;
      })
      .join('');
  }

  el.innerHTML = `
    <h3 style="margin-top:0; margin-bottom: 1rem; color: var(--text-primary); font-size: 1.1rem; font-weight: 600;">実行ステップ</h3>
    <div style="margin-top: 1rem;">
      ${stepsHtml}
    </div>
  `;
  return el;
}
