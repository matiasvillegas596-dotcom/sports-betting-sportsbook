// Loads historical results from CSV or JSON. Accepts football-data.co.uk column names
// (Date, HomeTeam, AwayTeam, FTHG, FTAG) as well as this project's own names.

import { readFileSync } from 'node:fs';
import { type MatchResult, type TwoWayResult } from '../engine/models.ts';

function parseRows(path: string): Record<string, string>[] {
    const text = readFileSync(path, 'utf8');
    if (path.endsWith('.json')) return JSON.parse(text);
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    const header = lines[0].split(',').map((h) => h.trim());
    return lines.slice(1).map((l) => {
        const cells = l.split(',');
        return Object.fromEntries(header.map((h, i) => [h, (cells[i] ?? '').trim()]));
    });
}

/** football-data.co.uk uses dd/mm/yy or dd/mm/yyyy. */
function normaliseDate(d: string): string {
    const m = d.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (!m) return d;
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${year}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

export function loadResults(path: string): MatchResult[] {
    return parseRows(path)
        .map((r: any) => ({
            date: normaliseDate(String(r.date ?? r.Date)),
            home: String(r.home ?? r.HomeTeam),
            away: String(r.away ?? r.AwayTeam),
            homeGoals: Number(r.homeGoals ?? r.FTHG),
            awayGoals: Number(r.awayGoals ?? r.FTAG),
            neutral: r.neutral === true || r.neutral === 'true'
        }))
        .filter((r) => Number.isFinite(r.homeGoals) && Number.isFinite(r.awayGoals) && r.home && r.away);
}

export function loadTwoWayResults(path: string): TwoWayResult[] {
    return parseRows(path).map((r: any) => ({
        date: normaliseDate(String(r.date)),
        home: String(r.home),
        away: String(r.away),
        homeWon: r.homeWon === true || r.homeWon === 'true' || r.homeWon === '1',
        margin: r.margin !== undefined && r.margin !== '' ? Number(r.margin) : undefined
    }));
}
