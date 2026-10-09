import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promises as fsPromises } from 'node:fs';

import type { TaskEngine } from '../runtime/task-engine.js';
import { Scheduler } from '../runtime/scheduler.js';
import type { ApiServerOptions, Route } from './types.js';
import { initAuthToken } from './middleware/auth.js';
import { authMiddleware } from './middleware/auth.js';
import { corsMiddleware } from './middleware/cors.js';
import { withErrorHandler } from './middleware/error-handler.js';
import { jsonResponse } from './utils.js';
import { registerTaskRoutes } from './routes/tasks.js';
import { registerApprovalRoutes } from './routes/approvals.js';
import { registerSkillRoutes } from './routes/skills.js';
import { registerScheduleRoutes } from './routes/schedules.js';
import { registerAuditRoutes } from './routes/audit.js';
import { registerConnectorRoutes } from './routes/connectors.js';
import { handleSseConnection } from './routes/events.js';

export function createApiServer(engine: TaskEngine, options: ApiServerOptions = {}) {
  const token = initAuthToken();
  const scheduler = new Scheduler(engine.store);

  const routes: Route[] = [
    ...registerTaskRoutes(engine),
    ...registerApprovalRoutes(engine),
    ...registerSkillRoutes(engine),
    ...registerScheduleRoutes(engine.store, scheduler),
    ...registerAuditRoutes(engine),
    ...registerConnectorRoutes(engine),
    {
      method: 'GET',
      pattern: /^\/api\/v1\/dashboard$/u,
      paramNames: [],
      handler: async (_req: IncomingMessage, res: ServerResponse) => {
        const tasks = engine.listTasks();
        const allApprovals = engine.listApprovals();
        const pendingApprovals = allApprovals.filter((a) => a.status === 'pending');
        const audit = engine.verifyAudit();
        const skills = engine.skills.listRecords();
        const schedules = engine.store.listSchedules();
        jsonResponse(res, 200, {
          tasks,
          pendingApprovals,
          audit,
          stats: {
            taskCount: tasks.length,
            runningCount: tasks.filter((t) => t.status === 'running').length,
            pendingApprovalCount: pendingApprovals.length,
            skillCount: skills.length,
            scheduleCount: schedules.length,
          },
        });
      },
    },
  ];

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' https://fonts.gstatic.com; connect-src 'self'",
    );

    await withErrorHandler(req, res, async () => {
      await corsMiddleware(req, res, async () => {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);

        if (url.pathname.startsWith('/api/')) {
          await authMiddleware(req, res, async () => {
            // SSE is inside authMiddleware — authenticated access only
            if (url.pathname === '/api/v1/events' && req.method === 'GET') {
              handleSseConnection(req, res, engine);
              return;
            }

            for (const route of routes) {
              if (route.method !== req.method) continue;
              const match = url.pathname.match(route.pattern);
              if (match !== null) {
                const params: Record<string, string> = {};
                for (let i = 0; i < route.paramNames.length; i++) {
                  const name = route.paramNames[i];
                  if (name !== undefined) params[name] = match[i + 1] ?? '';
                }
                await route.handler(req, res, params);
                return;
              }
            }
            jsonResponse(res, 404, { error: 'Not Found' });
          });
          return;
        }

        // Serve built static web UI
        const webDistPath = resolve(
          options.webRoot ?? join(dirname(fileURLToPath(import.meta.url)), '../../../web/dist'),
        );
        let cleanPath: string;
        try {
          cleanPath = decodeURIComponent(url.pathname);
        } catch {
          jsonResponse(res, 400, { error: 'Malformed URL path' });
          return;
        }
        if (cleanPath === '/') {
          cleanPath = '/index.html';
        }
        const requestedPath = cleanPath.replace(/^\/+/, '');
        let filePath = resolve(webDistPath, requestedPath);

        // Safe static-file path handling (prevent directory traversal)
        const relativePath = relative(webDistPath, filePath);
        if (
          isAbsolute(relativePath) ||
          relativePath === '..' ||
          relativePath.startsWith(`..${sep}`)
        ) {
          jsonResponse(res, 403, { error: 'Forbidden' });
          return;
        }

        let stats;
        try {
          stats = await fsPromises.stat(filePath);
        } catch {
          // SPA fallback: try index.html
          filePath = join(webDistPath, 'index.html');
          try {
            stats = await fsPromises.stat(filePath);
          } catch {
            // index.html doesn't exist - no web build found
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`
              <!doctype html>
              <html lang="ja">
              <head>
                <meta charset="utf-8">
                <title>Spark Runtime - Setup</title>
                <style>
                  body { font-family: sans-serif; padding: 40px; line-height: 1.6; max-width: 600px; margin: 0 auto; }
                  .card { border: 1px solid #ccc; padding: 20px; border-radius: 8px; background: #fafafa; }
                  code { background: #eee; padding: 2px 6px; border-radius: 4px; font-family: monospace; }
                </style>
              </head>
              <body>
                <div class="card">
                  <h2>Spark Runtime (Web UIがビルドされていません)</h2>
                  <p>Web UIを表示するには、プロジェクトのルートで <code>npm run web:build</code> を実行してフロントエンドをビルドしてください。</p>
                  <p>APIサーバーは正常に起動しています。START.commandをもう一度実行するか、<code>npm run web:build</code>の後にページを再読み込みしてください。</p>
                </div>
              </body>
              </html>
            `);
            return;
          }
        }

        if (stats.isDirectory()) {
          filePath = join(webDistPath, 'index.html');
        }

        try {
          let content: string | Buffer = await fsPromises.readFile(filePath);
          const ext = extname(filePath).toLowerCase();

          let contentType = 'application/octet-stream';
          const contentTypes: Record<string, string> = {
            '.html': 'text/html; charset=utf-8',
            '.js': 'application/javascript; charset=utf-8',
            '.css': 'text/css; charset=utf-8',
            '.json': 'application/json; charset=utf-8',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.gif': 'image/gif',
            '.svg': 'image/svg+xml',
            '.ico': 'image/x-icon',
          };
          if (ext in contentTypes) {
            contentType = contentTypes[ext]!;
          }

          if (ext === '.html') {
            let htmlStr = content.toString('utf8');
            const metaTag = `<meta name="spark-token" content="${token.replaceAll('"', '&quot;')}">`;
            if (htmlStr.includes('<head>')) {
              htmlStr = htmlStr.replace('<head>', `<head>${metaTag}`);
            } else {
              htmlStr = metaTag + htmlStr;
            }
            content = htmlStr;
          }

          res.writeHead(200, { 'Content-Type': contentType });
          res.end(content);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          jsonResponse(res, 500, { error: `Internal Server Error: ${errMsg}` });
        }
      });
    });
  });

  const port = options.port ?? 4317;
  const host = options.host ?? '127.0.0.1';

  return {
    server,
    token,
    listen: () => {
      server.listen(port, host, () => {
        process.stdout.write(`\nSpark Runtime API: http://${host}:${port}\n`);
        process.stdout.write('Web UIには認証情報を自動設定しました。\n\n');
      });
    },
    close: (callback?: () => void) => {
      server.close(callback);
    },
  };
}
