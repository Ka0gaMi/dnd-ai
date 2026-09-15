// Seeds the bundled SRD glossary (campaign_id NULL) once per database.
import type { Db } from '../db/connection.js';
import * as srd from './data.js';

export const ABILITY_NAMES: Record<string, string> = {
  str: 'Strength',
  dex: 'Dexterity',
  con: 'Constitution',
  int: 'Intelligence',
  wis: 'Wisdom',
  cha: 'Charisma',
};

const titleCase = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);

function entries(): Array<{ term: string; definition: string }> {
  const rows: Array<{ term: string; definition: string }> = [];
  for (const rule of srd.rules()) rows.push({ term: rule.fields.name, definition: rule.fields.desc });
  for (const condition of srd.conditionDescriptions()) {
    rows.push({ term: `${titleCase(condition.fields.describes)} (condition)`, definition: condition.fields.desc });
  }
  for (const skill of srd.skills()) {
    rows.push({
      term: `${skill.name} (skill)`,
      definition: `${skill.ability_score.name} skill. ${skill.description}`,
    });
  }
  for (const ability of srd.abilityDescriptions()) {
    const name = ABILITY_NAMES[ability.fields.describes];
    if (name) rows.push({ term: `${name} (ability)`, definition: ability.fields.desc });
  }
  const seen = new Set<string>();
  return rows.filter((row) => (seen.has(row.term) ? false : seen.add(row.term) !== undefined));
}

/** No-op once SRD rows exist, so it is safe on every startup. Returns how many rows were written. */
export function seedSrdGlossary(db: Db): number {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM glossary_entry WHERE campaign_id IS NULL').get() as {
    n: number;
  };
  if (existing.n > 0) return 0;

  const rows = entries();
  const ts = new Date().toISOString();
  const insert = db.prepare(
    "INSERT INTO glossary_entry (campaign_id, term, definition, source, created_at) VALUES (NULL, ?, ?, 'srd', ?)",
  );
  db.transaction(() => {
    for (const row of rows) insert.run(row.term, row.definition, ts);
  })();
  return rows.length;
}
