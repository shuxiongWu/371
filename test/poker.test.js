import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { evaluate, compareRanks, handName } from '../server/cards.js';
import { Hand, GameError } from '../server/hand.js';
import { Table, MIN_BUYIN } from '../server/table.js';
import {
  openDatabase,
  createUser,
  getUserByName,
  verifyPassword,
  createSession,
  userForToken,
  accountsFrom,
  STARTING_CHIPS,
} from '../server/db.js';

const deck = [];
for (const suit of 'shdc') {
  for (const rank of '23456789TJQKA') deck.push(rank + suit);
}

function ranked(cards) {
  return evaluate(cards.slice(0, 2), cards.slice(2));
}

test('hand rankings follow standard order', () => {
  const royal = evaluate([], ['As', 'Ks', 'Qs', 'Js', 'Ts']);
  const straightFlush = evaluate([], ['9h', '8h', '7h', '6h', '5h']);
  const quads = evaluate([], ['9c', '9d', '9h', '9s', '2c']);
  const full = evaluate([], ['Kc', 'Kd', 'Kh', '3s', '3d']);
  const flush = evaluate([], ['2s', '5s', '7s', 'Js', 'Qs']);
  const straight = evaluate([], ['9c', '8d', '7h', '6s', '5c']);
  const trips = evaluate([], ['Qc', 'Qd', 'Qh', '2s', '3c']);
  const twoPair = evaluate([], ['Ac', 'Ad', '4c', '4d', '7h']);
  const pair = evaluate([], ['Ac', 'Ad', '5c', '8d', 'Kh']);
  const high = evaluate([], ['Ac', 'Kd', '9c', '5h', '2s']);
  const order = [royal, straightFlush, quads, full, flush, straight, trips, twoPair, pair, high];
  for (let i = 0; i < order.length - 1; i += 1) {
    assert.equal(compareRanks(order[i], order[i + 1]), 1, handName(order[i]));
  }
  assert.equal(handName(royal), '皇家同花顺');
  assert.equal(handName(straightFlush), '同花顺');
  assert.equal(handName(full), '葫芦');

  const wheel = evaluate([], ['Ac', '2d', '3h', '4s', '5c']);
  const sixHigh = evaluate([], ['6c', '5d', '4h', '3s', '2c']);
  assert.equal(handName(wheel), '顺子');
  assert.equal(compareRanks(sixHigh, wheel), 1);

  const aceKicker = evaluate(['Ac', 'Ad'], ['Kc', '5d', '2h', '9s', '4c']);
  const queenKicker = evaluate(['Ac', 'Ad'], ['Qc', '5d', '2h', '9s', '4c']);
  assert.equal(compareRanks(aceKicker, queenKicker), 1);

  const seven = evaluate(['As', 'Ah'], ['Ad', 'Kc', 'Kd', '2c', '3s']);
  assert.equal(handName(seven), '葫芦');
});

test('folding out returns every chip to the last player', () => {
  const hand = new Hand({
    players: [
      { id: 'A', name: '甲', seat: 0, stack: 1000 },
      { id: 'B', name: '乙', seat: 1, stack: 1000 },
      { id: 'C', name: '丙', seat: 2, stack: 1000 },
    ],
    buttonSeat: 2,
    sb: 50,
    bb: 100,
    deck,
  });
  assert.equal(hand.sbSeat, 0);
  assert.equal(hand.bbSeat, 1);
  assert.equal(hand.currentPlayer().id, 'C');
  hand.action('C', 'fold');
  hand.action('A', 'fold');
  assert.equal(hand.phase, 'complete');
  assert.equal(hand.result.kind, 'fold');
  const stacks = Object.fromEntries(hand.players.map((player) => [player.id, player.stack]));
  assert.equal(stacks.A, 950);
  assert.equal(stacks.B, 1050);
  assert.equal(stacks.C, 1000);
  assert.equal(stacks.A + stacks.B + stacks.C, 3000);
});

test('heads-up button posts the small blind and acts first', () => {
  const hand = new Hand({
    players: [
      { id: 'A', name: '甲', seat: 0, stack: 1000 },
      { id: 'B', name: '乙', seat: 1, stack: 1000 },
    ],
    buttonSeat: 0,
    sb: 50,
    bb: 100,
    deck,
  });
  assert.equal(hand.sbSeat, 0);
  assert.equal(hand.bbSeat, 1);
  assert.equal(hand.currentPlayer().id, 'A');
  const legal = hand.legalFor(hand.currentPlayer());
  assert.equal(legal.callAmount, 50);
  assert.equal(legal.minRaiseTo, 200);
  assert.throws(() => hand.action('A', 'raise', 150), GameError);
});

test('short all-in does not let the previous raiser reraise', () => {
  const hand = new Hand({
    players: [
      { id: 'A', name: '甲', seat: 0, stack: 2000 },
      { id: 'B', name: '乙', seat: 1, stack: 2000 },
      { id: 'C', name: '丙', seat: 2, stack: 350 },
    ],
    buttonSeat: 2,
    sb: 50,
    bb: 100,
    deck,
  });
  hand.action('C', 'call');
  hand.action('A', 'call');
  hand.action('B', 'check');
  assert.equal(hand.phase, 'await_board');
  hand.dealNext();
  assert.equal(hand.street, 'flop');
  hand.action('A', 'check');
  hand.action('B', 'check');
  hand.action('C', 'raise', 100);
  hand.action('A', 'raise', 200);
  hand.action('B', 'fold');
  hand.action('C', 'allin');
  const legal = hand.legalFor(hand.currentPlayer());
  assert.equal(hand.currentPlayer().id, 'A');
  assert.equal(legal.callAmount, 50);
  assert.equal(legal.canCall, true);
  assert.equal(legal.minRaiseTo, null);
  assert.equal(legal.allInTo, null);
});

test('side pots and odd split chips follow seat order', () => {
  const scripted = ['Ah', 'Kh', '7c', 'Ad', 'Kd', '2d', '2h', '5c', '9d', 'Js', 'Qh'];
  const hand = new Hand({
    players: [
      { id: 'A', name: '甲', seat: 0, stack: 80 },
      { id: 'B', name: '乙', seat: 1, stack: 800 },
      { id: 'C', name: '丙', seat: 2, stack: 800 },
    ],
    buttonSeat: 2,
    sb: 50,
    bb: 100,
    deck: scripted,
  });
  hand.action('C', 'call');
  hand.action('A', 'allin');
  hand.action('B', 'check');
  while (hand.phase !== 'complete') {
    if (hand.phase === 'await_board') hand.dealNext();
    else {
      const player = hand.currentPlayer();
      const legal = hand.legalFor(player);
      hand.action(player.id, legal.canCheck ? 'check' : 'call');
    }
  }
  assert.equal(hand.phase, 'complete');
  assert.equal(hand.result.kind, 'showdown');
  const stacks = Object.fromEntries(hand.players.map((player) => [player.id, player.stack]));
  assert.equal(stacks.A, 240);
  assert.equal(stacks.B, 740);
  assert.equal(stacks.C, 700);
  assert.equal(stacks.A + stacks.B + stacks.C, 1680);

  const splitDeck = ['2h', '3h', '4h', '5h', '6h', '7h', 'Ts', 'Js', 'Qs', 'Ks', 'As'];
  const split = new Hand({
    players: [
      { id: 'A', name: '甲', seat: 0, stack: 100 },
      { id: 'B', name: '乙', seat: 1, stack: 100 },
      { id: 'C', name: '丙', seat: 2, stack: 100 },
    ],
    buttonSeat: 2,
    sb: 1,
    bb: 1,
    deck: splitDeck,
  });
  split.action('C', 'call');
  split.action('A', 'check');
  split.action('B', 'check');
  split.dealNext();
  split.action('A', 'raise', 1);
  split.action('B', 'call');
  split.action('C', 'fold');
  while (split.phase !== 'complete') {
    if (split.phase === 'await_board') split.dealNext();
    else {
      const player = split.currentPlayer();
      const legal = split.legalFor(player);
      split.action(player.id, legal.canCheck ? 'check' : 'call');
    }
  }
  const ended = Object.fromEntries(split.players.map((player) => [player.id, player.stack]));
  assert.equal(ended.A, 101);
  assert.equal(ended.B, 100);
  assert.equal(ended.C, 99);
  assert.equal(handName(split.players[0].rank), '皇家同花顺');
});

test('random hands conserve chips', () => {
  for (let game = 0; game < 40; game += 1) {
    const players = [
      { id: 'A', name: '甲', seat: 0, stack: 900 + game, isBot: true },
      { id: 'B', name: '乙', seat: 1, stack: 1400, isBot: true },
      { id: 'C', name: '丙', seat: 4, stack: 700 + (game % 5) * 10, isBot: true },
    ];
    const start = players.reduce((sum, player) => sum + player.stack, 0);
    const hand = new Hand({
      players,
      buttonSeat: [0, 1, 4][game % 3],
      sb: 50,
      bb: 100,
    });
    let guard = 0;
    while (hand.phase !== 'complete' && guard < 120) {
      guard += 1;
      if (hand.phase === 'await_board') {
        hand.dealNext();
        continue;
      }
      const player = hand.currentPlayer();
      const legal = hand.legalFor(player);
      const options = [];
      if (legal.canFold) options.push('fold');
      if (legal.canCheck) options.push('check');
      if (legal.canCall) options.push('call');
      if (legal.minRaiseTo) options.push('raise');
      if (legal.allInTo) options.push('allin');
      const choice = options[randomInt(options.length)];
      if (choice === 'raise') hand.action(player.id, 'raise', legal.minRaiseTo);
      else hand.action(player.id, choice);
    }
    assert.equal(hand.phase, 'complete');
    const end = hand.players.reduce((sum, player) => sum + player.stack, 0);
    assert.equal(end, start);
  }
});

function memoryAccounts() {
  const users = new Map();
  return {
    users,
    addUser(id, username, chips) {
      users.set(id, { id, username, chips });
    },
    getChips(id) {
      return users.get(id)?.chips ?? 0;
    },
    addChips(id, delta) {
      const user = users.get(id);
      if (!user) throw new Error('用户不存在');
      if (user.chips + delta < 0) throw new GameError('筹码不足');
      user.chips += delta;
      return user.chips;
    },
    getUser(id) {
      return users.get(id) ?? null;
    },
  };
}

function chipTotal(table, userId) {
  const stacks = table.seats.reduce((sum, seat) => sum + (seat?.stack || 0), 0);
  const pot = table.hand && table.hand.phase !== 'complete' ? table.hand.potAmount() : 0;
  return stacks + pot + table.wallet(userId);
}

test('sitting, leaving, and reconnecting keep the same seat and chips', () => {
  const db = memoryAccounts();
  db.addUser(7, '青石', 10000);
  const table = new Table(db, { manual: true });
  table.sit({ id: 7, username: '青石' }, 2000);
  assert.equal(db.getChips(7), 8000);
  assert.equal(table.seatByUser(7).stack, 2000);
  const seatIndex = table.seats.indexOf(table.seatByUser(7));
  table.sit({ id: 7, username: '青石' }, 2000);
  assert.equal(db.getChips(7), 8000);
  table.setConnected(7, false);
  assert.equal(table.seatByUser(7).disconnected, true);
  assert.equal(table.seats.indexOf(table.seatByUser(7)), seatIndex);
  table.setConnected(7, true);
  assert.equal(table.seatByUser(7).disconnected, false);
  assert.equal(table.seats[seatIndex].id, 7);

  const view = table.view(7);
  assert.equal(view.you.seated, true);
  assert.equal(view.you.wallet, 8000);
  assert.equal(view.table.blinds.sb, 50);
  assert.equal(view.table.blinds.bb, 100);
  assert.equal(view.table.maxSeats, 6);

  table.leave(7);
  assert.equal(table.seatByUser(7), null);
  assert.equal(db.getChips(7), 10000);
  assert.throws(() => table.sit({ id: 7, username: '青石' }, MIN_BUYIN - 1), GameError);
  table.destroy();
});

test('a full table hand conserves the wallet and seat stacks', () => {
  const db = memoryAccounts();
  db.addUser(3, '远山', 10000);
  const table = new Table(db, { manual: true });
  table.sit({ id: 3, username: '远山' }, 2500, 0);
  const before = chipTotal(table, 3);
  assert.equal(before, 10000 + 4200 + 3600 + 4800);
  table.runPending();
  const heroView = table.view(3);
  const hero = heroView.table.seats.find((seat) => seat.isYou);
  const stranger = heroView.table.seats.find((seat) => seat.isBot && seat.hole);
  assert.equal(hero.hole.length, 2);
  assert.notEqual(hero.hole[0], 'back');
  assert.deepEqual(stranger.hole, ['back', 'back']);

  for (let step = 0; step < 300 && table.hand && table.hand.phase !== 'complete'; step += 1) {
    assert.equal(chipTotal(table, 3), before);
    if (table.hand.phase === 'betting' && table.hand.currentPlayer().id === 3) {
      const legal = table.hand.legalFor(table.hand.currentPlayer());
      if (legal.canCheck) table.action(3, 'check');
      else if (legal.canCall) table.action(3, 'call');
      else table.action(3, 'fold');
    } else {
      assert.ok(table.pending);
      table.runPending();
    }
  }
  assert.equal(table.hand.phase, 'complete');
  assert.equal(chipTotal(table, 3), before);
  assert.equal(table.seatByUser(3)?.id, 3);
  table.destroy();
});

test('accounts start with 10000 play-money chips', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'qz-')), 'test.db');
  const db = openDatabase(file);
  const user = createUser(db, 'tester', 'secret12');
  assert.equal(user.chips, STARTING_CHIPS);
  assert.equal(STARTING_CHIPS, 10000);
  const row = getUserByName(db, 'tester');
  assert.equal(verifyPassword('secret12', row.password_hash), true);
  assert.equal(verifyPassword('nope', row.password_hash), false);
  const token = createSession(db, user.id);
  assert.equal(userForToken(db, token).username, 'tester');
  const accounts = accountsFrom(db);
  assert.equal(accounts.addChips(user.id, -2500), 7500);
  assert.throws(() => accounts.addChips(user.id, -8000), GameError);
  db.close();
});
