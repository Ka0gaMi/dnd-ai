import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { registerOpTool } from '../src/mcp/tools/op.js';

type SampleArgs = { op: string; campaign_id: number; item_id?: number; qty?: number | null };

const seen: SampleArgs[] = [];

type SampleOp = { summary: string; requires: ReadonlyArray<never>; run: (args: SampleArgs) => Promise<CallToolResult> };

const sampleOp = (echo: unknown): SampleOp => ({
  summary: 'Echo the args back',
  requires: [],
  run: async (args) => {
    seen.push(args);
    return { content: [{ type: 'text', text: JSON.stringify(echo) }] };
  },
});

async function setup(): Promise<Client> {
  const server = new McpServer({ name: 'op-tool-test', version: '0.0.0' });
  registerOpTool(server, 'inventory', {
    title: 'Inventory actions',
    description: 'One tool for adding, removing and listing inventory items.',
    fields: {
      campaign_id: z.number().int().describe('The campaign.'),
      item_id: z.number().int().optional().describe('The item.'),
      qty: z.number().int().nullable().optional().describe('How many.'),
    },
    ops: {
      add: { ...sampleOp('added'), requires: ['item_id'] },
      remove: { ...sampleOp('removed'), requires: ['item_id', 'qty'] },
      list: { ...sampleOp('listed') },
    },
    annotations: { title: 'Inventory actions' },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

let client: Client;

beforeEach(async () => {
  seen.length = 0;
  client = await setup();
});

const textOf = (result: CallToolResult | { content: Array<{ text: string }> }): string =>
  (result.content as Array<{ text: string }>)[0]!.text;

describe('registerOpTool', () => {
  it('advertises the flat schema: op enum in order, op required, per-op lines in the description', async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'inventory')!;
    expect(tool.title).toBe('Inventory actions');
    const props = (tool.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties;
    expect(props.op!.enum).toEqual(['add', 'remove', 'list']);
    expect(tool.inputSchema!.required).toEqual(['op', 'campaign_id']);
    expect((tool.inputSchema!.properties as Record<string, { description?: string }>).qty!.description).toBe('How many.');
    const description = tool.description ?? '';
    expect(description).toContain('op=remove: Echo the args back. Requires item_id, qty.');
    expect(description).toContain('op=add: Echo the args back. Requires item_id.');
    expect(description).toContain('op=list: Echo the args back. Requires nothing beyond campaign_id.');
    expect(description).toContain('You must set op; there is no default.');
  });

  it('keeps the caller description when it already says "no default"', async () => {
    const server = new McpServer({ name: 'op-tool-test-2', version: '0.0.0' });
    registerOpTool(server, 'inventory2', {
      title: 'Inventory actions',
      description: 'One tool for inventory. You must set op; there is no default.',
      fields: { campaign_id: z.number().int() },
      ops: { list: { ...sampleOp('listed') } },
      annotations: {},
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: 'test2', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), c.connect(clientTransport)]);
    const { tools } = await c.listTools();
    const description = tools.find((t) => t.name === 'inventory2')!.description ?? '';
    expect(description).toContain('You must set op; there is no default.');
    expect(description.split('You must set op; there is no default.').length - 1).toBe(1);
  });

  it('answers a missing required field with a teaching error, one field', async () => {
    const result = (await client.callTool({
      name: 'inventory',
      arguments: { op: 'remove', campaign_id: 1, item_id: 7 },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Missing qty for op=remove (requires item_id, qty). Re-call with qty set.');
    expect(seen).toHaveLength(0);
  });

  it('answers missing required fields with a teaching error, two fields', async () => {
    const result = (await client.callTool({
      name: 'inventory',
      arguments: { op: 'remove', campaign_id: 1 },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^Missing item_id, qty for op=remove \(requires item_id, qty\)\./);
  });

  it('runs an op that requires nothing and passes the parsed args through', async () => {
    const result = (await client.callTool({ name: 'inventory', arguments: { op: 'list', campaign_id: 3 } })) as CallToolResult;
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(textOf(result))).toEqual('listed');
    expect(seen[0]).toEqual({ op: 'list', campaign_id: 3 });
  });

  it('runs an op and its handler receives op in args', async () => {
    await client.callTool({ name: 'inventory', arguments: { op: 'add', campaign_id: 3, item_id: 9 } });
    expect(seen[0]).toEqual({ op: 'add', campaign_id: 3, item_id: 9 });
  });

  it('answers an op outside the enum with the SDK validation error as isError', async () => {
    const result = (await client.callTool({
      name: 'inventory',
      arguments: { op: 'drop', campaign_id: 1 },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/expected one of "add"\|"remove"\|"list" at op/);
  });
  it('treats null as absent: a nullable field sent as null fails the required check and never reaches run', async () => {
    const missing = (await client.callTool({
      name: 'inventory',
      arguments: { op: 'remove', campaign_id: 3, item_id: 9, qty: null },
    })) as CallToolResult;
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toMatch(/^Missing qty for op=remove/);
    expect(seen).toHaveLength(0);
  });

  it('leaves a null on a non-nullable field to the schema, as every other tool does', async () => {
    const refused = (await client.callTool({
      name: 'inventory',
      arguments: { op: 'add', campaign_id: 3, item_id: null },
    })) as CallToolResult;
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain('expected number, received null at item_id');
    expect(seen).toHaveLength(0);
  });
});
