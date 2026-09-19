import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

export interface OpSpec<Shape extends z.ZodRawShape> {
  /** One line for the tool description: what this op does, without a trailing period. */
  summary: string;
  /** Root fields this op requires (besides op and campaign_id); checked server-side before run. */
  requires: ReadonlyArray<keyof Shape & string>;
  /** The optional fields this op reads besides requires; any other declared field is refused. */
  uses?: ReadonlyArray<keyof Shape & string>;
  run: (args: z.infer<z.ZodObject<Shape>> & { op: string }) => CallToolResult | Promise<CallToolResult>;
}

export interface OpToolConfig<Shape extends z.ZodRawShape, Ops extends Record<string, OpSpec<Shape>>> {
  title: string;
  /** The family-level text; the per-op lines are appended by the helper. */
  description: string;
  /** Every field any op uses, each already .optional() unless shared by all ops (campaign_id is typically required). */
  fields: Shape;
  /** Fields every op may take (e.g. character_id); the non-optional fields of `fields` are shared implicitly. */
  shared?: ReadonlyArray<keyof Shape & string>;
  ops: Ops;
  annotations: ToolAnnotations;
}

const OP_LINE = 'You must set op; there is no default.';

const sentence = (text: string): string => text.replace(/\.\s*$/, '');

/**
 * Registers one MCP tool whose required `op` enum picks the operation, so same-noun families stop multiplying tools.
 * The helper owns only validation and the description; each op's `run` touches the DB and calls reply() itself.
 * A `null` argument counts as absent and is stripped before `run`, so a client that sends null for "unset" cannot
 * pass the required-field check with nothing.
 */
export function registerOpTool<Shape extends z.ZodRawShape, Ops extends Record<string, OpSpec<Shape>>>(
  server: McpServer,
  name: string,
  config: OpToolConfig<Shape, Ops>,
): void {
  const names = Object.keys(config.ops);
  // What every op needs anyway: the caller's fields that are not optional (usually campaign_id).
  const baseline = Object.entries(config.fields)
    .filter(([, schema]) => !(schema as z.ZodTypeAny).isOptional())
    .map(([field]) => field);
  const shared = config.shared ?? [];
  const perOp = names.map((name_) => {
    const { summary, requires, uses = [] } = config.ops[name_]!;
    const needs =
      requires.length > 0
        ? `Requires ${requires.join(', ')}`
        : baseline.length > 0
          ? `Requires nothing beyond ${baseline.join(', ')}`
          : 'Requires nothing else';
    const tail = uses.length > 0 ? `${needs}; also ${uses.join(', ')}.` : `${needs}.`;
    return `op=${name_}: ${sentence(summary)}. ${tail}`;
  });
  const family = config.description.includes(OP_LINE) ? config.description : `${sentence(config.description)}. ${OP_LINE}`;
  const description = `${family}\n\n${perOp.join('\n')}`;
  const inputSchema: { op: z.ZodEnum<{ [x: string]: string }> } & Shape = {
    op: z.enum(names as [string, ...string[]]).describe('Which operation to run. You must set this; there is no default.'),
    ...config.fields,
  };
  const handler = async (raw: Record<string, unknown>): Promise<CallToolResult> => {
    const args = Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== null));
    const opName = String(args.op);
    // Defence in depth: the enum already refuses an unknown op before the handler runs.
    const spec = Object.hasOwn(config.ops, opName) ? config.ops[opName] : undefined;
    if (!spec) {
      return { isError: true, content: [{ type: 'text', text: `Unknown op '${opName}'. Valid ops: ${names.join(', ')}.` }] };
    }
    const absent = spec.requires.filter((field) => args[field] === undefined);
    if (absent.length > 0) {
      const text = `Missing ${absent.join(', ')} for op=${opName} (requires ${spec.requires.join(', ')}). Re-call with ${absent.join(', ')} set.`;
      return { isError: true, content: [{ type: 'text', text }] };
    }
    // Zod already dropped unknown keys, so anything here was declared: refuse the fields this op does not read.
    const allowed = [...new Set<string>([...baseline, ...shared, ...spec.requires, ...(spec.uses ?? [])])];
    const foreign = Object.keys(args).filter((field) => field !== 'op' && !allowed.includes(field));
    if (foreign.length > 0) {
      const verb = foreign.length === 1 ? 'does not apply' : 'do not apply';
      const text = `${foreign.join(', ')} ${verb} to op=${opName}; it takes ${allowed.join(', ')}. Re-call without ${foreign.length === 1 ? "it" : "them"}.`;
      return { isError: true, content: [{ type: 'text', text }] };
    }
    // The SDK parsed args against this very shape, so the object is the shape's output.
    return spec.run(args as unknown as z.infer<z.ZodObject<Shape>> & { op: string });
  };
  // The SDK's ToolCallback conditional cannot resolve against a generic shape, so the handler is cast once.
  server.registerTool(
    name,
    { title: config.title, description, inputSchema, annotations: config.annotations },
    handler as unknown as ToolCallback<typeof inputSchema>,
  );
}
