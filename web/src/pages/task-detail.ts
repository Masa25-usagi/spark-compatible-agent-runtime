import { createTaskStepper } from '../components/task-stepper';
import { createStatusBadge } from '../components/status-badge';
import { createApprovalCard } from '../components/approval-card';
import { createLoadingSpinner } from '../components/loading-spinner';
import { api } from '../api-client';
import { escapeHtml } from '../render-utils';

function formatTime(dateStr: string): string {
  const d = new Date(dateStr);
  const yr = d.getFullYear();
  const mo = (d.getMonth() + 1).toString().padStart(2, '0');
  const dy = d.getDate().toString().padStart(2, '0');
  const hr = d.getHours().toString().padStart(2, '0');
  const mi = d.getMinutes().toString().padStart(2, '0');
  const sc = d.getSeconds().toString().padStart(2, '0');
  return `${yr}-${mo}-${dy} ${hr}:${mi}:${sc}`;
}

function getTimelineBadgeClass(status: string): string {
  if (status === 'responded') return 'timeline-badge-complete';
  if (status === 'running' || status === 'queued') return 'timeline-badge-active';
  if (status === 'needs_user') return 'timeline-badge-pending';
  if (status === 'failed' || status === 'timed_out') return 'timeline-badge-error';
  return 'timeline-badge-todo';
}

function getTimelineStatusTitle(status: string): string {
  switch (status) {
    case 'queued':
      return 'CLIに引き渡し（開始待ち）';
    case 'running':
      return 'CLI応答（実行中）';
    case 'responded':
      return 'CLI応答（完了）';
    case 'failed':
      return 'CLI応答（エラー終了）';
    case 'timed_out':
      return 'CLI応答（タイムアウト）';
    case 'cancelled':
      return 'CLI応答（キャンセル）';
    case 'needs_user':
      return 'CLI応答（介入要求）';
    case 'unavailable':
      return 'CLI応答（利用不可）';
    default:
      return 'CLI応答（未実行）';
  }
}

function getTimelineStatusDesc(status: string): string {
  switch (status) {
    case 'queued':
      return '実行キューに入りました。';
    case 'running':
      return 'CLIがバックグラウンドで実行中です。';
    case 'responded':
      return 'CLIからの応答を受信しました。';
    case 'failed':
      return 'CLIがエラーを応答しました。';
    case 'timed_out':
      return '実行制限時間を超過しました。';
    case 'cancelled':
      return '実行がキャンセルされました。';
    case 'needs_user':
      return 'CLIからユーザー介入が要求されています。';
    case 'unavailable':
      return 'CLIが利用不可能です。';
    default:
      return 'CLIへの引き渡しは行われていません。';
  }
}

function formatElapsedTime(task: {
  dispatchStartedAt: string | null;
  dispatchFinishedAt: string | null;
}) {
  if (!task.dispatchStartedAt) return '00:00:00';
  const start = new Date(task.dispatchStartedAt).getTime();
  const end = task.dispatchFinishedAt ? new Date(task.dispatchFinishedAt).getTime() : Date.now();
  const diffMs = Math.max(0, end - start);
  const secs = Math.floor(diffMs / 1000) % 60;
  const mins = Math.floor(diffMs / 60000) % 60;
  const hours = Math.floor(diffMs / 3600000);
  return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

export async function renderTaskDetail(id: string): Promise<HTMLElement> {
  const container = document.createElement('div');
  container.className = 'animate-fade-in';

  container.innerHTML = `
    <div style="margin-bottom: 2rem;">
      <a href="#/tasks" style="display: inline-flex; align-items: center; gap: 0.5rem; color: var(--text-secondary); margin-bottom: 1rem; text-decoration: none; font-size: 0.9rem;">
        タスク一覧へ戻る
      </a>
      <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 1rem;">
        <h1 style="margin: 0; color: var(--text-primary); font-size: 1.5rem;" id="task-title-header">タスク詳細: ${escapeHtml(id)}</h1>
        <div style="display: flex; align-items: center; gap: 1rem;">
          <div id="status-container"></div>
          <button id="btn-refresh" class="btn btn-secondary" style="font-size: 0.85rem; padding: 0.4rem 0.8rem;">更新</button>
        </div>
      </div>
    </div>

    <!-- 異常終了・停止状態の説明パネル -->
    <div id="alert-panel" style="margin-bottom: 2rem;"></div>
    
    <div class="grid-2">
      <!-- 左側: ステップ進行状況 -->
      <div id="stepper-container"></div>
      
      <!-- 右側: メタデータ & ファイル操作 & コントロール -->
      <div style="display: flex; flex-direction: column; gap: 1.5rem;">
        <!-- 保存した指示文の表示 -->
        <div class="card" style="border: 1px solid var(--border); padding: 1.5rem;">
          <h3 style="margin-top: 0; margin-bottom: 0.75rem; color: var(--text-primary); font-size: 1.1rem; font-weight: 600;">指示（プロンプト）</h3>
          <div id="meta-instruction" style="font-size: 0.95rem; color: var(--text-primary); white-space: pre-wrap; line-height: 1.6;"></div>
        </div>

        <!-- コントロールパネル -->
        <div class="card" style="border: 1px solid var(--border); padding: 1.5rem;">
          <h3 style="margin-top: 0; margin-bottom: 1rem; color: var(--text-primary); font-size: 1.1rem; font-weight: 600;">操作とコントロール</h3>
          <div style="display: flex; gap: 1rem;" id="control-buttons"></div>
        </div>

        <!-- エージェント実行状況 (Agent Dispatch) -->
        <div id="dispatch-panel"></div>

        <!-- 承認待ちパネル (埋め込み) -->
        <div id="embedded-approvals"></div>

        <!-- AI使用状況 -->
        <div class="card" style="border: 1px solid var(--border); padding: 1.5rem; font-size: 0.9rem;">
          <h3 style="margin-top: 0; margin-bottom: 0.75rem; color: var(--text-primary); font-size: 1.1rem; font-weight: 600;">AI使用状況</h3>
          <div id="detail-ai-usage" style="line-height: 1.6; color: var(--text-secondary);">
            読み込み中...
          </div>
        </div>

        <!-- メタデータ詳細 -->
        <div class="card" style="border: 1px solid var(--border); padding: 1.5rem; line-height: 1.8; font-size: 0.9rem;">
          <h3 style="margin-top: 0; margin-bottom: 1rem; color: var(--text-primary); font-size: 1.1rem; font-weight: 600;">基本情報</h3>
          <div style="display: grid; grid-template-columns: 100px 1fr; gap: 0.5rem;">
            <div style="color: var(--text-secondary);">稼働環境:</div>
            <div id="meta-harness"></div>
            <div style="color: var(--text-secondary);">ポリシー群:</div>
            <div id="meta-profile"></div>
            <div style="color: var(--text-secondary);">作成日時:</div>
            <div id="meta-created"></div>
            <div style="color: var(--text-secondary);">更新日時:</div>
            <div id="meta-updated"></div>
          </div>
        </div>

        <!-- 関連リソース & 変更ファイル一覧 -->
        <div class="card" style="border: 1px solid var(--border); padding: 1.5rem; font-size: 0.9rem;">
          <h3 style="margin-top: 0; margin-bottom: 1rem; color: var(--text-primary); font-size: 1.1rem; font-weight: 600;">ファイル操作・スキル履歴</h3>
          
          <div style="margin-bottom: 1rem;">
            <h4 style="margin: 0 0 0.5rem; font-size: 0.85rem; color: var(--primary); font-weight: bold;">読み込んだファイル</h4>
            <div id="files-read" style="font-family: monospace; color: var(--text-secondary); background: var(--bg-hover); padding: 0.5rem; border-radius: 4px; font-size: 0.8rem; overflow-wrap: anywhere; word-break: break-all;">なし</div>
          </div>

          <div style="margin-bottom: 1rem;">
            <h4 style="margin: 0 0 0.5rem; font-size: 0.85rem; color: var(--status-complete); font-weight: bold;">編集・作成したファイル</h4>
            <div id="files-changed" style="font-family: monospace; color: var(--text-secondary); background: var(--bg-hover); padding: 0.5rem; border-radius: 4px; font-size: 0.8rem; overflow-wrap: anywhere; word-break: break-all;">なし</div>
          </div>

          <div style="margin-bottom: 1rem;">
            <h4 style="margin: 0 0 0.5rem; font-size: 0.85rem; color: var(--secondary); font-weight: bold;">使用したスキル</h4>
            <div id="used-skills" style="color: var(--text-secondary); font-size: 0.85rem;">なし</div>
          </div>

          <div>
            <h4 style="margin: 0 0 0.5rem; font-size: 0.85rem; color: var(--accent); font-weight: bold;">使用したコネクタ</h4>
            <div id="used-connectors" style="color: var(--text-secondary); font-size: 0.85rem;">なし</div>
          </div>
        </div>
      </div>
    </div>
  `;

  const titleHeader = container.querySelector('#task-title-header')!;
  const statusContainer = container.querySelector('#status-container')!;
  const alertPanel = container.querySelector('#alert-panel')!;
  const stepperContainer = container.querySelector('#stepper-container')!;
  const controlButtons = container.querySelector('#control-buttons')!;
  const dispatchPanel = container.querySelector('#dispatch-panel')!;
  const embeddedApprovals = container.querySelector('#embedded-approvals')!;
  const detailAiUsage = container.querySelector('#detail-ai-usage')!;
  const refreshBtn = container.querySelector('#btn-refresh')!;

  const metaHarness = container.querySelector('#meta-harness')!;
  const metaProfile = container.querySelector('#meta-profile')!;
  const metaCreated = container.querySelector('#meta-created')!;
  const metaUpdated = container.querySelector('#meta-updated')!;

  const filesReadDiv = container.querySelector('#files-read')!;
  const filesChangedDiv = container.querySelector('#files-changed')!;
  const usedSkillsDiv = container.querySelector('#used-skills')!;
  const usedConnectorsDiv = container.querySelector('#used-connectors')!;

  async function loadTask(showSpinner = true) {
    if (showSpinner) {
      statusContainer.innerHTML = '';
      alertPanel.innerHTML = '';
      stepperContainer.innerHTML = '';
      controlButtons.innerHTML = '';
      dispatchPanel.innerHTML = '';
      embeddedApprovals.innerHTML = '';

      statusContainer.appendChild(createLoadingSpinner());
      stepperContainer.appendChild(createLoadingSpinner());
    }

    try {
      const { task, approvals } = await api.getTask(id);

      titleHeader.textContent = `タスク詳細: ${task.title}`;

      statusContainer.innerHTML = '';
      statusContainer.appendChild(createStatusBadge(task.status));

      // Stepper
      stepperContainer.innerHTML = '';
      stepperContainer.appendChild(createTaskStepper(task));

      // Instruction
      const metaInstruction = container.querySelector('#meta-instruction')!;
      metaInstruction.textContent = task.instruction || '（指示文なし）';

      // Basic info
      metaHarness.textContent = task.harness;
      metaProfile.textContent = task.profile;
      metaCreated.textContent = new Date(task.createdAt).toLocaleString('ja-JP');
      metaUpdated.textContent = new Date(task.updatedAt).toLocaleString('ja-JP');

      // Resource usage
      filesReadDiv.textContent =
        task.filesRead && task.filesRead.length > 0 ? task.filesRead.join(', ') : 'なし';

      const changed = [...(task.filesCreated || []), ...(task.filesChanged || [])];
      filesChangedDiv.textContent =
        changed.length > 0 ? Array.from(new Set(changed)).join(', ') : 'なし';

      usedSkillsDiv.textContent =
        task.usedSkills && task.usedSkills.length > 0 ? task.usedSkills.join(', ') : 'なし';
      usedConnectorsDiv.textContent =
        task.usedConnectors && task.usedConnectors.length > 0
          ? task.usedConnectors.join(', ')
          : 'なし';

      // Warnings or alerts
      if (task.status === 'stopped') {
        alertPanel.innerHTML = `
          <div class="alert-banner alert-banner-warning" style="align-items: flex-start;">
            <div>
              <h4 style="margin:0 0 0.5rem; color: var(--status-pending);">タスクは一時停止されました</h4>
              <p style="margin:0; font-size:0.9rem; color: var(--text-secondary);">理由: ${escapeHtml(task.stopReason || 'ユーザーによる指示')}</p>
            </div>
          </div>
        `;
      } else if (task.status === 'take_control') {
        alertPanel.innerHTML = `
          <div class="alert-banner alert-banner-error" style="align-items: flex-start;">
            <div>
              <h4 style="margin:0 0 0.5rem; color: var(--status-error);">システム介入要求 (Take Control)</h4>
              <p style="margin:0 0 0.5rem; font-size:0.9rem; color: var(--text-secondary);">理由: ${escapeHtml(task.takeControlReason || '秘密データの入力要求など')}</p>
              <p style="margin:0; font-size:0.8rem; color: var(--status-error);">安全のため自動的に処理を中断しました。再開ボタンを押す前に状態を確認してください。</p>
            </div>
          </div>
        `;
      } else if (task.status === 'failed') {
        const errorMsg =
          task.errors && task.errors.length > 0 ? task.errors.join('\n') : '未知のエラー';
        alertPanel.innerHTML = `
          <div class="alert-banner alert-banner-error" style="align-items: flex-start;">
            <div style="min-width: 0; flex: 1;">
              <h4 style="margin:0 0 0.5rem; color: var(--status-error);">タスクが異常終了（失敗）しました</h4>
              <p style="margin:0; font-size:0.9rem; font-family: monospace; color: var(--text-primary); white-space: pre-wrap; overflow-wrap: anywhere;">${escapeHtml(errorMsg)}</p>
            </div>
          </div>
        `;
      } else if (task.status === 'waiting_for_approval') {
        alertPanel.innerHTML = `
          <div class="alert-banner alert-banner-warning">
            <h4 style="margin:0; color: var(--status-pending); font-size: 0.95rem;">安全確認のため、承認を待機しています</h4>
          </div>
        `;
      }

      // Control Buttons
      const isStoppable = ['planning', 'running', 'waiting_for_approval'].includes(task.status);
      const isResumable = ['stopped', 'take_control'].includes(task.status);

      if (isStoppable) {
        controlButtons.innerHTML = `
          <button class="btn btn-danger-outline" id="btn-stop" style="font-weight: 700; width: 100%; display: flex; align-items: center; justify-content: center; gap: 0.25rem;">
            タスクを一時停止する
          </button>
        `;

        container.querySelector('#btn-stop')?.addEventListener('click', async () => {
          const reason = prompt('停止理由を入力してください（オプション）:');
          if (reason === null) return; // cancel
          try {
            await api.stopTask(task.id, reason || undefined);
            loadTask();
          } catch (e) {
            alert(`停止処理エラー: ${e instanceof Error ? e.message : String(e)}`);
          }
        });
      } else if (isResumable) {
        controlButtons.innerHTML = `
          <button class="btn btn-primary" id="btn-resume" style="font-weight: bold; width: 100%; display: flex; align-items: center; justify-content: center; gap: 0.25rem;">
            タスクを再開する
          </button>
        `;

        container.querySelector('#btn-resume')?.addEventListener('click', async () => {
          try {
            await api.resumeTask(task.id);
            loadTask();
          } catch (e) {
            alert(`再開処理エラー: ${e instanceof Error ? e.message : String(e)}`);
          }
        });
      } else {
        controlButtons.innerHTML = `
          <div style="color: var(--text-secondary); text-align: center; width: 100%; font-size: 0.9rem;">
            このステータス（${escapeHtml(task.status)}）では操作コントロールはありません。
          </div>
        `;
      }

      // Dynamic timeline generation
      const timelineHtml = `
        <div class="timeline">
          <!-- Step 1: Saved -->
          <div class="timeline-item">
            <span class="timeline-badge timeline-badge-complete"></span>
            <div class="timeline-content">
              <div style="display: flex; justify-content: space-between; font-weight: bold; font-size: 0.9rem;">
                <span>保存完了</span>
                <span style="font-size: 0.8rem; font-weight: normal; color: var(--text-secondary);">${formatTime(task.createdAt)}</span>
              </div>
              <div style="font-size: 0.85rem; color: var(--text-secondary); margin-top: 0.2rem;">タスクが保存されました。</div>
            </div>
          </div>
          <!-- Step 2: Handed to CLI -->
          <div class="timeline-item">
            <span class="timeline-badge ${task.dispatchStartedAt ? 'timeline-badge-complete' : 'timeline-badge-todo'}"></span>
            <div class="timeline-content">
              <div style="display: flex; justify-content: space-between; font-weight: bold; font-size: 0.9rem;">
                <span>CLIに引き渡し</span>
                <span style="font-size: 0.8rem; font-weight: normal; color: var(--text-secondary);">${task.dispatchStartedAt ? formatTime(task.dispatchStartedAt) : '-'}</span>
              </div>
              <div style="font-size: 0.85rem; color: var(--text-secondary); margin-top: 0.2rem;">
                ${task.dispatchStartedAt ? `${escapeHtml(task.agent === 'antigravity' ? 'Antigravity' : task.agent === 'codex' ? 'Codex' : task.agent)} CLIにタスクを引き渡しました。` : '委託開始を待機中。'}
              </div>
            </div>
          </div>
          <!-- Step 3: CLI Response -->
          <div class="timeline-item" style="border-left-color: transparent; padding-bottom: 0;">
            <span class="timeline-badge ${getTimelineBadgeClass(task.dispatchStatus)}"></span>
            <div class="timeline-content">
              <div style="display: flex; justify-content: space-between; font-weight: bold; font-size: 0.9rem;">
                <span>${getTimelineStatusTitle(task.dispatchStatus)}</span>
                <span style="font-size: 0.8rem; font-weight: normal; color: var(--text-secondary);">${task.dispatchFinishedAt ? formatTime(task.dispatchFinishedAt) : '-'}</span>
              </div>
              <div style="font-size: 0.85rem; color: var(--text-secondary); margin-top: 0.2rem; display: flex; justify-content: space-between; flex-wrap: wrap; gap: 0.5rem;">
                <span>${getTimelineStatusDesc(task.dispatchStatus)}</span>
                ${task.dispatchStartedAt ? `<span style="font-family: monospace;">経過時間: ${formatElapsedTime(task)}</span>` : ''}
              </div>
            </div>
          </div>
        </div>
      `;

      // Dispatch Panel rendering
      dispatchPanel.innerHTML = `
        <div class="card" style="border: 1px solid var(--border); padding: 1.5rem;">
          <h3 style="margin-top: 0; margin-bottom: 1rem; color: var(--text-primary); font-size: 1.1rem; font-weight: 600;">エージェント実行状況 (Agent Dispatch)</h3>
          
          <!-- Hidden span for auto refresh checker -->
          <span id="dispatch-status-val" style="display: none;">${escapeHtml(task.dispatchStatus)}</span>

          <!-- Dropdowns-like side-by-side read-only inputs -->
          <div style="display: flex; gap: 1rem; margin-bottom: 1.5rem;">
            <div style="flex: 1;">
              <label style="display: block; font-size: 0.8rem; color: var(--text-secondary); margin-bottom: 0.25rem; font-weight: bold;">プロバイダ</label>
              <div class="input" style="background: var(--bg-elevated); padding: 0.5rem 0.75rem; font-size: 0.9rem; pointer-events: none;">
                ${escapeHtml(task.agent === 'antigravity' ? 'Antigravity' : task.agent === 'codex' ? 'Codex' : task.agent)}
              </div>
            </div>
            <div style="flex: 1;">
              <label style="display: block; font-size: 0.8rem; color: var(--text-secondary); margin-bottom: 0.25rem; font-weight: bold;">モデル</label>
              <div class="input" style="background: var(--bg-elevated); padding: 0.5rem 0.75rem; font-size: 0.9rem; pointer-events: none;">
                ${escapeHtml(task.model)}
              </div>
            </div>
          </div>

          <div style="margin-bottom: 1.5rem;">
            <h4 style="margin: 0 0 1rem; font-size: 0.95rem; color: var(--text-primary); font-weight: bold;">実行ステータス</h4>
            ${timelineHtml}
          </div>

          ${
            task.dispatchStatus === 'needs_user'
              ? `
            <div style="background: color-mix(in srgb, var(--status-pending) 10%, transparent); border: 1px solid var(--status-pending); color: var(--text-primary); padding: 0.75rem 1rem; border-radius: 6px; margin-bottom: 1rem; font-size: 0.85rem; line-height: 1.5;">
              <strong>外部エージェントの要確認ステータス:</strong><br>
              このステータスは、外部CLIからの応答内に確認や入力を求める要求が含まれていたことを示しています。現在の引き渡し（ハンドオフ）処理は完了しており、本アプリケーションは外部プロバイダーとの対話の継続をサポートしていないため、外部プロセスが待機しているわけではありません。また、これはアプリケーション層での承認要求ではありません。ユーザーは、以下の要約を確認した上で、必要な指示を明確にした新しいタスクを作成して再実行してください。
            </div>
            `
              : ''
          }

          ${
            task.dispatchSummary
              ? `
            <div style="margin-bottom: 1.5rem;">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
                <h4 style="margin: 0; font-size: 0.95rem; color: var(--text-primary); font-weight: bold;">CLIの応答（抜粋）</h4>
                <button id="btn-copy-response" class="btn btn-secondary btn-sm" style="font-size: 0.75rem; padding: 0.25rem 0.5rem;">全体を表示 / コピー</button>
              </div>
              <div style="font-size: 0.85rem; color: var(--text-primary); background: var(--bg-elevated); border: 1px solid var(--border); padding: 0.75rem; border-radius: var(--radius-md); line-height: 1.5; white-space: pre-wrap; font-family: monospace; overflow-wrap: anywhere; word-break: break-all;">${escapeHtml(task.dispatchSummary)}</div>
            </div>
          `
              : ''
          }

          <div style="display: flex; gap: 0.75rem; flex-wrap: wrap; margin-bottom: 0.75rem;" id="dispatch-controls-container"></div>

          <div style="font-size: 0.75rem; color: var(--text-secondary); line-height: 1.4; border-top: 1px solid var(--border); padding-top: 0.75rem; margin-top: 0.75rem;">
            確認境界に関する注意:<br>
            エージェントの出力要約は自己申告によるものです。外部システムへの実際の副作用が正しく完了したかどうかは、登録されたコネクタの検証結果、または監査ログでのみ保証されます。
          </div>
        </div>
      `;

      // Copy response text listener
      const copyBtn = container.querySelector('#btn-copy-response');
      if (copyBtn) {
        copyBtn.addEventListener('click', () => {
          navigator.clipboard.writeText(task.dispatchSummary || '');
          alert('クリップボードに要約をコピーしました。');
        });
      }

      const dispatchControlsContainer = container.querySelector('#dispatch-controls-container')!;
      const isDispatching = ['queued', 'running'].includes(task.dispatchStatus);

      if (isDispatching) {
        dispatchControlsContainer.innerHTML = `
          <button id="btn-cancel-dispatch" class="btn btn-danger-outline" style="font-weight: 700; width: 100%;">
            実行キャンセル
          </button>
        `;
        container.querySelector('#btn-cancel-dispatch')?.addEventListener('click', async () => {
          const btn = container.querySelector('#btn-cancel-dispatch') as HTMLButtonElement;
          btn.disabled = true;
          try {
            await api.cancelTaskDispatch(task.id);
            loadTask();
          } catch (e: any) {
            alert(`キャンセルエラー: ${e.message || String(e)}`);
            btn.disabled = false;
          }
        });

        startAutoRefresh();
      } else {
        const retryMode = task.dispatchStatus === 'not_started' ? task.dispatchMode : 'plan';
        dispatchControlsContainer.innerHTML = `
          <select id="select-dispatch-mode" class="input" style="flex: 1; min-width: 120px; font-size: 0.85rem; padding: 0.4rem 0.8rem;">
            <option value="plan" ${retryMode === 'plan' ? 'selected' : ''}>シミュレーション (Plan)</option>
            <option value="workspace" ${retryMode === 'workspace' ? 'selected' : ''}>編集許可 (Workspace)</option>
          </select>
          <button id="btn-start-dispatch" class="btn btn-primary" style="flex: 1.5; font-weight: bold; font-size: 0.85rem; padding: 0.4rem 0.8rem;">
            ${task.dispatchStatus === 'not_started' ? '実行開始' : '安全に再実行'}
          </button>
        `;
        container.querySelector('#btn-start-dispatch')?.addEventListener('click', async () => {
          const btn = container.querySelector('#btn-start-dispatch') as HTMLButtonElement;
          const selectMode = container.querySelector('#select-dispatch-mode') as HTMLSelectElement;
          btn.disabled = true;
          try {
            const mode = selectMode.value as 'plan' | 'workspace';
            await api.dispatchTask(task.id, mode);
            loadTask();
          } catch (e: any) {
            alert(`実行エラー: ${e.message || String(e)}`);
            btn.disabled = false;
          }
        });
      }

      // Embedded approvals
      const pendingApprovals = approvals.filter((a) => a.status === 'pending');
      if (pendingApprovals.length > 0) {
        const header = document.createElement('h3');
        header.textContent = 'このタスクで必要な承認要求';
        header.style.color = 'var(--status-pending)';
        header.style.fontSize = '1.1rem';
        header.style.margin = '0 0 1rem';
        embeddedApprovals.appendChild(header);

        pendingApprovals.forEach((a) => {
          embeddedApprovals.appendChild(createApprovalCard(a, loadTask));
        });
      }

      // Load AI usage quota data
      try {
        const providersData = await api.getAgentProviders();
        const provider = providersData.providers.find((p) => p.id === task.agent);
        if (provider) {
          const quotaText =
            provider.quotaAvailability === 'unavailable'
              ? 'CLIから取得できません'
              : provider.quotaAvailability;
          detailAiUsage.innerHTML = `
            <div style="margin-bottom: 0.5rem;">
              接続ステータス: <span style="color: ${provider.available ? 'var(--status-complete)' : 'var(--status-error)'}; font-weight: bold;">
                ${provider.available ? '利用可能' : '利用不可'}
              </span>
            </div>
            <div style="margin-bottom: 0.5rem;">
              選択モデル: <strong>${escapeHtml(task.model)}</strong> (デフォルト: ${escapeHtml(provider.defaultModel)})
            </div>
            <div style="border-top: 1px dashed var(--border); padding-top: 0.5rem; margin-top: 0.5rem;">
              利用量制限: <strong>${escapeHtml(quotaText)}</strong>
            </div>
          `;
        } else {
          detailAiUsage.textContent = 'プロバイダー情報が取得できません。';
        }
      } catch (err) {
        detailAiUsage.textContent = 'AI使用状況の読み込みに失敗しました。';
      }
    } catch (e) {
      statusContainer.innerHTML = '';
      stepperContainer.innerHTML = `
        <div style="color: var(--status-error); padding: 2rem; text-align: center; background: var(--bg-card); border-radius: var(--radius-md); border: 1px solid var(--border);">
          タスク詳細の読み込みに失敗しました。
        </div>
      `;
    }
  }

  let refreshInterval: ReturnType<typeof setInterval> | null = null;

  function startAutoRefresh() {
    if (refreshInterval) return;
    refreshInterval = setInterval(async () => {
      if (!container.isConnected) {
        if (refreshInterval) {
          clearInterval(refreshInterval);
          refreshInterval = null;
        }
        return;
      }
      const statusVal = container.querySelector('#dispatch-status-val')?.textContent;
      if (statusVal === 'queued' || statusVal === 'running') {
        try {
          await loadTask(false);
        } catch {
          // ignore failures on auto-refresh
        }
      } else {
        if (refreshInterval) {
          clearInterval(refreshInterval);
          refreshInterval = null;
        }
      }
    }, 3000);
  }

  refreshBtn.addEventListener('click', () => loadTask(true));

  // Initial load
  loadTask(true);

  return container;
}
