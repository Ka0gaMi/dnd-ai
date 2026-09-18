// Seeds the bundled SRD glossary (campaign_id NULL) and rewrites it when the bundled text changes.
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
  // Conditions already have their own `Foo (condition)` row below; the glossary's `Foo [Condition]` name is the
  // same rule under the SRD's tagged heading, so skip it rather than seeding the player window two of each.
  const conditions = new Set(srd.conditionDescriptions().map((c) => titleCase(c.fields.describes)));
  for (const rule of srd.allRules()) {
    const tagged = /^(.+) \[Condition\]$/.exec(rule.name);
    if (tagged !== null && conditions.has(tagged[1]!)) continue;
    rows.push({ term: rule.name, definition: rule.desc });
  }
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

/** Rewrites the SRD rows only when the bundled text differs from what is stored, so it is safe on every startup. Returns how many rows were written. */
export function seedSrdGlossary(db: Db): number {
  const rows = entries();
  const stored = db
    .prepare('SELECT term, definition FROM glossary_entry WHERE campaign_id IS NULL ORDER BY term')
    .all() as Array<{ term: string; definition: string }>;
  const key = (list: Array<{ term: string; definition: string }>): string =>
    JSON.stringify([...list].sort((a, b) => a.term.localeCompare(b.term)));
  if (stored.length > 0 && key(stored) === key(rows)) return 0;

  const ts = new Date().toISOString();
  const insert = db.prepare(
    "INSERT INTO glossary_entry (campaign_id, term, definition, source, created_at) VALUES (NULL, ?, ?, 'srd', ?)",
  );
  db.transaction(() => {
    db.prepare('DELETE FROM glossary_entry WHERE campaign_id IS NULL').run();
    for (const row of rows) insert.run(row.term, row.definition, ts);
  })();
  return rows.length;
}
