import React from 'react';
import { abbreviateTeam } from '@/utils/teamAbbreviations';

type Props = {
  v: string;
  abbreviated?: boolean;
};

export const MarkCell: React.FC<Props> = ({ v, abbreviated = false }) => {
  const val = (v ?? '').trim();
  if (val === '?') return <span style={{ color: '#eac54f', fontWeight: 700 }}>?</span>;
  if (val === 'x' || val === 'X') return <span style={{ color: '#ff6b6b', fontWeight: 800 }}>x</span>;
  if (val === '+') return <span style={{ color: '#3ccf91', fontWeight: 800 }}>+</span>;

  const displayVal = abbreviated ? abbreviateTeam(val) : val;
  return <>{displayVal}</>;
};
