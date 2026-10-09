import type { Route } from '../types.js';
import { jsonResponse } from '../utils.js';
import type { TaskEngine } from '../../runtime/task-engine.js';

export function registerConnectorRoutes(engine: TaskEngine): Route[] {
  return [
    {
      method: 'GET',
      pattern: /^\/api\/v1\/connectors$/u,
      paramNames: [],
      handler: async (_req, res) => {
        jsonResponse(res, 200, { connectors: engine.connectors.list().map((c) => c.name) });
      },
    },
  ];
}
