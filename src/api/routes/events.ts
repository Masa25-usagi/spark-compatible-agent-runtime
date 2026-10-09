import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TaskEngine } from '../../runtime/task-engine.js';

export function handleSseConnection(
  req: IncomingMessage,
  res: ServerResponse,
  engine: TaskEngine,
): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const sendEvent = (event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  sendEvent('ping', { time: Date.now() });

  let lastTasksJson = JSON.stringify(engine.listTasks());
  let lastApprovalsJson = JSON.stringify(engine.listApprovals());

  const pollInterval = setInterval(() => {
    try {
      const currentTasksJson = JSON.stringify(engine.listTasks());
      if (currentTasksJson !== lastTasksJson) {
        sendEvent('task-update', JSON.parse(currentTasksJson));
        lastTasksJson = currentTasksJson;
      }
      const currentApprovalsJson = JSON.stringify(engine.listApprovals());
      if (currentApprovalsJson !== lastApprovalsJson) {
        sendEvent('approval-update', JSON.parse(currentApprovalsJson));
        lastApprovalsJson = currentApprovalsJson;
      }
    } catch {
      // Ignore polling errors
    }
  }, 2000);

  const pingInterval = setInterval(() => {
    try {
      sendEvent('ping', { time: Date.now() });
    } catch {
      // Ignore write errors
    }
  }, 15000);

  req.on('close', () => {
    clearInterval(pollInterval);
    clearInterval(pingInterval);
  });
}
