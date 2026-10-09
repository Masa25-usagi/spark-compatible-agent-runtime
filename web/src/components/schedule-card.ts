import { ScheduleRecord } from '../types';
import { createStatusBadge } from './status-badge';
import { api } from '../api-client';
import { escapeHtml } from '../render-utils';

export function createScheduleCard(schedule: ScheduleRecord, onAction?: () => void): HTMLElement {
  const el = document.createElement('div');
  el.className = 'card animate-fade-in';

  const statusStr = schedule.enabled ? 'running' : 'stopped';
  const intervalSec = Math.round(schedule.intervalMs / 1000);
  let intervalText = `${intervalSec} 秒`;
  if (intervalSec >= 60) {
    const mins = Math.floor(intervalSec / 60);
    const secs = intervalSec % 60;
    intervalText = `${mins} 分 ${secs > 0 ? `${secs} 秒` : ''}`;
  }

  el.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 1rem;">
      <h3 style="margin: 0; display: flex; align-items: center; gap: 0.5rem; color: var(--text-primary); font-size: 1.1rem; font-weight: 600;">
        ${escapeHtml(schedule.name)}
      </h3>
      <div id="badge-container"></div>
    </div>
    <div style="font-size: 0.875rem; color: var(--text-secondary); margin-bottom: 1rem; line-height: 1.6;">
      <div>実行間隔: ${intervalText}</div>
      <div>次回実行予定: ${new Date(schedule.nextRunAt).toLocaleString('ja-JP')}</div>
    </div>
    <div style="display: flex; gap: 0.5rem;">
      ${
        schedule.enabled
          ? `
        <button class="btn btn-secondary btn-sm" id="btn-pause">一時停止</button>
      `
          : `
        <button class="btn btn-primary btn-sm" id="btn-resume">再開</button>
      `
      }
    </div>
  `;

  el.querySelector('#badge-container')!.appendChild(createStatusBadge(statusStr));

  el.querySelector('#btn-pause')?.addEventListener('click', async () => {
    try {
      await api.pauseSchedule(schedule.id, 'UIによる一時停止');
      if (onAction) onAction();
    } catch (e) {
      alert(`スケジュール停止エラー: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  el.querySelector('#btn-resume')?.addEventListener('click', async () => {
    try {
      await api.resumeSchedule(schedule.id);
      if (onAction) onAction();
    } catch (e) {
      alert(`スケジュール再開エラー: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  return el;
}
