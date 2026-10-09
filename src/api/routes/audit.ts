import type { Route } from '../types.js';
import { jsonResponse } from '../utils.js';
import type { TaskEngine } from '../../runtime/task-engine.js';

export function registerAuditRoutes(engine: TaskEngine): Route[] {
  return [
    {
      method: 'GET',
      pattern: /^\/api\/v1\/audit$/u,
      paramNames: [],
      handler: async (_req, res) => {
        jsonResponse(res, 200, engine.listAuditEvents());
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/v1\/audit\/verify$/u,
      paramNames: [],
      handler: async (_req, res) => {
        jsonResponse(res, 200, engine.verifyAudit());
      },
    },
  ];
}
