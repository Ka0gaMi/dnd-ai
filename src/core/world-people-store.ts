// Storage for the people of the living world: royal families, their courts and the tribal elders
// who speak for wild land.
import type { Db } from '../db/connection.js';

export type PersonSex = 'male' | 'female';

export type PersonRole =
  | 'ruler'
  | 'consort'
  | 'heir'
  | 'relative'
  | 'elder'
  | 'regent'
  | 'dowager'
  | 'first_citizen'
  | 'rival';

export interface WorldPerson {
  id: number;
  name: string;
  house: string | null;
  sex: PersonSex;
  birth_day: number;
  death_day: number | null;
  died_how: string | null;
  traits: string[];
  epithet: string | null;
  role: PersonRole;
  realm_id: number | null;
  faction_id: number | null;
  entity_id: number | null;
  parent_id: number | null;
  spouse_id: number | null;
  created_day: number;
}

export interface NewWorldPerson {
  name: string;
  house?: string | null;
  sex: PersonSex;
  birth_day: number;
  death_day?: number | null;
  died_how?: string | null;
  traits?: string[];
  epithet?: string | null;
  role: PersonRole;
  realm_id?: number | null;
  faction_id?: number | null;
  entity_id?: number | null;
  parent_id?: number | null;
  spouse_id?: number | null;
  created_day: number;
}

export interface RealmCourt {
  succession_law: string | null;
  ruler_person_id: number | null;
  heir_person_id: number | null;
  regent_person_id: number | null;
  council: boolean;
}

interface PersonRow {
  id: number;
  name: string;
  house: string | null;
  sex: PersonSex;
  birth_day: number;
  death_day: number | null;
  died_how: string | null;
  traits_json: string;
  epithet: string | null;
  role: PersonRole;
  realm_id: number | null;
  faction_id: number | null;
  entity_id: number | null;
  parent_id: number | null;
  spouse_id: number | null;
  created_day: number;
}

interface CourtRow {
  succession_law: string | null;
  ruler_person_id: number | null;
  heir_person_id: number | null;
  regent_person_id: number | null;
  council: number;
}

const PERSON_COLUMNS =
  'id, name, house, sex, birth_day, death_day, died_how, traits_json, epithet, role, realm_id, faction_id, entity_id, parent_id, spouse_id, created_day';

function personFromRow(row: PersonRow): WorldPerson {
  return {
    id: row.id,
    name: row.name,
    house: row.house,
    sex: row.sex,
    birth_day: row.birth_day,
    death_day: row.death_day,
    died_how: row.died_how,
    traits: JSON.parse(row.traits_json) as string[],
    epithet: row.epithet,
    role: row.role,
    realm_id: row.realm_id,
    faction_id: row.faction_id,
    entity_id: row.entity_id,
    parent_id: row.parent_id,
    spouse_id: row.spouse_id,
    created_day: row.created_day,
  };
}

function getPersonById(db: Db, campaignId: number, id: number): WorldPerson | undefined {
  const row = db
    .prepare(`SELECT ${PERSON_COLUMNS} FROM world_person WHERE campaign_id = ? AND id = ?`)
    .get(campaignId, id) as PersonRow | undefined;
  return row ? personFromRow(row) : undefined;
}

export function insertPerson(db: Db, campaignId: number, p: NewWorldPerson): WorldPerson {
  const info = db
    .prepare(
      `INSERT INTO world_person
         (campaign_id, name, house, sex, birth_day, death_day, died_how, traits_json, epithet, role,
          realm_id, faction_id, entity_id, parent_id, spouse_id, created_day)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      campaignId,
      p.name,
      p.house ?? null,
      p.sex,
      p.birth_day,
      p.death_day ?? null,
      p.died_how ?? null,
      JSON.stringify(p.traits ?? []),
      p.epithet ?? null,
      p.role,
      p.realm_id ?? null,
      p.faction_id ?? null,
      p.entity_id ?? null,
      p.parent_id ?? null,
      p.spouse_id ?? null,
      p.created_day,
    );
  return getPersonById(db, campaignId, Number(info.lastInsertRowid))!;
}

export function getPerson(db: Db, campaignId: number, id: number): WorldPerson | undefined {
  return getPersonById(db, campaignId, id);
}

export function listPeople(
  db: Db,
  campaignId: number,
  options: { realmId?: number; alive?: boolean } = {},
): WorldPerson[] {
  const clauses: string[] = [];
  const values: number[] = [campaignId];
  if (options.realmId !== undefined) {
    clauses.push('realm_id = ?');
    values.push(options.realmId);
  }
  if (options.alive !== undefined) clauses.push(options.alive ? 'death_day IS NULL' : 'death_day IS NOT NULL');
  const where = clauses.length > 0 ? ` AND ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(`SELECT ${PERSON_COLUMNS} FROM world_person WHERE campaign_id = ?${where} ORDER BY id`)
    .all(...values) as PersonRow[];
  return rows.map(personFromRow);
}

export function updatePerson(
  db: Db,
  campaignId: number,
  id: number,
  patch: Partial<Pick<WorldPerson, 'death_day' | 'died_how' | 'epithet' | 'role' | 'spouse_id' | 'entity_id' | 'realm_id'>>,
): WorldPerson {
  if (!getPersonById(db, campaignId, id)) throw new Error(`No person ${id} in this campaign.`);

  const sets: string[] = [];
  const values: Array<number | string | null> = [];
  if (patch.death_day !== undefined) {
    sets.push('death_day = ?');
    values.push(patch.death_day);
  }
  if (patch.died_how !== undefined) {
    sets.push('died_how = ?');
    values.push(patch.died_how);
  }
  if (patch.epithet !== undefined) {
    sets.push('epithet = ?');
    values.push(patch.epithet);
  }
  if (patch.role !== undefined) {
    sets.push('role = ?');
    values.push(patch.role);
  }
  if (patch.spouse_id !== undefined) {
    sets.push('spouse_id = ?');
    values.push(patch.spouse_id);
  }
  if (patch.entity_id !== undefined) {
    sets.push('entity_id = ?');
    values.push(patch.entity_id);
  }
  if (patch.realm_id !== undefined) {
    sets.push('realm_id = ?');
    values.push(patch.realm_id);
  }
  if (sets.length > 0) {
    db.prepare(`UPDATE world_person SET ${sets.join(', ')} WHERE id = ? AND campaign_id = ?`).run(
      ...values,
      id,
      campaignId,
    );
  }
  return getPersonById(db, campaignId, id)!;
}

/** Whole years lived, counting a year as 360 world days. */
export function ageOf(person: Pick<WorldPerson, 'birth_day'>, today: number): number {
  return Math.floor((today - person.birth_day) / 360);
}

const EMPTY_COURT: RealmCourt = {
  succession_law: null,
  ruler_person_id: null,
  heir_person_id: null,
  regent_person_id: null,
  council: false,
};

export function getRealmCourt(db: Db, campaignId: number, realmId: number): RealmCourt {
  const row = db
    .prepare(
      'SELECT succession_law, ruler_person_id, heir_person_id, regent_person_id, council FROM world_realm WHERE campaign_id = ? AND id = ?',
    )
    .get(campaignId, realmId) as CourtRow | undefined;
  return row ? { ...row, council: row.council === 1 } : { ...EMPTY_COURT };
}

export function setRealmCourt(db: Db, campaignId: number, realmId: number, patch: Partial<RealmCourt>): void {
  const sets: string[] = [];
  const values: Array<number | string | null> = [];
  if (patch.succession_law !== undefined) {
    sets.push('succession_law = ?');
    values.push(patch.succession_law);
  }
  if (patch.ruler_person_id !== undefined) {
    sets.push('ruler_person_id = ?');
    values.push(patch.ruler_person_id);
  }
  if (patch.heir_person_id !== undefined) {
    sets.push('heir_person_id = ?');
    values.push(patch.heir_person_id);
  }
  if (patch.regent_person_id !== undefined) {
    sets.push('regent_person_id = ?');
    values.push(patch.regent_person_id);
  }
  if (patch.council !== undefined) {
    sets.push('council = ?');
    values.push(patch.council ? 1 : 0);
  }
  if (sets.length === 0) return;
  db.prepare(`UPDATE world_realm SET ${sets.join(', ')} WHERE id = ? AND campaign_id = ?`).run(
    ...values,
    realmId,
    campaignId,
  );
}