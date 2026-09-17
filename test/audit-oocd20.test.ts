// Out-of-combat d20 defects: the sheet path has to read the character's own conditions and its
// exhaustion the way the combat engine does. Composed checks and saves go through the roll tool.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import {
  applyDamage,
  checkModifier,
  createCharacter,
  deathSave,
  setCondition,
  setExhaustion,
  type CreateCharacterInput,
} from '../src/core/character.js';
import { createGameServer } from '../src/mcp/server.js';
import { openDb, type Db } from '../src/db/connection.js';
import { resolvePendingRollsImmediately } from './helpers.js';

let db: Db;
let campaignId: number;

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'Out of combat', story_shape: 'sandbox' }).campaign_id;
});

/** Borg the Dwarf Fighter: STR 17 (+3), WIS 12 (+1), CON 14 (+2), 13 HP. */
function fighter(): number {
  return createCharacter(db, {
    campaign_id: campaignId,
    name: 'Borg',
    species: 'Dwarf',
    class: 'Fighter',
    background: 'Soldier',
    ability_method: 'standard_array',
    abilities: { str: 15, dex: 10, con: 14, int: 8, wis: 12, cha: 13 },
    ability_bonuses: { str: 2, con: 1 },
    skill_choices: ['athletics', 'perception'],
  } satisfies CreateCharacterInput).character!.id as number;
}

async function connect(): Promise<{ client: Client; done: () => void }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
  const unsubscribe = resolvePendingRollsImmediately(db);
  return {
    client,
    done: () => {
      unsubscribe();
      void client.close();
    },
  };
}

async function call<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const result = (await client.callTool({ name, arguments: args })) as unknown as {
    isError?: boolean;
    content: Array<{ text: string }>;
    structuredContent: T;
  };
  if (result.isError) throw new Error(result.content[0]!.text);
  return result.structuredContent;
}

interface RollReply extends Record<string, unknown> {
  total: number | null;
  expr?: string;
  outcome: string | null;
  advantage?: string;
  auto_fail?: string;
  rules_applied?: string[];
  modifier?: { exhaustion: number; total_modifier: number };
  modifier_from_sheet?: string;
}

describe('conditions on an out-of-combat d20', () => {
  it('fails a Paralyzed character’s Strength save outright, with no die', async () => {
    const characterId = fighter();
    setCondition(db, { campaign_id: campaignId, character_id: characterId, condition: 'paralyzed', active: true });

    expect(checkModifier(db, campaignId, characterId, { save: 'str' })).toMatchObject({
      auto_fail_save: 'Borg is paralyzed',
    });

    const { client, done } = await connect();
    try {
      const result = await call<RollReply>(client, 'roll', {
        campaign_id: campaignId,
        purpose: 'Strength save against the grip',
        save: 'str',
        dc: 5,
        roller: 'player',
      });
      expect(result.auto_fail).toBe('Borg is paralyzed');
      expect(result.outcome).toBe('failure');
      expect(result.total).toBeNull();
    } finally {
      done();
    }
  });

  it('rolls a Poisoned character’s ability check with Disadvantage', async () => {
    const characterId = fighter();
    setCondition(db, { campaign_id: campaignId, character_id: characterId, condition: 'poisoned', active: true });

    expect(checkModifier(db, campaignId, characterId, { ability: 'str' }).condition_disadvantage).toEqual([
      'Borg is poisoned',
    ]);

    const { client, done } = await connect();
    try {
      const result = await call<RollReply>(client, 'roll', {
        campaign_id: campaignId,
        purpose: 'Strength check to force the door',
        ability: 'str',
        dc: 5,
        roller: 'player',
      });
      expect(result.advantage).toBe('disadvantage');
      expect((result.rules_applied ?? []).join(' ')).toContain('Borg is poisoned');
    } finally {
      done();
    }
  });
});

describe('exhaustion on an out-of-combat d20', () => {
  it('takes 4 off the DM’s d20 for a level-2 character, composed or raw', async () => {
    const characterId = fighter();
    setExhaustion(db, { campaign_id: campaignId, level: 2 });

    const { client, done } = await connect();
    try {
      // Composed off the sheet: STR 17 (+3) less 4 is -1.
      const composed = await call<RollReply>(client, 'roll', {
        campaign_id: campaignId,
        purpose: 'Strength check to force the door',
        ability: 'str',
        dc: 10,
        roller: 'dm',
        character_id: characterId,
      });
      expect(composed.modifier).toMatchObject({ exhaustion: 4, total_modifier: -1 });

      // The DM naming the expression instead: the same 4 comes off before the die is read.
      const raw = await call<RollReply>(client, 'roll', {
        campaign_id: campaignId,
        purpose: 'A straight d20 for the tired character',
        expr: '1d20+5',
        roll_type: 'check',
        dc: 10,
        roller: 'dm',
        character_id: characterId,
      });
      expect(raw.expr).toBe('1d20+5-4');
    } finally {
      done();
    }
  });

  it('takes 4 off a death save', () => {
    fighter();
    applyDamage(db, { campaign_id: campaignId, amount: 13 });
    setExhaustion(db, { campaign_id: campaignId, level: 2 });

    // A clicked 12 would succeed; exhaustion 2 turns it into an 8 and a failure.
    const result = deathSave(db, {
      campaign_id: campaignId,
      roll: { total: 12, natural_d20: 12 },
    });
    expect(result.roll).toBe(8);
    expect(result.result).toBe('failure');
    expect(result.failures).toBe(1);
  });
});

describe('passive checks and exhaustion', () => {
  it('does not take exhaustion off a passive check, which rolls no die', async () => {
    fighter();
    setExhaustion(db, { campaign_id: campaignId, level: 2 });

    const { client, done } = await connect();
    try {
      const result = await call<RollReply>(client, 'roll', {
        campaign_id: campaignId,
        purpose: 'Passive Wisdom',
        ability: 'wis',
        passive: true,
        roller: 'dm',
      });
      // WIS 12 (+1): 10 + 1. Exhaustion is a D20 Test penalty and this is not a D20 Test.
      expect(result.total).toBe(11);
      expect(result.modifier).toMatchObject({ exhaustion: 0, total_modifier: 1 });
    } finally {
      done();
    }
  });

  it('still gives a Poisoned character the passive check’s -5 for Disadvantage', async () => {
    fighter();
    setCondition(db, { campaign_id: campaignId, condition: 'poisoned', active: true });

    const { client, done } = await connect();
    try {
      const result = await call<RollReply>(client, 'roll', {
        campaign_id: campaignId,
        purpose: 'Passive Wisdom',
        ability: 'wis',
        passive: true,
        roller: 'dm',
      });
      expect(result.advantage).toBe('disadvantage');
      expect(result.total).toBe(6); // 10 + 1 - 5
    } finally {
      done();
    }
  });
});

describe('the boundaries the fix must not cross', () => {
  it('leaves a DM roll that names no character free of the party’s exhaustion', async () => {
    fighter();
    setExhaustion(db, { campaign_id: campaignId, level: 3 });

    const { client, done } = await connect();
    try {
      // A monster's own d20: no character_id, so it must not borrow the tired PC's penalty.
      const monster = await call<RollReply>(client, 'roll', {
        campaign_id: campaignId,
        purpose: 'The ogre heaves at the portcullis',
        expr: '1d20+4',
        roll_type: 'check',
        roller: 'dm',
      });
      expect(monster.expr).toBe('1d20+4');
    } finally {
      done();
    }
  });

  it('spends nothing when a save fails automatically', async () => {
    const characterId = fighter();
    setCondition(db, { campaign_id: campaignId, condition: 'paralyzed', active: true });

    const { client, done } = await connect();
    try {
      const result = await call<RollReply>(client, 'roll', {
        campaign_id: campaignId,
        purpose: 'Strength save against the closing wall',
        save: 'str',
        dc: 10,
        roller: 'dm',
        character_id: characterId,
      });
      expect(result.total).toBeNull();
      // No die was rolled, so the reply must not claim anything was used for it.
      expect(JSON.stringify(result)).not.toMatch(/boosts_spent/);
      expect(result.rules_applied ?? []).toHaveLength(1);
    } finally {
      done();
    }
  });
});
