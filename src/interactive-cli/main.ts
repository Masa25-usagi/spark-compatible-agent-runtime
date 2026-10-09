import { SQLiteStore } from '../storage/sqlite.js';
import { TaskEngine } from '../runtime/task-engine.js';
import * as tasks from './commands/tasks.js';
import * as approvals from './commands/approvals.js';
import * as skills from './commands/skills.js';
import * as schedules from './commands/schedules.js';
import * as audit from './commands/audit.js';
import { runDashboard } from './commands/dashboard.js';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
}

function printHelp(): void {
  process.stdout.write(
    [
      '',
      '  Spark Runtime CLI',
      '',
      '  Usage: spark-cli <command> [options]',
      '',
      '  Commands:',
      '    dashboard              Full-screen live dashboard (default)',
      '    tasks:list             List all tasks',
      '    tasks:show <id>        Show task detail',
      '    tasks:create           Interactive task creation wizard',
      '    tasks:stop <id>        Stop a task',
      '    tasks:resume <id>      Resume a stopped task',
      '    tasks:dispatch <id>    Dispatch a task',
      '    tasks:cancel <id>      Cancel task dispatch',
      '    tasks:logs <id>        Show logs for a task',
      '    providers:list         List providers',
      '    providers:models <p>   List models for a provider',
      '    approvals:list         List pending approvals',
      '    approvals:show <id>    Show approval detail',
      '    approvals:accept <id>  Accept an approval',
      '    approvals:deny <id>    Deny an approval',
      '    skills:list            List all skills',
      '    skills:create          Create a skill interactively',
      '    skills:toggle <name>   Toggle a skill on/off',
      '    skills:delete <name>   Delete a skill',
      '    schedules:list         List all schedules',
      '    schedules:create       Create a schedule interactively',
      '    schedules:pause <id>   Pause a schedule',
      '    schedules:resume <id>  Resume a schedule',
      '    audit:verify           Verify audit chain integrity',
      '    audit:list             List audit events',
      '    help                   Show this help message',
      '',
      '  Options:',
      '    --db <path>            SQLite database path (default: data/runtime.sqlite)',
      '    --no-color             Disable colored output',
      '',
    ].join('\n'),
  );
}

export async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const command = args[0] ?? 'dashboard';

  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return 0;
  }

  // Build real TaskEngine from SQLite store
  const dbPath = option('db') ?? 'data/runtime.sqlite';
  const store = new SQLiteStore(dbPath);
  const engine = new TaskEngine(store, {});

  try {
    const id = args[1] ?? '';

    switch (command) {
      case 'dashboard':
        await runDashboard(engine);
        break;
      case 'tasks:list':
        await tasks.listTasks(engine);
        break;
      case 'tasks:show':
        await tasks.showTask(engine, id);
        break;
      case 'tasks:create':
        await tasks.createTask(engine);
        break;
      case 'tasks:stop':
        await tasks.stopTask(engine, id);
        break;
      case 'tasks:resume':
        await tasks.resumeTask(engine, id);
        break;
      case 'tasks:dispatch':
        await tasks.dispatchTask(engine, id);
        break;
      case 'tasks:cancel':
        await tasks.cancelTaskDispatch(engine, id);
        break;
      case 'tasks:logs':
        await tasks.showTaskLogs(engine, id);
        break;
      case 'providers:list':
        await tasks.listProviders(engine);
        break;
      case 'providers:models':
        await tasks.listProviderModels(engine, id);
        break;
      case 'approvals:list':
        await approvals.listApprovals(engine);
        break;
      case 'approvals:show':
        await approvals.showApproval(engine, id);
        break;
      case 'approvals:accept':
        await approvals.acceptApproval(engine, id);
        break;
      case 'approvals:deny':
        await approvals.denyApproval(engine, id);
        break;
      case 'skills:list':
        await skills.listSkills(engine);
        break;
      case 'skills:create':
        await skills.createSkill(engine);
        break;
      case 'skills:toggle':
        await skills.toggleSkill(engine, id);
        break;
      case 'skills:delete':
        await skills.deleteSkill(engine, id);
        break;
      case 'schedules:list':
        await schedules.listSchedules(engine);
        break;
      case 'schedules:create':
        await schedules.createSchedule(engine);
        break;
      case 'schedules:pause':
        await schedules.pauseSchedule(engine, id);
        break;
      case 'schedules:resume':
        await schedules.resumeSchedule(engine, id);
        break;
      case 'audit:verify':
        await audit.verifyAudit(engine);
        break;
      case 'audit:list':
        await audit.listAuditEvents(engine);
        break;
      default:
        process.stderr.write(`Unknown command: ${command}\nRun 'spark-cli help' for usage.\n`);
        return 1;
    }

    return 0;
  } finally {
    store.close();
  }
}
