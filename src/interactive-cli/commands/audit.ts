import { renderTable } from '../render/table.js';
import { ansi } from '../render/ansi.js';

export async function verifyAudit(engine: any) {
  const result = await engine.verifyAudit();
  if (result.valid) {
    console.log(ansi.green('✓ Audit log is valid'));
    console.log(`Events verified: ${result.eventCount}`);
  } else {
    console.log(ansi.red('✗ Audit log verification failed'));
    console.log(`Reason: ${result.reason}`);
  }
}

export async function listAuditEvents(engine: any) {
  const events = await engine.listAuditEvents();
  const rows = events.map((e: any) => [
    e.id.substring(0, 8),
    new Date(e.timestamp).toISOString(),
    e.taskId.substring(0, 8),
    e.action || 'Unknown',
  ]);
  console.log(renderTable(['ID', 'Time', 'Task ID', 'Action'], rows));
}
