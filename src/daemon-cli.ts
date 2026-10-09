import { pathToFileURL } from 'node:url';

import { loadConnectorRegistry } from './connectors/config.js';
import { RuntimeDaemon, createTaskEventHandler } from './runtime/daemon.js';
import { Scheduler } from './runtime/scheduler.js';
import { TaskEngine } from './runtime/task-engine.js';
import { WorkerPool } from './runtime/worker-pool.js';
import { SQLiteStore } from './storage/sqlite.js';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
}

export async function daemonMain(): Promise<number> {
  const store = new SQLiteStore(option('db') ?? 'data/runtime.sqlite');
  const controller = new AbortController();
  try {
    const connectorPath = option('connectors');
    const connectors =
      connectorPath === undefined ? undefined : loadConnectorRegistry(connectorPath);
    const engine = new TaskEngine(store, connectors === undefined ? {} : { connectors });
    const workers = new WorkerPool(store);
    const scheduler = new Scheduler(store);
    const pollInterval = Number(option('poll-ms') ?? '1000');
    const daemon = new RuntimeDaemon(scheduler, workers, createTaskEventHandler(engine), {
      pollIntervalMs: pollInterval,
      onError: (error) =>
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`),
    });
    if (process.argv.includes('--once')) {
      const events = await daemon.runOnce();
      process.stdout.write(
        `${JSON.stringify({ events, workerControls: workers.listTaskControls() }, null, 2)}\n`,
      );
      return 0;
    }
    const stop = (): void => {
      controller.abort();
      daemon.stop();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    await daemon.run(controller.signal);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    store.close();
  }
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  process.exitCode = await daemonMain();
}
