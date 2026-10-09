import { pathToFileURL } from 'node:url';

import {
  ACTION_OPERATIONS,
  POLICY_PROFILES,
  type ActionOperation,
  type ActionInput,
  type Amount,
  type CreateTaskInput,
  type JsonValue,
  type PolicyProfile,
} from './domain/types.js';
import { SQLiteStore } from './storage/sqlite.js';
import { TaskEngine, type RunActionInput } from './runtime/task-engine.js';
import { loadConnectorRegistry } from './connectors/config.js';
import { Scheduler } from './runtime/scheduler.js';
import { GmailEventTrigger } from './triggers/gmail.js';
import { createTaskEventHandler } from './runtime/daemon.js';

type ParsedArguments = {
  positionals: string[];
  values: Map<string, string | true>;
};

function parseArguments(argumentsList: string[]): ParsedArguments {
  const positionals: string[] = [];
  const values = new Map<string, string | true>();
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === undefined) continue;
    if (!argument.startsWith('--')) {
      positionals.push(argument);
      continue;
    }
    const content = argument.slice(2);
    const equalsIndex = content.indexOf('=');
    if (equalsIndex >= 0) {
      values.set(content.slice(0, equalsIndex), content.slice(equalsIndex + 1));
      continue;
    }
    const next = argumentsList[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      values.set(content, next);
      index += 1;
    } else {
      values.set(content, true);
    }
  }
  return { positionals, values };
}

function value(argumentsObject: ParsedArguments, key: string): string | undefined {
  const candidate = argumentsObject.values.get(key);
  return typeof candidate === 'string' ? candidate : undefined;
}

function requiredValue(argumentsObject: ParsedArguments, key: string): string {
  const result = value(argumentsObject, key);
  if (result === undefined || result.trim().length === 0) {
    throw new Error(`Missing required option --${key}`);
  }
  return result;
}

function booleanValue(argumentsObject: ParsedArguments, key: string, fallback = false): boolean {
  const candidate = argumentsObject.values.get(key);
  if (candidate === undefined) return fallback;
  if (candidate === true) return true;
  if (candidate === 'true') return true;
  if (candidate === 'false') return false;
  throw new Error(`Option --${key} must be true or false`);
}

function numberValue(
  argumentsObject: ParsedArguments,
  key: string,
  fallback?: number,
): number | undefined {
  const raw = value(argumentsObject, key);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`Option --${key} must be numeric`);
  return parsed;
}

function jsonValue(raw: string): JsonValue {
  try {
    return JSON.parse(raw) as JsonValue;
  } catch {
    return raw;
  }
}

function optionalJsonValue(argumentsObject: ParsedArguments, key: string): JsonValue | undefined {
  const raw = value(argumentsObject, key);
  return raw === undefined ? undefined : jsonValue(raw);
}

function listValue(argumentsObject: ParsedArguments, key: string): string[] | undefined {
  const raw = value(argumentsObject, key);
  if (raw === undefined) return undefined;
  const parsed = jsonValue(raw);
  if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
    return parsed as string[];
  }
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function profileValue(argumentsObject: ParsedArguments): PolicyProfile | undefined {
  const raw = value(argumentsObject, 'profile');
  if (raw === undefined) return undefined;
  if (!POLICY_PROFILES.includes(raw as PolicyProfile)) {
    throw new Error(`Unknown policy profile ${raw}`);
  }
  return raw as PolicyProfile;
}

function operationValue(argumentsObject: ParsedArguments): ActionOperation {
  const raw = requiredValue(argumentsObject, 'operation');
  if (!ACTION_OPERATIONS.includes(raw as ActionOperation)) {
    throw new Error(`Unknown action operation ${raw}`);
  }
  return raw as ActionOperation;
}

function defaultConnector(operation: ActionOperation): string {
  if (operation === 'shell') return 'shell';
  if (operation === 'send_email') return 'gmail';
  if (operation === 'send_message' || operation === 'publish_post') return 'web';
  if (operation === 'edit_shared_document') return 'google-drive';
  if (
    operation === 'edit_data' ||
    operation === 'delete_to_trash' ||
    operation === 'delete_permanently'
  ) {
    return 'google-tasks';
  }
  if (operation === 'submit_form') return 'web';
  if (operation === 'purchase' || operation === 'contract' || operation === 'charge') {
    return 'web';
  }
  return 'files';
}

function amountValue(argumentsObject: ParsedArguments): Amount | undefined {
  const raw = value(argumentsObject, 'amount');
  if (raw !== undefined) {
    const parsed = jsonValue(raw);
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      typeof parsed.currency !== 'string' ||
      typeof parsed.value !== 'number'
    ) {
      throw new Error('--amount must be JSON with currency and numeric value');
    }
    return { currency: parsed.currency, value: parsed.value };
  }
  const amountRaw = value(argumentsObject, 'amount-value');
  const currency = value(argumentsObject, 'currency');
  if (amountRaw === undefined && currency === undefined) return undefined;
  if (amountRaw === undefined || currency === undefined) {
    throw new Error('--amount-value and --currency must be provided together');
  }
  const amount = Number(amountRaw);
  if (!Number.isFinite(amount)) throw new Error('--amount-value must be numeric');
  return { currency, value: amount };
}

function actionInput(argumentsObject: ParsedArguments): RunActionInput {
  const operation = operationValue(argumentsObject);
  const action: RunActionInput = {
    tool: value(argumentsObject, 'tool') ?? defaultConnector(operation),
    connector: value(argumentsObject, 'connector') ?? defaultConnector(operation),
    operation,
    target: optionalJsonValue(argumentsObject, 'target') ?? 'unspecified',
    originatingTask: value(argumentsObject, 'originating-task') ?? '',
  };
  const id = value(argumentsObject, 'action-id');
  const taskId = value(argumentsObject, 'action-task-id');
  const payload = optionalJsonValue(argumentsObject, 'payload');
  const before = optionalJsonValue(argumentsObject, 'before');
  const after = optionalJsonValue(argumentsObject, 'after');
  const itemCount = numberValue(argumentsObject, 'item-count');
  const dataSizeBytes = numberValue(argumentsObject, 'data-size-bytes');
  const recipient = value(argumentsObject, 'recipient');
  const undoMethod = value(argumentsObject, 'undo-method');
  const reversibleRaw = argumentsObject.values.get('reversible');
  if (id !== undefined) action.id = id;
  if (taskId !== undefined) action.taskId = taskId;
  if (payload !== undefined) action.payload = payload;
  if (before !== undefined) action.before = before;
  if (after !== undefined) action.after = after;
  if (itemCount !== undefined) action.itemCount = itemCount;
  if (dataSizeBytes !== undefined) action.dataSizeBytes = dataSizeBytes;
  if (recipient !== undefined) action.recipient = recipient;
  if (undoMethod !== undefined) action.undoMethod = undoMethod;
  if (reversibleRaw !== undefined) action.reversible = booleanValue(argumentsObject, 'reversible');
  const amount = amountValue(argumentsObject);
  if (amount !== undefined) action.amount = amount;
  const approvalId = value(argumentsObject, 'approval-id');
  const skill = value(argumentsObject, 'skill');
  const step = value(argumentsObject, 'step');
  if (approvalId !== undefined) action.approvalId = approvalId;
  if (skill !== undefined) action.skill = skill;
  if (step !== undefined) action.step = step;
  return action;
}

function taskCreateInput(argumentsObject: ParsedArguments): CreateTaskInput {
  const title = value(argumentsObject, 'title');
  const instruction = value(argumentsObject, 'instruction');
  if (title === undefined && instruction === undefined) {
    throw new Error('--title or --instruction is required');
  }
  return {
    title,
    instruction,
    profile: profileValue(argumentsObject),
    agent: value(argumentsObject, 'agent'),
    model: value(argumentsObject, 'model'),
    harness: value(argumentsObject, 'harness'),
    plannedSteps: listValue(argumentsObject, 'steps'),
    usedSkills: listValue(argumentsObject, 'skills'),
  };
}

function taskIdValue(argumentsObject: ParsedArguments): string {
  return value(argumentsObject, 'task-id') ?? requiredValue(argumentsObject, 'id');
}

function approvalIdValue(argumentsObject: ParsedArguments): string {
  return value(argumentsObject, 'approval-id') ?? requiredValue(argumentsObject, 'id');
}

function printJson(valueToPrint: unknown): void {
  process.stdout.write(`${JSON.stringify(valueToPrint, null, 2)}\n`);
}

function showTask(engine: TaskEngine, taskId: string): void {
  const task = engine.getTask(taskId);
  if (task === null) throw new Error(`Task ${taskId} was not found`);
  printJson({
    task,
    progress: engine.getProgress(taskId),
    approvals: engine.listApprovals(taskId),
    events: engine.listEvents(taskId),
  });
}

function parseActions(raw: string): RunActionInput[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error('--actions must be a JSON array');
  return parsed as RunActionInput[];
}

function dispatch(engine: TaskEngine, argumentsObject: ParsedArguments): void {
  const [command, subcommand] = argumentsObject.positionals;
  if (command === 'init') {
    printJson({ initialized: true });
    return;
  }
  if (command === 'task' && subcommand === 'create') {
    printJson(engine.createTask(taskCreateInput(argumentsObject)));
    return;
  }
  if (command === 'create') {
    printJson(engine.createTask(taskCreateInput(argumentsObject)));
    return;
  }
  if ((command === 'task' && subcommand === 'show') || command === 'show') {
    showTask(engine, taskIdValue(argumentsObject));
    return;
  }
  if (command === 'task' && subcommand === 'run') {
    const taskId = taskIdValue(argumentsObject);
    const actions = parseActions(requiredValue(argumentsObject, 'actions'));
    const result = engine.run(taskId, actions, {
      complete: booleanValue(argumentsObject, 'complete', true),
    });
    printJson(result);
    return;
  }
  if (command === 'skill' && subcommand === 'create') {
    engine.skills.register({
      name: requiredValue(argumentsObject, 'name'),
      description: requiredValue(argumentsObject, 'description'),
      instructions: value(argumentsObject, 'instructions') ?? '',
    });
    printJson(engine.skills.getRecord(requiredValue(argumentsObject, 'name').trim()));
    return;
  }
  if (command === 'skill' && subcommand === 'list') {
    printJson(engine.skills.listRecords());
    return;
  }
  if (command === 'skill' && subcommand === 'show') {
    const skill = engine.skills.getRecord(requiredValue(argumentsObject, 'name'));
    if (skill === null) throw new Error('Skill was not found');
    printJson(skill);
    return;
  }
  if (command === 'skill' && subcommand === 'update') {
    const name = requiredValue(argumentsObject, 'name');
    const current = engine.skills.getRecord(name);
    if (current === null) throw new Error(`Skill ${name} was not found`);
    printJson(
      engine.skills.update(name, {
        description: value(argumentsObject, 'description') ?? current.description,
        instructions: value(argumentsObject, 'instructions') ?? current.instructions,
      }),
    );
    return;
  }
  if (command === 'skill' && (subcommand === 'enable' || subcommand === 'disable')) {
    printJson(
      engine.skills.setEnabled(requiredValue(argumentsObject, 'name'), subcommand === 'enable'),
    );
    return;
  }
  if (command === 'skill' && subcommand === 'delete') {
    const name = requiredValue(argumentsObject, 'name');
    printJson({ name, deleted: engine.skills.remove(name) });
    return;
  }
  if (command === 'schedule') {
    const scheduler = new Scheduler(engine.store);
    if (subcommand === 'create') {
      const intervalMs = numberValue(argumentsObject, 'interval-ms');
      if (intervalMs === undefined) throw new Error('Missing required option --interval-ms');
      const firstRun = value(argumentsObject, 'first-run-at');
      printJson(
        scheduler.add(
          requiredValue(argumentsObject, 'name'),
          intervalMs,
          optionalJsonValue(argumentsObject, 'payload') ?? null,
          firstRun === undefined ? new Date() : new Date(firstRun),
        ),
      );
      return;
    }
    if (subcommand === 'list') {
      printJson(engine.store.listSchedules());
      return;
    }
    if (subcommand === 'show') {
      const schedule = engine.store.getSchedule(requiredValue(argumentsObject, 'id'));
      if (schedule === null) throw new Error('Schedule was not found');
      printJson(schedule);
      return;
    }
    if (subcommand === 'pause') {
      printJson(
        scheduler.pause(
          requiredValue(argumentsObject, 'id'),
          value(argumentsObject, 'reason') ?? 'Paused by user',
        ),
      );
      return;
    }
    if (subcommand === 'resume') {
      printJson(scheduler.resume(requiredValue(argumentsObject, 'id')));
      return;
    }
    if (subcommand === 'enable') {
      printJson(scheduler.enable(requiredValue(argumentsObject, 'id')));
      return;
    }
    if (subcommand === 'disable') {
      printJson(scheduler.disable(requiredValue(argumentsObject, 'id')));
      return;
    }
    if (subcommand === 'tick') {
      const at = value(argumentsObject, 'at');
      printJson(scheduler.tick(at === undefined ? new Date() : new Date(at)));
      return;
    }
  }
  if (command === 'gmail' && subcommand === 'event') {
    const envelope = optionalJsonValue(argumentsObject, 'envelope');
    const workflow = optionalJsonValue(argumentsObject, 'workflow');
    if (envelope === undefined) throw new Error('Missing required option --envelope');
    if (
      workflow === undefined ||
      workflow === null ||
      typeof workflow !== 'object' ||
      Array.isArray(workflow)
    ) {
      throw new Error('--workflow must be a JSON object');
    }
    const event = new GmailEventTrigger(engine.store).ingest(envelope, workflow);
    if (event !== null) {
      const now = new Date().toISOString();
      const claim = engine.store.claimEvent(event.id, now);
      if (claim === null) throw new Error('Gmail event is already running');
      try {
        createTaskEventHandler(engine)(event);
        if (!engine.store.completeEvent(claim, new Date().toISOString())) {
          throw new Error(`Gmail event ${event.id} claim was lost before completion`);
        }
      } catch (error) {
        engine.store.failEvent(
          claim,
          error instanceof Error ? error.message : String(error),
          new Date().toISOString(),
        );
        throw error;
      }
    }
    printJson({ duplicate: event === null, event });
    return;
  }
  if (command === 'action') {
    const taskId = taskIdValue(argumentsObject);
    const input = actionInput(argumentsObject);
    const result = engine.runAction(taskId, input, {
      approvalId: input.approvalId,
      skill: input.skill,
      step: input.step,
    });
    printJson(result);
    return;
  }
  if (command === 'approve') {
    printJson(
      engine.approve(
        approvalIdValue(argumentsObject),
        value(argumentsObject, 'by') ?? 'cli-user',
        booleanValue(argumentsObject, 'confirm'),
      ),
    );
    return;
  }
  if (command === 'deny') {
    printJson(
      engine.deny(
        approvalIdValue(argumentsObject),
        value(argumentsObject, 'by') ?? 'cli-user',
        requiredValue(argumentsObject, 'reason'),
      ),
    );
    return;
  }
  if (command === 'stop') {
    printJson(
      engine.stop(
        taskIdValue(argumentsObject),
        value(argumentsObject, 'reason') ?? 'Stopped by user',
      ),
    );
    return;
  }
  if (command === 'task' && subcommand === 'pause') {
    printJson(
      engine.stop(
        taskIdValue(argumentsObject),
        value(argumentsObject, 'reason') ?? 'Paused by user',
      ),
    );
    return;
  }
  if (command === 'task' && subcommand === 'resume') {
    printJson(engine.resume(taskIdValue(argumentsObject)));
    return;
  }
  if (command === 'resume') {
    printJson(
      engine.resume(taskIdValue(argumentsObject), {
        executePending: booleanValue(argumentsObject, 'execute-pending'),
      }),
    );
    return;
  }
  if (command === 'audit' && subcommand === 'verify') {
    printJson(engine.verifyAudit());
    return;
  }
  if (command === 'audit' && subcommand === 'list') {
    printJson(engine.listAuditEvents());
    return;
  }
  if (command === 'connector' && (subcommand === 'list' || subcommand === 'validate')) {
    printJson({ connectors: engine.connectors.list().map((connector) => connector.name) });
    return;
  }
  throw new Error(
    'Usage: task create|show|run|pause|resume, skill create|list|show|update|enable|disable|delete, schedule create|list|show|pause|resume|enable|disable|tick, gmail event, action, approve, deny, audit verify, connector list, or demo',
  );
}

function runDemo(): void {
  const store = new SQLiteStore(':memory:');
  try {
    const engine = new TaskEngine(store);
    const task = engine.createTask({
      title: 'Demo: review inbox and send a summary',
      plannedSteps: ['Read inbox', 'Send summary'],
      usedSkills: ['inbox-review'],
    });
    const read = engine.run(
      task.id,
      [
        {
          tool: 'gmail.search',
          connector: 'gmail',
          operation: 'read',
          target: { folder: 'inbox' },
          originatingTask: task.title,
          step: 'Read inbox',
          skill: 'inbox-review',
        },
      ],
      { complete: false },
    );
    const approvalRequest = engine.runAction(
      task.id,
      {
        tool: 'gmail.send',
        connector: 'gmail',
        operation: 'send_email',
        target: { thread: 'demo-thread' },
        payload: { subject: 'Demo summary', body: 'This is simulated.' },
        recipient: 'user-1d76b62@example.com',
        reversible: false,
        undoMethod: 'No external mutation occurred; this is a mock.',
        originatingTask: task.title,
      },
      { step: 'Send summary' },
    );
    if (approvalRequest.approval === null) throw new Error('Demo did not create an approval');
    const approved = engine.approve(approvalRequest.approval.id, 'demo-user');
    const sent = engine.runAction(task.id, approvalRequest.action, {
      approvalId: approved.id,
      step: 'Send summary',
    });
    const stopped = engine.stop(task.id, 'Demonstrate persisted stop');
    const resumed = engine.resume(task.id);
    const completed = engine.complete(task.id);
    printJson({
      simulated: true,
      read,
      approvalRequest,
      approved,
      sent,
      stopped,
      resumed,
      completed,
      audit: engine.verifyAudit(),
    });
  } finally {
    store.close();
  }
}

export function main(argumentsList = process.argv.slice(2)): number {
  const parsed = parseArguments(argumentsList);
  if (
    parsed.values.has('help') ||
    parsed.positionals[0] === 'help' ||
    parsed.positionals[0] === '--help' ||
    parsed.positionals[0] === '-h'
  ) {
    process.stdout.write(
      'Usage: task create|show|run|pause|resume, skill create|list|show|update|enable|disable|delete, schedule create|list|show|pause|resume|enable|disable|tick, gmail event, action, approve, deny, audit verify, connector list, or demo\n',
    );
    return 0;
  }
  if (parsed.positionals[0] === 'demo') {
    try {
      runDemo();
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      return 1;
    }
  }

  const dbPath = value(parsed, 'db') ?? 'data/runtime.sqlite';
  const store = new SQLiteStore(dbPath);
  try {
    const connectorConfig = value(parsed, 'connectors');
    const connectors =
      connectorConfig === undefined ? undefined : loadConnectorRegistry(connectorConfig);
    dispatch(new TaskEngine(store, connectors === undefined ? {} : { connectors }), parsed);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    return 1;
  } finally {
    store.close();
  }
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  process.exitCode = main();
}
