import { evaluate, compareRanks } from './cards.js';

const RANKS = '23456789TJQKA';
const SUITS = 'shdc';

const STYLES = {
  tight: { foldBelow: 0.46, raiseAbove: 0.64, aggression: 0.28 },
  loose: { foldBelow: 0.3, raiseAbove: 0.74, aggression: 0.18 },
  aggro: { foldBelow: 0.36, raiseAbove: 0.5, aggression: 0.72 },
};

function allCards() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) deck.push(rank + suit);
  }
  return deck;
}

function parse(code) {
  return { r: RANKS.indexOf(code[0]), s: code[1] };
}

export function preflopStrength(hole) {
  const [a, b] = hole.map(parse);
  const high = Math.max(a.r, b.r);
  const low = Math.min(a.r, b.r);
  const suited = a.s === b.s;
  const gap = high - low;
  if (a.r === b.r) return Math.min(0.97, 0.5 + high / 26);
  let score = 0.18 + high / 22;
  if (suited) score += 0.06;
  if (gap === 1) score += 0.05;
  else if (gap === 2) score += 0.02;
  else if (gap > 4) score -= 0.07;
  if (high >= 12 && low >= 10) score += 0.16;
  else if (high >= 11 && low >= 9) score += 0.06;
  return Math.max(0.12, Math.min(0.9, score));
}

export function equity(hole, board, trials = 48) {
  const used = new Set([...hole, ...board]);
  const deck = allCards().filter((card) => !used.has(card));
  const needBoard = 5 - board.length;
  const need = needBoard + 2;
  let score = 0;
  for (let trial = 0; trial < trials; trial += 1) {
    for (let i = 0; i < need; i += 1) {
      const j = i + Math.floor(Math.random() * (deck.length - i));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    const fullBoard = board.concat(deck.slice(0, needBoard));
    const opponent = [deck[needBoard], deck[needBoard + 1]];
    const cmp = compareRanks(evaluate(hole, fullBoard), evaluate(opponent, fullBoard));
    score += cmp > 0 ? 1 : cmp === 0 ? 0.5 : 0;
  }
  return score / trials;
}

function fallback(legal) {
  if (legal.canCheck) return { action: 'check' };
  if (legal.canCall) return { action: 'call' };
  if (legal.callAllIn) return { action: 'allin' };
  if (legal.canFold) return { action: 'fold' };
  if (legal.allInTo) return { action: 'allin' };
  return { action: 'fold' };
}

export function chooseAction({ style = 'loose', hole, board, legal, opponents = 1, pot = 0 }) {
  if (!legal) return { action: 'fold' };
  const profile = STYLES[style] ?? STYLES.loose;
  let strength;
  try {
    const base = board?.length ? equity(hole, board) : preflopStrength(hole);
    strength = Math.max(0, base - Math.max(0, opponents - 1) * 0.045);
  } catch {
    return fallback(legal);
  }

  const toCall = legal.callAmount || 0;
  const odds = toCall > 0 ? toCall / (pot + toCall) : 0;

  const sizedBet = () => {
    if (strength > 0.9 && legal.potTo) return legal.potTo;
    if (strength > 0.72 && legal.halfPotTo) return legal.halfPotTo;
    return legal.minRaiseTo;
  };

  if (!toCall) {
    const wantBet = strength >= profile.raiseAbove
      || (strength > 0.55 && Math.random() < profile.aggression * 0.28);
    if (wantBet && legal.minRaiseTo != null) return { action: 'raise', amount: sizedBet() };
    return { action: 'check' };
  }

  if (strength < profile.foldBelow && strength < odds + 0.05) return { action: 'fold' };
  if (legal.minRaiseTo != null && strength >= profile.raiseAbove && Math.random() < 0.22 + profile.aggression * 0.4) {
    const amount = sizedBet();
    if (legal.maxRaiseTo != null && amount >= legal.maxRaiseTo && strength > 0.9) return { action: 'allin' };
    return { action: 'raise', amount };
  }
  if (legal.callAllIn && strength > 0.62) return { action: 'allin' };
  if (legal.canCall) return { action: 'call' };
  return fallback(legal);
}
