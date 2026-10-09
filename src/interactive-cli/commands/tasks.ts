import { renderTable } from '../render/table.js';
import { renderStatusBadge, renderProgressBar } from '../render/progress.js';
import { renderStepper } from '../render/stepper.js';
import { promptLine, promptConfirm, promptSelect } from '../input/prompt.js';
import {
  dispatchAgent,
  cancelDispatch,
  getAntigravityModels,
  getCodexModels,
  getProviderAvailability,
} from '../../runtime/agent-dispatcher.js';

export async function listTasks(engine: any) {
  const tasks = await engine.listTasks();
  const rows = tasks.map((t: any) => {
    let statusText = renderStatusBadge(t.status);
    if (t.dispatchStatus && t.dispatchStatus !== 'not_started') {
      statusText += ` (Dispatch: ${t.dispatchStatus})`;
    }
    return [
      t.id.substring(0, 8),
      t.title,
      statusText,
      renderProgressBar(t.completedSteps.length, t.plannedSteps.length, 10),
      new Date(t.createdAt).toLocaleString(),
    ];
  });

  console.log(renderTable(['ID', 'Title', 'Status', 'Progress', 'Created At'], rows));
}

export async function showTask(engine: any, taskId: string) {
  const task = await engine.getTask(taskId);
  if (!task) {
    console.log('Task not found.');
    return;
  }

  console.log(`Task: ${task.title} (${task.id})`);
  console.log(`Status: ${renderStatusBadge(task.status)}`);
  if (task.dispatchStatus && task.dispatchStatus !== 'not_started') {
    console.log(`Dispatch Status: ${task.dispatchStatus}`);
    console.log(`Dispatch Mode: ${task.dispatchMode || 'n/a'}`);
    if (task.dispatchSummary) {
      console.log(`Dispatch Summary: ${task.dispatchSummary}`);
    }
  }
  console.log('\nSteps:');
  console.log(renderStepper(task.plannedSteps, task.completedSteps, task.currentStep));
}

export async function createTask(engine: any) {
  const instruction = await promptLine('Task Instruction:');
  if (!instruction) {
    console.log('Error: Task instruction is required.');
    return;
  }

  const providerIdx = await promptSelect('Choose Provider:', ['Antigravity CLI', 'Codex CLI']);
  const provider = providerIdx === 0 ? 'antigravity' : 'codex';

  let model = 'default';
  if (provider === 'antigravity') {
    const models = await getAntigravityModels();
    const modelIdx = await promptSelect('Choose Model:', [...models, 'Other (custom model id)']);
    if (modelIdx === models.length) {
      model = await promptLine('Enter custom model ID:');
    } else {
      model = models[modelIdx] || 'gemini-3.5-flash-high';
    }
  } else {
    const models = await getCodexModels();
    const modelIdx = await promptSelect('Choose Model:', [...models, 'Other (custom model id)']);
    if (modelIdx === models.length) {
      model = await promptLine('Enter custom model ID:');
    } else {
      model = models[modelIdx] || 'default';
    }
  }

  const dispatchInPlan = await promptConfirm('Dispatch in plan mode immediately?');

  try {
    const task = engine.createTask({
      instruction,
      agent: provider,
      model,
    });
    console.log(`Task created successfully with ID: ${task.id}`);

    if (dispatchInPlan) {
      console.log('Dispatching task in plan mode...');
      await dispatchAgent(engine, task.id, { mode: 'plan' });
      const updated = engine.getTask(task.id);
      console.log(`Task dispatch finished. Status: ${updated.dispatchStatus}`);
      console.log(`Summary: ${updated.dispatchSummary || '(No summary available)'}`);
    }
  } catch (error: any) {
    console.log(`Failed to create task: ${error.message}`);
  }
}

export async function stopTask(engine: any, taskId: string) {
  await engine.stop(taskId, 'Stopped from CLI');
  console.log('Task stopped.');
}

export async function resumeTask(engine: any, taskId: string) {
  await engine.resume(taskId);
  console.log('Task resumed.');
}

export async function dispatchTask(engine: any, taskId: string) {
  const task = await engine.getTask(taskId);
  if (!task) {
    console.log('Task not found.');
    return;
  }
  const modeIdx = await promptSelect('Choose Dispatch Mode:', ['plan', 'workspace']);
  const mode = modeIdx === 0 ? 'plan' : 'workspace';
  try {
    await dispatchAgent(engine, taskId, { mode });
    const updated = engine.getTask(taskId);
    console.log(
      `Task ${taskId} dispatch finished in ${mode} mode. Status: ${updated.dispatchStatus}`,
    );
    console.log(`Summary: ${updated.dispatchSummary || '(No summary available)'}`);
  } catch (error: any) {
    console.log(`Failed to dispatch task: ${error.message}`);
  }
}

export async function cancelTaskDispatch(engine: any, taskId: string) {
  try {
    const success = await cancelDispatch(engine, taskId);
    if (success) {
      console.log(`Task ${taskId} dispatch cancelled.`);
    } else {
      console.log(`No active dispatch found for task ${taskId}.`);
    }
  } catch (error: any) {
    console.log(`Failed to cancel dispatch: ${error.message}`);
  }
}

export async function showTaskLogs(engine: any, taskId: string) {
  const task = await engine.getTask(taskId);
  if (!task) {
    console.log('Task not found.');
    return;
  }
  console.log(`Task: ${task.title} (${task.id})`);
  console.log(`Provider: ${task.agent} | Model: ${task.model}`);
  console.log(`Dispatch Status: ${task.dispatchStatus}`);
  console.log(`Dispatch Mode: ${task.dispatchMode || 'n/a'}`);
  console.log(`Started At: ${task.dispatchStartedAt || 'n/a'}`);
  console.log(`Finished At: ${task.dispatchFinishedAt || 'n/a'}`);
  console.log('\n--- Redacted Summary ---');
  console.log(task.dispatchSummary || '(No summary available)');
}

export async function listProviders(engine: any) {
  const antigravityAvailable = getProviderAvailability('antigravity');
  const codexAvailable = getProviderAvailability('codex');
  console.log('\nAvailable Providers:');
  console.log(`1. Antigravity CLI (available: ${antigravityAvailable ? 'yes' : 'no'})`);
  console.log('   Capability: Local autonomous agent framework using Google Gemini models.');
  console.log('   Quota Availability: unavailable');
  console.log(`2. Codex CLI (available: ${codexAvailable ? 'yes' : 'no'})`);
  console.log(
    '   Capability: Codex local coding agent execution environment and account-aware model catalog.',
  );
  console.log('   Quota Availability: unavailable\n');
}

export async function listProviderModels(engine: any, provider: string) {
  if (provider === 'antigravity') {
    const models = await getAntigravityModels();
    console.log(`\nAntigravity Models:`);
    models.forEach((m: string) => console.log(`- ${m}`));
    console.log('');
  } else if (provider === 'codex') {
    const models = await getCodexModels();
    console.log('\nCodex Models:');
    models.forEach((model: string) => {
      const label = model === 'default' ? 'default (CLI configuration)' : model;
      console.log(`- ${label}`);
    });
    console.log('- Other (custom model id)\n');
  } else {
    console.log(`Unknown provider: ${provider}`);
  }
}
