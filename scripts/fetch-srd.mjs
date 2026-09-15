// Downloads the SRD 5.2.1 JSON the server needs into srd/. The files are committed; this only refreshes them.
// Name one or more files to refresh just those, e.g. `npm run srd:fetch -- Magic-Items`.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OPEN5E = 'https://raw.githubusercontent.com/open5e/open5e-api/main/data/v2/wizards-of-the-coast/srd-2024';
const BITS = 'https://raw.githubusercontent.com/5e-bits/5e-database/main/src/2024/en';

// Open5e has the 2024 spells, rules glossary and creatures; 5e-bits has the class/species/background/level tables.
const SOURCES = [
  ...[
    'Spell',
    'Rule',
    'ConditionDescription',
    'SkillDescription',
    'AbilityDescription',
    'Creature',
    'CreatureAction',
    'CreatureActionAttack',
    'CreatureTrait',
    'ClassFeature',
  ].map((name) => ({
    url: `${OPEN5E}/${name}.json`,
    dir: 'open5e',
    file: `${name}.json`,
  })),
  ...[
    'Classes',
    'Levels',
    'Features',
    'Subclasses',
    'Species',
    'Traits',
    'Backgrounds',
    'Feats',
    'Equipment',
    'Skills',
    'Magic-Items',
    'Weapon-Mastery-Properties',
    'Weapon-Properties',
  ].map((name) => ({ url: `${BITS}/5e-SRD-${name}.json`, dir: '5e-bits', file: `${name}.json` })),
];

// Refreshing everything risks upstream drift breaking the tests, so a run may name the files it wants.
const wanted = process.argv.slice(2).map((arg) => arg.replace(/\.json$/i, '').toLowerCase());
const sources = wanted.length
  ? SOURCES.filter((s) => wanted.includes(s.file.replace(/\.json$/i, '').toLowerCase()))
  : SOURCES;
if (wanted.length && sources.length !== wanted.length) {
  throw new Error(`Unknown file(s): ${wanted.join(', ')}. Available: ${SOURCES.map((s) => s.file).join(', ')}.`);
}

const root = new URL('../srd/', import.meta.url);

for (const source of sources) {
  const dir = new URL(`${source.dir}/`, root);
  mkdirSync(dir, { recursive: true });
  const res = await fetch(source.url);
  if (!res.ok) throw new Error(`${source.url} -> HTTP ${res.status}`);
  const json = JSON.parse(await res.text());
  const path = join(dir.pathname.slice(1), source.file);
  writeFileSync(path, `${JSON.stringify(json)}\n`);
  console.log(`${source.dir}/${source.file}: ${Array.isArray(json) ? json.length : '?'} entries`);
}
