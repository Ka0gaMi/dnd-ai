import { describe, expect, it } from 'vitest';
import { groupRelations, layoutTree, relationWording } from '../src/lib/codex';
import type { EntityRelation, TreeNode } from '../src/lib/types';

const tie = (id: number, as: string, name: string): EntityRelation => ({
  id,
  type: as,
  as,
  direction: 'out',
  entity: { id: id + 100, name, kind: 'npc' },
  notes: '',
});

const node = (id: number, name: string, relation: string | null, links: TreeNode[] = []): TreeNode => ({
  id,
  name,
  kind: 'npc',
  relation,
  links,
});

describe('relation wording', () => {
  it('reads each stored side as words', () => {
    expect(relationWording('child')).toBe('Child of');
    expect(relationWording('member_of')).toBe('Member of');
    expect(relationWording('ally')).toBe('Ally of');
    expect(relationWording('has_member')).toBe('Members');
  });

  it('falls back to the raw wording for anything the server adds later', () => {
    expect(relationWording('sworn_to')).toBe('Sworn to');
    expect(relationWording('')).toBe('Tied to');
  });

  it('groups ties by their wording, blood before allegiance before acquaintance', () => {
    const groups = groupRelations([tie(1, 'knows', 'Mattis'), tie(2, 'child', 'Alda'), tie(3, 'member_of', 'The Watch')]);
    expect(groups.map((group) => group.label)).toEqual(['Child of', 'Member of', 'Knows']);
  });

  it('puts every tie of one kind in one group', () => {
    const groups = groupRelations([tie(1, 'ally', 'Bern'), tie(2, 'ally', 'Cass')]);
    expect(groups).toHaveLength(1);
    expect(groups[0].relations.map((relation) => relation.entity.name)).toEqual(['Bern', 'Cass']);
  });

  it('keeps an unknown tie in its own group at the end', () => {
    const groups = groupRelations([tie(1, 'haunts', 'The Mill'), tie(2, 'enemy', 'Ivo')]);
    expect(groups.map((group) => group.as)).toEqual(['enemy', 'haunts']);
  });
});

describe('tree layout', () => {
  /** `relation` says what the node above is to this one, so "parent" hangs a child below. */
  const tree = node(1, 'Rowan', null, [
    node(2, 'Alda', 'child'),
    node(3, 'Bern', 'spouse'),
    node(4, 'Cass', 'parent', [node(5, 'Dov', 'parent')]),
    node(6, 'The Watch', 'member_of'),
  ]);

  it('puts parents above, spouse beside, children below and factions in their own box', () => {
    expect(layoutTree(tree).groups.map((group) => [group.band, group.label])).toEqual([
      ['above', 'Parents'],
      ['beside', 'Married to'],
      ['below', 'Children'],
      ['factions', 'Factions'],
    ]);
  });

  it('keeps the entity it was drawn for as the root', () => {
    expect(layoutTree(tree).root).toEqual({ id: 1, name: 'Rowan', kind: 'npc' });
  });

  it('names what each node is to the one it hangs off', () => {
    const groups = layoutTree(tree).groups;
    expect(groups[0].entries[0]).toMatchObject({ name: 'Alda', role: 'parent', depth: 0 });
    expect(groups[3].entries[0]).toMatchObject({ name: 'The Watch', role: 'faction' });
  });

  it('indents the step beyond a direct tie instead of drawing it flat', () => {
    const children = layoutTree(tree).groups.find((group) => group.band === 'below')!;
    expect(children.entries.map((entry) => [entry.name, entry.depth])).toEqual([
      ['Cass', 0],
      ['Dov', 1],
    ]);
  });

  it('lays out an entity with no ties as an empty tree', () => {
    expect(layoutTree(node(9, 'Alone', null)).groups).toEqual([]);
  });
});
