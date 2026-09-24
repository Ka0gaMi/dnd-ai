// The catalogue of faction agendas the living world may run. Pure data: what kind of faction pursues
// each goal, its clock, the warning signs a traveller could notice, and what winning costs the world.
export type FactionType = 'realm' | 'house' | 'church' | 'guild' | 'gang' | 'monsters' | 'off_map';
export type TargetRule =
  | 'rival_faction'
  | 'neighbour_county'
  | 'settlement'
  | 'danger'
  | 'own_seat'
  | 'heresy'
  | 'church_in_realm';

export interface AgendaOutcome {
  text: string;
  severity: 1 | 2 | 3 | 4 | 5;
  resources: number;
  target_resources: number;
  irreversible: boolean;
}

export interface AgendaTemplate {
  id: string;
  label: string;
  runners: FactionType[];
  target: TargetRule;
  clock_size: 4 | 6 | 8;
  portents: string[];
  on_win: AgendaOutcome;
}

export const AGENDA_TEMPLATES: readonly AgendaTemplate[] = [
  {
    id: 'expand_territory',
    label: 'Expand territory',
    runners: ['realm', 'house'],
    target: 'neighbour_county',
    clock_size: 8,
    portents: [
      'Levies are mustered in {place}.',
      '{faction} riders are seen near {target}.',
      'Envoys from {faction} demand tribute from {target}.',
      'Border stones are moved and new toll posts appear on the {target} road.',
      'Songs in {place} name {faction} as the coming power.',
    ],
    on_win: {
      text: '{faction} takes control of {target}',
      severity: 4,
      resources: 1,
      target_resources: -1,
      irreversible: false,
    },
  },
  {
    id: 'raid',
    label: 'Raid',
    runners: ['gang', 'monsters'],
    target: 'settlement',
    clock_size: 4,
    portents: [
      'Tracks and cold camps are found within a day of {target}.',
      'A merchant caravan bound for {target} fails to arrive.',
      'Watchfires burn late along the walls of {target}.',
      'Farmsteads outside {target} stand empty, doors open.',
    ],
    on_win: {
      text: '{faction} raids {target}',
      severity: 3,
      resources: 1,
      target_resources: -1,
      irreversible: false,
    },
  },
  {
    id: 'trade_monopoly',
    label: 'Trade monopoly',
    runners: ['guild'],
    target: 'rival_faction',
    clock_size: 8,
    portents: [
      "Prices for {target}'s goods rise in every market in {place}.",
      'Warehouses in {place} fill with stock marked by {faction}.',
      "Two of {target}'s caravans are turned back at the gates.",
      '{faction} hires every caravan master in {place}.',
      'A notice in {place} names {faction} sole buyer of the trade.',
    ],
    on_win: {
      text: '{faction} forces {target} out of trade',
      severity: 3,
      resources: 1,
      target_resources: -1,
      irreversible: false,
    },
  },
  {
    id: 'conversion',
    label: 'Conversion',
    runners: ['church'],
    target: 'settlement',
    clock_size: 6,
    portents: [
      'Preachers of {faction} hold open-air services in {target}.',
      'A shrine to {faction} is raised at the edge of {target}.',
      'Fewer offerings reach the old temple in {target}.',
      'Families in {target} ask {faction} to bless their doorways.',
    ],
    on_win: {
      text: '{target} turns to the faith of {faction}',
      severity: 2,
      resources: 1,
      target_resources: 0,
      irreversible: false,
    },
  },
  {
    id: 'hunt_monster',
    label: 'Hunt a monster',
    runners: ['house', 'church', 'guild'],
    target: 'danger',
    clock_size: 6,
    portents: [
      "Hunters wearing {faction}'s colours ask after {target} in {place}.",
      'Bounty notices for {target} are posted by {faction}.',
      'Wagons of traps and spears roll out of {place} toward {target}.',
      'Scouts from {faction} map the ground around {target}.',
    ],
    on_win: {
      text: '{faction} hunters strike at {target}',
      severity: 3,
      resources: 0,
      target_resources: -2,
      irreversible: false,
    },
  },
  {
    id: 'build',
    label: 'Build',
    runners: ['realm', 'house', 'church', 'guild'],
    target: 'own_seat',
    clock_size: 8,
    portents: [
      'Scaffolding rises over {target}.',
      'Masons and carters are hired away from {place} to {target}.',
      'Dust and hammering carry across {target} all day.',
      '{faction} buys timber and stone in every yard in {place}.',
      'A new foundation is staked out at the heart of {target}.',
    ],
    on_win: {
      text: '{faction} completes a new work in {target}',
      severity: 2,
      resources: -1,
      target_resources: 0,
      irreversible: false,
    },
  },
  {
    id: 'feud',
    label: 'Open feud',
    runners: ['house', 'gang'],
    target: 'rival_faction',
    clock_size: 6,
    portents: [
      'Retainers of {faction} and {target} drink apart in {place}.',
      'A duel between {faction} and {target} men ends in blood.',
      'Insults to {target} are sung openly in {place}.',
      'Guards double at the doors of {faction} and {target} alike.',
    ],
    on_win: {
      text: '{faction} humiliates {target} in open feud',
      severity: 3,
      resources: 1,
      target_resources: -1,
      irreversible: false,
    },
  },
  {
    id: 'monsters_grow',
    label: 'Monsters grow',
    runners: ['monsters'],
    target: 'settlement',
    clock_size: 6,
    portents: [
      'Refugees from the wilds reach {place} with stories of {faction}.',
      'Livestock vanish from the pastures around {target}.',
      'Tracks of {faction} are found closer to {target} each night.',
      'Smoke rises from the woods beyond {target}.',
      'Trappers report {faction} in numbers no one has seen before.',
    ],
    on_win: {
      text: '{faction} overruns {target}',
      severity: 4,
      resources: 1,
      target_resources: -2,
      irreversible: true,
    },
  },
  {
    id: 'crusade',
    label: 'Crusade',
    runners: ['church', 'realm'],
    target: 'danger',
    clock_size: 6,
    portents: [
      "Knights in {faction}'s colours gather in {place}.",
      'Priests of {faction} preach a holy war against {target}.',
      'Pilgrims bring arms and coin to {place} for the crusade.',
      'A banner of {faction} is blessed before the march on {target}.',
    ],
    on_win: {
      text: '{faction} crusaders purge {target}',
      severity: 3,
      resources: 1,
      target_resources: -2,
      irreversible: false,
    },
  },
  {
    id: 'persecute',
    label: 'Persecute heretics',
    runners: ['church', 'realm'],
    target: 'heresy',
    clock_size: 6,
    portents: [
      'Inquisitors of {faction} arrive in {place}.',
      'Tracts of {target} are burned in the square at {place}.',
      'Followers of {target} are named from the pulpit in {place}.',
      'Some who whispered for {target} are taken in the night.',
    ],
    on_win: {
      text: '{faction} drives {target} underground',
      severity: 3,
      resources: 0,
      target_resources: -2,
      irreversible: false,
    },
  },
  {
    id: 'raise_cathedral',
    label: 'Raise a cathedral',
    runners: ['church', 'realm'],
    target: 'own_seat',
    clock_size: 8,
    portents: [
      'Masons gather at {target} for a great work of {faction}.',
      'Collection plates in {place} fill for a new cathedral.',
      'The foundations of a cathedral are laid in {target}.',
      'Stained glass arrives in {target} from distant workshops.',
    ],
    on_win: {
      text: '{faction} consecrates a cathedral in {target}',
      severity: 2,
      resources: 1,
      target_resources: 0,
      irreversible: false,
    },
  },
  {
    id: 'seize_church_lands',
    label: 'Seize church lands',
    runners: ['realm'],
    target: 'church_in_realm',
    clock_size: 6,
    portents: [
      'Tax assessors of {faction} survey the lands of {target}.',
      '{faction} questions the tithes owed to {target}.',
      "Soldiers of {faction} are seen at the gates of {target}'s estates.",
      'Sermons in {place} rail against {faction}.',
    ],
    on_win: {
      text: '{faction} seizes the lands of {target}',
      severity: 3,
      resources: 2,
      target_resources: -2,
      irreversible: false,
    },
  },
];

/** The templates a faction of this type may run, in catalogue order. */
export function templatesFor(type: FactionType): AgendaTemplate[] {
  return AGENDA_TEMPLATES.filter((t) => t.runners.includes(type));
}

/** Replaces {faction}, {target} and {place}; {place} falls back to the target when none is given. */
export function fillText(text: string, vars: { faction: string; target: string; place?: string }): string {
  const place = vars.place ?? vars.target;
  return text
    .replaceAll('{faction}', vars.faction)
    .replaceAll('{target}', vars.target)
    .replaceAll('{place}', place);
}
