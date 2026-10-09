import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import type { ApprovalRecord, TaskRecord } from '../domain/types.js';
import type { TaskEngine } from '../runtime/task-engine.js';

export type ApprovalUiOptions = {
  csrfToken?: string;
  maxBodyBytes?: number;
};

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function jsonText(value: unknown): string {
  return escapeHtml(JSON.stringify(value));
}

function disclosure(approval: ApprovalRecord): string {
  const item = approval.disclosure;
  return `<dl>
    <dt>Operation</dt><dd>${escapeHtml(item.operation)}</dd>
    <dt>Target</dt><dd>${escapeHtml(item.targetSummary)}</dd>
    <dt>Before</dt><dd>${escapeHtml(item.beforeSummary)}</dd>
    <dt>After</dt><dd>${escapeHtml(item.afterSummary)}</dd>
    <dt>Items / bytes</dt><dd>${item.itemCount} / ${item.dataSizeBytes ?? 'n/a'}</dd>
    <dt>Recipient</dt><dd>${escapeHtml(item.recipient ?? 'n/a')}</dd>
    <dt>Amount</dt><dd>${item.amount === null ? 'n/a' : `${escapeHtml(item.amount.currency)} ${item.amount.value}`}</dd>
    <dt>Reversible</dt><dd>${item.reversible ? 'yes' : 'no'}</dd>
    <dt>Undo</dt><dd>${escapeHtml(item.undoMethod ?? 'none')}</dd>
    <dt>Tool / connector</dt><dd>${escapeHtml(item.tool)} / ${escapeHtml(item.connector)}</dd>
    <dt>Task</dt><dd>${escapeHtml(item.originatingTask)}</dd>
  </dl>`;
}

function approvalCard(approval: ApprovalRecord, csrf: string): string {
  return `<article class="approval">
    <div class="approval-head"><strong>${escapeHtml(approval.disclosure.operation)}</strong><code>${escapeHtml(approval.id)}</code></div>
    ${disclosure(approval)}
    <div class="actions">
      <form method="post" action="/approve"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="id" value="${escapeHtml(approval.id)}">${approval.confirmationRequired ? '<label><input type="checkbox" name="confirm" value="true" required> Confirm bulk action</label>' : ''}<button class="approve" type="submit">Approve and run</button></form>
      <form method="post" action="/deny"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="id" value="${escapeHtml(approval.id)}"><input name="reason" required maxlength="500" placeholder="Reason"><button class="deny" type="submit">Deny</button></form>
    </div>
  </article>`;
}

function taskRow(task: TaskRecord, csrf: string): string {
  const command = task.status === 'stopped' || task.status === 'take_control' ? 'resume' : 'stop';
  return `<tr><td><strong>${escapeHtml(task.title)}</strong><br><code>${escapeHtml(task.id)}</code></td><td><span class="status ${escapeHtml(task.status)}">${escapeHtml(task.status)}</span></td><td>${escapeHtml(task.currentStep || 'n/a')}</td><td>${task.completedSteps.length}/${task.plannedSteps.length}</td><td><form method="post" action="/task/${command}"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="id" value="${escapeHtml(task.id)}"><button type="submit">${command === 'stop' ? 'Stop' : 'Resume'}</button></form></td></tr>`;
}

function page(engine: TaskEngine, csrf: string, message = ''): string {
  const pending = engine.listApprovals().filter((approval) => approval.status === 'pending');
  const tasks = engine.listTasks();
  const audit = engine.verifyAudit();
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="15"><title>Spark Runtime</title><style>
  :root{color-scheme:light;font-family:ui-sans-serif,system-ui,sans-serif;background:#f4f6f8;color:#17202a;letter-spacing:0}*{box-sizing:border-box}body{margin:0}header{background:#fff;border-bottom:1px solid #d8dee4;padding:14px 24px;display:flex;align-items:center;justify-content:space-between}h1{font-size:18px;margin:0}main{max-width:1180px;margin:0 auto;padding:20px}section{margin-bottom:28px}h2{font-size:15px;margin:0 0 10px}.metric{font-size:13px;color:#53606d}.ok{color:#177245}.bad{color:#b42318}.notice{padding:10px;border-left:4px solid #276fbf;background:#eaf3ff;margin-bottom:16px}.approval{background:#fff;border:1px solid #cfd7df;border-radius:6px;padding:16px;margin-bottom:12px}.approval-head{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}dl{display:grid;grid-template-columns:140px 1fr;gap:7px 14px;font-size:13px}dt{color:#64717d}dd{margin:0;overflow-wrap:anywhere}.actions{display:flex;gap:12px;flex-wrap:wrap;border-top:1px solid #e3e7eb;padding-top:12px}.actions form{display:flex;gap:8px;align-items:center;flex-wrap:wrap}button,input{font:inherit}button{border:1px solid #98a3ad;background:#fff;border-radius:4px;padding:7px 11px;cursor:pointer}.approve{background:#177245;color:#fff;border-color:#177245}.deny{background:#b42318;color:#fff;border-color:#b42318}input[name=reason]{padding:7px;border:1px solid #98a3ad;border-radius:4px}table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #cfd7df;font-size:13px}th,td{text-align:left;padding:9px;border-bottom:1px solid #e3e7eb;vertical-align:top}th{background:#eef1f4}.status{font-weight:600}.waiting_for_approval{color:#8a4b08}.failed,.stopped{color:#b42318}.completed{color:#177245}code{font-size:12px;overflow-wrap:anywhere}@media(max-width:700px){header,main{padding:12px}dl{grid-template-columns:1fr}dt{font-weight:600}table{display:block;overflow-x:auto}}
  </style></head><body><header><h1>Spark Runtime Control</h1><span class="metric ${audit.valid ? 'ok' : 'bad'}">Audit ${audit.valid ? 'valid' : 'invalid'} · ${audit.eventCount} events</span></header><main>${message === '' ? '' : `<div class="notice">${escapeHtml(message)}</div>`}<section><h2>Pending approvals (${pending.length})</h2>${pending.length === 0 ? '<p class="metric">No action is waiting for approval.</p>' : pending.map((item) => approvalCard(item, csrf)).join('')}</section><section><h2>Tasks (${tasks.length})</h2><table><thead><tr><th>Task</th><th>Status</th><th>Current step</th><th>Progress</th><th>Control</th></tr></thead><tbody>${tasks.map((task) => taskRow(task, csrf)).join('')}</tbody></table></section></main></body></html>`;
}

async function body(request: IncomingMessage, maximum: number): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > maximum) throw new Error('Request body is too large');
    chunks.push(value);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function redirect(response: ServerResponse, message: string): void {
  response.writeHead(303, { Location: `/?message=${encodeURIComponent(message)}` });
  response.end();
}

function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

export function createApprovalUiServer(engine: TaskEngine, options: ApprovalUiOptions = {}) {
  const csrf = options.csrfToken ?? randomBytes(24).toString('hex');
  const maximum = options.maxBodyBytes ?? 16_384;
  return createServer(async (request, response) => {
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    try {
      if (!isLoopbackAddress(request.socket.remoteAddress)) {
        throw new Error('Remote client rejected');
      }
      const host = request.headers.host ?? '127.0.0.1';
      if (!/^(?:127\.0\.0\.1|localhost):\d+$/u.test(host)) {
        throw new Error('Host rejected');
      }
      const url = new URL(request.url ?? '/', `http://${host}`);
      if (request.method === 'GET' && url.pathname === '/') {
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        response.end(page(engine, csrf, url.searchParams.get('message') ?? ''));
        return;
      }
      if (request.method !== 'POST') {
        response.writeHead(404).end('Not found');
        return;
      }
      const origin = request.headers.origin;
      if (origin !== undefined && origin !== `http://${host}`) throw new Error('Origin rejected');
      const form = await body(request, maximum);
      if (form.get('csrf') !== csrf) throw new Error('CSRF token rejected');
      const id = form.get('id');
      if (id === null) throw new Error('Missing id');
      if (url.pathname === '/approve') {
        const pending = engine.getApproval(id);
        if (pending === null) throw new Error(`Approval ${id} was not found`);
        const workflow = engine.store.getEventWorkflowForApproval(pending.taskId, pending.actionId);
        const waitingWorkflow = engine.store.getWaitingEventWorkflow(pending.taskId);
        if (waitingWorkflow !== null && workflow === null) {
          throw new Error(`Approval ${id} is not the expected action for its event workflow`);
        }
        const approval = engine.approve(id, 'local-ui', form.get('confirm') === 'true');
        const result = engine.runAction(approval.taskId, approval.action, {
          approvalId: approval.id,
        });
        if (workflow === null) {
          redirect(response, result.connectorResult?.summary ?? 'Action approved.');
          return;
        }
        if (result.decision.outcome === 'take_control') {
          engine.store.setEventWorkflowStatus(
            workflow.eventId,
            approval.taskId,
            'take_control',
            approval.actionId,
          );
          redirect(response, 'Action requires take-control handling.');
          return;
        }
        if (result.decision.outcome === 'deny') {
          engine.store.setEventWorkflowStatus(
            workflow.eventId,
            approval.taskId,
            'denied',
            approval.actionId,
          );
          redirect(response, 'Action denied by policy.');
          return;
        }
        if (result.connectorResult === null || !result.connectorResult.success) {
          engine.store.setEventWorkflowStatus(
            workflow.eventId,
            approval.taskId,
            'failed',
            approval.actionId,
          );
          throw new Error(result.connectorResult?.summary ?? 'Approved action failed');
        }
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
        redirect(response, result.connectorResult?.summary ?? 'Action approved.');
        return;
      }
      if (url.pathname === '/deny') {
        const pending = engine.getApproval(id);
        const workflow =
          pending === null
            ? null
            : engine.store.getEventWorkflowForApproval(pending.taskId, pending.actionId);
        const denied = engine.deny(id, 'local-ui', form.get('reason') ?? 'Denied in local UI');
        if (workflow !== null) {
          engine.store.setEventWorkflowStatus(
            workflow.eventId,
            denied.taskId,
            'denied',
            denied.actionId,
          );
        }
        redirect(response, 'Action denied.');
        return;
      }
      if (url.pathname === '/task/stop') {
        engine.stop(id, 'Stopped in local UI');
        redirect(response, 'Task stopped.');
        return;
      }
      if (url.pathname === '/task/resume') {
        engine.resume(id);
        redirect(response, 'Task resumed.');
        return;
      }
      response.writeHead(404).end('Not found');
    } catch (error) {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
}
