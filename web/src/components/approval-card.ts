import { ApprovalRecord } from '../types';
import { api } from '../api-client';
import { createStatusBadge } from './status-badge';
import { escapeHtml } from '../render-utils';

export function createApprovalCard(approval: ApprovalRecord, onAction?: () => void): HTMLElement {
  const el = document.createElement('div');
  el.className = 'card animate-fade-in';
  el.style.marginBottom = '1rem';

  const disc = approval.disclosure;

  let detailsHtml = `
    <div style="font-size: 0.9rem; margin-bottom: 1rem; display: grid; grid-template-columns: 120px 1fr; gap: 0.5rem; line-height: 1.6;">
      <div style="color: var(--text-secondary);">操作内容:</div>
      <div style="font-weight: 500; color: var(--text-primary);">${escapeHtml(disc.operation)}</div>
      <div style="color: var(--text-secondary);">対象:</div>
      <div style="font-family: monospace; background: var(--bg-hover); padding: 2px 6px; border-radius: 4px; font-size: 0.8rem; overflow-wrap: anywhere; word-break: break-all;">${escapeHtml(disc.targetSummary)}</div>
      <div style="color: var(--text-secondary);">タスク名:</div>
      <div>${escapeHtml(disc.originatingTask)}</div>
      <div style="color: var(--text-secondary);">コネクタ:</div>
      <div>${escapeHtml(disc.connector)} (${escapeHtml(disc.tool)})</div>
  `;

  if (disc.beforeSummary || disc.afterSummary) {
    detailsHtml += `
      <div style="color: var(--text-secondary); grid-column: span 2; margin-top: 0.5rem;">変更内容:</div>
      <div style="grid-column: span 2; display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-top: 0.25rem;">
        <div style="background: color-mix(in srgb, var(--status-error) 8%, transparent); border: 1px solid color-mix(in srgb, var(--status-error) 25%, transparent); padding: 0.5rem; border-radius: var(--radius-sm);">
          <div style="font-size: 0.75rem; color: var(--status-error); margin-bottom: 0.25rem; font-weight: 600;">変更前 (Before)</div>
          <div style="font-size: 0.8rem; white-space: pre-wrap; font-family: monospace;">${escapeHtml(disc.beforeSummary || '（空）')}</div>
        </div>
        <div style="background: color-mix(in srgb, var(--status-complete) 8%, transparent); border: 1px solid color-mix(in srgb, var(--status-complete) 25%, transparent); padding: 0.5rem; border-radius: var(--radius-sm);">
          <div style="font-size: 0.75rem; color: var(--status-complete); margin-bottom: 0.25rem; font-weight: 600;">変更後 (After)</div>
          <div style="font-size: 0.8rem; white-space: pre-wrap; font-family: monospace;">${escapeHtml(disc.afterSummary || '（空）')}</div>
        </div>
      </div>
    `;
  }

  if (disc.amount) {
    detailsHtml += `
      <div style="color: var(--text-secondary);">金額:</div>
      <div style="color: var(--accent); font-weight: bold;">${escapeHtml(disc.amount.currency)} ${disc.amount.value}</div>
    `;
  }
  if (disc.recipient) {
    detailsHtml += `
      <div style="color: var(--text-secondary);">送信先:</div>
      <div>${escapeHtml(disc.recipient)}</div>
    `;
  }

  detailsHtml += `</div>`;

  let confirmHtml = '';
  if (approval.confirmationRequired && approval.status === 'pending') {
    confirmHtml = `
      <div style="margin-bottom: 1rem; background: color-mix(in srgb, var(--status-pending) 10%, transparent); border: 1px solid color-mix(in srgb, var(--status-pending) 30%, transparent); padding: 0.75rem; border-radius: var(--radius-md);">
        <label style="display: flex; align-items: center; gap: 0.5rem; color: var(--status-pending); font-size: 0.85rem; cursor: pointer; user-select: none; font-weight: 500;">
          <input type="checkbox" id="confirm-checkbox" style="width: 16px; height: 16px; accent-color: var(--status-pending);">
          警告: この危険な操作（または一括操作）の内容を理解し、実行を許可します。
        </label>
      </div>
    `;
  }

  el.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 1rem;">
      <h3 style="margin: 0; font-size: 1.1rem; color: var(--text-primary); font-weight: 600;">承認要求: <code>${escapeHtml(approval.id)}</code></h3>
      <div id="badge-container"></div>
    </div>
    ${detailsHtml}
    ${confirmHtml}
    ${
      approval.status === 'pending'
        ? `
    <div style="display: flex; gap: 1rem; margin-top: 1rem;">
      <button class="btn btn-primary" id="btn-approve" style="display: flex; align-items: center; gap: 0.25rem;">
        実行を承認する
      </button>
      <button class="btn btn-danger-outline" id="btn-deny" style="display: flex; align-items: center; gap: 0.25rem;">
        却下する
      </button>
    </div>
    `
        : ''
    }
  `;

  el.querySelector('#badge-container')!.appendChild(createStatusBadge(approval.status));

  if (approval.status === 'pending') {
    el.querySelector('#btn-approve')?.addEventListener('click', async () => {
      let confirmVal = false;
      if (approval.confirmationRequired) {
        const checkbox = el.querySelector('#confirm-checkbox') as HTMLInputElement;
        if (!checkbox || !checkbox.checked) {
          alert('この操作を承認するには、警告チェックボックスをオンにしてください。');
          return;
        }
        confirmVal = true;
      }
      try {
        await api.approveApproval(approval.id, confirmVal);
        if (onAction) onAction();
      } catch (e) {
        alert(`承認エラー: ${e instanceof Error ? e.message : String(e)}`);
      }
    });

    el.querySelector('#btn-deny')?.addEventListener('click', async () => {
      const reason = prompt('却下する理由を入力してください (必須):');
      if (reason === null) return;
      if (reason.trim() === '') {
        alert('却下理由は必須です。');
        return;
      }
      try {
        await api.denyApproval(approval.id, reason);
        if (onAction) onAction();
      } catch (e) {
        alert(`却下エラー: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  }

  return el;
}
