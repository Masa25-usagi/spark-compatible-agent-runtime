import { createTaskCard } from '../components/task-card';
import { createModal } from '../components/modal';
import { createLoadingSpinner } from '../components/loading-spinner';
import { api } from '../api-client';
import { escapeHtml } from '../render-utils';

export async function renderTasks(): Promise<HTMLElement> {
  const container = document.createElement('div');
  container.className = 'animate-fade-in';

  container.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem;">
      <h1 style="margin: 0; color: var(--text-primary); font-size: 1.5rem;">タスク一覧</h1>
      <button class="btn btn-primary" id="btn-new-task" style="font-weight: bold; padding: 0.6rem 1.2rem;">
        新規タスク作成
      </button>
    </div>
    <p style="margin: -1rem 0 1.5rem; color: var(--text-secondary); font-size: 0.9rem; line-height: 1.5;">
      計画されたタスク（<strong>保存済み</strong>）と、外部エージェントに処理委託中の状況（<strong>受け渡し中</strong>）を管理します。実行結果にはエージェント自己申告の要約（<strong>未検証の応答</strong>）が表示されます。本物の変更結果（<strong>コネクタ検証済み</strong>）は改ざん防止監査ログに記録されます。
    </p>
    <div id="tasks-container"></div>
  `;

  const tasksContainer = container.querySelector('#tasks-container')!;

  async function loadTasks() {
    tasksContainer.innerHTML = '';
    tasksContainer.appendChild(createLoadingSpinner());

    try {
      const tasks = await api.getTasks();
      tasksContainer.innerHTML = '';

      if (tasks.length === 0) {
        tasksContainer.innerHTML = `
          <div class="card" style="padding: 2.5rem; text-align: center; color: var(--text-secondary);">
            <p style="font-size: 1.1rem; margin-bottom: 1rem;">作成されたタスクはまだありません。</p>
            <p style="font-size: 0.9rem; margin-bottom: 1.5rem;">「新規タスク作成」ボタンから、エージェントへの指示を作成しましょう。</p>
          </div>
        `;
      } else {
        const tableContainer = document.createElement('div');
        tableContainer.style.border = '1px solid var(--border)';
        tableContainer.style.borderRadius = 'var(--radius-md)';
        tableContainer.style.overflow = 'hidden';
        tableContainer.style.display = 'flex';
        tableContainer.style.flexDirection = 'column';

        tableContainer.innerHTML = `
          <div style="display: flex; align-items: center; padding: 0.75rem 1rem; border-bottom: 1px solid var(--border); font-size: 0.85rem; color: var(--text-secondary); font-weight: bold; background: var(--bg-elevated); user-select: none;">
            <div style="flex: 2;">タスク名</div>
            <div style="flex: 1; padding: 0 0.5rem;">プロバイダ / モデル</div>
            <div style="width: 100px; text-align: right;">経過時間</div>
          </div>
          <div id="tasks-rows-list" style="display: flex; flex-direction: column;"></div>
          <div style="padding: 0.75rem 1rem; font-size: 0.85rem; color: var(--text-secondary); display: flex; justify-content: space-between; align-items: center; background: var(--bg-card); border-top: 1px solid var(--border);">
            <span>全 ${tasks.length} 件中 1-${tasks.length} 件を表示</span>
            <button id="btn-refresh-list" class="btn btn-secondary btn-sm" style="font-size: 0.8rem; padding: 0.25rem 0.5rem;">更新</button>
          </div>
        `;

        const rowsList = tableContainer.querySelector('#tasks-rows-list')!;
        const sorted = [...tasks].sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        );
        sorted.forEach((t) => rowsList.appendChild(createTaskCard(t)));

        tableContainer.querySelector('#btn-refresh-list')?.addEventListener('click', (e) => {
          e.preventDefault();
          loadTasks();
        });

        tasksContainer.appendChild(tableContainer);
      }
    } catch (e) {
      tasksContainer.innerHTML = `
        <div style="color: var(--status-error); padding: 2rem; text-align: center; background: var(--bg-card); border-radius: var(--radius-md); border: 1px solid var(--border);">
          タスク一覧の読み込みに失敗しました。
        </div>
      `;
    }
  }

  loadTasks();

  function openNewTaskModal() {
    const form = document.createElement('div');
    form.style.width = '450px';
    form.style.maxWidth = '100%';
    form.innerHTML = `
      <h2 style="margin-top:0; margin-bottom: 1.25rem; color: var(--text-primary); font-size: 1.25rem; border-bottom: 1px solid var(--border); padding-bottom: 0.5rem;">新規タスクの作成</h2>
      
      <div style="margin-bottom: 1rem;">
        <label style="display: block; font-size: 0.9rem; margin-bottom: 0.5rem; color: var(--text-secondary); font-weight: bold;">やりたいこと・指示文 (必須)</label>
        <textarea id="task-instruction" class="input" placeholder="例: 週報フォルダのマークダウンファイルをまとめて、週報メールを送って" rows="4" style="width: 100%; box-sizing: border-box;" required></textarea>
      </div>

      <div style="margin-bottom: 1rem; display: flex; gap: 1rem; flex-wrap: wrap;">
        <div style="flex: 1; min-width: 200px;">
          <label style="display: block; font-size: 0.9rem; margin-bottom: 0.5rem; color: var(--text-secondary); font-weight: bold;">プロバイダー (Provider)</label>
          <select id="task-provider" class="input" style="width: 100%; box-sizing: border-box;"></select>
        </div>
        <div style="flex: 1; min-width: 200px;">
          <label style="display: block; font-size: 0.9rem; margin-bottom: 0.5rem; color: var(--text-secondary); font-weight: bold;">モデル (Model)</label>
          <select id="task-model" class="input" style="width: 100%; box-sizing: border-box;"></select>
        </div>
      </div>

      <div id="custom-model-container" style="margin-bottom: 1rem; display: none;">
        <label style="display: block; font-size: 0.9rem; margin-bottom: 0.5rem; color: var(--text-secondary); font-weight: bold;">カスタムモデル名 / ID</label>
        <input type="text" id="task-custom-model" class="input" placeholder="例: custom-model-id" style="width: 100%; box-sizing: border-box;">
      </div>
      
      <div style="margin-bottom: 1.25rem; display: flex; flex-direction: column; gap: 0.5rem;">
        <button id="btn-suggest-steps" class="btn btn-secondary" style="font-weight: bold; padding: 0.5rem 1rem; align-self: flex-start; display: flex; align-items: center; gap: 0.5rem; font-size: 0.85rem;">
          LLMに手順候補を作ってもらう
        </button>
        <div id="suggest-status" style="font-size: 0.85rem; display: none; line-height: 1.4; border-radius: var(--radius-sm); padding: 0.5rem; background: var(--bg-hover); border: 1px solid var(--border);"></div>
      </div>

      <details style="margin-bottom: 1.5rem; border: 1px solid var(--border); border-radius: var(--radius-md); padding: 0.75rem;">
        <summary style="font-size: 0.9rem; font-weight: bold; cursor: pointer; color: var(--text-secondary); user-select: none;">
          詳細設定 (オプション: タイトル、実行ステップ、起動モード)
        </summary>
        <div style="margin-top: 0.75rem; display: flex; flex-direction: column; gap: 1rem;">
          <div>
            <label style="display: block; font-size: 0.85rem; margin-bottom: 0.25rem; color: var(--text-secondary);">タスクのタイトル (省略時は指示文から自動生成)</label>
            <input type="text" id="task-title" class="input" placeholder="例: 週報をまとめてメールで送信" style="width: 100%; box-sizing: border-box;">
          </div>
          <div>
            <label style="display: block; font-size: 0.85rem; margin-bottom: 0.25rem; color: var(--text-secondary);">実行ステップ (1行に1ステップ。LLM候補がここに反映されます)</label>
            <textarea id="task-steps" class="input" placeholder="（ステップを指定したい場合のみ記述）" rows="5" style="width: 100%; box-sizing: border-box;"></textarea>
          </div>
          <div style="border-top: 1px solid var(--border); margin-top: 0.5rem; padding-top: 0.5rem;">
            <label style="display: block; font-size: 0.85rem; margin-bottom: 0.25rem; color: var(--text-secondary); font-weight: bold;">「作成して開始」の起動モード</label>
            <label style="display: block; font-size: 0.8rem; cursor: pointer; margin-bottom: 0.25rem; color: var(--text-primary);">
              <input type="radio" name="task-launch-mode" value="plan" checked> <strong>シミュレーションモード (Plan)</strong><br>
              <span style="color: var(--text-secondary); margin-left: 1.2rem; display: inline-block;">プロバイダー側での読み取り専用（Plan）実行を行います。外部エージェント自身の実装に基づいたシミュレーションであり、暗号的な副作用防止保証はありません。(推奨)</span>
            </label>
            <label style="display: block; font-size: 0.8rem; cursor: pointer; color: var(--text-primary);">
              <input type="radio" name="task-launch-mode" value="workspace"> <strong>編集許可モード (Workspace)</strong><br>
              <span style="color: var(--text-secondary); margin-left: 1.2rem; display: inline-block;">選択した外部CLI自身とその権限・設定に従ってローカルファイルを変更します。本アプリの承認ブローカーによる個々のアクションインターセプトや保護は適用されません。</span>
            </label>
          </div>
        </div>
      </details>

      <div style="display: flex; gap: 1rem; margin-top: 1.5rem;">
        <button id="btn-submit-task" class="btn btn-secondary" style="flex: 1; font-weight: bold; padding: 0.75rem;">作成する</button>
        <button id="btn-submit-and-start-task" class="btn btn-primary" style="flex: 2; font-weight: bold; padding: 0.75rem;">作成して開始</button>
      </div>
    `;

    const overlay = createModal(form);
    document.body.appendChild(overlay);

    const suggestBtn = form.querySelector('#btn-suggest-steps') as HTMLButtonElement;
    const suggestStatus = form.querySelector('#suggest-status') as HTMLDivElement;
    const instructionInput = form.querySelector('#task-instruction') as HTMLTextAreaElement;
    const titleInput = form.querySelector('#task-title') as HTMLInputElement;
    const stepsInput = form.querySelector('#task-steps') as HTMLTextAreaElement;
    const detailsElem = form.querySelector('details') as HTMLDetailsElement;

    const providerSelect = form.querySelector('#task-provider') as HTMLSelectElement;
    const modelSelect = form.querySelector('#task-model') as HTMLSelectElement;
    const customModelContainer = form.querySelector('#custom-model-container') as HTMLDivElement;
    const customModelInput = form.querySelector('#task-custom-model') as HTMLInputElement;

    let providersList: any[] = [
      {
        id: 'antigravity',
        name: 'Antigravity CLI',
        models: ['gemini-3.5-flash-high'],
        defaultModel: 'gemini-3.5-flash-high',
        customModelSupport: false,
        available: true,
      },
      {
        id: 'codex',
        name: 'Codex CLI',
        models: ['default'],
        defaultModel: 'default',
        customModelSupport: true,
        available: true,
      },
    ];

    function populateProviders() {
      providerSelect.innerHTML = '';
      providersList.forEach((p) => {
        const opt = document.createElement('option');
        opt.value = p.id;
        let displayName = p.name;
        if (!p.available) {
          displayName += ' (利用不可 / Unavailable)';
          opt.disabled = true;
        }
        opt.textContent = displayName;
        providerSelect.appendChild(opt);
      });
      // Set value to first available if possible
      const selected = providersList.find((p) => p.id === providerSelect.value);
      if (selected && !selected.available) {
        const firstAvail = providersList.find((p) => p.available);
        if (firstAvail) {
          providerSelect.value = firstAvail.id;
        }
      }
    }

    try {
      api
        .getAgentProviders()
        .then((res) => {
          providersList = res.providers;
          populateProviders();
          updateModels();
        })
        .catch((e) => {
          console.warn('Failed to load agent providers:', e);
        });
    } catch (e) {
      console.warn('Failed to load agent providers:', e);
    }

    populateProviders();

    function updateModels() {
      const providerId = providerSelect.value;
      const provider = providersList.find((p) => p.id === providerId);
      modelSelect.innerHTML = '';
      if (provider) {
        provider.models.forEach((m: string) => {
          const opt = document.createElement('option');
          opt.value = m;
          opt.textContent =
            provider.id === 'codex' && m === 'default' ? 'Codexの既定モデル（CLI設定を使う）' : m;
          if (m === provider.defaultModel) {
            opt.selected = true;
          }
          modelSelect.appendChild(opt);
        });
        if (provider.customModelSupport) {
          const opt = document.createElement('option');
          opt.value = 'custom';
          opt.textContent = 'カスタムモデルを指定...';
          modelSelect.appendChild(opt);
        }
      }
      updateCustomModelVisibility();
    }

    function updateCustomModelVisibility() {
      if (modelSelect.value === 'custom') {
        customModelContainer.style.display = 'block';
      } else {
        customModelContainer.style.display = 'none';
      }
    }

    providerSelect.addEventListener('change', updateModels);
    modelSelect.addEventListener('change', updateCustomModelVisibility);
    updateModels();

    suggestBtn.addEventListener('click', async () => {
      const instruction = instructionInput.value.trim();
      if (!instruction) {
        alert('先に指示文を入力してください。');
        return;
      }

      suggestStatus.style.display = 'block';
      suggestStatus.style.color = 'var(--text-secondary)';
      suggestStatus.textContent = 'LLMで手順候補を生成中...';
      suggestBtn.disabled = true;

      try {
        const provider = providerSelect.value as 'antigravity' | 'codex';
        const selectedModel =
          modelSelect.value === 'custom' ? customModelInput.value.trim() : modelSelect.value;
        const result = await api.suggestSteps(instruction, {
          provider,
          model: selectedModel || undefined,
        });
        titleInput.value = result.title;
        stepsInput.value = result.steps.join('\n');

        suggestStatus.style.color = 'var(--status-complete)';
        suggestStatus.innerHTML = `手順候補を生成し、詳細設定に反映しました。<br><span style="font-size:0.75rem; color:var(--text-secondary);">LLM: ${escapeHtml(result.provider)} / ${escapeHtml(result.model)}</span>`;
        detailsElem.open = true;
      } catch (err: any) {
        suggestStatus.style.color = 'var(--status-error)';
        const message = err.message || String(err);
        suggestStatus.textContent = `手順の生成に失敗しました: ${message}`;
      } finally {
        suggestBtn.disabled = false;
      }
    });

    async function submitTask(startImmediately: boolean) {
      const instruction = instructionInput.value.trim();
      const title = titleInput.value.trim();
      const stepsText = stepsInput.value.trim();

      if (!instruction) {
        alert('指示文を入力してください。');
        return;
      }

      const plannedSteps = stepsText
        ? stepsText
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.length > 0)
        : undefined;

      const provider = providerSelect.value;
      let model = modelSelect.value;
      if (model === 'custom') {
        model = customModelInput.value.trim() || 'default';
      }

      try {
        const createdTask = await api.createTask({
          instruction,
          title: title || undefined,
          plannedSteps,
          agent: provider,
          model: model,
        });

        if (startImmediately) {
          const launchModeInput = form.querySelector(
            'input[name="task-launch-mode"]:checked',
          ) as HTMLInputElement;
          const launchMode = (launchModeInput?.value as 'plan' | 'workspace') || 'plan';
          await api.dispatchTask(createdTask.id, launchMode);
        }

        if (overlay.parentNode) {
          overlay.parentNode.removeChild(overlay);
        }
        loadTasks();
      } catch (err: any) {
        alert(`タスク作成エラー: ${err.message || String(err)}`);
      }
    }

    form.querySelector('#btn-submit-task')?.addEventListener('click', () => submitTask(false));
    form
      .querySelector('#btn-submit-and-start-task')
      ?.addEventListener('click', () => submitTask(true));
  }

  container.querySelector('#btn-new-task')!.addEventListener('click', openNewTaskModal);

  // Check if hash contains new=true parameter to open modal automatically
  if (window.location.hash.includes('new=true')) {
    // Replace hash state to remove ?new=true to avoid reopening on reload
    history.replaceState(null, '', '#/tasks');
    setTimeout(() => {
      openNewTaskModal();
    }, 100);
  }

  return container;
}
