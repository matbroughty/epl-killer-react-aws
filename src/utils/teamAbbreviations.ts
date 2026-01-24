const teamAbbreviations: Record<string, string> = {
  // Full names
  'Arsenal': 'ARS',
  'Aston Villa': 'AVL',
  'Bournemouth': 'BOU',
  'Brentford': 'BRE',
  'Brighton': 'BHA',
  'Brighton & Hove Albion': 'BHA',
  'Chelsea': 'CHE',
  'Crystal Palace': 'CRY',
  'Everton': 'EVE',
  'Fulham': 'FUL',
  'Ipswich': 'IPS',
  'Ipswich Town': 'IPS',
  'Leicester': 'LEI',
  'Leicester City': 'LEI',
  'Liverpool': 'LIV',
  'Man City': 'MCI',
  'Manchester City': 'MCI',
  'Man United': 'MUN',
  'Manchester United': 'MUN',
  'Newcastle': 'NEW',
  'Newcastle United': 'NEW',
  'Nottingham Forest': 'NFO',
  'Nott\'m Forest': 'NFO',
  'Southampton': 'SOU',
  'Spurs': 'TOT',
  'Tottenham': 'TOT',
  'Tottenham Hotspur': 'TOT',
  'West Ham': 'WHU',
  'West Ham United': 'WHU',
  'Wolves': 'WOL',
  'Wolverhampton': 'WOL',
  'Wolverhampton Wanderers': 'WOL',
  // Additional common variations
  'Man Utd': 'MUN',
  'Nottm Forest': 'NFO',
  'Forest': 'NFO',
  'Villa': 'AVL',
  'Palace': 'CRY',
};

export function abbreviateTeam(name: string): string {
  const trimmed = (name ?? '').trim();

  // Check for special markers first
  if (trimmed === '?' || trimmed === 'x' || trimmed === 'X' || trimmed === '+' || trimmed === '') {
    return trimmed;
  }

  // Direct lookup
  if (teamAbbreviations[trimmed]) {
    return teamAbbreviations[trimmed];
  }

  // Case-insensitive lookup
  const lowerName = trimmed.toLowerCase();
  for (const [key, abbr] of Object.entries(teamAbbreviations)) {
    if (key.toLowerCase() === lowerName) {
      return abbr;
    }
  }

  // If already a 3-letter abbreviation, return as-is
  if (trimmed.length === 3 && trimmed === trimmed.toUpperCase()) {
    return trimmed;
  }

  // Fallback: return first 3 characters uppercase
  return trimmed.slice(0, 3).toUpperCase();
}
