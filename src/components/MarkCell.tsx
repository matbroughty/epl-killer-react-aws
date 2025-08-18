import React from 'react';

export const MarkCell: React.FC<{ v: string }> = ({ v }) => {
  const val = (v ?? '').trim();
  if (val === '?') return <span style={{ color: '#eac54f', fontWeight: 700 }}>?</span>;
  if (val === 'x' || val === 'X') return <span style={{ color: '#ff6b6b', fontWeight: 800 }}>x</span>;
  if (val === '+') return <span style={{ color: '#3ccf91', fontWeight: 800 }}>+</span>;
  return <>{val}</>;
};
