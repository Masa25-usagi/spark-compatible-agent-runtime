import { AuditEvent } from '../types';
import { escapeHtml, jsonForHtml } from '../render-utils';

export function createAuditTimeline(events: AuditEvent[]): HTMLElement {
  const el = document.createElement('div');
  el.style.display = 'flex';
  el.style.flexDirection = 'column';
  el.style.gap = '1.5rem';

  if (events.length === 0) {
    el.innerHTML = `<p style="color: var(--text-secondary); text-align: center; padding: 2rem;">監査イベントはまだ記録されていません。</p>`;
    return el;
  }

  el.innerHTML = events
    .map((ev, index) => {
      const isLast = index === events.length - 1;
      const dateStr = new Date(ev.timestamp).toLocaleString('ja-JP');

      // Map outcome
      const decisionLabels: Record<string, string> = {
        allow: '許可',
        require_approval: '承認要',
        take_control: '介入要',
        deny: '却下',
      };
      const decisionText = ev.decision ? decisionLabels[ev.decision] || ev.decision : '許可';

      let targetsText = '';
      if (ev.changedTargets && ev.changedTargets.length > 0) {
        targetsText = `<div style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 0.25rem;">対象ファイル/ターゲット: <code>${ev.changedTargets.map(escapeHtml).join(', ')}</code></div>`;
      }

      let argsText = '';
      if (ev.args) {
        argsText = `<div style="font-size: 0.75rem; color: var(--text-tertiary); font-family: monospace; background: var(--bg-hover); padding: 4px 8px; border-radius: 4px; margin-top: 0.5rem; max-height: 100px; overflow-y: auto;">引数: ${jsonForHtml(ev.args)}</div>`;
      }

      return `
      <div style="display: flex; gap: 1rem; align-items: start; position: relative;">
        ${!isLast ? `<div style="width: 2px; background: var(--border); position: absolute; left: 19px; top: 40px; bottom: -24px; z-index: 0;"></div>` : ''}
        <div style="background: var(--bg-elevated); border: 1px solid var(--border); width: 40px; height: 40px; border-radius: 50%; display: flex; align-items: center; justify-content: center; z-index: 1;">
          <span style="font-size: 0.75rem; font-weight: bold; color: var(--text-secondary);">LOG</span>
        </div>
        <div class="card" style="flex: 1; padding: 1rem; border: 1px solid var(--border);">
          <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 0.5rem;">
            <span style="font-weight: bold; color: var(--text-primary); font-size: 0.95rem;">${escapeHtml(ev.tool || 'システム操作')}</span>
            <span style="font-size: 0.75rem; color: var(--text-tertiary);">${dateStr}</span>
          </div>
          <div style="font-size: 0.85rem; color: var(--text-primary);">
            ポリシー判定: <strong>${escapeHtml(decisionText)}</strong>
          </div>
          ${targetsText}
          ${argsText}
          <div style="font-size: 0.7rem; color: var(--text-tertiary); margin-top: 0.5rem; display: flex; justify-content: space-between; font-family: monospace;">
            <span>エージェント: ${escapeHtml(ev.agent)} (${escapeHtml(ev.model)})</span>
            <span>ハッシュ: ${escapeHtml(ev.eventHash ? ev.eventHash.substring(0, 8) : 'n/a')}</span>
          </div>
        </div>
      </div>
    `;
    })
    .join('');

  return el;
}
