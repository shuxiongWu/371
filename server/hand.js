import { freshDeck, evaluate, compareRanks, handName, fmt } from './cards.js';

export class GameError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GameError';
  }
}

function copyPlayer(player) {
  return {
    id: player.id,
    name: player.name,
    seat: player.seat,
    isBot: !!player.isBot,
    stack: player.stack,
    hole: [],
    streetCommit: 0,
    handCommit: 0,
    folded: false,
    allIn: false,
    needsAction: false,
    raiseLocked: false,
  };
}

export function buildPots(players) {
  const contrib = players
    .filter((player) => player.handCommit > 0)
    .map((player) => ({ player, left: player.handCommit }));
  const pots = [];
  while (contrib.some((entry) => entry.left > 0)) {
    const active = contrib.filter((entry) => entry.left > 0);
    const level = Math.min(...active.map((entry) => entry.left));
    let amount = 0;
    const eligible = [];
    for (const entry of active) {
      amount += level;
      entry.left -= level;
      if (!entry.player.folded) eligible.push(entry.player);
    }
    pots.push({ amount, eligible });
  }
  return pots;
}

function orderFromButton(winners, buttonSeat) {
  const sorted = [...winners].sort((a, b) => a.seat - b.seat);
  const after = sorted.filter((player) => player.seat > buttonSeat);
  const before = sorted.filter((player) => player.seat <= buttonSeat);
  return [...after, ...before];
}

export class Hand {
  constructor({ players, buttonSeat, sb, bb, deck }) {
    if (!Array.isArray(players) || players.length < 2) {
      throw new GameError('至少需要两名玩家');
    }
    this.sb = sb;
    this.bb = bb;
    this.buttonSeat = buttonSeat;
    this.players = players.map(copyPlayer).sort((a, b) => a.seat - b.seat);
    const seats = new Set();
    for (const player of this.players) {
      if (seats.has(player.seat)) throw new GameError('座位重复');
      seats.add(player.seat);
      if (player.stack <= 0) throw new GameError('没有筹码的玩家不能入局');
    }
    if (!this.players.some((player) => player.seat === buttonSeat)) {
      throw new GameError('按钮位置没有玩家');
    }

    this.deck = deck ? [...deck] : freshDeck();
    this.deckIndex = 0;
    this.board = [];
    this.street = 'preflop';
    this.phase = 'betting';
    this.currentBet = 0;
    this.lastFullRaise = bb;
    this.toActIndex = -1;
    this.events = [];
    this.result = null;
    this.showCards = false;

    const buttonIndex = this.players.findIndex((player) => player.seat === buttonSeat);
    const count = this.players.length;
    const sbIndex = count === 2 ? buttonIndex : (buttonIndex + 1) % count;
    const bbIndex = count === 2 ? (buttonIndex + 1) % count : (buttonIndex + 2) % count;
    this.sbSeat = this.players[sbIndex].seat;
    this.bbSeat = this.players[bbIndex].seat;

    this.postBlind(this.players[sbIndex], sb, '小盲');
    this.postBlind(this.players[bbIndex], bb, '大盲');
    this.currentBet = Math.max(...this.players.map((player) => player.streetCommit));

    for (let round = 0; round < 2; round += 1) {
      for (let step = 0; step < count; step += 1) {
        const player = this.players[(sbIndex + step) % count];
        player.hole.push(this.draw());
      }
    }

    for (const player of this.players) {
      player.needsAction = !player.allIn;
      player.raiseLocked = false;
    }
    this.toActIndex = this.nextIndex(bbIndex);
    if (this.toActIndex === -1) this.endStreet();
  }

  draw() {
    if (this.deckIndex >= this.deck.length) throw new GameError('牌组已空');
    const card = this.deck[this.deckIndex];
    this.deckIndex += 1;
    return card;
  }

  postBlind(player, amount, label) {
    const pay = Math.min(player.stack, amount);
    player.stack -= pay;
    player.streetCommit += pay;
    player.handCommit += pay;
    if (player.stack === 0) player.allIn = true;
    this.events.push({
      type: 'blind',
      id: player.id,
      name: player.name,
      seat: player.seat,
      label,
      amount: pay,
    });
  }

  nextIndex(fromIndex) {
    const count = this.players.length;
    for (let step = 1; step <= count; step += 1) {
      const index = (fromIndex + step) % count;
      if (this.players[index].needsAction) return index;
    }
    return -1;
  }

  currentPlayer() {
    if (this.toActIndex < 0) return null;
    return this.players[this.toActIndex] ?? null;
  }

  potAmount() {
    return this.players.reduce((sum, player) => sum + player.handCommit, 0);
  }

  legalFor(player) {
    if (this.phase !== 'betting' || !player) return null;
    const current = this.currentPlayer();
    if (!current || current.id !== player.id) return null;

    const toCall = this.currentBet - player.streetCommit;
    const maxTo = player.streetCommit + player.stack;
    const minFull = this.currentBet + this.lastFullRaise;
    const canCheck = toCall <= 0;
    const canCall = toCall > 0 && player.stack > 0;
    const callAmount = canCall ? Math.min(toCall, player.stack) : 0;

    let minRaiseTo = null;
    let maxRaiseTo = null;
    if (!player.raiseLocked && player.stack > toCall && maxTo > this.currentBet) {
      if (maxTo >= minFull && minFull > this.currentBet) {
        minRaiseTo = minFull;
        maxRaiseTo = maxTo;
      }
    }

    const allInWouldRaise = maxTo > this.currentBet;
    const canAllIn = player.stack > 0 && (
      (!allInWouldRaise && canCall && callAmount === player.stack)
      || (!player.raiseLocked && allInWouldRaise)
    );

    const pot = this.potAmount();
    const clampRaise = (target) => {
      if (minRaiseTo == null) return null;
      return Math.min(maxRaiseTo, Math.max(minRaiseTo, target));
    };

    return {
      canFold: !canCheck,
      canCheck,
      canCall,
      callAmount,
      callAllIn: canCall && callAmount === player.stack,
      minRaiseTo,
      maxRaiseTo,
      allInTo: canAllIn ? maxTo : null,
      halfPotTo: clampRaise(this.currentBet + Math.floor((pot + Math.max(toCall, 0)) / 2)),
      potTo: clampRaise(this.currentBet + pot + Math.max(toCall, 0)),
    };
  }

  action(playerId, type, amount) {
    if (this.phase !== 'betting') throw new GameError('现在不能行动');
    const player = this.currentPlayer();
    if (!player || player.id !== playerId) throw new GameError('还没轮到你');
    const legal = this.legalFor(player);
    let outcome;

    if (type === 'fold') {
      if (!legal.canFold) {
        player.needsAction = false;
        outcome = { kind: 'check', amount: 0, raiseTo: player.streetCommit };
      } else {
        player.folded = true;
        player.needsAction = false;
        outcome = { kind: 'fold', amount: 0, raiseTo: player.streetCommit };
      }
    } else if (type === 'check') {
      if (!legal.canCheck) throw new GameError('不能过牌');
      player.needsAction = false;
      outcome = { kind: 'check', amount: 0, raiseTo: player.streetCommit };
    } else if (type === 'call') {
      if (!legal.canCall) throw new GameError('没有需要跟的注');
      outcome = this.commitCall(player);
    } else if (type === 'raise') {
      if (!Number.isInteger(amount) || legal.minRaiseTo == null) throw new GameError('现在不能加注');
      if (amount < legal.minRaiseTo || amount > legal.maxRaiseTo) {
        throw new GameError(`加注需要在 ${fmt(legal.minRaiseTo)} 到 ${fmt(legal.maxRaiseTo)} 之间`);
      }
      outcome = this.commitTo(player, amount);
    } else if (type === 'allin') {
      if (legal.allInTo == null) throw new GameError('现在不能全下');
      if (legal.allInTo <= this.currentBet) outcome = this.commitCall(player);
      else outcome = this.commitTo(player, legal.allInTo);
    } else {
      throw new GameError('未知行动');
    }

    this.events.push({
      type: 'action',
      id: player.id,
      name: player.name,
      seat: player.seat,
      kind: outcome.kind,
      amount: outcome.amount,
      raiseTo: outcome.raiseTo,
    });
    this.advance();
    return outcome;
  }

  forceFold(playerId) {
    if (this.phase === 'complete') return;
    const index = this.players.findIndex((player) => player.id === playerId);
    if (index < 0) return;
    const player = this.players[index];
    if (player.folded || player.allIn) return;
    player.folded = true;
    player.needsAction = false;
    this.events.push({
      type: 'action',
      id: player.id,
      name: player.name,
      seat: player.seat,
      kind: 'fold',
      amount: 0,
      raiseTo: player.streetCommit,
    });
    if (this.living().length <= 1) {
      this.awardFold();
      return;
    }
    if (this.phase === 'betting' && this.toActIndex === index) this.advance();
  }

  commitCall(player) {
    const toCall = this.currentBet - player.streetCommit;
    const pay = Math.min(player.stack, toCall);
    player.stack -= pay;
    player.streetCommit += pay;
    player.handCommit += pay;
    if (player.stack === 0) player.allIn = true;
    player.needsAction = false;
    return {
      kind: player.allIn ? 'allin' : 'call',
      amount: pay,
      raiseTo: player.streetCommit,
    };
  }

  commitTo(player, raiseTo) {
    const previousBet = this.currentBet;
    const added = raiseTo - player.streetCommit;
    if (added <= 0 || added > player.stack) throw new GameError('加注金额不合法');
    player.stack -= added;
    player.handCommit += added;
    player.streetCommit = raiseTo;
    if (player.stack === 0) player.allIn = true;

    const increment = raiseTo - previousBet;
    const fullRaise = increment >= this.lastFullRaise && raiseTo > previousBet;
    if (raiseTo > previousBet) {
      if (fullRaise) {
        this.lastFullRaise = increment;
        for (const other of this.players) {
          if (other !== player && !other.folded && !other.allIn) {
            other.needsAction = true;
            other.raiseLocked = false;
          }
        }
      } else {
        for (const other of this.players) {
          if (other === player || other.folded || other.allIn) continue;
          if (other.streetCommit < raiseTo && !other.needsAction) {
            other.raiseLocked = true;
            other.needsAction = true;
          }
        }
      }
      this.currentBet = raiseTo;
    }
    player.needsAction = false;
    let kind = 'raise';
    if (player.allIn) kind = 'allin';
    else if (previousBet === 0) kind = 'bet';
    return { kind, amount: added, raiseTo };
  }

  living() {
    return this.players.filter((player) => !player.folded);
  }

  advance() {
    if (this.living().length <= 1) {
      this.awardFold();
      return;
    }
    const next = this.nextIndex(this.toActIndex);
    if (next === -1) this.endStreet();
    else this.toActIndex = next;
  }

  endStreet() {
    this.toActIndex = -1;
    if (this.living().length <= 1) {
      this.awardFold();
      return;
    }
    if (this.board.length >= 5) {
      this.showdown();
      return;
    }
    this.phase = 'await_board';
  }

  dealNext() {
    if (this.phase !== 'await_board') throw new GameError('现在不能发牌');
    if (this.board.length === 0) {
      this.board.push(this.draw(), this.draw(), this.draw());
      this.street = 'flop';
    } else if (this.board.length === 3) {
      this.board.push(this.draw());
      this.street = 'turn';
    } else if (this.board.length === 4) {
      this.board.push(this.draw());
      this.street = 'river';
    } else {
      this.showdown();
      return;
    }
    this.events.push({ type: 'street', street: this.street, board: [...this.board] });

    const canAct = this.players.filter((player) => !player.folded && !player.allIn);
    if (canAct.length < 2) {
      if (this.board.length < 5) {
        this.phase = 'await_board';
        return;
      }
      this.showdown();
      return;
    }

    for (const player of this.players) {
      player.streetCommit = 0;
      player.needsAction = !player.folded && !player.allIn;
      player.raiseLocked = false;
    }
    this.currentBet = 0;
    this.lastFullRaise = this.bb;
    this.phase = 'betting';
    const buttonIndex = this.players.findIndex((player) => player.seat === this.buttonSeat);
    this.toActIndex = this.nextIndex(buttonIndex === -1 ? 0 : buttonIndex);
    if (this.toActIndex === -1) this.endStreet();
  }

  awardFold() {
    const winner = this.living()[0];
    const total = this.players.reduce((sum, player) => sum + player.handCommit, 0);
    if (winner) winner.stack += total;
    this.showCards = false;
    this.finish({
      kind: 'fold',
      winners: winner ? [{
        id: winner.id,
        name: winner.name,
        seat: winner.seat,
        amount: total,
        hand: null,
      }] : [],
    });
  }

  showdown() {
    while (this.board.length < 5) this.board.push(this.draw());
    this.showCards = true;
    this.street = 'river';
    for (const player of this.players) {
      if (!player.folded) {
        player.rank = evaluate(player.hole, this.board);
        player.rankName = handName(player.rank);
      }
    }

    const pots = buildPots(this.players);
    const won = new Map();
    for (const pot of pots) {
      if (pot.amount <= 0 || pot.eligible.length === 0) continue;
      let best = null;
      let winners = [];
      for (const player of pot.eligible) {
        const cmp = compareRanks(player.rank, best);
        if (best == null || cmp > 0) {
          best = player.rank;
          winners = [player];
        } else if (cmp === 0) winners.push(player);
      }
      const ordered = orderFromButton(winners, this.buttonSeat);
      const share = Math.floor(pot.amount / ordered.length);
      let remainder = pot.amount % ordered.length;
      for (const winner of ordered) {
        const gain = share + (remainder > 0 ? 1 : 0);
        if (remainder > 0) remainder -= 1;
        winner.stack += gain;
        won.set(winner.id, (won.get(winner.id) || 0) + gain);
      }
    }

    const winners = this.players
      .filter((player) => (won.get(player.id) || 0) > 0)
      .map((player) => ({
        id: player.id,
        name: player.name,
        seat: player.seat,
        amount: won.get(player.id),
        hand: player.rankName,
      }));
    this.finish({ kind: 'showdown', winners });
  }

  finish(result) {
    this.result = result;
    this.phase = 'complete';
    this.toActIndex = -1;
    this.events.push({ type: 'result', text: describeResult(result) });
  }
}

export function describeResult(result) {
  const winners = result?.winners ?? [];
  if (!winners.length) return '本手结束';
  if (result.kind === 'fold') {
    return `${winners[0].name} 赢得底池 ${fmt(winners[0].amount)}（其余玩家弃牌）`;
  }
  return winners.map((winner) => `${winner.name} 以${winner.hand}赢得 ${fmt(winner.amount)}`).join('；');
}

const STREET_LABEL = { flop: '—— 翻牌 ——', turn: '—— 转牌 ——', river: '—— 河牌 ——' };

export function formatEvent(event) {
  if (!event) return '';
  if (event.type === 'blind') return `${event.name} 下${event.label} ${fmt(event.amount)}`;
  if (event.type === 'street') return STREET_LABEL[event.street] ?? '';
  if (event.type === 'result' || event.type === 'note') return event.text;
  if (event.type === 'action') {
    if (event.kind === 'fold') return `${event.name} 弃牌`;
    if (event.kind === 'check') return `${event.name} 过牌`;
    if (event.kind === 'call') return `${event.name} 跟注 ${fmt(event.amount)}`;
    if (event.kind === 'bet') return `${event.name} 下注 ${fmt(event.raiseTo)}`;
    if (event.kind === 'raise') return `${event.name} 加注到 ${fmt(event.raiseTo)}`;
    if (event.kind === 'allin') return `${event.name} 全下 ${fmt(event.raiseTo || event.amount)}`;
  }
  return '';
}
