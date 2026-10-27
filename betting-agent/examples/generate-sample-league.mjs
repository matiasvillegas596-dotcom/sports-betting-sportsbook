// Generates a SYNTHETIC league (two double round-robin seasons) from known team strengths,
// so the model can be tested against ground truth. Not real data.
import { writeFileSync } from 'node:fs';

const teams = { Atlético: [1.45, 0.7], Rayo: [0.85, 1.15], Betis: [1.2, 0.9], Celta: [1.0, 1.05], Getafe: [0.75, 0.85], Osasuna: [0.9, 1.0], Sevilla: [1.15, 0.95], Valencia: [0.95, 1.1] };
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const poisson = (l) => { let k = 0, p = 1; const L = Math.exp(-l); do { k++; p *= rand(); } while (p > L); return k - 1; };

const rows = ['date,home,away,homeGoals,awayGoals'];
let day = Date.parse('2024-08-15');
for (let season = 0; season < 2; season++)
    for (const h of Object.keys(teams))
        for (const a of Object.keys(teams)) {
            if (h === a) continue;
            const lh = 1.35 * teams[h][0] * teams[a][1] * 1.2;
            const la = 1.35 * teams[a][0] * teams[h][1];
            rows.push(`${new Date(day).toISOString().slice(0, 10)},${h},${a},${poisson(lh)},${poisson(la)}`);
            day += 86_400_000 * 1.3;
        }
writeFileSync(new URL('./sample-league.csv', import.meta.url), rows.join('\n') + '\n');
console.log(`${rows.length - 1} partidos sintéticos escritos en examples/sample-league.csv`);
