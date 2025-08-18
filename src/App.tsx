import React, { useEffect, useState } from 'react';
import { GameTable } from '@/components/GameTable';

const CSV_URL = import.meta.env.VITE_CSV_URL as string;

// Add global styles for the loading spinner
const styles = document.createElement('style');
styles.textContent = `
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
`;
document.head.appendChild(styles);

function parseCsvSimple(text: string): string[][] {
  return text.trim().split(/\r?\n/).map(line => line.split(',').map(s => s.trim()));
}

function splitIntoGames(rows: string[][], headerLen: number): string[][][] {
  const games: string[][][] = [];
  let current: string[][] = [];
  for (const row of rows) {
    const isSep = row.length >= headerLen && row.slice(0, headerLen).every(c => (c ?? '').trim() === '---');
    if (isSep) {
      if (current.length) {
        games.push(current);
        current = [];
      }
    } else {
      current.push(row);
    }
  }
  if (current.length) games.push(current);
  return games;
}

export default function App() {
  const [url, setUrl] = useState(CSV_URL || '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>('');
  const [headers, setHeaders] = useState<string[]>([]);
  const [games, setGames] = useState<string[][][]>([]);

  const load = async () => {
    setError('');
    setLoading(true);
    try {
      if (!url) throw new Error('CSV URL is empty');
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const rows = parseCsvSimple(text);
      if (rows.length === 0) throw new Error('CSV is empty');
      const hdr = rows[0].map(s => s || '');
      const body = rows.slice(1);
      const normalized = body.map(r => {
        const copy = r.slice(0, hdr.length);
        while (copy.length < hdr.length) copy.push('');
        return copy;
      });
      const gamesSplit = splitIntoGames(normalized, hdr.length);
      setHeaders(hdr);
      setGames(gamesSplit);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  return (
    <div style={{ maxWidth: 1100, margin: '32px auto', padding: '0 16px', color: '#e8ebf2' }}>
      <div style={{ marginBottom: 32 }}>
        <h1 style={{
          fontSize: '2.5rem',
          fontWeight: 800,
          margin: 0,
          background: 'linear-gradient(90deg, #e8ebf2, #a0aec0)',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          display: 'inline-block',
          marginBottom: '8px'
        }}>
          EPL Killer
        </h1>
        <div style={{ color: '#a0aec0', fontSize: '0.95rem' }}>Premier League - Last Person Standing</div>
      </div>
      
      <div style={{ 
        display: 'flex', 
        gap: 12, 
        alignItems: 'center', 
        marginBottom: 32,
        background: '#1a2032',
        padding: '12px 16px',
        borderRadius: 10,
        border: '1px solid #2d3748'
      }}>
        <input
          type="text"
          value={url}
          onChange={e => setUrl(e.target.value)}
          placeholder="Enter CSV URL"
          style={{
            flex: 1,
            padding: '10px 14px',
            borderRadius: 6,
            border: '1px solid #2d3748',
            background: '#121623',
            color: '#e8ebf2',
            fontSize: '0.95rem',
            outline: 'none',
            transition: 'border-color 0.2s'
          } as React.CSSProperties}
          onFocus={e => e.target.style.borderColor = '#4299e1'}
          onBlur={e => e.target.style.borderColor = '#2d3748'}
        />
        <button 
          onClick={load} 
          disabled={loading}
          style={{
            padding: '10px 20px',
            borderRadius: 6,
            border: 'none',
            background: loading ? '#2d3748' : '#4299e1',
            color: 'white',
            fontWeight: 600,
            cursor: loading ? 'not-allowed' : 'pointer',
            transition: 'all 0.2s',
            transform: 'translateY(0)'
          } as React.CSSProperties}
          onMouseEnter={e => !loading && (e.currentTarget.style.background = '#3182ce', e.currentTarget.style.transform = 'translateY(-1px)')}
          onMouseLeave={e => !loading && (e.currentTarget.style.background = '#4299e1', e.currentTarget.style.transform = 'translateY(0)')}
          onMouseDown={e => !loading && (e.currentTarget.style.transform = 'translateY(0)')}
          onMouseUp={e => !loading && (e.currentTarget.style.transform = 'translateY(-1px)')}
        >
          {loading ? (
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="spinner" style={{
                display: 'inline-block',
                width: '14px',
                height: '14px',
                border: '2px solid rgba(255,255,255,0.3)',
                borderRadius: '50%',
                borderTopColor: 'white',
                animation: 'spin 1s ease-in-out infinite',
              }} />
              Loading...
            </span>
          ) : 'Refresh Data'}
        </button>
      </div>
      {error && <div>Error: {error}</div>}
      <div>
        {games.map((g, i) => (
          <GameTable key={i} index={i} headers={headers} rows={g} />
        ))}
      </div>
    </div>
  );
}
