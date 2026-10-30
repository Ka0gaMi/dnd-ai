import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { Tool } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { createCharacter } from '../src/core/character.js';
import { CLAUSE_WHEN, clausesSchema } from '../src/core/mechanics.js';
import { updateSettings } from '../src/core/settings.js';
import { REPEATED_SUBSCHEMA_CHARS, estimateTokens } from '../src/core/token-budget.js';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';
import { replyData, replyText } from './helpers/reply.js';

/** tools/list on kk/a0a 62d8954, before the clause grammar left every tool but check_mechanics. */
const BEFORE = { tokens: 64_170, repeated_chars: 74_225 };

let db: Db;
let client: Client;
let campaignId: number;
let characterId: number;

beforeEach(async () => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'Diet', story_shape: 'sandbox' }).campaign_id;
  characterId = createCharacter(db, {
    campaign_id: campaignId,
    name: 'Vex',
    species: 'Human',
    class: 'Rogue',
    background: 'Criminal',
    ability_method: 'standard_array',
    abilities: { str: 8, dex: 15, con: 14, int: 13, wis: 12, cha: 10 },
    ability_bonuses: { dex: 2, int: 1 },
    skill_choices: ['acrobatics', 'perception', 'persuasion', 'athletics', 'survival'],
  }).character!.id;
  db.prepare('UPDATE character SET gold = 50 WHERE id = ?').run(characterId);
  updateSettings(db, campaignId, { rules_mode: 'freeform' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'diet-test', version: '0.0.0' });
  await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
});

afterEach(async () => {
  await client.close();
  db.close();
});

async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(replyText(result));
  return replyData<T>(result);
}

/** Valid clauses that lean on the defaults (uses, decide) the server fills in. */
const VALID = [
  { when: 'roll', if: { kind: 'attack' }, do: [{ kind: 'bonus', to: 'attack', amount: 1 }] },
  { when: 'always', do: [{ kind: 'proficiency', skill: 'stealth' }], decide: 'auto' },
  { when: 'action', do: [{ kind: 'condition', name: 'Frightened', until: 'end_of_target_next_turn' }], uses: { per: 'long', count: 1 } },
];
/** What the old tool schema handed the handler for VALID, defaults applied. */
const PARSED = clausesSchema.parse(VALID);

/** Everything a homebrew call could write. */
function written(): unknown {
  return {
    homebrew: db.prepare('SELECT id, schema_json FROM homebrew ORDER BY id').all(),
    decisions: db.prepare('SELECT count(*) AS n FROM pending_decision').get(),
    events: db.prepare('SELECT count(*) AS n FROM event').get(),
    character: db
      .prepare('SELECT features_json, inventory_json, gold, pending_level_up_json FROM character WHERE id = ?')
      .get(characterId),
  };
}

const storedSchema = (id: number): Record<string, unknown> =>
  JSON.parse((db.prepare('SELECT schema_json FROM homebrew WHERE id = ?').get(id) as { schema_json: string }).schema_json);

const SUBCLASS = (clauses: unknown[]) => ({
  class: 'Barbarian',
  name: 'Path of the Ash',
  flavour_text: 'The fire answers when you call.',
  features: { '3': [{ name: 'Ashen Oath', text: 'Ash coats your blade.', clauses }] },
});

const BACKGROUND = (clauses: unknown[]) => ({
  name: 'Snarewright',
  abilities: ['dex', 'int', 'wis'],
  origin_feat: { name: 'Snare Sense', text: 'You see the trap first.', mechanics: {}, clauses },
  skills: ['stealth', 'investigation'],
  tool: "Thieves' Tools",
  equipment: { items: [], gold: 10 },
  text: 'You grew up rigging snares under the city.',
});

describe('the clause grammar is published once', () => {
  let tools: Tool[];

  beforeEach(async () => {
    tools = (await client.listTools()).tools;
  });

  /** The tools whose input schema holds a node `match` accepts. */
  const holders = (match: (node: Record<string, unknown>) => boolean): string[] =>
    tools
      .filter((tool) => {
        const walk = (node: unknown): boolean =>
          !!node && typeof node === 'object' && (match(node as Record<string, unknown>) || Object.values(node).some(walk));
        return walk(tool.inputSchema);
      })
      .map((tool) => tool.name);

  it('carries the clause item and the legacy mechanics fields on check_mechanics only', () => {
    const props = (node: Record<string, unknown>) => (node.properties ?? {}) as Record<string, { enum?: unknown[] }>;
    expect(holders((node) => JSON.stringify(props(node).when?.enum) === JSON.stringify(CLAUSE_WHEN))).toEqual(['check_mechanics']);
    expect(holders((node) => 'asi' in props(node) && 'to_hit' in props(node))).toEqual(['check_mechanics']);
  });

  it('points every slimmed clauses field at check_mechanics', () => {
    interface JsonSchema {
      type?: string;
      description?: string;
      properties?: Record<string, JsonSchema>;
      items?: JsonSchema;
      anyOf?: JsonSchema[];
      additionalProperties?: JsonSchema;
    }
    const props = (name: string) => (tools.find((tool) => tool.name === name)!.inputSchema as JsonSchema).properties!;
    const propose = props('propose');
    const fields = [
      propose.clauses,
      propose.origin_feat!.anyOf![1]!.properties!.clauses,
      propose.schema!.anyOf![0]!.properties!.features!.additionalProperties!.items!.properties!.clauses,
      props('revise_mechanics').clauses,
      props('propose_level_up_options').suggestions!.items!.properties!.clauses,
      props('inventory').magic!.properties!.mechanics!.properties!.clauses,
    ];
    for (const field of fields) {
      expect(field!.type).toBe('array');
      expect(field!.items).toEqual({ type: 'object', properties: {}, additionalProperties: {} });
      expect(field!.description).toContain('check_mechanics');
    }
  });

  it('shrinks tools/list and its repeated sub-schemas below the old sizes', () => {
    const seen = new Set<string>();
    let repeated = 0;
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      if (!Array.isArray(node)) {
        const json = JSON.stringify(node);
        if (json.length > REPEATED_SUBSCHEMA_CHARS) {
          if (seen.has(json)) {
            repeated += json.length;
            return;
          }
          seen.add(json);
        }
      }
      Object.values(node).forEach(walk);
    };
    for (const tool of tools) walk(tool.inputSchema);
    expect(estimateTokens(JSON.stringify(tools))).toBeLessThan(BEFORE.tokens);
    expect(repeated).toBeLessThan(BEFORE.repeated_chars);
  });
});

describe('each slimmed tool accepts the clauses it accepted before', () => {
  it('propose op=feature', async () => {
    const result = await call<{ status: string; homebrew_id: number }>('propose', {
      op: 'feature',
      campaign_id: campaignId,
      name: 'Trapwright',
      text: 'Your snares catch what walks past them.',
      mechanics: {},
      clauses: VALID,
      justification: 'They rig a trap in every fight.',
    });
    expect(result.status).toBe('applied');
    expect(storedSchema(result.homebrew_id).clauses).toEqual(PARSED);
  });

  it('propose op=background, in the invented origin feat', async () => {
    const result = await call<{ homebrew_id: number }>('propose', { op: 'background', campaign_id: campaignId, ...BACKGROUND(VALID) });
    expect((storedSchema(result.homebrew_id).origin_feat as { clauses: unknown }).clauses).toEqual(PARSED);
  });

  it('propose op=subclass, in a level bundle', async () => {
    const result = await call<{ homebrew_id: number }>('propose', {
      op: 'subclass',
      campaign_id: campaignId,
      schema: SUBCLASS(VALID.slice(0, 2)),
      justification: 'The player asked for the ash order.',
    });
    const features = storedSchema(result.homebrew_id).features as Record<string, Array<{ clauses: unknown }>>;
    expect(features['3']![0]!.clauses).toEqual(PARSED.slice(0, 2));
  });

  it('revise_mechanics', async () => {
    const { homebrew_id } = await call<{ homebrew_id: number }>('propose', {
      op: 'feature',
      campaign_id: campaignId,
      name: 'Trapwright',
      text: 'Your snares catch what walks past them.',
      mechanics: {},
      justification: 'They rig a trap in every fight.',
    });
    const result = await call<{ status: string }>('revise_mechanics', {
      campaign_id: campaignId,
      homebrew_id,
      clauses: VALID,
      reason: 'The text said more than the engine ran.',
    });
    expect(result.status).toBe('revised');
    expect(storedSchema(homebrew_id).clauses).toEqual(PARSED);
  });

  it('propose_level_up_options', async () => {
    const result = await call<{ level_up: { suggestions: Array<{ homebrew_id: number; clauses: unknown }> } }>(
      'propose_level_up_options',
      {
        campaign_id: campaignId,
        suggestions: [{ name: 'Snare Master', text: 'Harder to spot.', mechanics: {}, clauses: VALID, justification: 'Traps.' }],
      },
    );
    const [suggestion] = result.level_up.suggestions;
    expect(suggestion!.clauses).toEqual(PARSED);
    expect(storedSchema(suggestion!.homebrew_id).clauses).toEqual(PARSED);
  });

  it('inventory op=add, in a magic item', async () => {
    await call('inventory', {
      op: 'add',
      campaign_id: campaignId,
      name: 'Cloak of the Northern Wind',
      magic: { rarity: 'rare', mechanics: { resistances: ['cold'], clauses: VALID } },
    });
    const inventory = JSON.parse(
      (db.prepare('SELECT inventory_json FROM character WHERE id = ?').get(characterId) as { inventory_json: string })
        .inventory_json,
    ) as Array<{ name: string; magic?: { mechanics?: { resistances?: string[]; clauses?: unknown } } }>;
    const cloak = inventory.find((item) => item.name === 'Cloak of the Northern Wind')!;
    expect(cloak.magic!.mechanics).toEqual({ resistances: ['cold'], clauses: PARSED });
  });
});

describe('each slimmed tool refuses a bad clause by index and field, writing nothing', () => {
  const refusal = async (name: string, args: Record<string, unknown>, where: RegExp): Promise<void> => {
    const before = written();
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).toBe(true);
    const text = replyText(result);
    expect(text).toMatch(where);
    expect(text).toContain('check_mechanics publishes the clause grammar');
    expect(written()).toEqual(before);
  };
  const teleport = { when: 'always', do: [{ kind: 'teleport' }] };

  it('propose op=feature: a bad verb, too many clauses, and a bad legacy field', async () => {
    const feature = {
      op: 'feature',
      campaign_id: campaignId,
      name: 'Trapwright',
      text: 'Your snares catch what walks past them.',
      mechanics: {},
      justification: 'They rig a trap in every fight.',
    };
    await refusal('propose', { ...feature, clauses: [VALID[0], teleport] }, /^clauses\[1\]\.do\[0\]\.kind: Invalid discriminator value\. Expected 'bonus'/);
    await refusal('propose', { ...feature, clauses: [...VALID, ...VALID] }, /^clauses: Too big: expected array to have <=4 items\./);
    await refusal('propose', { ...feature, mechanics: { ac: 9 }, clauses: VALID }, /^mechanics\.ac: Too big: expected number to be <=5\./);
    expect(replyText(await client.callTool({ name: 'propose', arguments: { ...feature, clauses: [teleport] } }))).toMatch(
      /Nothing was written\.$/,
    );
  });

  it('propose op=background: a bad hook in the origin feat', async () => {
    await refusal(
      'propose',
      { op: 'background', campaign_id: campaignId, ...BACKGROUND([{ when: 'sometimes', do: [{ kind: 'advantage' }] }]) },
      /^origin_feat\.clauses\[0\]\.when: Invalid option: expected one of "always"/,
    );
  });

  it('propose op=subclass: an invented condition in a level bundle', async () => {
    await refusal(
      'propose',
      {
        op: 'subclass',
        campaign_id: campaignId,
        schema: SUBCLASS([{ when: 'hit', do: [{ kind: 'condition', name: 'dazzled', until: 'rounds', rounds: 1 }] }]),
        justification: 'The player asked for the ash order.',
      },
      /"dazzled" is not a condition[\s\S]*→ at features\.3\[0\]\.clauses\[0\]\.do\[0\]\.name/,
    );
  });

  it('revise_mechanics: a do list with nothing in it', async () => {
    const { homebrew_id } = await call<{ homebrew_id: number }>('propose', {
      op: 'feature',
      campaign_id: campaignId,
      name: 'Trapwright',
      text: 'Your snares catch what walks past them.',
      mechanics: {},
      clauses: VALID,
      justification: 'They rig a trap in every fight.',
    });
    await refusal(
      'revise_mechanics',
      { campaign_id: campaignId, homebrew_id, clauses: [{ when: 'always', do: [] }], reason: 'Trim it.' },
      /^clauses\[0\]\.do: Too small: expected array to have >=1 items\./,
    );
    expect(storedSchema(homebrew_id).clauses).toEqual(PARSED);
  });

  it('propose_level_up_options: a bad uses in the second suggestion refuses the whole call', async () => {
    await refusal(
      'propose_level_up_options',
      {
        campaign_id: campaignId,
        suggestions: [
          { name: 'Snare Master', text: 'Harder to spot.', mechanics: {}, clauses: VALID, justification: 'Traps.' },
          { name: 'Wall Runner', text: 'Up the walls.', mechanics: {}, clauses: [{ ...VALID[1], uses: 'twice' }], justification: 'Climbs.' },
        ],
      },
      /^suggestions\[1\]\.clauses\[0\]\.uses: Invalid input\./,
    );
  });

  it('inventory op=add: spends no gold and adds no item', async () => {
    await refusal(
      'inventory',
      {
        op: 'add',
        campaign_id: campaignId,
        name: 'Cloak of the Northern Wind',
        cost_gp: 5,
        magic: { rarity: 'rare', mechanics: { clauses: [teleport] } },
      },
      /^magic\.mechanics\.clauses\[0\]\.do\[0\]\.kind: Invalid discriminator value/,
    );
  });
});
