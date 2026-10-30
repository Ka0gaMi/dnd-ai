// The real HTTP server serves 2025-era clients plain JSON and 2026-07-28 clients through the SDK handler.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, InMemoryTransport, ProtocolError, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';
import { HOST, startHttpServer } from '../src/transport/http.js';

const SECRET = 'erassecret0123456789abcdef012345';
const MODERN = '2026-07-28';
const ERAS = ['legacy', MODERN] as const;
type Era = (typeof ERAS)[number];

let db: Db | undefined;
let base: string;
let port: number;
let stop: (() => Promise<void>) | undefined;
let registered: string[];

beforeAll(async () => {
  const opened = openDb(':memory:');
  db = opened;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const local = new Client({ name: 'registry', version: '0.0.0' });
  await Promise.all([createGameServer(opened).connect(serverTransport), local.connect(clientTransport)]);
  registered = (await local.listTools()).tools.map((tool) => tool.name).sort();
  await local.close();
  const started = await startHttpServer(opened, { port: 0, secret: SECRET });
  port = started.port;
  base = `http://${HOST}:${port}`;
  stop = started.close;
});

afterAll(async () => {
  await stop?.();
  db?.close();
});

interface Exchange {
  method: string;
  status: number;
  contentType: string;
}

async function connect(era: Era, exchanges: Exchange[] = []): Promise<Client> {
  const client = new Client(
    { name: `eras-${era}`, version: '0.0.0' },
    { versionNegotiation: { mode: era === 'legacy' ? 'legacy' : { pin: era } } },
  );
  const recording = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const res = await fetch(input, init);
    if (init?.method === 'POST') {
      const { method } = JSON.parse(String(init.body)) as { method?: string };
      exchanges.push({ method: method ?? '', status: res.status, contentType: res.headers.get('content-type') ?? '' });
    }
    return res;
  };
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${SECRET}`), { fetch: recording }));
  return client;
}

describe.each(ERAS)('a %s client over http', (era) => {
  it('negotiates its era, lists the registered tools and calls a read-only one', async () => {
    const exchanges: Exchange[] = [];
    const client = await connect(era, exchanges);
    try {
      expect(client.getProtocolEra()).toBe(era === 'legacy' ? 'legacy' : 'modern');
      const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
      expect(names).toEqual(registered);
      const result = await client.callTool({ name: 'read_guide', arguments: { section: 'rolls' } });
      expect(result.isError).toBeFalsy();
      expect(result.content).toEqual([expect.objectContaining({ type: 'text' })]);
    } finally {
      await client.close();
    }
    expect(exchanges[0]?.method).toBe(era === 'legacy' ? 'initialize' : 'server/discover');
    // The OpenAI tunnel reads 2025-era replies as plain JSON, as enableJsonResponse did under SDK v1.
    const replies = exchanges.filter((exchange) => exchange.status === 200);
    expect(replies.map((reply) => reply.method)).toEqual(expect.arrayContaining(['tools/list', 'tools/call']));
    expect(replies.every((reply) => reply.contentType.includes('application/json'))).toBe(true);
  });

  it('rejects an unknown tool with a -32602 protocol error', async () => {
    const client = await connect(era);
    try {
      const call = client.callTool({ name: 'no_such_tool', arguments: {} });
      await expect(call).rejects.toBeInstanceOf(ProtocolError);
      await expect(call).rejects.toMatchObject({ code: -32602 });
    } finally {
      await client.close();
    }
  });

  it('logs every tools/call and its result', async () => {
    const client = await connect(era);
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => {
      lines.push(parts.map(String).join(' '));
    });
    try {
      await client.callTool({ name: 'read_guide', arguments: { section: 'rolls' } });
      await client.callTool({ name: 'no_such_tool', arguments: {} }).catch(() => undefined);
    } finally {
      spy.mockRestore();
      await client.close();
    }
    expect(lines.some((line) => /tools\/call read_guide \{"section":"rolls"\}/.test(line))).toBe(true);
    expect(lines.some((line) => /tools\/result read_guide ok \d+ms [1-9]\d*B /.test(line))).toBe(true);
    expect(lines.some((line) => /tools\/result no_such_tool error \d+ms [1-9]\d*B Tool no_such_tool not found/.test(line))).toBe(
      true,
    );
  });
});

interface RawReply {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
}

/** A plain node:http POST, so the framing headers are seen exactly as sent and Host can be anything. */
function rawPost(body: unknown, headers: Record<string, string> = {}): Promise<RawReply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: HOST,
        port,
        path: `/mcp/${SECRET}`,
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

describe('the mcp path', () => {
  it('answers only POST; a GET never falls through to the companion UI', async () => {
    const res = await fetch(`${base}/mcp/${SECRET}`, { headers: { accept: 'text/html' } });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('text/plain');
  });

  it('frames 2025-era JSON replies with Content-Length instead of chunked encoding', async () => {
    const initialize = await rawPost({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0.0.0' } },
    });
    const call = await rawPost({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'read_guide', arguments: { section: 'rolls' } },
    });
    for (const reply of [initialize, call]) {
      expect(reply.status).toBe(200);
      expect(reply.headers['content-type']).toContain('application/json');
      expect(reply.headers['transfer-encoding']).toBeUndefined();
      expect(Number(reply.headers['content-length'])).toBe(Buffer.byteLength(reply.text, 'utf8'));
    }
  });

  it('never logs the secret when a request fails', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => {
      lines.push(parts.map(String).join(' '));
    });
    // A Host with a space cannot become a URL, so the adapter fails with the full request URL in its message.
    const reply = await rawPost({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }, { host: 'a b' }).finally(() =>
      spy.mockRestore(),
    );
    expect(reply.status).toBe(500);
    expect(lines.some((line) => line.includes('error handling MCP request:') && line.includes('<secret>'))).toBe(true);
    expect(lines.filter((line) => line.includes(SECRET))).toEqual([]);
  });
});

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

describe.each(ERAS)('a %s client over stdio', (era) => {
  it('gets the registered tools from a child on a throwaway database', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dnd-eras-stdio-'));
    // DND_AI_DB keeps the child off the default data/dnd-ai.sqlite.
    const env = { ...process.env, DND_AI_DB: join(dir, 'stdio.sqlite') } as Record<string, string>;
    const client = new Client(
      { name: `eras-stdio-${era}`, version: '0.0.0' },
      { versionNegotiation: { mode: era === 'legacy' ? 'legacy' : { pin: era } } },
    );
    const errors: Error[] = [];
    client.onerror = (error) => errors.push(error);
    try {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: ['--import', 'tsx', 'src/bin/stdio.ts'],
          cwd: repoRoot,
          env,
          stderr: 'ignore',
        }),
      );
      expect(client.getProtocolEra()).toBe(era === 'legacy' ? 'legacy' : 'modern');
      const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
      expect(names).toEqual(registered);
      expect(errors).toEqual([]);
    } finally {
      try {
        await client.close();
      } finally {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    }
  });
});

describe('the stdio server', () => {
  // The SDK client skips stdout lines that are not JSON, so only a raw read of the pipe catches stray output.
  it('writes nothing but JSON-RPC to stdout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dnd-eras-stdout-'));
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/bin/stdio.ts'], {
      cwd: repoRoot,
      env: { ...process.env, DND_AI_DB: join(dir, 'stdio.sqlite') },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    try {
      let stdout = '';
      const complete = (): string[] => stdout.split('\n').slice(0, -1).filter((line) => line.trim() !== '');
      const isJsonRpc = (line: string): boolean => {
        try {
          return (JSON.parse(line) as { jsonrpc?: unknown }).jsonrpc === '2.0';
        } catch {
          return false;
        }
      };
      const listed = new Promise<void>((resolve, reject) => {
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
          if (complete().some((line) => isJsonRpc(line) && (JSON.parse(line) as { id?: unknown }).id === 2)) resolve();
        });
        child.on('exit', (code) => reject(new Error(`stdio server exited with ${code}`)));
      });
      const messages = [
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0.0.0' } },
        },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      ];
      child.stdin.write(messages.map((message) => `${JSON.stringify(message)}\n`).join(''));
      await listed;
      expect(complete().filter((line) => !isJsonRpc(line))).toEqual([]);
    } finally {
      // The child holds the database open until it is gone, so wait for it before removing the folder.
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((resolve) => child.once('exit', resolve));
        child.kill();
        await exited;
      }
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
