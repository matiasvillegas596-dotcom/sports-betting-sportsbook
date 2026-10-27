// Predictive models: Dixon-Coles (Poisson) for goal sports and Elo for two-way sports.

export interface MatchResult {
    date: string; // ISO date
    home: string;
    away: string;
    homeGoals: number;
    awayGoals: number;
    neutral?: boolean;
}

export interface TeamRating {
    attack: number;
    defence: number;
    matches: number;
}

export interface PoissonModel {
    teams: Record<string, TeamRating>;
    homeAdvantage: number;
    rho: number;
    baseRate: number;
    fittedOn: number;
}

const factorialCache = [1];
function factorial(n: number): number {
    for (let i = factorialCache.length; i <= n; i++) factorialCache[i] = factorialCache[i - 1] * i;
    return factorialCache[n];
}

export const poissonPmf = (k: number, lambda: number): number => (Math.exp(-lambda) * Math.pow(lambda, k)) / factorial(k);

/** Dixon-Coles low-score correction factor. */
function tau(x: number, y: number, lh: number, la: number, rho: number): number {
    if (x === 0 && y === 0) return 1 - lh * la * rho;
    if (x === 0 && y === 1) return 1 + lh * rho;
    if (x === 1 && y === 0) return 1 + la * rho;
    if (x === 1 && y === 1) return 1 - rho;
    return 1;
}

/**
 * Fits attack/defence ratings with exponential time decay (half-life in days),
 * using iterative maximum-likelihood updates (Maher / Dixon-Coles style).
 */
export function fitPoissonModel(results: MatchResult[], opts: { halfLifeDays?: number; asOf?: string; iterations?: number } = {}): PoissonModel {
    if (results.length < 10) throw new Error('Se necesitan al menos 10 partidos históricos para ajustar el modelo');
    const halfLife = opts.halfLifeDays ?? 180;
    const asOf = opts.asOf ? Date.parse(opts.asOf) : Math.max(...results.map((r) => Date.parse(r.date)));
    const xi = Math.log(2) / halfLife;
    const games = results
        .filter((r) => Date.parse(r.date) <= asOf)
        .map((r) => ({ ...r, w: Math.exp((-xi * (asOf - Date.parse(r.date))) / 86_400_000) }));

    const teams: Record<string, TeamRating> = {};
    for (const g of games) {
        for (const t of [g.home, g.away]) teams[t] ??= { attack: 1, defence: 1, matches: 0 };
        teams[g.home].matches++;
        teams[g.away].matches++;
    }
    const totalW = games.reduce((s, g) => s + g.w, 0);
    const totalGoals = games.reduce((s, g) => s + g.w * (g.homeGoals + g.awayGoals), 0);
    let baseRate = totalGoals / (2 * totalW);
    let home = 1.25;

    for (let it = 0; it < (opts.iterations ?? 60); it++) {
        const attNum: Record<string, number> = {};
        const attDen: Record<string, number> = {};
        const defNum: Record<string, number> = {};
        const defDen: Record<string, number> = {};
        let homeNum = 0;
        let homeDen = 0;
        for (const g of games) {
            const h = g.neutral ? 1 : home;
            const H = teams[g.home];
            const A = teams[g.away];
            attNum[g.home] = (attNum[g.home] ?? 0) + g.w * g.homeGoals;
            attDen[g.home] = (attDen[g.home] ?? 0) + g.w * baseRate * A.defence * h;
            attNum[g.away] = (attNum[g.away] ?? 0) + g.w * g.awayGoals;
            attDen[g.away] = (attDen[g.away] ?? 0) + g.w * baseRate * H.defence;
            defNum[g.away] = (defNum[g.away] ?? 0) + g.w * g.homeGoals;
            defDen[g.away] = (defDen[g.away] ?? 0) + g.w * baseRate * H.attack * h;
            defNum[g.home] = (defNum[g.home] ?? 0) + g.w * g.awayGoals;
            defDen[g.home] = (defDen[g.home] ?? 0) + g.w * baseRate * A.attack;
            if (!g.neutral) {
                homeNum += g.w * g.homeGoals;
                homeDen += g.w * baseRate * H.attack * A.defence;
            }
        }
        // Light shrinkage toward 1 (pseudo-observations) keeps small samples sane.
        const prior = 2 * baseRate;
        for (const t of Object.keys(teams)) {
            teams[t].attack = (attNum[t] + prior) / (attDen[t] + prior);
            teams[t].defence = (defNum[t] + prior) / (defDen[t] + prior);
        }
        if (homeDen > 0) home = homeNum / homeDen;
        const meanAtt = mean(Object.values(teams).map((t) => t.attack));
        const meanDef = mean(Object.values(teams).map((t) => t.defence));
        for (const t of Object.values(teams)) {
            t.attack /= meanAtt;
            t.defence /= meanDef;
        }
        // Normalising ratings shifts the overall scale, so re-estimate it by MLE.
        let expected = 0;
        for (const g of games) {
            const h = g.neutral ? 1 : home;
            expected += g.w * (teams[g.home].attack * teams[g.away].defence * h + teams[g.away].attack * teams[g.home].defence);
        }
        baseRate = totalGoals / expected;
    }

    const model: PoissonModel = { teams, homeAdvantage: home, rho: 0, baseRate, fittedOn: games.length };
    model.rho = fitRho(model, games);
    return model;
}

function fitRho(model: PoissonModel, games: (MatchResult & { w: number })[]): number {
    let best = 0;
    let bestLL = -Infinity;
    for (let rho = -0.2; rho <= 0.2001; rho += 0.01) {
        let ll = 0;
        for (const g of games) {
            const { lambdaHome, lambdaAway } = expectedGoals(model, g.home, g.away, g.neutral);
            const t = tau(g.homeGoals, g.awayGoals, lambdaHome, lambdaAway, rho);
            if (t <= 0) {
                ll = -Infinity;
                break;
            }
            ll += g.w * Math.log(t);
        }
        if (ll > bestLL) {
            bestLL = ll;
            best = rho;
        }
    }
    return Math.round(best * 100) / 100;
}

export function expectedGoals(model: PoissonModel, home: string, away: string, neutral = false) {
    const H = model.teams[home];
    const A = model.teams[away];
    if (!H) throw new Error(`Equipo sin historial: ${home}`);
    if (!A) throw new Error(`Equipo sin historial: ${away}`);
    const h = neutral ? 1 : model.homeAdvantage;
    return {
        lambdaHome: model.baseRate * H.attack * A.defence * h,
        lambdaAway: model.baseRate * A.attack * H.defence
    };
}

/** Full scoreline matrix P[homeGoals][awayGoals] using Dixon-Coles correction. */
export function scoreMatrix(lambdaHome: number, lambdaAway: number, rho = 0, maxGoals = 10): number[][] {
    const m: number[][] = [];
    let total = 0;
    for (let x = 0; x <= maxGoals; x++) {
        m[x] = [];
        for (let y = 0; y <= maxGoals; y++) {
            const p = poissonPmf(x, lambdaHome) * poissonPmf(y, lambdaAway) * tau(x, y, lambdaHome, lambdaAway, rho);
            m[x][y] = p;
            total += p;
        }
    }
    return m.map((row) => row.map((p) => p / total));
}

export interface MarketProbabilities {
    lambdaHome: number;
    lambdaAway: number;
    home: number;
    draw: number;
    away: number;
    over: Record<string, number>;
    bttsYes: number;
    asianHandicap: Record<string, { home: number; away: number }>;
    topScores: { score: string; p: number }[];
}

/** Derives every main market from a score matrix. */
export function marketsFromMatrix(m: number[][], lambdaHome: number, lambdaAway: number): MarketProbabilities {
    let home = 0;
    let draw = 0;
    let away = 0;
    let btts = 0;
    const scores: { score: string; p: number }[] = [];
    const totals: number[] = [];
    const diffs = new Map<number, number>();
    m.forEach((row, x) =>
        row.forEach((p, y) => {
            if (x > y) home += p;
            else if (x === y) draw += p;
            else away += p;
            if (x > 0 && y > 0) btts += p;
            totals[x + y] = (totals[x + y] ?? 0) + p;
            diffs.set(x - y, (diffs.get(x - y) ?? 0) + p);
            scores.push({ score: `${x}-${y}`, p });
        })
    );
    const over: Record<string, number> = {};
    for (const line of [0.5, 1.5, 2.5, 3.5, 4.5, 5.5]) {
        over[line.toFixed(1)] = totals.reduce((s, p, g) => (g > line ? s + (p ?? 0) : s), 0);
    }
    const asianHandicap: Record<string, { home: number; away: number }> = {};
    for (let h = -2.5; h <= 2.51; h += 0.25) {
        const r = asianHandicapProbability(diffs, h);
        asianHandicap[(h > 0 ? '+' : '') + h.toFixed(2)] = r;
    }
    scores.sort((a, b) => b.p - a.p);
    return { lambdaHome, lambdaAway, home, draw, away, over, bttsYes: btts, asianHandicap, topScores: scores.slice(0, 6) };
}

/**
 * Effective win probability for the home side at an Asian handicap line,
 * returned as the "push-adjusted" probability (refunds excluded), so EV = p*odds - 1 holds.
 * Quarter lines are split into two half-stakes.
 */
export function asianHandicapProbability(diffs: Map<number, number>, line: number): { home: number; away: number } {
    const frac = Math.round((line - Math.floor(line)) * 100) / 100;
    if (frac === 0.25 || frac === 0.75) {
        const a = asianHandicapProbability(diffs, line - 0.25);
        const b = asianHandicapProbability(diffs, line + 0.25);
        return { home: (a.home + b.home) / 2, away: (a.away + b.away) / 2 };
    }
    let win = 0;
    let lose = 0;
    for (const [d, p] of diffs) {
        const adj = d + line;
        if (adj > 1e-9) win += p;
        else if (adj < -1e-9) lose += p;
    }
    const decided = win + lose;
    return { home: win / decided, away: lose / decided };
}

export function predictMatch(model: PoissonModel, home: string, away: string, neutral = false): MarketProbabilities {
    const { lambdaHome, lambdaAway } = expectedGoals(model, home, away, neutral);
    return marketsFromMatrix(scoreMatrix(lambdaHome, lambdaAway, model.rho), lambdaHome, lambdaAway);
}

// ---------------- Elo (basketball, tennis, MMA, eSports...) ----------------

export interface EloModel {
    ratings: Record<string, number>;
    k: number;
    homeAdvantage: number;
}

export interface TwoWayResult {
    date: string;
    home: string;
    away: string;
    homeWon: boolean;
    margin?: number;
}

export function fitElo(results: TwoWayResult[], opts: { k?: number; homeAdvantage?: number; initial?: number } = {}): EloModel {
    const model: EloModel = { ratings: {}, k: opts.k ?? 20, homeAdvantage: opts.homeAdvantage ?? 65 };
    const init = opts.initial ?? 1500;
    for (const r of [...results].sort((a, b) => Date.parse(a.date) - Date.parse(b.date))) {
        const rh = (model.ratings[r.home] ??= init);
        const ra = (model.ratings[r.away] ??= init);
        const expected = eloWinProbability(rh + model.homeAdvantage, ra);
        // Margin-of-victory multiplier (FiveThirtyEight style) when margin is known.
        const mov = r.margin ? Math.log(Math.abs(r.margin) + 1) * (2.2 / ((r.homeWon ? rh - ra : ra - rh) * 0.001 + 2.2)) : 1;
        const delta = model.k * mov * ((r.homeWon ? 1 : 0) - expected);
        model.ratings[r.home] = rh + delta;
        model.ratings[r.away] = ra - delta;
    }
    return model;
}

export const eloWinProbability = (ratingA: number, ratingB: number): number => 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));

export function predictElo(model: EloModel, home: string, away: string, neutral = false): { home: number; away: number } {
    const rh = model.ratings[home];
    const ra = model.ratings[away];
    if (rh === undefined) throw new Error(`Equipo sin historial: ${home}`);
    if (ra === undefined) throw new Error(`Equipo sin historial: ${away}`);
    const p = eloWinProbability(rh + (neutral ? 0 : model.homeAdvantage), ra);
    return { home: p, away: 1 - p };
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
