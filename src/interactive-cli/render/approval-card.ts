import { ansi, box } from './ansi.js';
import type { ApprovalRecord } from '../../domain/types.js';

export function renderApprovalCard(approval: ApprovalRecord): string {
  const width = 60;
  const d = approval.disclosure;

  const hLine = box.horizontal.repeat(width - 2);
  const borderTop = `${box.topLeft}${hLine}${box.topRight}`;
  const borderBottom = `${box.bottomLeft}${hLine}${box.bottomRight}`;
  const borderMid = `${box.tRight}${hLine}${box.tLeft}`;

  const pad = (s: string, len: number) => {
    const rawLen = s.replace(/\x1b\[[0-9;]*m/g, '').length;
    return s + ' '.repeat(Math.max(0, len - rawLen));
  };

  const line = (s: string) => `${box.vertical} ${pad(s, width - 4)} ${box.vertical}`;

  const card = [
    borderTop,
    line(ansi.bold(ansi.yellow(`Approval Required: ${approval.action}`))),
    line(`ID: ${ansi.dim(approval.id)}`),
    borderMid,
    line(ansi.cyan('Operation: ') + String(d.operation || 'Unknown')),
    line(ansi.cyan('Target: ') + String(d.targetSummary || 'None')),
    line(ansi.cyan('Before: ') + String(d.beforeSummary || 'N/A')),
    line(ansi.cyan('After: ') + String(d.afterSummary || 'N/A')),
  ];

  if (d.itemCount !== undefined) card.push(line(ansi.cyan('Item Count: ') + String(d.itemCount)));
  if (d.dataSizeBytes !== undefined)
    card.push(line(ansi.cyan('Size: ') + String(d.dataSizeBytes) + ' bytes'));
  if (d.recipient) card.push(line(ansi.cyan('Recipient: ') + String(d.recipient)));
  if (d.amount !== undefined) card.push(line(ansi.cyan('Amount: ') + String(d.amount)));

  card.push(line(ansi.cyan('Reversible: ') + (d.reversible ? ansi.green('Yes') : ansi.red('No'))));
  if (d.reversible && d.undoMethod) {
    card.push(line(ansi.cyan('Undo Method: ') + String(d.undoMethod)));
  }

  card.push(borderBottom);

  return card.join('\n');
}
