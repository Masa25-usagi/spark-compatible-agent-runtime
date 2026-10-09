import type { Route } from '../types.js';
import { readJsonBody, jsonResponse } from '../utils.js';
import type { TaskEngine } from '../../runtime/task-engine.js';

export function registerSkillRoutes(engine: TaskEngine): Route[] {
  return [
    {
      method: 'GET',
      pattern: /^\/api\/v1\/skills$/u,
      paramNames: [],
      handler: async (_req, res) => {
        jsonResponse(res, 200, engine.skills.listRecords());
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/v1\/skills$/u,
      paramNames: [],
      handler: async (req, res) => {
        const body = await readJsonBody<{
          name: string;
          description: string;
          instructions?: string;
        }>(req);
        try {
          engine.skills.register(body);
          const record = engine.skills.getRecord(body.name.trim());
          jsonResponse(res, 201, record);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          jsonResponse(res, 400, { error: message });
        }
      },
    },
    {
      method: 'PUT',
      pattern: /^\/api\/v1\/skills\/([^\/]+)$/u,
      paramNames: ['name'],
      handler: async (req, res, params) => {
        const body = await readJsonBody<{ description?: string; instructions?: string }>(req);
        const name = decodeURIComponent(params['name'] ?? '');
        try {
          const current = engine.skills.getRecord(name);
          if (current === null) {
            jsonResponse(res, 404, { error: 'Skill not found' });
            return;
          }
          const record = engine.skills.update(name, {
            description: body.description ?? current.description,
            instructions: body.instructions ?? current.instructions,
          });
          jsonResponse(res, 200, record);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          jsonResponse(res, 400, { error: message });
        }
      },
    },
    {
      method: 'DELETE',
      pattern: /^\/api\/v1\/skills\/([^\/]+)$/u,
      paramNames: ['name'],
      handler: async (_req, res, params) => {
        const name = decodeURIComponent(params['name'] ?? '');
        const deleted = engine.skills.remove(name);
        jsonResponse(res, 200, { name, deleted });
      },
    },
    {
      method: 'PATCH',
      pattern: /^\/api\/v1\/skills\/([^\/]+)\/toggle$/u,
      paramNames: ['name'],
      handler: async (_req, res, params) => {
        const name = decodeURIComponent(params['name'] ?? '');
        const current = engine.skills.getRecord(name);
        if (current === null) {
          jsonResponse(res, 404, { error: 'Skill not found' });
          return;
        }
        const record = engine.skills.setEnabled(name, !current.enabled);
        jsonResponse(res, 200, record);
      },
    },
  ];
}
