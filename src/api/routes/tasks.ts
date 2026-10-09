import type { Route } from '../types.js';
import { readJsonBody, jsonResponse } from '../utils.js';
import type { TaskEngine } from '../../runtime/task-engine.js';
import type { CreateTaskInput } from '../../domain/types.js';
import { suggestSteps, type PlannerProvider } from '../../planning/step-planner.js';
import {
  dispatchAgent,
  cancelDispatch,
  getAntigravityModels,
  getCodexModels,
  getProviderAvailability,
  startAgentDispatch,
  getSafeJapaneseError,
} from '../../runtime/agent-dispatcher.js';

export function registerTaskRoutes(engine: TaskEngine): Route[] {
  return [
    {
      method: 'GET',
      pattern: /^\/api\/v1\/tasks$/u,
      paramNames: [],
      handler: async (_req, res) => {
        jsonResponse(res, 200, engine.listTasks());
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/v1\/tasks$/u,
      paramNames: [],
      handler: async (req, res) => {
        const body = await readJsonBody<CreateTaskInput>(req);
        try {
          if (!body.instruction && !body.title) {
            throw new Error('Task instruction or title is required');
          }
          if (body.agent !== undefined) {
            if (body.agent !== 'antigravity' && body.agent !== 'codex') {
              throw new Error(`Unsupported provider: ${body.agent}`);
            }
          }
          if (body.model !== undefined) {
            if (!body.model || body.model.trim().length === 0) {
              throw new Error('Invalid model ID');
            }
          }
          const task = engine.createTask(body);
          jsonResponse(res, 201, task);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          jsonResponse(res, 400, { error: message });
        }
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/v1\/tasks\/suggest-steps$/u,
      paramNames: [],
      handler: async (req, res) => {
        const body = await readJsonBody<{
          instruction?: string;
          provider?: PlannerProvider;
          model?: string;
        }>(req);
        try {
          if (!body.instruction || body.instruction.trim().length === 0) {
            throw new Error('Instruction is required');
          }
          if (body.provider !== undefined && !['antigravity', 'codex'].includes(body.provider)) {
            throw new Error(`Unsupported provider: ${body.provider}`);
          }
          if (body.model !== undefined && body.model.trim().length === 0) {
            throw new Error('Invalid model ID');
          }
          const result = await suggestSteps(body.instruction, {
            provider: body.provider,
            model: body.model,
          });
          jsonResponse(res, 200, result);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          jsonResponse(res, 400, { error: message });
        }
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/v1\/tasks\/([^\/]+)$/u,
      paramNames: ['id'],
      handler: async (_req, res, params) => {
        const task = engine.getTask(params['id'] ?? '');
        if (task === null) {
          jsonResponse(res, 404, { error: 'Task not found' });
          return;
        }
        const progress = engine.getProgress(task.id);
        const approvals = engine.listApprovals(task.id);
        const events = engine.listEvents(task.id);
        jsonResponse(res, 200, { task, progress, approvals, events });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/v1\/tasks\/([^\/]+)\/stop$/u,
      paramNames: ['id'],
      handler: async (req, res, params) => {
        const body = await readJsonBody<{ reason?: string }>(req);
        try {
          const task = engine.stop(params['id'] ?? '', body.reason ?? 'Stopped via API');
          jsonResponse(res, 200, task);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          jsonResponse(res, 400, { error: message });
        }
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/v1\/tasks\/([^\/]+)\/resume$/u,
      paramNames: ['id'],
      handler: async (_req, res, params) => {
        try {
          const task = engine.resume(params['id'] ?? '');
          jsonResponse(res, 200, task);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          jsonResponse(res, 400, { error: message });
        }
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/v1\/tasks\/([^\/]+)\/run$/u,
      paramNames: ['id'],
      handler: async (req, res, params) => {
        const body = await readJsonBody<{ actions: unknown[]; complete?: boolean }>(req);
        try {
          const result = engine.run(
            params['id'] ?? '',
            body.actions as Parameters<TaskEngine['run']>[1],
            {
              complete: body.complete,
            },
          );
          jsonResponse(res, 200, result);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          jsonResponse(res, 400, { error: message });
        }
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/v1\/agent-providers$/u,
      paramNames: [],
      handler: async (_req, res) => {
        try {
          const antigravityAvailable = getProviderAvailability('antigravity');
          const codexAvailable = getProviderAvailability('codex');
          const [antigravityModels, codexModels] = await Promise.all([
            getAntigravityModels(),
            getCodexModels(),
          ]);

          jsonResponse(res, 200, {
            providers: [
              {
                id: 'antigravity',
                name: 'Antigravity CLI',
                available: antigravityAvailable,
                models: antigravityModels,
                defaultModel: 'gemini-3.5-flash-high',
                capabilityText: 'Local autonomous agent framework using Google Gemini models.',
                quotaAvailability: 'unavailable',
                customModelSupport: false,
              },
              {
                id: 'codex',
                name: 'Codex CLI',
                available: codexAvailable,
                models: codexModels,
                defaultModel: 'default',
                capabilityText:
                  'Codex local coding agent execution environment and account-aware model catalog.',
                quotaAvailability: 'unavailable',
                customModelSupport: true,
              },
            ],
          });
        } catch (error: any) {
          jsonResponse(res, 500, { error: error.message || String(error) });
        }
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/v1\/tasks\/([^\/]+)\/dispatch$/u,
      paramNames: ['id'],
      handler: async (req, res, params) => {
        const body = await readJsonBody<{ mode?: 'plan' | 'workspace' }>(req);
        const taskId = params['id'] ?? '';

        const task = engine.getTask(taskId);
        if (!task) {
          jsonResponse(res, 404, { error: `Task ${taskId} not found` });
          return;
        }

        const provider = task.agent;
        const mode = body.mode ?? 'plan';

        if (provider !== 'antigravity' && provider !== 'codex') {
          jsonResponse(res, 400, { error: `Unsupported provider: ${provider}` });
          return;
        }
        if (mode !== 'plan' && mode !== 'workspace') {
          jsonResponse(res, 400, { error: `Unsupported mode: ${mode}` });
          return;
        }

        if (!getProviderAvailability(provider)) {
          jsonResponse(res, 400, { error: `Provider ${provider} is not available` });
          return;
        }

        try {
          const handle = startAgentDispatch(engine, taskId, { mode });
          handle.promise.catch((err) => {
            try {
              const currentTask = engine.getTask(taskId);
              if (
                currentTask &&
                (currentTask.dispatchStatus === 'queued' ||
                  currentTask.dispatchStatus === 'running')
              ) {
                engine.recordDispatchTransition(taskId, {
                  status: 'failed',
                  summary:
                    '実行できませんでした: 外部CLIの起動中に予期しないエラーが発生しました。',
                  finishedAt: engine.now(),
                  error: getSafeJapaneseError(err?.message || String(err)),
                });
              }
            } catch {
              // Ignore database errors
            }
          });
          const updatedTask = engine.getTask(taskId);
          jsonResponse(res, 202, updatedTask);
        } catch (error: any) {
          jsonResponse(res, 400, { error: error.message || String(error) });
        }
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/v1\/tasks\/([^\/]+)\/cancel-dispatch$/u,
      paramNames: ['id'],
      handler: async (_req, res, params) => {
        const taskId = params['id'] ?? '';
        try {
          const success = await cancelDispatch(engine, taskId);
          const task = engine.getTask(taskId);
          jsonResponse(res, 200, { success, task });
        } catch (error: any) {
          jsonResponse(res, 400, { error: error.message || String(error) });
        }
      },
    },
  ];
}
