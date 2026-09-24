import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { WebSocketServer } from 'ws';
import { bus } from '../core/bus.js';
import { activeEncounter, combatLog } from '../combat/state.js';
import { campaignSnapshot, listCampaigns, setCampaignDeleted } from '../core/campaign.js';
import type { Db } from '../db/connection.js';
import { portraitsDir } from '../core/portraits.js';
import { createGameServer } from '../mcp/server.js';
import { registerRouteModules } from './routes/index.js';

export const HOST = '127.0.0.1';
export const DEFAULT_PORT = 8765;

const secretFile = fileURLToPath(new URL('../../tunnel/secret.txt', import.meta.url));
const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url));

/** The MCP endpoint is protected by an unguessable path segment shared with the OpenAI tunnel profile. */
export function readOrCreateSecret(): string {
  if (existsSync(secretFile)) {
    const existing = readFileSync(secretFile, 'utf8').trim();
    if (existing) return existing;
  }
  const secret = randomBytes(16).toString('hex');
  mkdirSync(dirname(secretFile), { recursive: true });
  writeFileSync(secretFile, secret, 'utf8');
  return secret;
}

/**
 * The companion UI and the WebSocket are same-origin only. Non-browser clients (the tunnel,
 * Claude Desktop, curl) send no Origin header and are let through; the Vite dev server is
 * allowed outside production, or via DND_AI_DEV_ORIGIN.
 */
export function originAllowed(origin: string | undefined, port: number): boolean {
  if (!origin) return true;
  const allowed = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  if (process.env.DND_AI_DEV_ORIGIN) allowed.push(process.env.DND_AI_DEV_ORIGIN);
  if (process.env.NODE_ENV !== 'production') allowed.push('http://127.0.0.1:5173', 'http://localhost:5173');
  return allowed.includes(origin);
}

export function log(...parts: unknown[]): void {
  console.log(new Date().toISOString(), ...parts);
}

export async function createApp(db: Db, secret: string) {
  const mcpPath = `/mcp/${secret}`;
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  app.use((req, _res, next) => {
    log(req.method, req.path.replace(secret, '<secret>'));
    next();
  });

  app.get('/healthz', (_req, res) => {
    res.type('text/plain').send('ok');
  });

  app.post(mcpPath, async (req, res) => {
    const calls = new Map<unknown, string>();
    for (const message of Array.isArray(req.body) ? req.body : [req.body]) {
      if (message?.method === 'tools/call') {
        calls.set(message.id, String(message.params?.name));
        log('tools/call', message.params?.name, truncate(JSON.stringify(message.params?.arguments ?? {}), 300));
      }
    }
    if (calls.size > 0) logToolResults(res, calls, Date.now());
    // Stateless pattern: a fresh server and transport per request, torn down when the response closes.
    const server = createGameServer(db);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log('error handling MCP request:', (err as Error).message);
      if (!res.headersSent) res.status(500).json({ error: 'internal error' });
    }
  });

  app.use('/api', (req, res, next) => {
    if (!originAllowed(req.headers.origin, req.socket.localPort ?? 0)) {
      res.status(403).type('text/plain').send('Forbidden');
      return;
    }
    next();
  });

  registerApi(app, db);
  await registerRouteModules(app, db);
  app.use('/portraits', express.static(portraitsDir()));
  serveCompanionUi(app);

  app.use((_req, res) => {
    res.status(404).type('text/plain').send('Not found');
  });

  return { app, mcpPath };
}

/** Live game state for the companion UI: subscribe, get a snapshot, then every event for that campaign. */
export function attachWebSocket(httpServer: Server, db: Db): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  wss.on('connection', (socket, request) => {
    if (!originAllowed(request.headers.origin, request.socket.localPort ?? 0)) {
      socket.close(1008, 'forbidden origin');
      return;
    }
    let campaignId: number | null = null;
    const unsubscribe = bus.subscribe((event) => {
      if (campaignId !== null && event.campaign_id === campaignId) {
        socket.send(JSON.stringify({ type: 'event', event }));
      }
    });
    socket.on('message', (raw) => {
      try {
        const message = JSON.parse(String(raw)) as { type?: string; campaignId?: number };
        if (message.type !== 'subscribe' || typeof message.campaignId !== 'number') {
          throw new Error('expected {"type":"subscribe","campaignId":<id>}');
        }
        campaignId = message.campaignId;
        socket.send(
          JSON.stringify({ type: 'snapshot', data: campaignSnapshot(db, campaignId, { forPlayer: true }) }),
        );
        log('ws subscribe', campaignId);
      } catch (err) {
        socket.send(JSON.stringify({ type: 'error', message: (err as Error).message }));
      }
    });
    socket.on('close', unsubscribe);
  });
  return wss;
}

export async function startHttpServer(
  db: Db,
  options: { port?: number; secret?: string } = {},
): Promise<{ server: Server; port: number; mcpPath: string; close: () => Promise<void> }> {
  const secret = options.secret ?? readOrCreateSecret();
  const port = options.port ?? Number(process.env.DND_AI_PORT ?? DEFAULT_PORT);
  const { app, mcpPath } = await createApp(db, secret);
  const server = createServer(app);
  const wss = attachWebSocket(server, db);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, resolve);
  });
  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;

  return {
    server,
    port: boundPort,
    mcpPath,
    close: async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

interface RollRow {
  id: number;
  event_id: number | null;
  expr: string;
  results_json: string;
  total: number;
  purpose: string | null;
  dc: number | null;
  outcome: string | null;
  overridden: number;
  ts: string;
}

/** JSON the companion UI needs beyond the WebSocket snapshot. */
function registerApi(app: express.Express, db: Db): void {
  app.get('/api/campaigns', (req, res) => {
    res.json(listCampaigns(db, req.query.include_deleted === '1'));
  });

  // Restoring a soft-deleted campaign is the player's call, never the DM's; permanent delete lives in a route module.
  app.post('/api/campaigns/:id/restore', (req, res) => {
    softDelete(req, res, db, false);
  });

  app.get('/api/campaigns/:id/glossary', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad campaign id' });
      return;
    }
    const rows = db
      .prepare(
        'SELECT term, definition, source, chapter_id FROM glossary_entry WHERE campaign_id IS NULL OR campaign_id = ? ORDER BY term COLLATE NOCASE',
      )
      .all(id);
    res.json(rows);
  });

  app.get('/api/campaigns/:id/rolls', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad campaign id' });
      return;
    }
    const requested = Number(req.query.limit);
    const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 200) : 50;
    const rows = db
      .prepare(
        'SELECT id, event_id, expr, results_json, total, purpose, dc, outcome, overridden, ts FROM roll WHERE campaign_id = ? ORDER BY id DESC LIMIT ?',
      )
      .all(id, limit) as RollRow[];
    res.json(
      rows.map(({ results_json, ...roll }) => ({ ...roll, groups: safeParse(results_json) })),
    );
  });

  // The battle screen replays a whole fight, so this one runs oldest first over the active encounter by default.
  app.get('/api/campaigns/:id/combat-log', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad campaign id' });
      return;
    }
    const wanted = req.query.encounter;
    let encounterId: number | null;
    if (wanted === undefined || wanted === 'current') {
      encounterId = activeEncounter(db, id)?.id ?? null;
    } else {
      const asked = Number(wanted);
      if (!Number.isInteger(asked)) {
        res.status(400).json({ error: 'bad encounter id' });
        return;
      }
      const row = db.prepare('SELECT id FROM encounter WHERE id = ? AND campaign_id = ?').get(asked, id) as
        | { id: number }
        | undefined;
      if (!row) {
        res.status(404).json({ error: 'no such encounter in this campaign' });
        return;
      }
      encounterId = row.id;
    }
    if (encounterId === null) {
      res.json([]);
      return;
    }
    const requested = Number(req.query.limit);
    const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 1000) : 500;
    res.json(combatLog(db, encounterId, limit));
  });
}

function softDelete(req: express.Request, res: express.Response, db: Db, deleted: boolean): void {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: 'bad campaign id' });
    return;
  }
  if (!setCampaignDeleted(db, id, deleted)) {
    res.status(404).json({ error: 'no such campaign' });
    return;
  }
  res.status(204).end();
}

/** The companion UI is a plain Vite build; unknown navigations fall back to index.html, everything else 404s. */
function serveCompanionUi(app: express.Express): void {
  if (!existsSync(webDist)) {
    log(`companion UI not built: ${webDist} is missing (run "npm install && npm run build" in web/)`);
    return;
  }
  app.use(express.static(webDist));
  app.use((req, res, next) => {
    const reserved = /^\/(api\/|mcp|ws|healthz)/.test(req.path);
    if (req.method === 'GET' && !reserved && String(req.headers.accept ?? '').includes('text/html')) {
      res.sendFile(join(webDist, 'index.html'));
      return;
    }
    next();
  });
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}

/**
 * Logs how each tools/call ended - ok or error (schema rejections included), duration, reply size in
 * bytes and the start of the reply - by reading the JSON body on its way out. This is the baseline the tool-surface
 * consolidation is measured against.
 */
function logToolResults(res: express.Response, calls: Map<unknown, string>, startedAt: number): void {
  type Reply = { id?: unknown; result?: { isError?: boolean; content?: Array<{ type: string; text?: string }> }; error?: { message?: string } };
  const chunks: string[] = [];
  const collect = (chunk: unknown): void => {
    if (typeof chunk === 'string') chunks.push(chunk);
    else if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk).toString('utf8'));
  };
  // The body arrives as write() chunks and/or the end() argument depending on how the transport streams it.
  const write = res.write.bind(res) as (...args: unknown[]) => boolean;
  const end = res.end.bind(res) as (...args: unknown[]) => express.Response;
  res.write = ((...args: unknown[]) => {
    collect(args[0]);
    return write(...args);
  }) as typeof res.write;
  res.end = ((...args: unknown[]) => {
    collect(args[0]);
    const body = safeParse(chunks.join(''));
    for (const message of Array.isArray(body) ? body : [body]) {
      const m = message as Reply | null;
      if (!m) continue;
      const name = calls.get(m.id);
      if (!name) continue;
      const outcome = m.error || m.result?.isError ? 'error' : 'ok';
      const text = m.error?.message ?? m.result?.content?.find((c) => c.type === 'text')?.text ?? '';
      // The reply's size on the wire is what the tool-surface audit weighs a chatty tool by.
      const bytes = Buffer.byteLength(JSON.stringify(m.error ?? m.result ?? null), 'utf8');
      log('tools/result', name, outcome, `${Date.now() - startedAt}ms`, `${bytes}B`, truncate(text, 300));
    }
    return end(...args);
  }) as typeof res.end;
}
