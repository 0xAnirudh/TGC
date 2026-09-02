import {
  buyCost,
  sellBreakdown,
  price,
  reserveAt,
  maxTradeQty,
  STARTING_GRANT,
} from '@tgc/shared';

/**
 * An in-memory model of the whole economy.
 *
 * This is deliberately not the production implementation - there is no
 * Redis, no Mongo, no concurrency. It exists to answer one question
 * before any of that is built: is the economy itself sound? If the curve
 * math has an exploitable inverse, or the money supply can be made to
 * grow, every line of infrastructure written on top of it inherits the
 * flaw.
 *
 * The accounting model is the part worth carrying into the server. Notes
 * live in exactly three places:
 *
 *   cash     - held by players
 *   reserve  - paid into the curve by buys, paid back out by sells
 *   burned   - taken by the spread, gone permanently
 *
 * and enter only through grants. So at every instant:
 *
 *   granted === cash + reserve + burned
 *
 * The reserve is tracked as an explicit accumulator rather than
 * recomputed from the curve integral. That matters once basePrice
 * drifts: drift moves the curve out from under Notes already paid in, so
 * the integral stops equalling what was actually collected. An
 * accumulator stays exact regardless.
 */
export class Economy {
  constructor({ seed = 1 } = {}) {
    this.goods = new Map();
    this.players = new Map();

    this.granted = 0;
    this.reserve = 0;
    this.burned = 0;

    this.trades = [];
    this.rejections = { funds: 0, holdings: 0, cap: 0, slippage: 0 };
    this.seed = seed;
  }

  addGood(id, { basePrice, k, n }) {
    this.goods.set(id, { id, basePrice, k, n, supply: 0, volume: 0 });
    return this.goods.get(id);
  }

  addPlayer(id, grant = STARTING_GRANT) {
    const player = { id, cash: 0, holdings: new Map() };
    this.players.set(id, player);
    this.grant(id, grant);
    return player;
  }

  /** The only faucet. Notes enter the economy here and nowhere else. */
  grant(playerId, amount) {
    const player = this.players.get(playerId);
    player.cash += amount;
    this.granted += amount;
  }

  held(playerId, goodId) {
    return this.players.get(playerId).holdings.get(goodId) ?? 0;
  }

  spot(goodId) {
    const g = this.goods.get(goodId);
    return price(g.basePrice, g.supply, g.k, g.n);
  }

  /**
   * Buy `qty` units. Notes move from the player's cash into the reserve.
   * Nothing is created or destroyed.
   */
  buy(playerId, goodId, qty) {
    const player = this.players.get(playerId);
    const good = this.goods.get(goodId);

    if (qty > maxTradeQty(good.supply)) {
      this.rejections.cap += 1;
      return { ok: false, reason: 'trade_cap' };
    }

    const cost = buyCost(good.basePrice, good.supply, qty, good.k, good.n);
    if (cost > player.cash) {
      this.rejections.funds += 1;
      return { ok: false, reason: 'insufficient_funds' };
    }

    player.cash -= cost;
    this.reserve += cost;

    good.supply += qty;
    good.volume += qty;
    player.holdings.set(goodId, this.held(playerId, goodId) + qty);

    const trade = { side: 'buy', playerId, goodId, qty, notional: cost, spread: 0 };
    this.trades.push(trade);
    return { ok: true, ...trade };
  }

  /**
   * Sell `qty` units. The curve pays out of the reserve; the spread is
   * skimmed off that payout and burned. gross === net + spread, so the
   * reserve decreases by exactly what leaves it.
   */
  sell(playerId, goodId, qty) {
    const player = this.players.get(playerId);
    const good = this.goods.get(goodId);

    if (qty > this.held(playerId, goodId)) {
      this.rejections.holdings += 1;
      return { ok: false, reason: 'insufficient_holdings' };
    }
    if (qty > maxTradeQty(good.supply)) {
      this.rejections.cap += 1;
      return { ok: false, reason: 'trade_cap' };
    }

    const { gross, spread, net } = sellBreakdown(
      good.basePrice,
      good.supply,
      qty,
      good.k,
      good.n,
    );

    this.reserve -= gross;
    player.cash += net;
    this.burned += spread;

    good.supply -= qty;
    good.volume += qty;
    player.holdings.set(goodId, this.held(playerId, goodId) - qty);

    const trade = { side: 'sell', playerId, goodId, qty, notional: net, spread };
    this.trades.push(trade);
    return { ok: true, ...trade };
  }

  totalCash() {
    let sum = 0;
    for (const p of this.players.values()) sum += p.cash;
    return sum;
  }

  /** Sum of every player's holdings of one good. Must equal its supply. */
  totalHeld(goodId) {
    let sum = 0;
    for (const p of this.players.values()) sum += p.holdings.get(goodId) ?? 0;
    return sum;
  }

  /**
   * Every economic invariant, checked together. Returns a list of
   * violations; an empty list is the healthy case.
   */
  checkInvariants() {
    const violations = [];

    const accounted = this.totalCash() + this.reserve + this.burned;
    if (accounted !== this.granted) {
      violations.push(
        `money supply: granted ${this.granted} != cash ${this.totalCash()} + ` +
          `reserve ${this.reserve} + burned ${this.burned} (= ${accounted}, ` +
          `off by ${accounted - this.granted})`,
      );
    }

    for (const p of this.players.values()) {
      if (p.cash < 0) violations.push(`player ${p.id} has negative cash ${p.cash}`);
      for (const [goodId, q] of p.holdings) {
        if (q < 0) violations.push(`player ${p.id} has negative holding ${q} of ${goodId}`);
      }
    }

    for (const g of this.goods.values()) {
      if (g.supply < 0) violations.push(`good ${g.id} has negative supply ${g.supply}`);
      const held = this.totalHeld(g.id);
      if (held !== g.supply) {
        violations.push(`good ${g.id}: holdings sum ${held} != supply ${g.supply}`);
      }
    }

    return violations;
  }

  /**
   * What the reserve would be if it were recomputed from the curve
   * rather than accumulated. With drift off these agree to within
   * accumulated rounding; with drift on they legitimately diverge.
   */
  reserveFromCurve() {
    let sum = 0;
    for (const g of this.goods.values()) {
      sum += reserveAt(g.basePrice, g.supply, g.k, g.n);
    }
    return sum;
  }
}
