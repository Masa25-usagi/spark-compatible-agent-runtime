export function renderHelp(): HTMLElement {
  const container = document.createElement('div');
  container.className = 'animate-fade-in';
  container.style.maxWidth = '800px';
  container.style.margin = '0 auto';
  container.style.padding = '2rem 1rem';

  container.innerHTML = `
    <h1 style="margin-bottom: 1.5rem; color: var(--primary); font-size: 1.5rem; font-weight: 600;">
      使い方ガイド・安全性の説明
    </h1>

    <div class="card" style="margin-bottom: 2rem; border-left: 4px solid var(--primary); padding: 1.5rem;">
      <h2 style="margin-bottom: 1rem; color: var(--text-primary); font-size: 1.2rem; font-weight: 600;">基本の流れ</h2>
      <ol style="margin-left: 1.5rem; line-height: 2; font-size: 1rem; color: var(--text-primary);">
        <li>
          <strong>起動と待機:</strong> <code>START.command</code> を実行し、タスクの完了までそのターミナルウィンドウを開いたままにしてください。
        </li>
        <li>
          <strong>タスクを作成:</strong> 「タスク」メニューから「新規タスク作成」を押し、やりたいことを自然な文章で入力します。実行ステップ（手順）の入力は空欄のままでも作成可能です。「作成する」は保存のみ、「作成して開始」は選択したCLIへ指示を渡します。
        </li>
        <li>
          <strong>エージェントとモデルの選択:</strong> Antigravity (Google/Gemini-first) または Codex と、使用するモデルを選択します。モデル一覧は各CLIから読み取り、Codexの「既定モデル」はCLI設定を使います。認証はログイン済みの各CLIで行われ、カスタムのGoogle OAuth認証などは行いません。
        </li>
        <li>
          <strong>タスク状況の確認:</strong> タスク詳細画面で「保存済みタスク」「外部CLIへの受け渡し中」「未検証のエージェント応答」「コネクタ検証済み結果」の遷移を確認できます。
        </li>
      </ol>
    </div>

    <div class="card" style="margin-bottom: 2rem; border-left: 4px solid var(--status-complete); padding: 1.5rem;">
      <h3 style="margin-bottom: 1rem; color: var(--status-complete); font-size: 1.1rem; font-weight: 600;">
        セキュリティと安全性の仕組み
      </h3>
      <p style="margin-bottom: 1rem; font-size: 0.95rem; color: var(--text-primary); line-height: 1.8;">
        本システムには、未承認または危険な操作を自動でブロック・制限する「セーフティポリシー」が組み込まれています。
      </p>
      <ul style="margin-left: 1.5rem; line-height: 1.8; font-size: 0.95rem; color: var(--text-secondary);">
        <li><strong>ローカル安全設計:</strong> 操作画面と承認処理はあなたのパソコン内で動作します。手順候補の生成、または「作成して開始」「実行開始」を使うと、指示文が設定済みのLLM CLIへ送られます。秘密情報を含む指示文は送信前に遮断されます。</li>
        <li><strong>ポリシーと権限の境界:</strong> このアプリのセーフティポリシーは本アプリ自身が提供する統合コネクタのみを制御します。外部エージェントCLI（<code>agy</code>/<code>codex</code>）によるファイルやメール等の実行権限は、呼び出し先の外部CLIの設定および権限に従います。外部CLIプロセス自体の内部アクションを直接横取りして一時停止することはできません。</li>
        <li><strong>停止時の動作:</strong> ランチャー（APIサーバー）が正常に停止されると、現在実行中の外部エージェント（受け渡し中）は自動的にキャンセルされます。不意の電源切断や強制終了などの異常時には、CLIプロセスの追跡や復帰は行えません。</li>
      </ul>
    </div>

    <div class="card" style="margin-bottom: 2rem; border-left: 4px solid var(--primary); padding: 1.5rem;">
      <h3 style="margin-bottom: 1rem; color: var(--primary); font-size: 1.1rem; font-weight: 600;">
        開発背景と今後のロードマップ
      </h3>
      <p style="margin-bottom: 1rem; font-size: 0.95rem; color: var(--text-primary); line-height: 1.8;">
        <strong>Google優先開発の動機 (Google-service-first Motivation):</strong><br>
        本ランタイムは、Googleのセキュリティ基準とAI統合の整合性を最優先とするため、デフォルトのタスク実行エンジンとしてAntigravity（Gemini AI）を第一に選択するように設計されています。開発の初期段階ではGoogleの強力なLLMエコシステムおよび安全性フレームワークとの統合に焦点を当てていますが、将来的にはより広範な外部ツールおよびサービス向けの汎用コネクタ群の拡充をロードマップとして予定しています。
      </p>
    </div>

    <div style="text-align: center; margin-top: 2rem;">
      <a href="#/" class="btn btn-primary" style="display: inline-block; padding: 0.75rem 2rem; border-radius: var(--radius-md); font-weight: bold; background: var(--primary); color: #fff; text-decoration: none;">
        ホーム画面へ戻る
      </a>
    </div>
  `;

  return container;
}
