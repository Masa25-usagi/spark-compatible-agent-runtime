import type { Route } from '../types.js';
import { readJsonBody, jsonResponse } from '../utils.js';
import type { Scheduler } from '../../runtime/scheduler.js';
import type { SQLiteStore } from '../../storage/sqlite.js';
import type { JsonValue } from '../../domain/types.js';

export function registerScheduleRoutes(store: SQLiteStore, scheduler: Scheduler): Route[] {
  return [
    {
      method: 'GET',
      pattern: /^\/api\/v1\/schedules$/u,
      paramNames: [],
      handler: async (_req, res) => {
        jsonResponse(res, 200, store.listSchedules());
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/v1\/schedules$/u,
      paramNames: [],
      handler: async (req, res) => {
        const body = await readJsonBody<{
          name: string;
          intervalMs: number;
          payload?: JsonValue;
          firstRunAt?: string;
        }>(req);
        try {
          const firstRun = body.firstRunAt !== undefined ? new Date(body.firstRunAt) : undefined;
          const record = scheduler.add(body.name, body.intervalMs, body.payload ?? null, firstRun);
          jsonResponse(res, 201, record);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          jsonResponse(res, 400, { error: message });
        }
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/v1\/schedules\/([^\/]+)$/u,
      paramNames: ['id'],
      handler: async (_req, res, params) => {
        const record = store.getSchedule(params['id'] ?? '');
        if (record === null) {
          jsonResponse(res, 404, { error: 'Schedule not found' });
          return;
        }
        jsonResponse(res, 200, record);
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/v1\/schedules\/([^\/]+)\/pause$/u,
      paramNames: ['id'],
      handler: async (req, res, params) => {
        const body = await readJsonBody<{ reason?: string }>(req);
        try {
          const record = scheduler.pause(params['id'] ?? '', body.reason);
          jsonResponse(res, 200, record);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          jsonResponse(res, 400, { error: message });
        }
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/v1\/schedules\/([^\/]+)\/resume$/u,
      paramNames: ['id'],
      handler: async (req, res, params) => {
        try {
          const record = scheduler.resume(params['id'] ?? '');
          jsonResponse(res, 200, record);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          jsonResponse(res, 400, { error: message });
        }
      },
    },
  ];
}
