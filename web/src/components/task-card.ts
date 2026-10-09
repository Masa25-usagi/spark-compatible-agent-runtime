import { TaskRecord } from '../types';
import { escapeHtml } from '../render-utils';

function getStatusDotClass(task: TaskRecord): string {
  if (
    task.status === 'failed' ||
    task.dispatchStatus === 'failed' ||
    task.dispatchStatus === 'timed_out'
  ) {
    return 'status-dot-error';
  }
  if (
    task.status === 'waiting_for_approval' ||
    task.dispatchStatus === 'needs_user' ||
    task.status === 'take_control'
  ) {
    return 'status-dot-pending';
  }
  if (
    task.status === 'running' ||
    task.dispatchStatus === 'running' ||
    task.dispatchStatus === 'queued'
  ) {
    return 'status-dot-active';
  }
  if (task.status === 'completed' || task.dispatchStatus === 'responded') {
    return 'status-dot-complete';
  }
  return 'status-dot-gray';
}

function formatElapsedTime(task: TaskRecord): string {
  if (!task.dispatchStartedAt) return '00:00:00';
  const start = new Date(task.dispatchStartedAt).getTime();
  const end = task.dispatchFinishedAt ? new Date(task.dispatchFinishedAt).getTime() : Date.now();
  const diffMs = Math.max(0, end - start);
  const secs = Math.floor(diffMs / 1000) % 60;
  const mins = Math.floor(diffMs / 60000) % 60;
  const hours = Math.floor(diffMs / 3600000);
  return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

export function createTaskCard(task: TaskRecord): HTMLElement {
  const el = document.createElement('a');
  el.href = `#/tasks/${encodeURIComponent(task.id)}`;
  el.className = 'task-row animate-slide-in';

  const providerName =
    task.agent === 'antigravity' ? 'Antigravity' : task.agent === 'codex' ? 'Codex' : task.agent;
  const modelName = task.model;
  const displayProviderModel = `${providerName} / ${modelName}`;
  const elapsedTime = formatElapsedTime(task);
  const dotClass = getStatusDotClass(task);

  el.innerHTML = `
    <div class="task-row-title-col">
      <span class="status-dot ${dotClass}"></span>
      <span class="task-row-title-text" title="${escapeHtml(task.title)}">${escapeHtml(task.title)}</span>
    </div>
    <div class="task-row-provider-col" title="${escapeHtml(displayProviderModel)}">
      ${escapeHtml(displayProviderModel)}
    </div>
    <div class="task-row-time-col">
      ${elapsedTime}
    </div>
  `;

  return el;
}
