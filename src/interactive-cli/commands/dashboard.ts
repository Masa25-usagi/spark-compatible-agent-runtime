import { enableRawMode, disableRawMode, onKeyPress } from '../input/keybindings.js';
import { ansi } from '../render/ansi.js';

export async function runDashboard(engine: any) {
  console.clear();
  enableRawMode();

  let active = true;

  const draw = () => {
    const tasks = engine.listTasks();
    const running = tasks.filter((t: any) => t.status === 'running').length;
    const dispatching = tasks.filter(
      (t: any) => t.dispatchStatus === 'running' || t.dispatchStatus === 'queued',
    ).length;
    const approvals = engine.listApprovals().filter((a: any) => a.status === 'pending').length;
    console.clear();
    console.log(ansi.bold(ansi.cyan('Spark Agent Runtime Dashboard')));
    console.log(ansi.gray('─'.repeat(40)));
    console.log(
      `Tasks running: ${running} | Dispatching: ${dispatching} | Approvals pending: ${approvals}`,
    );
    const activeDispatches = tasks.filter(
      (t: any) => t.dispatchStatus === 'running' || t.dispatchStatus === 'queued',
    );
    if (activeDispatches.length > 0) {
      console.log('\nActive Agent Dispatches:');
      for (const t of activeDispatches) {
        console.log(
          `- ${t.title} (${t.id.substring(0, 8)}): ${t.dispatchStatus} [${t.agent} / ${t.model}]`,
        );
      }
    }
    console.log('\n[q]uit [a]pprovals [t]asks [s]kills [r]efresh');
  };

  draw();
  const interval = setInterval(() => {
    if (active) draw();
  }, 5000);

  onKeyPress((key) => {
    if (key === 'q') {
      active = false;
      clearInterval(interval);
      disableRawMode();
      console.clear();
      process.exit(0);
    } else if (key === 'r') {
      draw();
    }
  });
}
