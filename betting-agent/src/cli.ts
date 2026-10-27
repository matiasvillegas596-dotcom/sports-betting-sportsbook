// CLI: `chat` runs the Claude analyst; the other commands use the quant engine offline.

import { createInterface } from 'node:readline/promises';
import { readFileSync } from 'node:fs';
import { BettingAgent } from './agent/agent.ts';
import { BetLog } from './agent/store.ts';
import { loadResults } from './agent/data.ts';
import { devig, overround } from './engine/odds.ts';
import { fitPoissonModel, predictMatch } from './engine/models.ts';
import { findArbitrage, findValueBets } from './engine/value.ts';
import { performance, simulateBankroll } from './engine/bankroll.ts';

const [command, ...args] = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : fallback;
};
const bankroll = Number(flag('bankroll', process.env.BANKROLL ?? '1000'));
const log = new BetLog(flag('log', 'data/bets.json')!, bankroll);
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

async function chat() {
    const agent = new BettingAgent({
        log,
        model: flag('model'),
        effort: flag('effort') as any,
        onText: (t) => console.log(`\n${t}`),
        onTool: (name) => console.log(`  · ${name}`)
    });
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    console.log(`Analista de apuestas listo. Banca: ${log.bankroll()}. Escribe "salir" para terminar.`);
    while (true) {
        const q = (await rl.question('\n> ')).trim();
        if (!q) continue;
        if (['salir', 'exit', 'quit'].includes(q.toLowerCase())) break;
        try {
            await agent.ask(q);
        } catch (e) {
            console.error(`Error: ${(e as Error).message}`);
        }
    }
    rl.close();
}

/** Offline: fit Dixon-Coles on history and price a fixture, optionally against odds "home,draw,away". */
function predict() {
    const firstFlag = args.findIndex((a) => a.startsWith('--'));
    const positional = firstFlag === -1 ? args : args.slice(0, firstFlag);
    const [history, home, away] = positional;
    if (!history || !home || !away) throw new Error('Uso: predict <historico.csv> <local> <visitante> [--odds 2.1,3.4,3.6]');
    const model = fitPoissonModel(loadResults(history));
    const p = predictMatch(model, home, away);
    console.log(`${home} vs ${away}  ·  xG ${p.lambdaHome.toFixed(2)} - ${p.lambdaAway.toFixed(2)}`);
    console.log(`1X2: ${pct(p.home)} / ${pct(p.draw)} / ${pct(p.away)}  ·  Over 2.5: ${pct(p.over['2.5'])}  ·  BTTS: ${pct(p.bttsYes)}`);
    console.log(`Marcadores: ${p.topScores.map((s) => `${s.score} (${pct(s.p)})`).join(', ')}`);
    const odds = flag('odds');
    if (odds) {
        const d = odds.split(',').map(Number);
        console.log(`Margen de la casa: ${pct(overround(d))}  ·  Mercado sin margen: ${devig(d).map(pct).join(' / ')}`);
        const bets = findValueBets(
            ['home', 'draw', 'away'].map((o, i) => ({ outcome: o, model: [p.home, p.draw, p.away][i], odds: [{ bookmaker: 'casa', decimal: d[i] }] })),
            { bankroll: log.bankroll() }
        );
        if (!bets.length) console.log('Sin valor: no apostar.');
        for (const b of bets) console.log(`VALOR → ${b.outcome} @ ${b.decimal}: EV ${pct(b.ev)}, stake ${b.kelly.stake} (${pct(b.kelly.fraction)}), confianza ${b.confidence}`);
    }
}

function arb() {
    const file = args[0];
    if (!file) throw new Error('Uso: arb <mercado.json>  (formato: [{outcome, odds:[{bookmaker, decimal}]}])');
    const res = findArbitrage(JSON.parse(readFileSync(file, 'utf8')), Number(flag('stake', '100')));
    console.log(res ? JSON.stringify(res, null, 2) : 'No hay arbitraje.');
}

function simulate() {
    const res = simulateBankroll({
        bankroll: log.bankroll(),
        bets: Number(flag('bets', '500')),
        probability: Number(flag('p', '0.5')),
        decimal: Number(flag('odds', '2.1')),
        stakePct: Number(flag('stake', '0.02'))
    });
    console.log(JSON.stringify(res, null, 2));
}

const commands: Record<string, () => unknown> = {
    chat,
    predict,
    arb,
    simulate,
    report: () => console.log(JSON.stringify({ bankroll: log.bankroll(), ...performance(log.all()) }, null, 2))
};

const run = commands[command ?? 'chat'];
if (!run) {
    console.log('Comandos: chat | predict | arb | simulate | report');
    process.exit(1);
}
Promise.resolve(run()).catch((e) => {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
});
