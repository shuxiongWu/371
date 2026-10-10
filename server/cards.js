import { randomInt } from 'node:crypto';

export const RANKS = '23456789TJQKA';
export const SUITS = 'shdc';

const CATEGORY_NAMES = ['高牌', '一对', '两对', '三条', '顺子', '同花', '葫芦', '四条', '同花顺'];

export function parseCard(code) {
  if (typeof code !== 'string' || code.length < 2) {
    throw new Error(`无效牌面: ${code}`);
  }
  const rank = RANKS.indexOf(code[0]);
  const suit = code[1];
  if (rank < 0 || !SUITS.includes(suit)) {
    throw new Error(`无效牌面: ${code}`);
  }
  return { r: rank, s: suit, code: code[0] + suit };
}

export function freshDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) deck.push(rank + suit);
  }
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

export function compareRanks(a, b) {
  if (a == null && b == null) return 0;
  if (b == null) return 1;
  if (a == null) return -1;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (a[i] ?? -1) - (b[i] ?? -1);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function detectStraight(sortedAsc) {
  const unique = [];
  for (const rank of sortedAsc) {
    if (unique[unique.length - 1] !== rank) unique.push(rank);
  }
  if (unique.length !== 5) return null;
  if (unique[4] - unique[0] === 4) return unique[4];
  if (unique[0] === 0 && unique[1] === 1 && unique[2] === 2 && unique[3] === 3 && unique[4] === 12) {
    return 3;
  }
  return null;
}

export function evaluate5(cards) {
  const ranks = cards.map((card) => card.r).sort((a, b) => a - b);
  const flush = cards.every((card) => card.s === cards[0].s);
  const straightHigh = detectStraight(ranks);
  if (flush && straightHigh != null) return [8, straightHigh];

  const count = Array(13).fill(0);
  for (const rank of ranks) count[rank] += 1;
  const byCount = (n) => {
    const found = [];
    for (let rank = 12; rank >= 0; rank -= 1) {
      if (count[rank] === n) found.push(rank);
    }
    return found;
  };

  const quads = byCount(4);
  const trips = byCount(3);
  const pairs = byCount(2);
  const singles = byCount(1);

  if (quads.length) return [7, quads[0], singles[0]];
  if (trips.length && pairs.length) return [6, trips[0], pairs[0]];
  if (flush) return [5, ...ranks.slice().reverse()];
  if (straightHigh != null) return [4, straightHigh];
  if (trips.length) return [3, trips[0], ...singles];
  if (pairs.length >= 2) return [2, pairs[0], pairs[1], singles[0]];
  if (pairs.length === 1) return [1, pairs[0], ...singles];
  return [0, ...ranks.slice().reverse()];
}

export function evaluate(hole, board) {
  const cards = [...hole, ...board].map((card) => (typeof card === 'string' ? parseCard(card) : card));
  if (cards.length < 5) throw new Error('至少需要五张牌');
  if (cards.length === 5) return evaluate5(cards);

  let best = null;
  const n = cards.length;
  for (let a = 0; a < n; a += 1) {
    for (let b = a + 1; b < n; b += 1) {
      for (let c = b + 1; c < n; c += 1) {
        for (let d = c + 1; d < n; d += 1) {
          for (let e = d + 1; e < n; e += 1) {
            const rank = evaluate5([cards[a], cards[b], cards[c], cards[d], cards[e]]);
            if (best == null || compareRanks(rank, best) > 0) best = rank;
          }
        }
      }
    }
  }
  return best;
}

export function handName(rank) {
  if (!rank) return '';
  if (rank[0] === 8 && rank[1] === 12) return '皇家同花顺';
  return CATEGORY_NAMES[rank[0]] ?? '';
}

export function fmt(n) {
  return Number(n).toLocaleString('zh-CN');
}
