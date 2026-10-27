// Expected value, edge detection, Kelly staking and arbitrage.

import { devig, type DevigMethod } from './odds.ts';

export const expectedValue = (probability: number, decimal: number): number => probability * decimal - 1;

/** Full Kelly fraction of bankroll: (b*p - q) / b. Negative means no bet. */
export function kellyFraction(probability: number, decimal: number): number {
    const b = decimal - 1;
    return (b * probability - (1 - probability)) / b;
}

export interface StakeAdvice {
    fullKelly: number;
    fraction: number;
    stake: number;
    reason?: string;
}

/**
 * Fractional Kelly with a hard cap per bet. Quarter Kelly (0.25) is the default:
 * it keeps ~94% less variance than full Kelly while giving up ~44% of growth,
 * and protects against overestimating the edge (which is the norm, not the exception).
 */
export function stakeAdvice(probability: number, decimal: number, bankroll: number, opts: { kellyMultiplier?: number; maxStakePct?: number } = {}): StakeAdvice {
    const full = kellyFraction(probability, decimal);
    if (full <= 0) return { fullKelly: full, fraction: 0, stake: 0, reason: 'EV negativo: no apostar' };
    const fraction = Math.min(full * (opts.kellyMultiplier ?? 0.25), opts.maxStakePct ?? 0.03);
    return { fullKelly: full, fraction, stake: round2(bankroll * fraction) };
}

export interface OutcomeQuote {
    outcome: string;
    model: number; // model probability
    odds: { bookmaker: string; decimal: number }[];
}

export interface ValueBet {
    outcome: string;
    bookmaker: string;
    decimal: number;
    modelProbability: number;
    marketProbability: number;
    blendedProbability: number;
    fairOdds: number;
    ev: number;
    edge: number;
    kelly: StakeAdvice;
    confidence: 'baja' | 'media' | 'alta';
}

export interface ValueScanOptions {
    bankroll: number;
    minEv?: number; // default 3%
    marketWeight?: number; // how much to trust the market consensus vs model (0..1), default 0.5
    devigMethod?: DevigMethod;
    kellyMultiplier?: number;
    maxStakePct?: number;
    maxOdds?: number; // longshots amplify model error, default 6.0
}

/**
 * Finds +EV bets. The model probability is blended with the de-vigged market consensus
 * because closing lines of liquid markets are hard to beat; a model that disagrees
 * strongly with the market is more often wrong than the market is.
 */
export function findValueBets(market: OutcomeQuote[], opts: ValueScanOptions): ValueBet[] {
    const minEv = opts.minEv ?? 0.03;
    const w = opts.marketWeight ?? 0.5;
    const maxOdds = opts.maxOdds ?? 6;
    // Consensus: per outcome, average implied probability across books, then de-vig.
    const avgOdds = market.map((o) => 1 / mean(o.odds.map((q) => 1 / q.decimal)));
    const consensus = devig(avgOdds, opts.devigMethod ?? 'shin');
    const out: ValueBet[] = [];
    market.forEach((o, i) => {
        const best = o.odds.reduce((a, b) => (b.decimal > a.decimal ? b : a));
        const blended = w * consensus[i] + (1 - w) * o.model;
        const ev = expectedValue(blended, best.decimal);
        if (ev < minEv || best.decimal > maxOdds) return;
        const disagreement = Math.abs(o.model - consensus[i]);
        out.push({
            outcome: o.outcome,
            bookmaker: best.bookmaker,
            decimal: best.decimal,
            modelProbability: round4(o.model),
            marketProbability: round4(consensus[i]),
            blendedProbability: round4(blended),
            fairOdds: round2(1 / blended),
            ev: round4(ev),
            edge: round4(blended - 1 / best.decimal),
            kelly: stakeAdvice(blended, best.decimal, opts.bankroll, opts),
            // Large model/market disagreement is a red flag (missing info: injuries, lineups...).
            confidence: disagreement > 0.12 ? 'baja' : disagreement > 0.06 ? 'media' : 'alta'
        });
    });
    return out.sort((a, b) => b.ev - a.ev);
}

export interface Arbitrage {
    margin: number; // guaranteed return on total stake
    legs: { outcome: string; bookmaker: string; decimal: number; stake: number }[];
    totalStake: number;
    guaranteedPayout: number;
}

/** Detects a sure bet across bookmakers for a mutually exclusive, exhaustive set of outcomes. */
export function findArbitrage(market: { outcome: string; odds: { bookmaker: string; decimal: number }[] }[], totalStake = 100): Arbitrage | null {
    const best = market.map((o) => ({ outcome: o.outcome, ...o.odds.reduce((a, b) => (b.decimal > a.decimal ? b : a)) }));
    const inv = best.reduce((s, b) => s + 1 / b.decimal, 0);
    if (inv >= 1) return null;
    const legs = best.map((b) => ({ ...b, stake: round2((totalStake * (1 / b.decimal)) / inv) }));
    return { margin: round4(1 / inv - 1), legs, totalStake, guaranteedPayout: round2(totalStake / inv) };
}

/** Parlay: joint probability assumes independence (same-game legs are correlated — avoid). */
export function parlay(legs: { probability: number; decimal: number }[]) {
    const p = legs.reduce((s, l) => s * l.probability, 1);
    const d = legs.reduce((s, l) => s * l.decimal, 1);
    return { probability: round4(p), decimal: round2(d), ev: round4(expectedValue(p, d)) };
}

/** Closing Line Value: positive = you beat the closing price (best long-run skill signal). */
export const closingLineValue = (takenDecimal: number, closingDecimal: number): number => takenDecimal / closingDecimal - 1;

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
export const round2 = (x: number) => Math.round(x * 100) / 100;
export const round4 = (x: number) => Math.round(x * 10000) / 10000;
