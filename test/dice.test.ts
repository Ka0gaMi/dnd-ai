import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCampaign, rollAndRecord } from '../src/core/campaign.js';
import { applyRollOverride, expressionDice, rollDice } from '../src/core/dice.js';
import { openDb, type Db } from '../src/db/connection.js';

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
});

function dice(group: ReturnType<typeof rollDice>['groups'][number]): number[] {
  if (typeof group !== 'object' || group === null) throw new Error('expected a dice group');
  return group.dice.map((d) => d.value);
}

describe('notation', () => {
  it('rolls 1d20+5 within range', () => {
    for (let i = 0; i < 50; i++) {
      const r = rollDice('1d20+5');
      expect(r.total).toBeGreaterThanOrEqual(6);
      expect(r.total).toBeLessThanOrEqual(25);
      expect(r.natural_d20).toBe(r.total - 5);
    }
  });

  it('keeps the highest three of 4d6', () => {
    for (let i = 0; i < 50; i++) {
      const r = rollDice('4d6kh3');
      const values = dice(r.groups[0]!);
      expect(values).toHaveLength(4);
      expect(r.total).toBe([...values].sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0));
      expect(r.natural_d20).toBeNull();
    }
  });

  it('adds separate dice groups', () => {
    const r = rollDice('2d6+1d4');
    expect(r.groups).toHaveLength(3);
    expect(r.total).toBeGreaterThanOrEqual(3);
    expect(r.total).toBeLessThanOrEqual(16);
  });

  it('rejects garbage notation', () => {
    expect(() => rollDice('nonsense')).toThrow(/Invalid dice notation/);
  });
});

describe('advantage', () => {
  it('rolls two d20 and keeps the higher', () => {
    for (let i = 0; i < 50; i++) {
      const r = rollDice('1d20+3', { advantage: 'advantage' });
      expect(r.expr).toBe('2d20kh1+3');
      const values = dice(r.groups[0]!);
      expect(values).toHaveLength(2);
      expect(r.natural_d20).toBe(Math.max(...values));
    }
  });

  it('keeps the lower on disadvantage', () => {
    for (let i = 0; i < 50; i++) {
      const r = rollDice('d20', { advantage: 'disadvantage' });
      expect(r.expr).toBe('2d20kl1');
      expect(r.natural_d20).toBe(Math.min(...dice(r.groups[0]!)));
    }
  });

  it('leaves non-d20 expressions alone', () => {
    const r = rollDice('2d6', { advantage: 'advantage' });
    expect(r.expr).toBe('2d6');
  });
});

describe('luck dial', () => {
  it('adds a die per point of bias and keeps the highest', () => {
    for (let i = 0; i < 30; i++) {
      const r = rollDice('1d20+2', { luck_bias: 1 });
      expect(r.expr).toBe('2d20kh1+2');
      expect(r.natural_d20).toBe(Math.max(...dice(r.groups[0]!)));

      const two = rollDice('d20', { luck_bias: 2 });
      expect(two.expr).toBe('3d20kh1');
      expect(dice(two.groups[0]!)).toHaveLength(3);
    }
  });

  it('keeps the lowest on a negative bias', () => {
    for (let i = 0; i < 30; i++) {
      const r = rollDice('1d20', { luck_bias: -2 });
      expect(r.expr).toBe('3d20kl1');
      expect(r.natural_d20).toBe(Math.min(...dice(r.groups[0]!)));
    }
  });

  it('stacks with advantage but never fights it', () => {
    expect(rollDice('1d20', { advantage: 'advantage', luck_bias: 1 }).expr).toBe('3d20kh1');
    expect(rollDice('1d20', { advantage: 'disadvantage', luck_bias: 1 }).expr).toBe('2d20kl1');
    expect(rollDice('1d20', { advantage: 'advantage', luck_bias: -1 }).expr).toBe('2d20kh1');
  });

  it('leaves damage rolls and a zero dial alone', () => {
    expect(rollDice('2d6+3', { luck_bias: 2 }).expr).toBe('2d6+3');
    expect(rollDice('1d20+1', { luck_bias: 0 }).expr).toBe('1d20+1');
  });
});

describe('cheat-mode override', () => {
  it('sets the die of a d20 roll and works the rest out from it', () => {
    const edited = applyRollOverride(rollDice('1d20+3', { dc: 15, roll_type: 'attack' }), [20]);
    expect(edited.total).toBe(23);
    expect(edited.natural_d20).toBe(20);
    expect(edited.natural).toBe(20);
    expect(edited.outcome).toBe('critical_hit');
    expect(edited.output).toBe('1d20+3: [20]+3 = 23');
    expect(edited.groups[0]).toEqual({ value: 20, dice: [{ value: 20, modifiers: [] }] });
  });

  it('sets every die of a damage roll and adds the modifier as written', () => {
    const edited = applyRollOverride(rollDice('2d6+3', { roll_type: 'damage' }), [6, 6]);
    expect(edited.total).toBe(15);
    expect(edited.output).toBe('2d6+3: [6, 6]+3 = 15');
    expect(edited.natural_d20).toBeNull();
  });

  it('takes a whole critical hit, doubled dice and all', () => {
    const edited = applyRollOverride(rollDice('4d6+3', { roll_type: 'damage' }), [6, 5, 4, 3]);
    expect(edited.total).toBe(21);
    expect(edited.output).toBe('4d6+3: [6, 5, 4, 3]+3 = 21');
  });

  it('reads the dice an expression rolls, and refuses the ones it cannot', () => {
    expect(expressionDice('1d20+5')).toEqual([20]);
    expect(expressionDice('2d6+1d4+3')).toEqual([6, 6, 4]);
    expect(expressionDice('4d6kh3')).toBeNull();
  });

  it('judges the edited roll against its DC, not the one it rolled', () => {
    const edited = applyRollOverride(rollDice('1d20+2', { dc: 18, roll_type: 'check' }), [1]);
    expect(edited.total).toBe(3);
    expect(edited.outcome).toBe('failure');
    expect(edited.natural).toBe(1);
  });
});

describe('outcomes', () => {
  it('is null without a dc', () => {
    expect(rollDice('1d20').outcome).toBeNull();
  });

  it('compares a check against the dc, natural 20 or not', () => {
    for (let i = 0; i < 300; i++) {
      const r = rollDice('1d20+2', { dc: 15, roll_type: 'check' });
      expect(r.outcome).toBe(r.total >= 15 ? 'success' : 'failure');
      expect(r.natural).toBe(r.natural_d20 === 20 || r.natural_d20 === 1 ? r.natural_d20 : null);
    }
  });

  it('crits and misses only on an attack roll', () => {
    for (let i = 0; i < 300; i++) {
      const r = rollDice('1d20+2', { dc: 15, roll_type: 'attack' });
      if (r.natural === 20) expect(r.outcome).toBe('critical_hit');
      else if (r.natural === 1) expect(r.outcome).toBe('miss');
      else expect(r.outcome).toBe(r.total >= 15 ? 'success' : 'failure');
    }
  });

  it('crits an attack without a dc but leaves checks and saves to the total', () => {
    // rpg-dice-roller is a pure function of Math.random: 0.041 -> d20 = 20, 0 -> d20 = 1.
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.041);
    expect(rollDice('1d20', { roll_type: 'attack' }).outcome).toBe('critical_hit');
    expect(rollDice('1d20', { roll_type: 'save' }).outcome).toBeNull();
    expect(rollDice('1d20', { dc: 25, roll_type: 'check' }).outcome).toBe('failure');

    random.mockReturnValue(0);
    expect(rollDice('1d20+9', { dc: 5, roll_type: 'attack' }).outcome).toBe('miss');
    expect(rollDice('1d20+9', { dc: 5, roll_type: 'save' })).toMatchObject({ outcome: 'success', natural: 1 });
    random.mockRestore();
  });

  it('defaults roll_type to other', () => {
    expect(rollDice('1d20').roll_type).toBe('other');
  });

  it('judges non-d20 rolls on the total alone', () => {
    expect(rollDice('1d1+10', { dc: 5 }).outcome).toBe('success');
    expect(rollDice('1d1', { dc: 5 }).outcome).toBe('failure');
  });
});

describe('persistence', () => {
  it('stores nothing without a campaign', () => {
    const r = rollAndRecord(db, { expr: '1d20', purpose: 'Idle curiosity' });
    expect(r.id).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM roll').get()).toEqual({ n: 0 });
  });

  it('writes a roll row and a roll event for a campaign', () => {
    const { campaign_id } = createCampaign(db, { name: 'Rolls', story_shape: 'sandbox' });
    const r = rollAndRecord(db, { expr: '1d20+5', purpose: 'Stealth check', dc: 12, campaign_id });

    const row = db.prepare('SELECT * FROM roll WHERE id = ?').get(r.id!) as Record<string, unknown>;
    expect(row).toMatchObject({
      campaign_id,
      expr: '1d20+5',
      total: r.total,
      purpose: 'Stealth check',
      dc: 12,
      outcome: r.outcome,
      luck_bias_applied: 0,
    });
    expect(JSON.parse(row.results_json as string)).toEqual(r.groups);

    const event = db.prepare('SELECT * FROM event WHERE id = ?').get(row.event_id as number) as {
      kind: string;
      text: string;
    };
    expect(event.kind).toBe('roll');
    expect(event.text).toContain('Stealth check');
  });
});

describe('randomness ownership', () => {
  it('keeps every Math.random in src/core/dice.ts', () => {
    const root = fileURLToPath(new URL('../src', import.meta.url));
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith('.ts') && readFileSync(path, 'utf8').includes('Math.random')) {
          offenders.push(relative(root, path).split(sep).join('/'));
        }
      }
    };
    walk(root);
    expect(offenders).toEqual(['core/dice.ts']);
  });
});
