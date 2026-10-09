import type { Route } from '../types.js';
import { readJsonBody, jsonResponse } from '../utils.js';
import type { TaskEngine } from '../../runtime/task-engine.js';

export function registerApprovalRoutes(engine: TaskEngine): Route[] {
  return [
    {
      method: 'GET',
      pattern: /^\/api\/v1\/approvals$/u,
      paramNames: [],
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        const status = url.searchParams.get('status');
        let approvals = engine.listApprovals();
        if (status === 'pending') {
          approvals = approvals.filter((a) => a.status === 'pending');
        }
        jsonResponse(res, 200, approvals);
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/v1\/approvals\/([^\/]+)$/u,
      paramNames: ['id'],
      handler: async (_req, res, params) => {
        const approval = engine.getApproval(params['id'] ?? '');
        if (approval === null) {
          jsonResponse(res, 404, { error: 'Approval not found' });
          return;
        }
        jsonResponse(res, 200, approval);
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/v1\/approvals\/([^\/]+)\/approve$/u,
      paramNames: ['id'],
      handler: async (req, res, params) => {
        const body = await readJsonBody<{ confirm?: boolean }>(req);
        try {
          const id = params['id'] ?? '';
          const pending = engine.getApproval(id);
          if (pending === null) {
            jsonResponse(res, 404, { error: `Approval ${id} was not found` });
            return;
          }
          const workflow = engine.store.getEventWorkflowForApproval(
            pending.taskId,
            pending.actionId,
          );
          const waitingWorkflow = engine.store.getWaitingEventWorkflow(pending.taskId);
          if (waitingWorkflow !== null && workflow === null) {
            jsonResponse(res, 400, {
              error: `Approval ${id} is not the expected action for its event workflow`,
            });
            return;
          }

          const approval = engine.approve(id, 'api-user', body.confirm === true);
          const result = engine.runAction(approval.taskId, approval.action, {
            approvalId: approval.id,
          });

          if (workflow !== null) {
            if (result.decision.outcome === 'take_control') {
              engine.store.setEventWorkflowStatus(
                workflow.eventId,
                approval.taskId,
                'take_control',
                approval.actionId,
              );
            } else if (result.decision.outcome === 'deny') {
              engine.store.setEventWorkflowStatus(
                workflow.eventId,
                approval.taskId,
                'denied',
                approval.actionId,
              );
            } else if (result.connectorResult === null || !result.connectorResult.success) {
              engine.store.setEventWorkflowStatus(
                workflow.eventId,
                approval.taskId,
                'failed',
                approval.actionId,
              );
            } else {
              const advanced = engine.store.approveEventWorkflow(
                workflow.eventId,
                approval.taskId,
                approval.actionId,
              );
              if (advanced.status === 'completed') {
                const originalEvent = engine.store.getEvent(workflow.eventId);
                const originalPayload =
                  originalEvent?.payload !== null &&
                  typeof originalEvent?.payload === 'object' &&
                  !Array.isArray(originalEvent.payload)
                    ? originalEvent.payload
                    : null;

                if (
                  originalPayload?.complete !== false &&
                  engine.getTask(approval.taskId)?.status === 'running'
                ) {
                  engine.complete(approval.taskId);
                }
              }
            }
          }

          const updatedApproval = engine.getApproval(approval.id) ?? approval;
          jsonResponse(res, 200, {
            approval: updatedApproval,
            executionResult: {
              outcome: result.decision.outcome,
              success: result.connectorResult?.success ?? false,
              summary: result.connectorResult?.summary ?? '',
              changedTargets: result.connectorResult?.changedTargets ?? [],
            },
          });
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          jsonResponse(res, 400, { error: message });
        }
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/v1\/approvals\/([^\/]+)\/deny$/u,
      paramNames: ['id'],
      handler: async (req, res, params) => {
        const body = await readJsonBody<{ reason: string }>(req);
        try {
          const approval = engine.deny(
            params['id'] ?? '',
            'api-user',
            body.reason ?? 'Denied via API',
          );
          jsonResponse(res, 200, approval);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          jsonResponse(res, 400, { error: message });
        }
      },
    },
  ];
}
