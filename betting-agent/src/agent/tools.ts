// Tools the Claude agent can call. Every number the agent reports must come from here,
// never from the model's own mental arithmetic.

import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema';
import { readFileSync } from 'node:fs';
import { devig, fromDecimal, overround, toDecimal, type DevigMethod, type OddsFormat } from '../engine/odds.ts';
import { fitElo, fitPoissonModel, marketsFromMatrix, predictElo, predictMatch, scoreMatrix, type EloModel, type PoissonModel } from '../engine/models.ts';
import { findArbitrage, findValueBets, parlay, stakeAdvice, expectedValue, round4 } from '../engine/value.ts';
import { performance, simulateBankroll } from '../engine/bankroll.ts';
import { extractMarkets, type SportsbookEvent } from '../engine/sportsbook.ts';
import { BetLog } from './store.ts';
import { loadResults, loadTwoWayResults } from './data.ts';

const json = (x: unknown) => JSON.stringify(x, null, 2);

const oddsQuoteSchema = {
    type: 'array',
    items: {
        type: 'object',
        properties: { bookmaker: { type: 'string' }, decimal: { type: 'number', exclusiveMinimum: 1 } },
        required: ['bookmaker', 'decimal'],
        additionalProperties: false
    }
} as const;

export function buildTools(ctx: { log: BetLog; bankroll: () => number }) {
    let soccerModel: PoissonModel | null = null;
    let eloModel: EloModel | null = null;

    return [
        betaTool({
            name: 'convert_odds',
            description: 'Convierte una cuota entre formatos (decimal, american, fractional, hongkong, malay, indonesian) y da su probabilidad implícita.',
            inputSchema: {
                type: 'object',
                properties: {
                    value: { type: 'string', description: 'Cuota, p. ej. "2.10", "-150", "5/2"' },
                    format: { type: 'string', enum: ['decimal', 'american', 'fractional', 'hongkong', 'malay', 'indonesian'] }
                },
                required: ['value', 'format'],
                additionalProperties: false
            },
            run: ({ value, format }) => {
                const d = toDecimal(value, format as OddsFormat);
                return json({
                    decimal: round4(d),
                    american: fromDecimal(d, 'american'),
                    fractional: fromDecimal(d, 'fractional'),
                    impliedProbability: round4(1 / d)
                });
            }
        }),

        betaTool({
            name: 'remove_margin',
            description:
                'Quita el margen de la casa a un mercado completo (todas las salidas mutuamente excluyentes, p. ej. 1X2 o over/under) y devuelve probabilidades justas. Usa "shin" para 1X2 y "power" para mercados de 2 vías por defecto.',
            inputSchema: {
                type: 'object',
                properties: {
                    outcomes: { type: 'array', items: { type: 'string' } },
                    decimals: { type: 'array', items: { type: 'number', exclusiveMinimum: 1 }, minItems: 2 },
                    method: { type: 'string', enum: ['multiplicative', 'additive', 'power', 'shin'] }
                },
                required: ['outcomes', 'decimals'],
                additionalProperties: false
            },
            run: ({ outcomes, decimals, method }) => {
                const fair = devig(decimals, (method ?? 'shin') as DevigMethod);
                return json({
                    overround: round4(overround(decimals)),
                    fair: outcomes.map((o, i) => ({ outcome: o, probability: round4(fair[i]), fairOdds: round4(1 / fair[i]), offered: decimals[i] }))
                });
            }
        }),

        betaTool({
            name: 'fit_soccer_model',
            description:
                'Ajusta un modelo Dixon-Coles (Poisson con corrección de marcadores bajos y decaimiento temporal) con resultados históricos de fútbol desde un archivo CSV o JSON (columnas: date, home, away, homeGoals, awayGoals). Necesario antes de predict_soccer_match.',
            inputSchema: {
                type: 'object',
                properties: {
                    path: { type: 'string' },
                    halfLifeDays: { type: 'number', description: 'Vida media del peso temporal (por defecto 180)' }
                },
                required: ['path'],
                additionalProperties: false
            },
            run: ({ path, halfLifeDays }) => {
                soccerModel = fitPoissonModel(loadResults(path), { halfLifeDays });
                const ranking = Object.entries(soccerModel.teams)
                    .map(([team, r]) => ({ team, attack: round4(r.attack), defence: round4(r.defence), strength: round4(r.attack / r.defence) }))
                    .sort((a, b) => b.strength - a.strength);
                return json({ matches: soccerModel.fittedOn, homeAdvantage: round4(soccerModel.homeAdvantage), rho: soccerModel.rho, goalsPerTeam: round4(soccerModel.baseRate), ranking });
            }
        }),

        betaTool({
            name: 'predict_soccer_match',
            description: 'Probabilidades del modelo Dixon-Coles ajustado: 1X2, over/under, ambos marcan, hándicap asiático y marcadores más probables.',
            inputSchema: {
                type: 'object',
                properties: { home: { type: 'string' }, away: { type: 'string' }, neutral: { type: 'boolean' } },
                required: ['home', 'away'],
                additionalProperties: false
            },
            run: ({ home, away, neutral }) => {
                if (!soccerModel) throw new Error('Primero llama a fit_soccer_model');
                return json(roundDeep(predictMatch(soccerModel, home, away, neutral)));
            }
        }),

        betaTool({
            name: 'poisson_from_expected_goals',
            description:
                'Calcula todos los mercados de un partido de fútbol a partir de goles esperados (xG) de cada equipo. Úsalo cuando no haya histórico cargado y hayas estimado los xG a partir de datos investigados.',
            inputSchema: {
                type: 'object',
                properties: {
                    xgHome: { type: 'number', exclusiveMinimum: 0 },
                    xgAway: { type: 'number', exclusiveMinimum: 0 },
                    rho: { type: 'number', description: 'Corrección Dixon-Coles (típico -0.05 a -0.15)' }
                },
                required: ['xgHome', 'xgAway'],
                additionalProperties: false
            },
            run: ({ xgHome, xgAway, rho }) => json(roundDeep(marketsFromMatrix(scoreMatrix(xgHome, xgAway, rho ?? -0.08), xgHome, xgAway)))
        }),

        betaTool({
            name: 'fit_elo_model',
            description: 'Ajusta ratings Elo para deportes de 2 vías (baloncesto, tenis, MMA, eSports) desde CSV/JSON con columnas: date, home, away, homeWon (true/false), margin (opcional).',
            inputSchema: {
                type: 'object',
                properties: { path: { type: 'string' }, k: { type: 'number' }, homeAdvantage: { type: 'number', description: 'Puntos Elo de localía (0 para tenis/MMA)' } },
                required: ['path'],
                additionalProperties: false
            },
            run: ({ path, k, homeAdvantage }) => {
                eloModel = fitElo(loadTwoWayResults(path), { k, homeAdvantage });
                const ranking = Object.entries(eloModel.ratings)
                    .map(([team, rating]) => ({ team, rating: Math.round(rating) }))
                    .sort((a, b) => b.rating - a.rating);
                return json({ ranking });
            }
        }),

        betaTool({
            name: 'predict_two_way',
            description: 'Probabilidad de victoria según el modelo Elo ajustado.',
            inputSchema: {
                type: 'object',
                properties: { home: { type: 'string' }, away: { type: 'string' }, neutral: { type: 'boolean' } },
                required: ['home', 'away'],
                additionalProperties: false
            },
            run: ({ home, away, neutral }) => {
                if (!eloModel) throw new Error('Primero llama a fit_elo_model');
                return json(roundDeep(predictElo(eloModel, home, away, neutral)));
            }
        }),

        betaTool({
            name: 'find_value_bets',
            description:
                'Detecta apuestas de valor (+EV) en un mercado completo. Mezcla la probabilidad de tu modelo con el consenso sin margen de las casas, exige un EV mínimo y calcula el stake con Kelly fraccional. Pasa TODAS las salidas del mercado.',
            inputSchema: {
                type: 'object',
                properties: {
                    market: {
                        type: 'array',
                        minItems: 2,
                        items: {
                            type: 'object',
                            properties: {
                                outcome: { type: 'string' },
                                model: { type: 'number', minimum: 0, maximum: 1, description: 'Probabilidad estimada por el modelo' },
                                odds: oddsQuoteSchema
                            },
                            required: ['outcome', 'model', 'odds'],
                            additionalProperties: false
                        }
                    },
                    minEv: { type: 'number', description: 'EV mínimo (0.03 = 3%)' },
                    marketWeight: { type: 'number', minimum: 0, maximum: 1, description: 'Peso del consenso del mercado (por defecto 0.5)' },
                    maxOdds: { type: 'number' }
                },
                required: ['market'],
                additionalProperties: false
            },
            run: ({ market, minEv, marketWeight, maxOdds }) => {
                const bets = findValueBets(market, { bankroll: ctx.bankroll(), minEv, marketWeight, maxOdds });
                return bets.length ? json(bets) : 'Sin apuestas de valor con estos parámetros. No apostar también es una decisión ganadora.';
            }
        }),

        betaTool({
            name: 'stake_size',
            description: 'EV y stake recomendado (Kelly fraccional con tope) para una probabilidad y cuota concretas, sobre la banca actual.',
            inputSchema: {
                type: 'object',
                properties: {
                    probability: { type: 'number', minimum: 0, maximum: 1 },
                    decimal: { type: 'number', exclusiveMinimum: 1 },
                    kellyMultiplier: { type: 'number', description: 'Fracción de Kelly (por defecto 0.25)' }
                },
                required: ['probability', 'decimal'],
                additionalProperties: false
            },
            run: ({ probability, decimal, kellyMultiplier }) =>
                json({ ev: round4(expectedValue(probability, decimal)), bankroll: ctx.bankroll(), ...stakeAdvice(probability, decimal, ctx.bankroll(), { kellyMultiplier }) })
        }),

        betaTool({
            name: 'find_arbitrage',
            description: 'Busca una surebet (arbitraje) entre varias casas para un mercado completo y reparte el stake para asegurar beneficio.',
            inputSchema: {
                type: 'object',
                properties: {
                    market: {
                        type: 'array',
                        minItems: 2,
                        items: {
                            type: 'object',
                            properties: { outcome: { type: 'string' }, odds: oddsQuoteSchema },
                            required: ['outcome', 'odds'],
                            additionalProperties: false
                        }
                    },
                    totalStake: { type: 'number' }
                },
                required: ['market'],
                additionalProperties: false
            },
            run: ({ market, totalStake }) => json(findArbitrage(market, totalStake) ?? 'No hay arbitraje: la suma de probabilidades implícitas de las mejores cuotas es ≥ 100%.')
        }),

        betaTool({
            name: 'evaluate_parlay',
            description: 'Probabilidad conjunta, cuota y EV de una combinada (asume independencia entre selecciones).',
            inputSchema: {
                type: 'object',
                properties: {
                    legs: {
                        type: 'array',
                        minItems: 2,
                        items: {
                            type: 'object',
                            properties: { probability: { type: 'number', minimum: 0, maximum: 1 }, decimal: { type: 'number', exclusiveMinimum: 1 } },
                            required: ['probability', 'decimal'],
                            additionalProperties: false
                        }
                    }
                },
                required: ['legs'],
                additionalProperties: false
            },
            run: ({ legs }) => json(parlay(legs))
        }),

        betaTool({
            name: 'simulate_bankroll',
            description: 'Simulación Monte Carlo de la banca: probabilidad de beneficio, de ruina y drawdown típico para una estrategia.',
            inputSchema: {
                type: 'object',
                properties: {
                    bets: { type: 'integer', minimum: 1, maximum: 5000 },
                    probability: { type: 'number', minimum: 0, maximum: 1 },
                    decimal: { type: 'number', exclusiveMinimum: 1 },
                    stakePct: { type: 'number', exclusiveMinimum: 0, maximum: 1 }
                },
                required: ['bets', 'probability', 'decimal', 'stakePct'],
                additionalProperties: false
            },
            run: (input) => json(simulateBankroll({ bankroll: ctx.bankroll(), ...input }))
        }),

        betaTool({
            name: 'analyze_sportsbook_event',
            description:
                'Lee un evento en el formato del sportsbook de este repo (JSON con home, away, odds por id de mercado como "1_1", "1_3", "18_1"…), extrae los mercados y, si hay un modelo de fútbol ajustado, compara probabilidades con las cuotas.',
            inputSchema: {
                type: 'object',
                properties: { path: { type: 'string' } },
                required: ['path'],
                additionalProperties: false
            },
            run: ({ path }) => {
                const raw = JSON.parse(readFileSync(path, 'utf8'));
                const events: SportsbookEvent[] = Array.isArray(raw) ? raw : [raw];
                return json(
                    events.map((ev) => {
                        const markets = extractMarkets(ev);
                        const fair = markets.map((m) => ({
                            ...m,
                            overround: round4(overround(m.outcomes.map((o) => o.decimal))),
                            fair: devig(
                                m.outcomes.map((o) => o.decimal),
                                m.outcomes.length === 3 ? 'shin' : 'power'
                            ).map(round4)
                        }));
                        let model: unknown = 'Sin modelo ajustado (usa fit_soccer_model o poisson_from_expected_goals)';
                        if (soccerModel && ev.sport_id === 1) {
                            try {
                                model = roundDeep(predictMatch(soccerModel, ev.home.name, ev.away.name));
                            } catch (e) {
                                model = (e as Error).message;
                            }
                        }
                        return { event: `${ev.home.name} vs ${ev.away.name}`, league: ev.league?.name, sport_id: ev.sport_id, markets: fair, model };
                    })
                );
            }
        }),

        betaTool({
            name: 'log_bet',
            description: 'Registra una apuesta realizada por el usuario en el historial local (solo cuando el usuario confirme que la hizo).',
            inputSchema: {
                type: 'object',
                properties: {
                    event: { type: 'string' },
                    market: { type: 'string' },
                    selection: { type: 'string' },
                    decimal: { type: 'number', exclusiveMinimum: 1 },
                    stake: { type: 'number', exclusiveMinimum: 0 },
                    probability: { type: 'number', minimum: 0, maximum: 1 }
                },
                required: ['event', 'market', 'selection', 'decimal', 'stake'],
                additionalProperties: false
            },
            run: (bet) => json(ctx.log.add(bet))
        }),

        betaTool({
            name: 'settle_bet',
            description: 'Liquida una apuesta registrada e indica la cuota de cierre para medir el CLV.',
            inputSchema: {
                type: 'object',
                properties: {
                    id: { type: 'string' },
                    result: { type: 'string', enum: ['win', 'loss', 'push', 'half-win', 'half-loss'] },
                    closingDecimal: { type: 'number', exclusiveMinimum: 1 }
                },
                required: ['id', 'result'],
                additionalProperties: false
            },
            run: ({ id, result, closingDecimal }) => json(ctx.log.settle(id, result as any, closingDecimal))
        }),

        betaTool({
            name: 'performance_report',
            description: 'Informe de rendimiento del historial: ROI, yield, CLV medio, Brier score, z-score y veredicto sobre si hay ventaja real o es suerte.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            run: () => json({ bankroll: ctx.bankroll(), ...performance(ctx.log.all()), pendingBets: ctx.log.all().filter((b) => !b.result || b.result === 'pending') })
        })
    ];
}

function roundDeep<T>(x: T): T {
    if (typeof x === 'number') return round4(x) as T;
    if (Array.isArray(x)) return x.map(roundDeep) as T;
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, roundDeep(v)])) as T;
    return x;
}
