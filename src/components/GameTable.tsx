import React from 'react';
import { MarkCell } from './MarkCell';

function statusForGame(gameRows: string[][]) {
  if (!gameRows.length) return { label: 'Empty', kind: 'neutral' as const };
  const last = gameRows[gameRows.length - 1];
  const hasPlus = last.some(c => (c ?? '').trim() === '+');
  return hasPlus ? { label: 'Completed', kind: 'bad' as const } : { label: 'Active', kind: 'ok' as const };
}

type Props = {
  index: number;
  headers: string[];
  rows: string[][];
};

export const GameTable: React.FC<Props> = ({ index, headers, rows }) => {
  const status = statusForGame(rows);

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
          <span style={{ fontSize: 12, padding: '3px 8px', borderRadius: 999, border: '1px solid #24304a' }}>{status.label}</span>
        </div>
        <span style={{ color: '#c8cbd4', fontSize: 12 }}>{rows.length} week{rows.length === 1 ? '' : 's'}</span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{
          width: '100%',
          borderCollapse: 'separate',
          borderSpacing: 0
        }}>
          <thead>
            <tr>
              {headers.map((h, i) => (
                <th key={i} style={{
                  padding: '14px 12px',
                  textAlign: 'center',
                  borderBottom: '1px solid #1e2536',
                  fontWeight: 600,
                  fontSize: '0.95rem',
                  color: '#a0aec0',
                  background: '#1a2032'
                }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri} style={{
                transition: 'background-color 0.2s ease',
                ':hover': {
                  backgroundColor: 'rgba(255, 255, 255, 0.03)'
                }
              }}>
                {headers.map((_, ci) => (
                  <td key={ci} style={{
                    textAlign: 'center',
                    padding: '12px',
                    borderBottom: '1px solid #1e2536',
                    fontSize: '1rem',
                    color: '#e8ebf2'
                  }}>
                    <MarkCell v={(r[ci] ?? '').trim()} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
