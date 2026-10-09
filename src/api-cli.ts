import { pathToFileURL } from 'node:url';

import { loadConnectorRegistry } from './connectors/config.js';
import { TaskEngine } from './runtime/task-engine.js';
import { SQLiteStore } from './storage/sqlite.js';
import { createApiServer } from './api/server.js';
import { shutdownAgentDispatcher } from './runtime/agent-dispatcher.js';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
}

export function apiMain(): number {
  const store = new SQLiteStore(option('db') ?? 'data/runtime.sqlite');
  try {
    const connectorPath = option('connectors');
    const connectors =
      connectorPath === undefined ? undefined : loadConnectorRegistry(connectorPath);
    const engine = new TaskEngine(store, connectors === undefined ? {} : { connectors });
    const port = Number(option('port') ?? '4317');
    const api = createApiServer(engine, { port });
    api.listen();
    const stop = (): void => {
      shutdownAgentDispatcher(engine)
        .catch((err) => {
          process.stderr.write(`Error during dispatcher shutdown: ${err}\n`);
        })
        .finally(() => {
          api.close(() => store.close());
        });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    return 0;
  } catch (error) {
    store.close();
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  process.exitCode = apiMain();
}
