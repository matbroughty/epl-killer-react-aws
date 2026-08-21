/**
 * Team name normalisation.
 *
 * Live data arrives from the provider with consistent names, so this exists
 * mainly for the legacy CSV import, where a decade of hand-typed spreadsheet
 * cells produced `Necastle`, `Forrest`, `Liecester`, `ManCity` and friends.
 * Extended from the map in the previous application.
 *
 * The canonical form is the provider's `shortName` where the two agree, because
 * that is what live imports will store.
 */

interface CanonicalTeam {
  name: string;
  code: string;
}

const CANONICAL: CanonicalTeam[] = [
  { name: 'Arsenal', code: 'ARS' },
  { name: 'Aston Villa', code: 'AVL' },
  { name: 'Bournemouth', code: 'BOU' },
  { name: 'Brentford', code: 'BRE' },
  { name: 'Brighton & Hove Albion', code: 'BHA' },
  { name: 'Burnley', code: 'BUR' },
  { name: 'Chelsea', code: 'CHE' },
  { name: 'Crystal Palace', code: 'CRY' },
  { name: 'Everton', code: 'EVE' },
  { name: 'Fulham', code: 'FUL' },
  { name: 'Ipswich Town', code: 'IPS' },
  { name: 'Leeds United', code: 'LEE' },
  { name: 'Leicester City', code: 'LEI' },
  { name: 'Liverpool', code: 'LIV' },
  { name: 'Luton Town', code: 'LUT' },
  { name: 'Manchester City', code: 'MCI' },
  { name: 'Manchester United', code: 'MUN' },
  { name: 'Newcastle United', code: 'NEW' },
  { name: 'Norwich City', code: 'NOR' },
  { name: 'Nottingham Forest', code: 'NOT' },
  { name: 'Sheffield United', code: 'SHU' },
  { name: 'Southampton', code: 'SOU' },
  { name: 'Sunderland', code: 'SUN' },
  { name: 'Tottenham Hotspur', code: 'TOT' },
  { name: 'Watford', code: 'WAT' },
  { name: 'West Bromwich Albion', code: 'WBA' },
  { name: 'West Ham United', code: 'WHU' },
  { name: 'Wolverhampton Wanderers', code: 'WOL' },
];

const BY_CODE = new Map(CANONICAL.map((team) => [team.code, team]));

/**
 * Aliases, keyed by their normalised form (lower case, punctuation and spaces
 * stripped) so `Man Utd`, `man-utd` and `ManUtd` all collapse to one key.
 * Misspellings present in the historical CSV are marked.
 */
const ALIASES: Record<string, string> = {
  // Arsenal
  arsenal: 'ARS',
  ars: 'ARS',
  gunners: 'ARS',
  // Aston Villa
  astonvilla: 'AVL',
  villa: 'AVL',
  avl: 'AVL',
  // Bournemouth
  bournemouth: 'BOU',
  afcbournemouth: 'BOU',
  bou: 'BOU',
  // Brentford
  brentford: 'BRE',
  bre: 'BRE',
  brentfrod: 'BRE',
  // Brighton
  brighton: 'BHA',
  brightonhovealbion: 'BHA',
  brightonandhovealbion: 'BHA',
  bha: 'BHA',
  // Burnley
  burnley: 'BUR',
  bur: 'BUR',
  // Chelsea
  chelsea: 'CHE',
  che: 'CHE',
  chelse: 'CHE',
  // Crystal Palace
  crystalpalace: 'CRY',
  palace: 'CRY',
  cry: 'CRY',
  // Everton
  everton: 'EVE',
  eve: 'EVE',
  // Fulham
  fulham: 'FUL',
  ful: 'FUL',
  // Ipswich
  ipswich: 'IPS',
  ipswichtown: 'IPS',
  ips: 'IPS',
  // Leeds
  leeds: 'LEE',
  leedsunited: 'LEE',
  lee: 'LEE',
  // Leicester
  leicester: 'LEI',
  leicestercity: 'LEI',
  lei: 'LEI',
  liecester: 'LEI', // CSV misspelling
  leciester: 'LEI',
  // Liverpool
  liverpool: 'LIV',
  liv: 'LIV',
  liverpoool: 'LIV',
  // Luton
  luton: 'LUT',
  lutontown: 'LUT',
  lut: 'LUT',
  // Man City
  mancity: 'MCI', // covers the CSV's "ManCity"
  manchestercity: 'MCI',
  city: 'MCI', // CSV shorthand
  mci: 'MCI',
  mancty: 'MCI',
  // Man United
  manunited: 'MUN',
  manutd: 'MUN',
  manu: 'MUN',
  manchesterunited: 'MUN',
  mun: 'MUN',
  manure: 'MUN',
  // Newcastle
  newcastle: 'NEW',
  newcastleunited: 'NEW',
  new: 'NEW',
  necastle: 'NEW', // CSV misspelling
  newastle: 'NEW', // CSV misspelling
  newcstle: 'NEW',
  // Norwich
  norwich: 'NOR',
  norwichcity: 'NOR',
  nor: 'NOR',
  // Nottingham Forest
  nottinghamforest: 'NOT',
  nottmforest: 'NOT',
  forest: 'NOT',
  nottingham: 'NOT', // CSV shorthand
  forrest: 'NOT', // CSV misspelling
  nottinghamforrest: 'NOT', // CSV misspelling
  nfo: 'NOT',
  not: 'NOT',
  // Sheffield United
  sheffieldunited: 'SHU',
  sheffutd: 'SHU',
  sheffield: 'SHU',
  shu: 'SHU',
  // Southampton
  southampton: 'SOU',
  saints: 'SOU',
  sou: 'SOU',
  // Sunderland
  sunderland: 'SUN',
  sun: 'SUN',
  // Tottenham
  tottenham: 'TOT',
  tottenhamhotspur: 'TOT',
  spurs: 'TOT',
  tot: 'TOT',
  // Watford
  watford: 'WAT',
  wat: 'WAT',
  // West Brom
  westbromwichalbion: 'WBA',
  westbrom: 'WBA',
  wba: 'WBA',
  // West Ham
  westham: 'WHU',
  westhamunited: 'WHU',
  whu: 'WHU',
  // Wolves
  wolves: 'WOL',
  wolverhampton: 'WOL',
  wolverhamptonwanderers: 'WOL',
  wol: 'WOL',
};

/** Lower case, strip everything that is not a letter or digit. */
export function normaliseKey(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Resolve a free-text team name to a canonical name and three-letter code.
 *
 * Returns null when it cannot be resolved, so the caller decides whether that
 * is a warning or a hard failure. The legacy importer reports every null rather
 * than guessing.
 */
export function resolveTeamName(input: string): CanonicalTeam | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // The CSV contains one cell of the form `Liverpool(Southampton)` — someone
  // recording a change of mind. Take the first name and flag it upstream.
  const withoutParenthetical = trimmed.replace(/\(.*\)\s*$/, '').trim();

  const key = normaliseKey(withoutParenthetical);
  const code = ALIASES[key];
  if (code) {
    const canonical = BY_CODE.get(code);
    if (canonical) return canonical;
  }
  return null;
}

/** True when a cell held more than one team name, e.g. `Liverpool(Southampton)`. */
export function hasParentheticalAlternative(input: string): boolean {
  return /\(.+\)\s*$/.test(input.trim());
}

/**
 * Three-letter code for display, e.g. `ARS`. Falls back to the first three
 * characters upper-cased so an unknown team still renders something sensible.
 */
export function teamCode(name: string): string {
  const resolved = resolveTeamName(name);
  if (resolved) return resolved.code;
  return name.trim().slice(0, 3).toUpperCase();
}

export function allCanonicalTeams(): readonly CanonicalTeam[] {
  return CANONICAL;
}
