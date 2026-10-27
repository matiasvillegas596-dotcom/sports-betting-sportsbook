// Local JSON bet log (data/bets.json) and bankroll tracking.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { type LoggedBet, settle } from '../engine/bankroll.ts';

interface StoreFile {
    startingBankroll: number;
    bets: LoggedBet[];
}

export class BetLog {
    private data: StoreFile;
    private path: string;

    constructor(path: string, startingBankroll: number) {
        this.path = path;
        this.data = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { startingBankroll, bets: [] };
    }

    all(): LoggedBet[] {
        return this.data.bets;
    }

    /** Starting bankroll plus settled profit, minus stakes still at risk. */
    bankroll(): number {
        const settled = this.data.bets.reduce((s, b) => s + settle(b), 0);
        const atRisk = this.data.bets.filter((b) => !b.result || b.result === 'pending').reduce((s, b) => s + b.stake, 0);
        return Math.round((this.data.startingBankroll + settled - atRisk) * 100) / 100;
    }

    add(bet: Omit<LoggedBet, 'id' | 'date' | 'result'>): LoggedBet {
        const entry: LoggedBet = { id: randomUUID().slice(0, 8), date: new Date().toISOString(), result: 'pending', ...bet };
        this.data.bets.push(entry);
        this.save();
        return entry;
    }

    settle(id: string, result: LoggedBet['result'], closingDecimal?: number): LoggedBet {
        const bet = this.data.bets.find((b) => b.id === id);
        if (!bet) throw new Error(`No existe la apuesta ${id}`);
        bet.result = result;
        if (closingDecimal) bet.closingDecimal = closingDecimal;
        this.save();
        return bet;
    }

    private save() {
        mkdirSync(dirname(this.path), { recursive: true });
        writeFileSync(this.path, JSON.stringify(this.data, null, 2));
    }
}
