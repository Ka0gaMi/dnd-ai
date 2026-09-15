// The codex panel's pure parts: how a relationship reads in words, and how the tree around an
// entity falls into bands (parents above, spouse beside, children below, factions in a box).
import type { EntityKind, EntityRelation, TreeNode } from './types';

/** `as` is this entity's side of the tie: a stored "parent" reads as "child" from the other end. */
const RELATION_WORDS: Record<string, string> = {
  parent: 'Parent of',
  child: 'Child of',
  spouse: 'Married to',
  sibling: 'Sibling of',
  ally: 'Ally of',
  enemy: 'Enemy of',
  member_of: 'Member of',
  has_member: 'Members',
  owns: 'Owns',
  owned_by: 'Owned by',
  rules: 'Rules',
  ruled_by: 'Ruled by',
  serves: 'Serves',
  served_by: 'Served by',
  knows: 'Knows',
  rival: 'Rival of',
  lover: 'Lover of',
};

/** The order the groups read in on the entity page: blood first, then loyalty, then acquaintance. */
const RELATION_ORDER = Object.keys(RELATION_WORDS);

export function relationWording(as: string): string {
  const known = RELATION_WORDS[as];
  if (known) return known;
  const words = as.replace(/_/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : 'Tied to';
}

export interface RelationGroup {
  as: string;
  label: string;
  relations: EntityRelation[];
}

/** One group per wording, in the order above; anything unknown keeps its own place at the end. */
export function groupRelations(relations: EntityRelation[]): RelationGroup[] {
  const groups = new Map<string, RelationGroup>();
  for (const relation of relations) {
    const group = groups.get(relation.as);
    if (group) group.relations.push(relation);
    else groups.set(relation.as, { as: relation.as, label: relationWording(relation.as), relations: [relation] });
  }
  const rank = (as: string): number => {
    const index = RELATION_ORDER.indexOf(as);
    return index === -1 ? RELATION_ORDER.length : index;
  };
  return [...groups.values()].sort((a, b) => rank(a.as) - rank(b.as));
}

export type TreeBand = 'above' | 'beside' | 'below' | 'factions';

/** A node's `relation` says what the node above it is to it, so the bands read the other way round. */
const BANDS: Record<string, { band: TreeBand; label: string; role: string }> = {
  child: { band: 'above', label: 'Parents', role: 'parent' },
  parent: { band: 'below', label: 'Children', role: 'child' },
  spouse: { band: 'beside', label: 'Married to', role: 'spouse' },
  sibling: { band: 'beside', label: 'Siblings', role: 'sibling' },
  member_of: { band: 'factions', label: 'Factions', role: 'faction' },
  has_member: { band: 'factions', label: 'Members', role: 'member' },
};

const BAND_ORDER: TreeBand[] = ['above', 'beside', 'below', 'factions'];

export interface TreeEntry {
  id: number;
  name: string;
  kind: EntityKind;
  /** What this node is to the one it hangs off: "child", "faction", and so on. */
  role: string;
  /** 0 for a direct tie, 1 and 2 for the two steps the server walks beyond it. */
  depth: number;
}

export interface TreeGroup {
  band: TreeBand;
  label: string;
  entries: TreeEntry[];
}

export interface TreeLayout {
  root: { id: number; name: string; kind: EntityKind };
  groups: TreeGroup[];
}

/** The tree as bands of indented rows: read-only, no geometry beyond the depth of each row. */
export function layoutTree(root: TreeNode): TreeLayout {
  const groups: TreeGroup[] = [];
  const find = (band: TreeBand, label: string): TreeGroup => {
    const found = groups.find((group) => group.band === band && group.label === label);
    if (found) return found;
    const made: TreeGroup = { band, label, entries: [] };
    groups.push(made);
    return made;
  };

  const walk = (node: TreeNode, group: TreeGroup, depth: number): void => {
    const band = BANDS[node.relation ?? ''];
    group.entries.push({
      id: node.id,
      name: node.name,
      kind: node.kind,
      role: band?.role ?? relationWording(node.relation ?? '').toLowerCase(),
      depth,
    });
    for (const link of node.links) walk(link, group, depth + 1);
  };

  for (const link of root.links) {
    const band = BANDS[link.relation ?? ''] ?? { band: 'below' as TreeBand, label: 'Tied to', role: 'tie' };
    walk(link, find(band.band, band.label), 0);
  }
  return {
    root: { id: root.id, name: root.name, kind: root.kind },
    groups: groups.sort((a, b) => BAND_ORDER.indexOf(a.band) - BAND_ORDER.indexOf(b.band)),
  };
}
