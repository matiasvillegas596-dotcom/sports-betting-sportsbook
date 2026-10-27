// Odds conversion, implied probability and margin (vig) removal.

export type OddsFormat = 'decimal' | 'american' | 'fractional' | 'hongkong' | 'malay' | 'indonesian';

export function toDecimal(value: number | string, format: OddsFormat = 'decimal'): number {
    if (format === 'fractional') {
        const [num, den] = String(value).split('/').map(Number);
        if (!den) throw new Error(`Cuota fraccional inválida: ${value}`);
        return 1 + num / den;
    }
    const v = Number(value);
    if (!Number.isFinite(v)) throw new Error(`Cuota inválida: ${value}`);
    switch (format) {
        case 'decimal':
            if (v <= 1) throw new Error(`Cuota decimal debe ser > 1: ${v}`);
            return v;
        case 'american':
            if (v > -100 && v < 100) throw new Error(`Cuota americana inválida: ${v}`);
            return v > 0 ? 1 + v / 100 : 1 + 100 / -v;
        case 'hongkong':
            return 1 + v;
        case 'malay':
            return v > 0 ? 1 + v : 1 + 1 / -v;
        case 'indonesian':
            return v >= 1 ? 1 + v : 1 + 1 / -v;
    }
}

export function fromDecimal(decimal: number, format: OddsFormat): string {
    switch (format) {
        case 'decimal':
            return decimal.toFixed(3);
        case 'american':
            return decimal >= 2 ? `+${Math.round((decimal - 1) * 100)}` : `${Math.round(-100 / (decimal - 1))}`;
        case 'fractional': {
            const x = decimal - 1;
            let best = [1, 1];
            let err = Infinity;
            for (let den = 1; den <= 100; den++) {
                const num = Math.round(x * den);
                const e = Math.abs(num / den - x);
                if (e < err - 1e-12) {
                    err = e;
                    best = [num, den];
                }
            }
            return `${best[0]}/${best[1]}`;
        }
        case 'hongkong':
            return (decimal - 1).toFixed(3);
        case 'malay':
            return (decimal >= 2 ? -1 / (decimal - 1) : decimal - 1).toFixed(3);
        case 'indonesian':
            return (decimal >= 2 ? decimal - 1 : -1 / (decimal - 1)).toFixed(3);
    }
}

export const impliedProbability = (decimal: number): number => 1 / decimal;

/** Bookmaker margin: sum of implied probabilities minus 1 (e.g. 0.05 = 5%). */
export function overround(decimals: number[]): number {
    return decimals.reduce((s, d) => s + 1 / d, 0) - 1;
}

export type DevigMethod = 'multiplicative' | 'additive' | 'power' | 'shin';

/**
 * Removes the bookmaker margin and returns fair probabilities that sum to 1.
 * - multiplicative: proportional normalisation (simple, biased toward longshots)
 * - additive: subtracts equal share of the margin from each outcome
 * - power: p_i = q_i^k with k solved so that sum = 1 (handles favourite–longshot bias)
 * - shin: Shin (1993) model assuming a share z of insider money; usually best for 1X2
 */
export function devig(decimals: number[], method: DevigMethod = 'shin'): number[] {
    if (decimals.length < 2) throw new Error('Se necesitan al menos 2 resultados para quitar el margen');
    const q = decimals.map((d) => 1 / d);
    const booksum = q.reduce((a, b) => a + b, 0);
    switch (method) {
        case 'multiplicative':
            return q.map((x) => x / booksum);
        case 'additive': {
            const n = q.length;
            const p = q.map((x) => x - (booksum - 1) / n);
            return p.some((x) => x <= 0) ? devig(decimals, 'multiplicative') : p;
        }
        case 'power': {
            const k = bisect((k) => q.reduce((s, x) => s + Math.pow(x, k), 0) - 1, 0.5, 3);
            return q.map((x) => Math.pow(x, k));
        }
        case 'shin': {
            if (booksum <= 1) return q.map((x) => x / booksum);
            const shinProbs = (z: number) =>
                q.map((x) => (Math.sqrt(z * z + (4 * (1 - z) * x * x) / booksum) - z) / (2 * (1 - z)));
            const z = bisect((z) => shinProbs(z).reduce((a, b) => a + b, 0) - 1, 0, 0.5);
            return shinProbs(z);
        }
    }
}

/** Bisection root finder for monotone f on [lo, hi]. */
export function bisect(f: (x: number) => number, lo: number, hi: number, iterations = 200): number {
    let flo = f(lo);
    for (let i = 0; i < iterations; i++) {
        const mid = (lo + hi) / 2;
        const fm = f(mid);
        if (Math.sign(fm) === Math.sign(flo)) {
            lo = mid;
            flo = fm;
        } else {
            hi = mid;
        }
    }
    return (lo + hi) / 2;
}

export const fairOdds = (probability: number): number => 1 / probability;
