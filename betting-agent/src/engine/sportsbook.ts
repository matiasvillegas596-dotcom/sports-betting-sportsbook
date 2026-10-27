// Adapter for the sportsbook's event format (BetsAPI-style `odds` keyed by market id,
// as consumed in frontend/src/utils/sports.tsx).

import { type OutcomeQuote } from './value.ts';

export interface SportsbookEvent {
    id: number;
    sport_id: number;
    home: { name: string };
    away: { name: string };
    league?: { name: string };
    time?: number;
    odds?: Record<string, any>;
}

export interface ExtractedMarket {
    marketId: string;
    name: string;
    handicap?: string;
    outcomes: { outcome: string; decimal: number }[];
}

const num = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 1 ? n : undefined;
};

/** Pulls the main markets (1x2 / money line, handicap, totals) out of an event. */
export function extractMarkets(event: SportsbookEvent): ExtractedMarket[] {
    const out: ExtractedMarket[] = [];
    for (const [marketId, raw] of Object.entries(event.odds ?? {})) {
        const m = Array.isArray(raw) ? raw[0] : raw; // BetsAPI returns history arrays; newest first
        if (!m) continue;
        const handicap = m.handicap !== undefined ? String(m.handicap) : undefined;
        if (handicap?.includes(',')) continue; // split lines are skipped like the frontend does
        const home = num(m.home_od);
        const draw = num(m.draw_od);
        const away = num(m.away_od);
        const over = num(m.over_od);
        const under = num(m.under_od);
        if (home && away && draw) {
            out.push({ marketId, name: '1X2', outcomes: [{ outcome: 'home', decimal: home }, { outcome: 'draw', decimal: draw }, { outcome: 'away', decimal: away }] });
        } else if (home && away) {
            out.push({ marketId, name: handicap ? 'Handicap' : 'Money Line', handicap, outcomes: [{ outcome: 'home', decimal: home }, { outcome: 'away', decimal: away }] });
        } else if (over && under) {
            out.push({ marketId, name: 'Over/Under', handicap, outcomes: [{ outcome: 'over', decimal: over }, { outcome: 'under', decimal: under }] });
        }
    }
    return out;
}

/** Turns a market + model probabilities into quotes ready for findValueBets. */
export function toQuotes(market: ExtractedMarket, modelProbs: Record<string, number>, bookmaker = 'sportsbook'): OutcomeQuote[] {
    return market.outcomes.map((o) => {
        const model = modelProbs[o.outcome];
        if (model === undefined) throw new Error(`Falta probabilidad del modelo para "${o.outcome}"`);
        return { outcome: o.outcome, model, odds: [{ bookmaker, decimal: o.decimal }] };
    });
}
