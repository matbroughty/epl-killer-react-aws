import React, { useState } from 'react';
import { abbreviateTeam } from '@/utils/teamAbbreviations';

type Props = {
  index: number;
  headers: string[];
  rows: string[][];
};

function statusForGame(gameRows: string[][]) {
  if (!gameRows.length) return { label: 'Empty', kind: 'neutral' as const };
  const last = gameRows[gameRows.length - 1];
  const hasPlus = last.some(c => (c ?? '').trim() === '+');
  return hasPlus ? { label: 'Completed', kind: 'bad' as const } : { label: 'Active', kind: 'ok' as const };
}

type ContestantCardProps = {
  name: string;
  picks: string[];
  isEliminated: boolean;
};

const ContestantCard: React.FC<ContestantCardProps> = ({ name, picks, isEliminated }) => {
  const [expanded, setExpanded] = useState(false);

  // Get the latest meaningful pick (not empty, ?, or x)
  const latestPick = [...picks].reverse().find((p: string) => {
    const trimmed = (p ?? '').trim();
    return trimmed && trimmed !== '?' && trimmed !== 'x' && trimmed !== 'X' && trimmed !== '+';
  });

  // Get the second-to-last meaningful pick for showing progression
  const previousPicks = picks.filter(p => {
    const trimmed = (p ?? '').trim();
    return trimmed && trimmed !== '?' && trimmed !== 'x' && trimmed !== 'X' && trimmed !== '+';
  });
  const prevPick = previousPicks.length > 1 ? previousPicks[previousPicks.length - 2] : null;

  // Check if contestant has a pending pick (?)
  const hasPending = picks.some(p => (p ?? '').trim() === '?');
  const latestIsPending = (picks[picks.length - 1] ?? '').trim() === '?';

  return (
    <div
      onClick={() => setExpanded(!expanded)}
      style={{
        background: isEliminated ? 'rgba(255, 107, 107, 0.08)' : '#1a2032',
        borderRadius: 8,
        padding: '12px 16px',
        marginBottom: 8,
        cursor: 'pointer',
        opacity: isEliminated ? 0.6 : 1,
        transition: 'all 0.2s ease',
        minHeight: 48,
        display: 'flex',
        flexDirection: 'column',
        border: isEliminated ? '1px solid rgba(255, 107, 107, 0.2)' : '1px solid #2d3748',
      }}
    >
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}>
        <span style={{
          fontWeight: 600,
          fontSize: '1rem',
          color: isEliminated ? '#ff6b6b' : '#e8ebf2',
        }}>
          {name}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {isEliminated ? (
            <span style={{ color: '#ff6b6b', fontWeight: 800 }}>x</span>
          ) : (
            <span style={{ color: '#a0aec0', fontSize: '0.9rem' }}>
              {prevPick && (
                <>
                  <span style={{ color: '#718096' }}>{abbreviateTeam(prevPick)}</span>
                  <span style={{ margin: '0 6px', color: '#4a5568' }}>&rarr;</span>
                </>
              )}
              {latestIsPending ? (
                <span style={{ color: '#eac54f', fontWeight: 700 }}>?</span>
              ) : latestPick ? (
                <span style={{ fontWeight: 600, color: '#e8ebf2' }}>{abbreviateTeam(latestPick)}</span>
              ) : (
                <span style={{ color: '#718096' }}>-</span>
              )}
            </span>
          )}
          <span style={{
            color: '#718096',
            fontSize: '0.8rem',
            transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 0.2s ease',
          }}>
            &#9660;
          </span>
        </div>
      </div>

      {expanded && (
        <div style={{
          marginTop: 12,
          paddingTop: 12,
          borderTop: '1px solid #2d3748',
        }}>
          <div style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 8,
          }}>
            {picks.map((pick, i) => {
              const trimmed = (pick ?? '').trim();
              const isEmpty = !trimmed;
              const isX = trimmed === 'x' || trimmed === 'X';
              const isPending = trimmed === '?';
              const isWin = trimmed === '+';

              return (
                <div
                  key={i}
                  style={{
                    background: isX ? 'rgba(255, 107, 107, 0.15)' :
                               isWin ? 'rgba(60, 207, 145, 0.15)' :
                               isPending ? 'rgba(234, 197, 79, 0.15)' :
                               '#121623',
                    padding: '6px 10px',
                    borderRadius: 6,
                    fontSize: '0.85rem',
                    minWidth: 44,
                    textAlign: 'center',
                  }}
                >
                  <span style={{ color: '#718096', fontSize: '0.7rem', display: 'block' }}>
                    W{i + 1}
                  </span>
                  <span style={{
                    fontWeight: 600,
                    color: isX ? '#ff6b6b' :
                           isWin ? '#3ccf91' :
                           isPending ? '#eac54f' :
                           isEmpty ? '#4a5568' :
                           '#e8ebf2',
                  }}>
                    {isEmpty ? '-' : isX ? 'x' : isWin ? '+' : abbreviateTeam(trimmed)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

export const MobileGameView: React.FC<Props> = ({ index, headers, rows }) => {
  const status = statusForGame(rows);

  // Build contestant data from columns (headers are contestant names)
  const contestants = headers.map((name, colIndex) => {
    const picks = rows.map(row => (row[colIndex] ?? '').trim());
    const isEliminated = picks.some(p => p === 'x' || p === 'X');
    return { name, picks, isEliminated };
  });

  // Sort: active contestants first, then eliminated
  const sortedContestants = [...contestants].sort((a, b) => {
    if (a.isEliminated === b.isEliminated) return 0;
    return a.isEliminated ? 1 : -1;
  });

  return (
    <div style={{
      background: '#121623',
      border: '1px solid #1e2536',
      borderRadius: 14,
      overflow: 'hidden',
      marginBottom: '24px',
      boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)'
    }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '16px 20px',
        borderBottom: '1px solid #1e2536',
        background: '#1a2032'
      }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <span style={{ fontWeight: 700, fontSize: '1.1rem' }}>Game {index + 1}</span>
          <span style={{
            fontSize: 12,
            padding: '3px 8px',
            borderRadius: 999,
            border: '1px solid #24304a'
          }}>{status.label}</span>
        </div>
        <span style={{ color: '#c8cbd4', fontSize: 12 }}>{rows.length} week{rows.length === 1 ? '' : 's'}</span>
      </div>
      <div style={{ padding: '16px' }}>
        {sortedContestants.map((contestant, i) => (
          <ContestantCard
            key={i}
            name={contestant.name}
            picks={contestant.picks}
            isEliminated={contestant.isEliminated}
          />
        ))}
      </div>
    </div>
  );
};
