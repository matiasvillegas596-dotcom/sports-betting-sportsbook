import { test } from 'node:test';
import assert from 'node:assert/strict';
import { devig, fromDecimal, overround, toDecimal } from '../src/engine/odds.ts';
import { asianHandicapProbability, expectedGoals, fitElo, fitPoissonModel, marketsFromMatrix, predictElo, scoreMatrix, type MatchResult } from '../src/engine/models.ts';
import { findArbitrage, findValueBets, kellyFraction, parlay, stakeAdvice } from '../src/engine/value.ts';
import { mulberry32, performance, simulateBankroll } from '../src/engine/bankroll.ts';
import { extractMarkets } from '../src/engine/sportsbook.ts';

const close = (a: number, b: number, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b}`);

test('conversión de cuotas', () => {
    close(toDecimal('-150', 'american'), 1 + 100 / 150);
    close(toDecimal('+250', 'american'), 3.5);
    close(toDecimal('5/2', 'fractional'), 3.5);
    assert.equal(fromDecimal(3.5, 'american'), '+250');
    assert.equal(fromDecimal(1.5, 'american'), '-200');
    assert.equal(fromDecimal(3.5, 'fractional'), '5/2');
    assert.throws(() => toDecimal('1.0', 'decimal'));
});

test('quitar margen: todas las variantes suman 1 y respetan el orden', () => {
    const odds = [1.8, 3.6, 4.75];
    close(overround(odds), 1 / 1.8 + 1 / 3.6 + 1 / 4.75 - 1);
    for (const m of ['multiplicative', 'additive', 'power', 'shin'] as const) {
        const p = devig(odds, m);
        close(p.reduce((a, b) => a + b, 0), 1, 1e-6);
        assert.ok(p[0] > p[1] && p[1] > p[2]);
    }
    // Shin and power shave more off the longshot than proportional normalisation.
    assert.ok(devig(odds, 'shin')[2] < devig(odds, 'multiplicative')[2]);
    assert.ok(devig(odds, 'power')[2] < devig(odds, 'multiplicative')[2]);
});

test('matriz de marcadores coherente', () => {
    const m = marketsFromMatrix(scoreMatrix(1.6, 1.1, -0.08), 1.6, 1.1);
    close(m.home + m.draw + m.away, 1, 1e-9);
    assert.ok(m.home > m.away);
    assert.ok(m.over['1.5'] > m.over['2.5'] && m.over['2.5'] > m.over['3.5']);
    // AH 0 is draw-no-bet: home / (home + away).
    close(m.asianHandicap['0.00'].home, m.home / (m.home + m.away), 1e-9);
    // AH -0.5 is the plain home win.
    close(m.asianHandicap['-0.50'].home, m.home, 1e-9);
});

test('hándicap asiático de cuarto = media de las dos medias líneas', () => {
    const diffs = new Map([[-1, 0.3], [0, 0.3], [1, 0.25], [2, 0.15]]);
    const q = asianHandicapProbability(diffs, -0.25);
    const a = asianHandicapProbability(diffs, -0.5);
    const b = asianHandicapProbability(diffs, 0);
    close(q.home, (a.home + b.home) / 2);
});

test('Dixon-Coles recupera fuerzas conocidas en una liga sintética', () => {
    const truth: Record<string, [number, number]> = { A: [1.5, 0.7], B: [1.2, 0.9], C: [1, 1], D: [0.8, 1.15], E: [0.7, 1.3], F: [1.0, 0.95] };
    const rand = mulberry32(3);
    const poisson = (l: number) => {
        let k = 0;
        let p = 1;
        const L = Math.exp(-l);
        do {
            k++;
            p *= rand();
        } while (p > L);
        return k - 1;
    };
    const results: MatchResult[] = [];
    let day = Date.parse('2020-01-01');
    for (let s = 0; s < 30; s++)
        for (const h of Object.keys(truth))
            for (const a of Object.keys(truth)) {
                if (h === a) continue;
                results.push({
                    date: new Date((day += 86_400_000)).toISOString(),
                    home: h,
                    away: a,
                    homeGoals: poisson(1.3 * truth[h][0] * truth[a][1] * 1.25),
                    awayGoals: poisson(1.3 * truth[a][0] * truth[h][1])
                });
            }
    const model = fitPoissonModel(results, { halfLifeDays: 100_000 });
    close(model.homeAdvantage, 1.25, 0.08);
    const { lambdaHome, lambdaAway } = expectedGoals(model, 'A', 'E');
    close(lambdaHome, 1.3 * 1.5 * 1.3 * 1.25, 0.35);
    close(lambdaAway, 1.3 * 0.7 * 0.7, 0.15);
});

test('Elo: el equipo que gana más sube', () => {
    const res = Array.from({ length: 20 }, (_, i) => ({ date: `2024-01-${String(i + 1).padStart(2, '0')}`, home: i % 2 ? 'X' : 'Y', away: i % 2 ? 'Y' : 'X', homeWon: i % 2 === 1 }));
    const m = fitElo(res, { homeAdvantage: 0 });
    assert.ok(m.ratings.X > m.ratings.Y);
    assert.ok(predictElo(m, 'X', 'Y', true).home > 0.5);
});

test('Kelly y stake con tope', () => {
    close(kellyFraction(0.55, 2), 0.1);
    assert.equal(stakeAdvice(0.4, 2, 1000).stake, 0);
    const s = stakeAdvice(0.7, 2, 1000);
    assert.equal(s.fraction, 0.03); // capped at 3%
});

test('apuestas de valor: mezcla con el mercado y no recomienda EV negativo', () => {
    const market = [
        { outcome: 'home', model: 0.5, odds: [{ bookmaker: 'A', decimal: 2.2 }, { bookmaker: 'B', decimal: 2.1 }] },
        { outcome: 'draw', model: 0.27, odds: [{ bookmaker: 'A', decimal: 3.4 }] },
        { outcome: 'away', model: 0.23, odds: [{ bookmaker: 'A', decimal: 3.6 }] }
    ];
    const bets = findValueBets(market, { bankroll: 1000, minEv: 0.01 });
    assert.equal(bets.length, 1);
    assert.equal(bets[0].outcome, 'home');
    assert.equal(bets[0].bookmaker, 'A');
    assert.ok(bets[0].blendedProbability < 0.5); // pulled toward market
    assert.equal(findValueBets(market, { bankroll: 1000, minEv: 0.2 }).length, 0);
});

test('arbitraje', () => {
    const arb = findArbitrage([
        { outcome: '1', odds: [{ bookmaker: 'A', decimal: 2.1 }] },
        { outcome: '2', odds: [{ bookmaker: 'B', decimal: 2.1 }] }
    ]);
    assert.ok(arb);
    close(arb!.margin, 0.05, 1e-4);
    assert.equal(findArbitrage([{ outcome: '1', odds: [{ bookmaker: 'A', decimal: 1.9 }] }, { outcome: '2', odds: [{ bookmaker: 'B', decimal: 1.9 }] }]), null);
});

test('combinada', () => {
    const p = parlay([{ probability: 0.5, decimal: 1.9 }, { probability: 0.5, decimal: 1.9 }]);
    close(p.probability, 0.25);
    assert.ok(p.ev < 0);
});

test('simulación: sin ventaja la mediana pierde dinero', () => {
    const r = simulateBankroll({ bankroll: 1000, bets: 500, probability: 0.5, decimal: 1.91, stakePct: 0.02, runs: 2000 });
    assert.ok(r.medianFinal < 1000);
    assert.ok(r.expectedRoiPerBet < 0);
});

test('informe de rendimiento con CLV', () => {
    const rep = performance([
        { id: '1', date: '', event: 'e', market: '1X2', selection: 'home', decimal: 2.0, stake: 10, result: 'win', closingDecimal: 1.9, probability: 0.55 },
        { id: '2', date: '', event: 'e', market: '1X2', selection: 'away', decimal: 3.0, stake: 10, result: 'loss', closingDecimal: 2.8, probability: 0.36 },
        { id: '3', date: '', event: 'e', market: '1X2', selection: 'draw', decimal: 3.2, stake: 10, result: 'pending' }
    ]);
    assert.equal(rep.settled, 2);
    assert.equal(rep.pending, 1);
    assert.equal(rep.profit, 0);
    assert.ok(rep.avgClv! > 0);
});

test('adaptador del formato del sportsbook', () => {
    const markets = extractMarkets({
        id: 1,
        sport_id: 1,
        home: { name: 'H' },
        away: { name: 'A' },
        odds: {
            '1_1': [{ home_od: '1.80', draw_od: '3.60', away_od: '4.75' }],
            '1_2': { home_od: '1.95', away_od: '1.90', handicap: '-0.5,-1.0' },
            '1_3': { over_od: '2.05', under_od: '1.80', handicap: '2.5' }
        }
    });
    assert.deepEqual(
        markets.map((m) => m.name),
        ['1X2', 'Over/Under']
    );
});
