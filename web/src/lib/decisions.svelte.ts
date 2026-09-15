// The questions only the player can answer: the DM proposes a piece of homebrew, they accept,
// reject or edit it. One card at a time, like the roll prompt, and it survives its own timeout.
import type { ClauseStatus, Mechanics, NumericMechanic, PowerReport, PowerVerdict, SpellEffect } from './progression';
import { applyMechanicEdits, numericMechanics } from './progression';

export interface HomebrewDecisionPayload {
  name: string;
  text: string;
  mechanics: Mechanics;
  /** Per clause, what the server says the engine will run; absent when the proposal carried none. */
  clause_status?: ClauseStatus[];
  justification?: string;
  report: PowerReport;
  character_id: number | null;
}

export interface SubclassFeature {
  name: string;
  text: string;
  mechanics?: Mechanics;
}

export interface SubclassBundle {
  level: number;
  budget_used: number;
  budget_allowed: number;
  items: PowerReport['items'];
  verdict: PowerVerdict;
}

export interface HomebrewSubclassSchema {
  class: string;
  name: string;
  flavour_text: string;
  /** Keyed by level, as strings: "3", "6", "10", "14". */
  features: Record<string, SubclassFeature[]>;
}

export interface HomebrewSubclassPayload {
  schema: HomebrewSubclassSchema;
  justification?: string;
  report: { bundles: SubclassBundle[] };
  character_id: number | null;
}

export interface HomebrewSpellSchema {
  name: string;
  level: number;
  school: string;
  casting_time: string;
  range: string;
  components: string;
  duration: string;
  concentration: boolean;
  ritual: boolean;
  effect: SpellEffect;
  text: string;
}

export interface HomebrewSpellPayload {
  schema: HomebrewSpellSchema;
  justification?: string;
  report: PowerReport;
  character_id: number | null;
}

export type DecisionPayload = HomebrewDecisionPayload | HomebrewSubclassPayload | HomebrewSpellPayload;

export interface PendingDecision {
  id: number;
  campaign_id: number;
  kind: string;
  payload: DecisionPayload;
  created_at: string;
  resolved_at: string | null;
}

/** The name in the title, whichever shape the kind gave the payload. */
function decisionName(decision: PendingDecision): string {
  if (decision.kind === 'homebrew_subclass') return (decision.payload as HomebrewSubclassPayload).schema.name;
  if (decision.kind === 'homebrew_spell') return (decision.payload as HomebrewSpellPayload).schema.name;
  return (decision.payload as HomebrewDecisionPayload).name;
}

/** The numbers this decision's Edit form may offer, whichever shape the kind gave the payload. */
export function decisionNumericFields(decision: PendingDecision): NumericMechanic[] {
  if (decision.kind === 'homebrew_subclass') {
    return subclassNumericFields((decision.payload as HomebrewSubclassPayload).schema.features);
  }
  if (decision.kind === 'homebrew_spell') {
    return numericSpellFields((decision.payload as HomebrewSpellPayload).schema);
  }
  return numericMechanics((decision.payload as HomebrewDecisionPayload).mechanics);
}

/** The typed boxes back into the shape the server expects for an "edit" resolution. */
export function buildDecisionEdit(
  decision: PendingDecision,
  typed: Record<string, string>,
):
  | { edits: { mechanics: Mechanics } | { schema: HomebrewSubclassSchema } | { schema: HomebrewSpellSchema } }
  | { error: string } {
  if (decision.kind === 'homebrew_subclass') {
    const edited = applySubclassFieldEdits((decision.payload as HomebrewSubclassPayload).schema, typed);
    return 'error' in edited ? edited : { edits: { schema: edited.schema } };
  }
  if (decision.kind === 'homebrew_spell') {
    const edited = applySpellFieldEdits((decision.payload as HomebrewSpellPayload).schema, typed);
    return 'error' in edited ? edited : { edits: { schema: edited.schema } };
  }
  const edited = applyMechanicEdits((decision.payload as HomebrewDecisionPayload).mechanics, typed);
  return 'error' in edited ? edited : { edits: { mechanics: edited.mechanics } };
}

/** Every feature across every level bundle that carries mechanics, flattened for the Edit form. */
export function subclassNumericFields(features: Record<string, SubclassFeature[]>): NumericMechanic[] {
  const fields: NumericMechanic[] = [];
  for (const [level, list] of Object.entries(features)) {
    list.forEach((feature, index) => {
      if (!feature.mechanics) return;
      for (const field of numericMechanics(feature.mechanics)) {
        fields.push({ ...field, key: `${level}.${index}.${field.key}`, label: `${feature.name} — ${field.label}` });
      }
    });
  }
  return fields;
}

/** Splits the typed boxes back out per feature, and re-applies each feature's own edit rules. */
export function applySubclassFieldEdits(
  schema: HomebrewSubclassSchema,
  typed: Record<string, string>,
): { schema: HomebrewSubclassSchema } | { error: string } {
  const features: Record<string, SubclassFeature[]> = {};
  for (const [level, list] of Object.entries(schema.features)) {
    const nextList: SubclassFeature[] = [];
    for (let index = 0; index < list.length; index += 1) {
      const feature = list[index]!;
      if (!feature.mechanics) {
        nextList.push(feature);
        continue;
      }
      const prefix = `${level}.${index}.`;
      const subset = Object.fromEntries(
        Object.entries(typed)
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, value]) => [key.slice(prefix.length), value]),
      );
      const edited = applyMechanicEdits(feature.mechanics, subset);
      if ('error' in edited) return edited;
      nextList.push({ ...feature, mechanics: edited.mechanics });
    }
    features[level] = nextList;
  }
  return { schema: { ...schema, features } };
}

/** A homebrew spell's schema has no mechanics of its own: only its numeric effect fields are editable. */
export function numericSpellFields(schema: HomebrewSpellSchema): NumericMechanic[] {
  const fields: NumericMechanic[] = [];
  if (typeof schema.effect?.targets === 'number') {
    fields.push({ key: 'effect.targets', label: 'Targets', value: schema.effect.targets, min: 1, max: 20 });
  }
  return fields;
}

export function applySpellFieldEdits(
  schema: HomebrewSpellSchema,
  typed: Record<string, string>,
): { schema: HomebrewSpellSchema } | { error: string } {
  const effect = { ...schema.effect };
  for (const field of numericSpellFields(schema)) {
    const written = (typed[field.key] ?? String(field.value)).trim();
    const value = Number(written);
    if (written === '' || !Number.isInteger(value) || value < field.min || value > field.max) {
      return { error: `${field.label}: a whole number from ${field.min} to ${field.max}.` };
    }
    if (field.key === 'effect.targets') effect.targets = value;
  }
  return { schema: { ...schema, effect } };
}

export type DecisionChoice = 'accept' | 'reject' | 'edit';

export interface DecisionResult {
  decision: DecisionChoice;
  summary: string;
  applied: boolean;
  name: string;
  power_label: PowerVerdict;
  homebrew_id?: number;
}

/** asking: the card as the DM sent it · editing: the player is changing the numbers first. */
export type DecisionPhase = 'asking' | 'editing' | 'answered';

const KIND_WORDS: Record<string, string> = {
  homebrew_feature: 'The DM proposes',
  homebrew_background: 'The DM proposes a background',
  homebrew_feat: 'The DM proposes a feat',
  homebrew_subclass: 'The DM proposes a subclass',
  homebrew_spell: 'The DM proposes a spell',
};

/** "The DM proposes: Trapwright" - the kind says what sort of thing it is, the payload names it. */
export function decisionTitle(decision: PendingDecision): string {
  return `${KIND_WORDS[decision.kind] ?? 'The DM asks about'}: ${decisionName(decision)}`;
}

/** Oldest first: the DM asked them in that order. */
const inOrder = (rows: PendingDecision[]): PendingDecision[] => [...rows].sort((a, b) => a.id - b.id);

export class DecisionStore {
  queue = $state<PendingDecision[]>([]);
  phase = $state<DecisionPhase>('asking');
  result = $state<DecisionResult | null>(null);
  /** One box per number the player may nudge, keyed as `numericMechanics` keys them. */
  edit = $state<Record<string, string>>({});
  /** The DM's own wait ran out: the card stays, and an answer still counts. */
  timedOut = $state(false);
  note = $state<string | null>(null);
  error = $state<string | null>(null);
  busy = $state(false);

  get current(): PendingDecision | null {
    return this.queue[0] ?? null;
  }

  /** The open questions on connect; ones already on screen keep their place and their phase. */
  setOpen(rows: PendingDecision[]): void {
    const known = new Set(this.queue.map((row) => row.id));
    this.queue = inOrder([...this.queue, ...rows.filter((row) => !known.has(row.id) && row.resolved_at === null)]);
  }

  add(row: PendingDecision): void {
    if (row.resolved_at !== null || this.queue.some((queued) => queued.id === row.id)) return;
    this.queue = inOrder([...this.queue, row]);
  }

  start(): void {
    this.busy = true;
    this.error = null;
  }

  /** "Edit": the numbers open for typing, starting at what the DM proposed. */
  startEdit(): void {
    const current = this.current;
    if (!current) return;
    this.edit = Object.fromEntries(decisionNumericFields(current).map((field) => [field.key, String(field.value)]));
    this.phase = 'editing';
    this.error = null;
  }

  cancelEdit(): void {
    this.phase = 'asking';
    this.edit = {};
    this.error = null;
  }

  showResult(result: DecisionResult): void {
    this.busy = false;
    this.phase = 'answered';
    this.result = result;
    this.note = result.summary;
  }

  /** 409: it was answered elsewhere, or the DM's own tool wrote the answer first. */
  alreadyAnswered(): void {
    this.busy = false;
    this.phase = 'answered';
    this.result = null;
    this.note = 'Already answered.';
  }

  fail(message: string): void {
    this.busy = false;
    this.error = message;
  }

  /** The DM waited as long as a roll and moved on; the question is still the player's to answer. */
  markTimedOut(): void {
    this.timedOut = true;
  }

  dismiss(): void {
    this.queue = this.queue.slice(1);
    this.phase = 'asking';
    this.result = null;
    this.edit = {};
    this.timedOut = false;
    this.note = null;
    this.error = null;
    this.busy = false;
  }

  clear(): void {
    this.queue = [];
    this.dismiss();
  }
}
