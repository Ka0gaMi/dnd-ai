import type { McpServer, ToolCallback, CallToolResult, ToolAnnotations } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { refusal } from '../../core/refusals.js';

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
  /** Renamed fields every op still accepts so its run can refuse them in its own words; never listed as taken. */
  retired?: ReadonlyArray<keyof Shape & string>;
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
  const retired: ReadonlyArray<string> = config.retired ?? [];
  const perOp = names.map((name_) => {
    const { summary, requires, uses = [] } = config.ops[name_]!;
    // The schema's required list already names the baseline, so a line only adds what this op needs.
    const tail =
      requires.length > 0
        ? `Requires ${requires.join(', ')}${uses.length > 0 ? `; also ${uses.join(', ')}` : ''}.`
        : uses.length > 0
          ? `Optional: ${uses.join(', ')}.`
          : 'Nothing else needed.';
    return `op=${name_}: ${sentence(summary)}. ${tail}`;
  });
  const family = config.description.includes(OP_LINE) ? config.description : `${sentence(config.description)}. ${OP_LINE}`;
  const description = `${family}\n\n${perOp.join('\n')}`;
  const inputSchema: { op: z.ZodEnum<{ [x: string]: string }> } & Shape = {
    op: z.enum(names as [string, ...string[]]).describe('Which operation to run.'),
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
    const foreign = Object.keys(args).filter((field) => field !== 'op' && !allowed.includes(field) && !retired.includes(field));
    if (foreign.length > 0) {
      const verb = foreign.length === 1 ? 'does not apply' : 'do not apply';
      const text = `${foreign.join(', ')} ${verb} to op=${opName}; it takes ${allowed.join(', ')}. Re-call without ${foreign.length === 1 ? "it" : "them"}.`;
      return { isError: true, content: [{ type: 'text', text }] };
    }
    // The SDK parsed args against this very shape, so the object is the shape's output.
    return spec.run(args as unknown as z.infer<z.ZodObject<Shape>> & { op: string });
  };
  // The SDK's ToolCallback conditional cannot resolve against a generic shape, so the handler is cast once.
  const schema = z.object(inputSchema);
  server.registerTool(
    name,
    { title: config.title, description, inputSchema: schema, annotations: config.annotations },
    handler as unknown as ToolCallback<typeof schema>,
  );
}

/** A refusal lists every valid value up to this many; past it, only the nearest are named. */
const SHORT_LIST = 20;

function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    row = next;
  }
  return row[b.length]!;
}

/** The valid values closest to `value`: one inside the other, or the fewest edits when that is a typo or two. */
function nearest(value: string, values: readonly string[]): string[] {
  const typed = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  const scored = values.map((valid) => ({
    valid,
    distance: typed.length > 2 && (valid.includes(typed) || typed.includes(valid)) ? 0 : editDistance(typed, valid),
  }));
  const best = Math.min(...scored.map((entry) => entry.distance));
  if (best > Math.max(2, typed.length / 3)) return [];
  return scored.filter((entry) => entry.distance === best).slice(0, 3).map((entry) => entry.valid);
}

/** The teaching refusal for a value outside an open kind's catalogue. */
function unknownKind(noun: string, value: string, values: readonly string[]): string {
  const near = nearest(value, values);
  const guess = near.length > 0 ? `Did you mean ${near.join(' or ')}? ` : '';
  const valid = values.length <= SHORT_LIST ? `one of: ${values.join(', ')}` : `a ${noun} from the list its description names`;
  return refusal('unknown_id', `${noun} "${value}"`, `${guess}Re-call with ${valid}.`).message;
}

/**
 * An open kind: a plain string in tools/list, so the catalogue costs no tokens there, refused while the call is parsed
 * (before any write) unless it is one of `values`. Describe the field with where the values are listed, or a short sample.
 */
export function openKind<const T extends readonly string[]>(noun: string, values: T) {
  return z.string().refine((value): value is T[number] => values.includes(value), {
    error: (issue) => unknownKind(noun, String(issue.input), values),
  });
}
