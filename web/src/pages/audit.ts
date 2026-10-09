import { createAuditTimeline } from '../components/audit-timeline';
import { createLoadingSpinner } from '../components/loading-spinner';
import { api } from '../api-client';
import { escapeHtml } from '../render-utils';

export async function renderAudit(): Promise<HTMLElement> {
  const container = document.createElement('div');
  container.className = 'animate-fade-in';

  container.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem;">
      <h1 style="margin: 0; color: var(--text-primary); font-size: 1.5rem;">安全履歴（監査ログ）</h1>
      <button id="btn-refresh" class="btn btn-secondary" style="font-size: 0.9rem; padding: 0.5rem 1rem;">更新</button>
    </div>
    <div id="verification-banner" style="margin-bottom: 2rem;"></div>
    <div id="timeline-container" style="max-width: 800px;"></div>
  `;

  const verificationBanner = container.querySelector('#verification-banner')!;
  const timelineContainer = container.querySelector('#timeline-container')!;
  const refreshBtn = container.querySelector('#btn-refresh')!;

  async function loadAudit() {
    verificationBanner.innerHTML = '';
    timelineContainer.innerHTML = '';

    verificationBanner.appendChild(createLoadingSpinner());
    timelineContainer.appendChild(createLoadingSpinner());

    try {
      const [events, verification] = await Promise.all([api.getAudit(), api.verifyAudit()]);

      // Render verification banner without emojis
      verificationBanner.innerHTML = '';
      if (verification.valid) {
        verificationBanner.innerHTML = `
          <div class="card" style="background: rgba(30, 142, 62, 0.08); border: 1px solid rgba(30, 142, 62, 0.3); display: flex; align-items: center; gap: 1rem; padding: 1rem; border-radius: var(--radius-md);">
            <div style="width: 8px; height: 8px; border-radius: 50%; background-color: var(--status-complete);"></div>
            <div>
              <h3 style="margin: 0; color: var(--status-complete); font-size: 1rem; font-weight: 600;">監査証跡の整合性を検証済み</h3>
              <p style="margin: 0; font-size: 0.85rem; color: var(--text-secondary); margin-top: 0.2rem;">
                過去のすべてのエージェント操作履歴はハッシュチェーンで暗号学的に保護されており、改ざんはありません。 (確認イベント数: ${verification.eventCount}件)
              </p>
            </div>
          </div>
        `;
      } else {
        verificationBanner.innerHTML = `
          <div class="card" style="background: rgba(217, 30, 37, 0.08); border: 1px solid rgba(217, 30, 37, 0.3); display: flex; align-items: center; gap: 1rem; padding: 1rem; border-radius: var(--radius-md);">
            <div style="width: 8px; height: 8px; border-radius: 50%; background-color: var(--status-error);"></div>
            <div>
              <h3 style="margin: 0; color: var(--status-error); font-size: 1rem; font-weight: 600;">監査証跡の整合性検証に失敗</h3>
              <p style="margin: 0; font-size: 0.85rem; color: var(--text-secondary); margin-top: 0.2rem;">
                履歴が改ざんされたか、検証中にエラーが発生しました。理由: ${escapeHtml(verification.reason || '不明なエラー')}
              </p>
            </div>
          </div>
        `;
      }

      // Render timeline
      timelineContainer.innerHTML = '';
      // Sort events by timestamp descending
      const sorted = [...events].sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
      );
      timelineContainer.appendChild(createAuditTimeline(sorted));
    } catch (e) {
      verificationBanner.innerHTML = '';
      timelineContainer.innerHTML = `
        <div style="color: var(--status-error); padding: 2rem; text-align: center; background: var(--bg-card); border-radius: var(--radius-md); border: 1px solid var(--border);">
          安全履歴の読み込みに失敗しました。
        </div>
      `;
    }
  }

  refreshBtn.addEventListener('click', loadAudit);

  // Initial load
  loadAudit();

  return container;
}
