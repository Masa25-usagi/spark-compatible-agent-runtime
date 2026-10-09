import { renderTable } from '../render/table.js';
import { renderApprovalCard } from '../render/approval-card.js';
import { promptConfirm, promptLine } from '../input/prompt.js';

export async function listApprovals(engine: any) {
  const approvals = await engine.listApprovals();
  const rows = approvals.map((a: any) => [
    a.id.substring(0, 8),
    a.taskId.substring(0, 8),
    a.action,
    a.status,
  ]);

  console.log(renderTable(['ID', 'Task ID', 'Action', 'Status'], rows));
}

export async function showApproval(engine: any, approvalId: string) {
  const approval = await engine.getApproval(approvalId);
  if (!approval) {
    console.log('Approval not found.');
    return;
  }
  console.log(renderApprovalCard(approval));
}

export async function acceptApproval(engine: any, approvalId: string) {
  const confirm = await promptConfirm('Accept this approval?');
  if (confirm) {
    await engine.approve(approvalId, 'cli-user');
    console.log('Approval accepted.');
  }
}

export async function denyApproval(engine: any, approvalId: string) {
  const reason = await promptLine('Denial reason:');
  await engine.deny(approvalId, 'cli-user', reason);
  console.log('Approval denied.');
}
