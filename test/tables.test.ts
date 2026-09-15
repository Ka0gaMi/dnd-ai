import { describe, expect, it } from 'vitest';
import { TABLE_NAMES, hashSeed, randomTables, rollTable, tableKeys } from '../src/core/tables.js';

describe('the bundled random tables', () => {
  it('carries a key set for every table but rumours', () => {
    expect(TABLE_NAMES).toEqual(['names', 'rumours', 'loot', 'weather', 'encounters']);
    expect(tableKeys('names')).toEqual(['northern', 'southern', 'eastern', 'old-empire']);
    expect(tableKeys('weather')).toEqual(['spring', 'summer', 'autumn', 'winter']);
    expect(tableKeys('encounters')).toEqual(['forest', 'road', 'cave', 'ruins', 'interior', 'town']);
    expect(tableKeys('loot')).toEqual(['0-4', '5-10', '11-16', '17+']);
    expect(tableKeys('rumours')).toEqual([]);
    for (const terrain of tableKeys('encounters')) {
      expect(randomTables().encounters[terrain]!.length).toBeGreaterThanOrEqual(6);
    }
  });

  it('gives the same answer for the same seed and key', () => {
    const first = rollTable('names', { seed: 12345, key: 'northern' });
    expect(rollTable('names', { seed: 12345, key: 'northern' })).toEqual(first);
    expect(first.result).toBe(`${first.parts.first} ${first.parts.family}`);
    expect(randomTables().names.northern!.first).toContain(first.parts.first);
    expect(rollTable('names', { seed: 999, key: 'northern' }).result).not.toBe(first.result);
  });

  it('rolls a seed of its own when none is given, and reports it', () => {
    const rolled = rollTable('encounters', { key: 'road' });
    expect(rolled.key).toBe('road');
    expect(randomTables().encounters.road).toContain(rolled.result);
    expect(rollTable('encounters', { key: 'road', seed: rolled.seed }).result).toBe(rolled.result);
  });

  it('picks a key of its own when none is given', () => {
    const rolled = rollTable('weather', { seed: 7 });
    expect(tableKeys('weather')).toContain(rolled.key);
    expect(randomTables().weather[rolled.key!]).toContain(rolled.result);
  });

  it('fills every slot in a rumour template', () => {
    for (let seed = 0; seed < 40; seed += 1) {
      const rolled = rollTable('rumours', { seed });
      expect(rolled.key).toBeNull();
      expect(rolled.result).not.toMatch(/[{}]/);
      expect(rolled.result.length).toBeGreaterThan(20);
    }
  });

  it('puts a challenge rating in its loot band', () => {
    expect(rollTable('loot', { seed: 3, key: '2' }).key).toBe('0-4');
    expect(rollTable('loot', { seed: 3, key: 'CR 9' }).key).toBe('5-10');
    expect(rollTable('loot', { seed: 3, key: '21' }).key).toBe('17+');
    const rolled = rollTable('loot', { seed: 3, key: '11-16' });
    expect(rolled.result).toBe(`${rolled.parts.coins}; ${rolled.parts.trinket}; ${rolled.parts.item}`);
  });

  it('refuses a key the table does not have', () => {
    expect(() => rollTable('encounters', { key: 'moon' })).toThrow(/forest/);
    expect(() => rollTable('names', { key: 'martian' })).toThrow(/northern/);
  });

  it('hashes a seed the same way every time', () => {
    expect(hashSeed('weather', 1, 1, 1, 1)).toBe(hashSeed('weather', 1, 1, 1, 1));
    expect(hashSeed('weather', 1, 1, 1, 1)).not.toBe(hashSeed('weather', 1, 1, 1, 2));
    expect(hashSeed('weather', 2, 3)).toBeGreaterThanOrEqual(0);
  });
});
