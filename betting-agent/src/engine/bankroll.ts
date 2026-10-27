// Monte Carlo bankroll simulation and bet-log performance statistics.

import { closingLineValue, round2, round4 } from './value.ts';

export interface SimulationInput {
    bankroll: number;
    bets: number; // number of bets to simulate
    probability: number; // true win probability (be honest/conservative)
    decimal: number;
    stakePct: number; // fraction of current bankroll per bet
    runs?: number;
    seed?: number;
}

export interface SimulationResult {
    medianFinal: number;
    p5Final: number;
    p95Final: number;
    probProfit: number;
    probRuin: number; // bankroll < 10% of start
    medianMaxDrawdown: number;
    expectedRoiPerBet: number;
}

/** Deterministic PRNG so simulations are reproducible. */
export function mulberry32(seed: number) {
    return () => {
        seed |= 0;
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function simulateBankroll(input: SimulationInput): SimulationResult {
    const runs = input.runs ?? 5000;
    const rand = mulberry32(input.seed ?? 42);
    const finals: number[] = [];
    const drawdowns: number[] = [];
    let ruined = 0;
    for (let r = 0; r < runs; r++) {
        let bank = input.bankroll;
        let peak = bank;
        let maxDd = 0;
        for (let i = 0; i < input.bets; i++) {
            const stake = bank * input.stakePct;
            bank += rand() < input.probability ? stake * (input.decimal - 1) : -stake;
            peak = Math.max(peak, bank);
            maxDd = Math.max(maxDd, 1 - bank / peak);
        }
        if (bank < input.bankroll * 0.1) ruined++;
        finals.push(bank);
        drawdowns.push(maxDd);
    }
    finals.sort((a, b) => a - b);
    drawdowns.sort((a, b) => a - b);
    const q = (xs: number[], p: number) => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))];
    return {
        medianFinal: round2(q(finals, 0.5)),
        p5Final: round2(q(finals, 0.05)),
        p95Final: round2(q(finals, 0.95)),
        probProfit: round4(finals.filter((f) => f > input.bankroll).length / runs),
        probRuin: round4(ruined / runs),
        medianMaxDrawdown: round4(q(drawdowns, 0.5)),
        expectedRoiPerBet: round4(input.probability * input.decimal - 1)
    };
}

export interface LoggedBet {
    id: string;
    date: string;
    event: string;
    market: string;
    selection: string;
    decimal: number;
    stake: number;
    probability?: number; // your estimate when placed
    closingDecimal?: number;
    result?: 'win' | 'loss' | 'push' | 'half-win' | 'half-loss' | 'pending';
}

export function settle(bet: LoggedBet): number {
    switch (bet.result) {
        case 'win':
            return bet.stake * (bet.decimal - 1);
        case 'loss':
            return -bet.stake;
        case 'half-win':
            return (bet.stake / 2) * (bet.decimal - 1);
        case 'half-loss':
            return -bet.stake / 2;
        default:
            return 0;
    }
}

export interface PerformanceReport {
    settled: number;
    pending: number;
    staked: number;
    profit: number;
    roi: number;
    hitRate: number;
    avgOdds: number;
    avgClv: number | null;
    clvPositiveRate: number | null;
    brierScore: number | null;
    zScore: number | null; // how many std devs the profit is from zero (luck check)
    verdict: string;
}

export function performance(bets: LoggedBet[]): PerformanceReport {
    const settled = bets.filter((b) => b.result && b.result !== 'pending');
    const staked = settled.reduce((s, b) => s + b.stake, 0);
    const profit = settled.reduce((s, b) => s + settle(b), 0);
    const decided = settled.filter((b) => b.result !== 'push');
    const wins = decided.filter((b) => b.result === 'win' || b.result === 'half-win').length;
    const withClv = bets.filter((b) => b.closingDecimal);
    const clvs = withClv.map((b) => closingLineValue(b.decimal, b.closingDecimal!));
    const withP = decided.filter((b) => b.probability !== undefined && (b.result === 'win' || b.result === 'loss'));
    const brier = withP.length ? withP.reduce((s, b) => s + Math.pow(b.probability! - (b.result === 'win' ? 1 : 0), 2), 0) / withP.length : null;
    // Variance of profit per unit staked under a fair-coin null at the taken odds.
    const variance = settled.reduce((s, b) => s + b.stake * b.stake * (b.decimal - 1), 0);
    const z = variance > 0 ? profit / Math.sqrt(variance) : null;
    const avgClv = clvs.length ? clvs.reduce((a, b) => a + b, 0) / clvs.length : null;

    let verdict: string;
    if (settled.length < 100) verdict = `Muestra pequeña (${settled.length} apuestas): el resultado es casi todo varianza. Usa el CLV como señal principal.`;
    else if (avgClv !== null && avgClv > 0.01 && (z ?? 0) > 0) verdict = 'CLV positivo y beneficio: señal real de ventaja. Mantén la disciplina de stake.';
    else if (avgClv !== null && avgClv < 0) verdict = 'CLV negativo: el mercado se mueve en tu contra. Probablemente no tienes ventaja; revisa el modelo o reduce stakes.';
    else if ((z ?? 0) > 2) verdict = 'Beneficio estadísticamente significativo (z > 2).';
    else verdict = 'Sin evidencia concluyente de ventaja todavía.';

    return {
        settled: settled.length,
        pending: bets.length - settled.length,
        staked: round2(staked),
        profit: round2(profit),
        roi: staked ? round4(profit / staked) : 0,
        hitRate: decided.length ? round4(wins / decided.length) : 0,
        avgOdds: settled.length ? round2(settled.reduce((s, b) => s + b.decimal, 0) / settled.length) : 0,
        avgClv: avgClv === null ? null : round4(avgClv),
        clvPositiveRate: clvs.length ? round4(clvs.filter((c) => c > 0).length / clvs.length) : null,
        brierScore: brier === null ? null : round4(brier),
        zScore: z === null ? null : round2(z),
        verdict
    };
}
