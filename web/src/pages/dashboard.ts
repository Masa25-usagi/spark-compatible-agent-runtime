import { createDashboardCard } from '../components/dashboard-card';
import { createTaskCard } from '../components/task-card';
import { createApprovalCard } from '../components/approval-card';
import { createLoadingSpinner } from '../components/loading-spinner';
import { api } from '../api-client';

export async function renderDashboard(): Promise<HTMLElement> {
  const container = document.createElement('div');
  container.className = 'animate-fade-in';

  container.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem;">
      <h1 style="margin: 0; color: var(--text-primary); font-size: 1.5rem;">ダッシュボード</h1>
      <button id="btn-refresh" class="btn btn-secondary" style="font-size: 0.9rem; padding: 0.5rem 1rem;">
        更新
      </button>
    </div>

    <!-- 主なアクションの案内 (Suggested Next Action) -->
    <div id="next-action-container" style="margin-bottom: 2rem;"></div>

    <div id="stats-grid" class="grid-3" style="margin-bottom: 2rem;"></div>
    
    <!-- AI使用状況 / AI usage panel -->
    <div class="card" style="margin-bottom: 2.5rem;">
      <h2 style="font-size: 1.1rem; color: var(--text-primary); margin-top: 0; margin-bottom: 1rem; font-weight: 600;">
        AI使用状況
      </h2>
      <div id="ai-usage-container" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 1rem;"></div>
    </div>

    <div class="grid-2">
      <div>
        <h2 style="margin-bottom: 1.5rem; color: var(--text-primary); font-size: 1.1rem; font-weight: 600;">
          実行中のタスク
        </h2>
        <div id="tasks-list" style="display: flex; flex-direction: column; gap: 1rem;"></div>
      </div>
      <div>
        <h2 style="margin-bottom: 1.5rem; color: var(--status-pending); font-size: 1.1rem; font-weight: 600;">
          承認待ちの操作
        </h2>
        <div id="approvals-list" style="display: flex; flex-direction: column; gap: 1rem;"></div>
      </div>
    </div>

    <!-- 安全性の説明 -->
    <div style="margin-top: 3rem; padding: 1rem; background: var(--bg-card); border-top: 1px solid var(--border); font-size: 0.8rem; color: var(--text-secondary); text-align: center; border-radius: var(--radius-md);">
      <strong>ローカル安全設計:</strong> 操作画面と監査ログはこのパソコン内で保持されます。タスクを開始すると、入力した指示が選択した外部CLIへ渡ります。外部CLIの実行権限は、そのCLIの設定に従います。
    </div>
  `;

  const statsGrid = container.querySelector('#stats-grid')!;
  const tasksList = container.querySelector('#tasks-list')!;
  const approvalsList = container.querySelector('#approvals-list')!;
  const nextActionContainer = container.querySelector('#next-action-container')!;
  const aiUsageContainer = container.querySelector('#ai-usage-container')!;
  const refreshButton = container.querySelector('#btn-refresh')!;

  async function loadData() {
    statsGrid.innerHTML = '';
    tasksList.innerHTML = '';
    approvalsList.innerHTML = '';
    nextActionContainer.innerHTML = '';
    aiUsageContainer.innerHTML = '';

    statsGrid.appendChild(createLoadingSpinner());
    tasksList.appendChild(createLoadingSpinner());
    approvalsList.appendChild(createLoadingSpinner());
    aiUsageContainer.appendChild(createLoadingSpinner());

    try {
      const [data, providersData] = await Promise.all([
        api.getDashboard(),
        api.getAgentProviders(),
      ]);

      statsGrid.innerHTML = '';
      tasksList.innerHTML = '';
      approvalsList.innerHTML = '';
      aiUsageContainer.innerHTML = '';

      // Render stats cards with icons
      statsGrid.appendChild(createDashboardCard('総タスク数', data.stats.taskCount, 'list'));
      statsGrid.appendChild(createDashboardCard('実行中タスク数', data.stats.runningCount, 'activity'));
      statsGrid.appendChild(
        createDashboardCard('承認待ち操作数', data.stats.pendingApprovalCount, 'shield'),
      );

      // Render AI usage status panel
      if (providersData.providers && providersData.providers.length > 0) {
        providersData.providers.forEach((p) => {
          const quotaText =
            p.quotaAvailability === 'unavailable' ? 'CLIから取得できません' : p.quotaAvailability;
          const card = document.createElement('div');
          card.style.background = 'var(--bg-elevated)';
          card.style.padding = '0.75rem 1rem';
          card.style.borderRadius = 'var(--radius-md)';
          card.style.border = '1px solid var(--border)';
          card.innerHTML = `
            <div style="font-weight: bold; font-size: 0.9rem; color: var(--text-primary); margin-bottom: 0.25rem;">
              ${p.name}
            </div>
            <div style="font-size: 0.8rem; color: var(--text-secondary); margin-bottom: 0.15rem;">
              接続ステータス: <span style="color: ${p.available ? 'var(--status-complete)' : 'var(--status-error)'}; font-weight: bold;">
                ${p.available ? '利用可能' : '利用不可'}
              </span>
            </div>
            <div style="font-size: 0.8rem; color: var(--text-secondary); margin-bottom: 0.15rem;">
              デフォルトモデル: ${p.defaultModel}
            </div>
            <div style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 0.4rem; border-top: 1px dashed var(--border); padding-top: 0.4rem;">
              利用量制限: ${quotaText}
            </div>
          `;
          aiUsageContainer.appendChild(card);
        });
      } else {
        aiUsageContainer.innerHTML = `<p style="color: var(--text-secondary); font-size: 0.9rem;">プロバイダー情報がありません。</p>`;
      }

      // Next Action Suggestion
      if (data.pendingApprovals.length > 0) {
        nextActionContainer.innerHTML = `
          <div class="alert-banner alert-banner-warning" style="justify-content: space-between;">
            <div style="font-size: 0.9rem;">
              <span style="font-weight: 700; color: var(--status-pending);">次に行うこと:</span>
              エージェントが作業の承認を待っています。安全確認を行って実行を許可してください。
            </div>
            <a href="#/approvals" class="btn btn-primary" style="background: var(--status-pending); color: #000; font-weight: 700; padding: 0.5rem 1rem; text-decoration: none;">
              承認待ちを確認する (${data.pendingApprovals.length}件)
            </a>
          </div>
        `;
      } else {
        nextActionContainer.innerHTML = `
          <div class="alert-banner alert-banner-info" style="justify-content: space-between;">
            <div style="font-size: 0.9rem;">
              <span style="font-weight: 700; color: var(--primary);">次に行うこと:</span>
              現在、承認待ちの操作はありません。新しいタスクを作成してエージェントに指示を出しましょう。
            </div>
            <a href="#/tasks?new=true" class="btn btn-primary" style="font-weight: 700; padding: 0.5rem 1rem; text-decoration: none;">
              新しいタスクを作る
            </a>
          </div>
        `;
      }

      // Render active external handoffs (queued / running in dispatchStatus, or running/waiting_for_approval in status)
      const activeTasks = data.tasks.filter(
        (t) =>
          t.status === 'running' ||
          t.status === 'waiting_for_approval' ||
          t.dispatchStatus === 'queued' ||
          t.dispatchStatus === 'running',
      );
      if (activeTasks.length === 0) {
        tasksList.innerHTML = `<p style="color: var(--text-secondary); font-size: 0.9rem;">現在実行中または引き渡し中のタスクはありません。</p>`;
      } else {
        activeTasks.forEach((t) => {
          tasksList.appendChild(createTaskCard(t));
        });
      }

      // Render approvals list
      if (data.pendingApprovals.length === 0) {
        approvalsList.innerHTML = `<p style="color: var(--text-secondary); font-size: 0.9rem;">現在承認待ちの操作はありません。</p>`;
      } else {
        data.pendingApprovals.forEach((a) => {
          approvalsList.appendChild(createApprovalCard(a, loadData));
        });
      }
    } catch (err) {
      statsGrid.innerHTML = '';
      tasksList.innerHTML = '';
      approvalsList.innerHTML = '';
      nextActionContainer.innerHTML = '';
      aiUsageContainer.innerHTML = '';
      container.innerHTML += `<div class="alert-banner alert-banner-error" style="justify-content: center; margin-top: 1rem;">データの読み込みに失敗しました。接続や認証トークンを確認してください。</div>`;
    }
  }

  refreshButton.addEventListener('click', loadData);

  // Initial load
  loadData();

  return container;
}
