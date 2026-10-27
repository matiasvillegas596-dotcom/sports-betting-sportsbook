# 🎯 Betting Agent — analista de apuestas con Claude

Agente que analiza partidos, calcula probabilidades y solo recomienda apuestas con **valor esperado positivo (+EV)**, con gestión de banca profesional. Combina:

- **Motor cuantitativo propio** (TypeScript, sin dependencias): modelos Dixon-Coles y Elo, eliminación de margen, Kelly, arbitraje, Monte Carlo y seguimiento de CLV.
- **Claude como analista**: investiga en la web (lesiones, alineaciones, cuotas de varias casas), llama a las herramientas del motor para cada número y explica cada recomendación.
- **Integración con este sportsbook**: lee eventos en el formato `odds` del frontend (`1_1` 1X2, `1_2` hándicap, `1_3` over/under, `18_1` money line…).

> ⚠️ **Honestidad ante todo.** Ningún sistema garantiza ganar dinero apostando. Las casas cobran un margen del 3–8 % por mercado y sus líneas de cierre son muy eficientes. Este agente está diseñado para **aumentar tus probabilidades de tener ventaja y para que no pierdas la banca por mala gestión**, y para decirte con datos (CLV, z-score) si tu ventaja es real o suerte. Habrá rachas perdedoras incluso con ventaja. Apuesta solo dinero que puedas perder, solo si eres mayor de edad y donde sea legal.

## Instalación

```bash
cd betting-agent
npm install
export ANTHROPIC_API_KEY=sk-ant-...   # o `ant auth login`
```

Requiere Node.js ≥ 22.6 (ejecuta TypeScript directamente).

## Uso

### Chat con el analista

```bash
npm run agent -- --bankroll 1000
```

Ejemplos de preguntas:

- «Analiza el Betis–Sevilla del domingo. Busca cuotas en varias casas y dime si hay valor en 1X2, over/under o hándicap asiático.»
- «Carga `examples/sample-league.csv`, ajusta el modelo y analiza `examples/sample-event.json`.»
- «Quiero duplicar mi banca en un mes, ¿qué stake uso?» → te mostrará con simulación por qué es mala idea.
- «Hice la apuesta: Betis @ 2.15, 20 €.» / «Ganó, la cuota cerró a 2.02.» → la registra y mide el CLV.
- «Dame el informe de rendimiento.»

Opciones: `--model claude-opus-5-5` (por defecto), `--effort high|xhigh|max`, `--log data/bets.json`.

### Comandos sin IA (offline)

```bash
# Ajusta Dixon-Coles con histórico y compara con cuotas 1X2
npm run cli -- predict examples/sample-league.csv Atlético Rayo --odds 1.80,3.60,4.75

# Busca surebets entre casas
npm run cli -- arb examples/sample-arbitrage.json --stake 100

# ¿Qué le pasa a tu banca con 500 apuestas al 2 % con p=0.5 @ 2.10?
npm run cli -- simulate --bets 500 --p 0.5 --odds 2.1 --stake 0.02

# Rendimiento del historial (ROI, CLV, Brier, z-score)
npm run cli -- report
```

El histórico acepta CSV/JSON con columnas `date,home,away,homeGoals,awayGoals` o directamente los CSV de [football-data.co.uk](https://www.football-data.co.uk/) (`Date,HomeTeam,AwayTeam,FTHG,FTAG`). `examples/sample-league.csv` es **sintético** (generado por `examples/generate-sample-league.mjs`), solo para probar.

## Cómo decide el agente

1. **Probabilidad del modelo** — Dixon-Coles (Poisson con corrección de marcadores bajos y decaimiento temporal) para fútbol; Elo con margen de victoria para deportes de 2 vías; o xG estimados a partir de la investigación.
2. **Probabilidad del mercado** — cuotas de varias casas sin margen (método de Shin / potencia, que corrigen el sesgo favorito–longshot).
3. **Mezcla** — por defecto 50/50 modelo–mercado. Un modelo que discrepa mucho del mercado suele estar equivocado (le falta información), así que esa discrepancia **baja la confianza** en vez de subir la apuesta.
4. **Filtro** — EV ≥ 3 % y cuota ≤ 6.0 (los longshots amplifican el error del modelo).
5. **Stake** — ¼ de Kelly, máximo 3 % de la banca por apuesta.
6. **Validación** — registra cada apuesta y su cuota de cierre. El **CLV** (Closing Line Value) es la mejor prueba de habilidad: si batallas consistentemente la cuota de cierre, ganarás a largo plazo; si no, el beneficio a corto plazo es suerte.

Ejemplo real de esta filosofía: con el CSV sintético (solo 112 partidos) el modelo da 84 % al local cuando el mercado dice 54 %. El agente lo marca como **confianza baja**: con tan poca muestra el modelo sobreajusta, y eso es justo lo que la mezcla con el mercado y la bandera de confianza existen para detectar.

## Estructura

```
src/engine/odds.ts        conversión de cuotas, margen, de-vig (multiplicativo, aditivo, potencia, Shin)
src/engine/models.ts      Dixon-Coles, matriz de marcadores, 1X2/OU/BTTS/hándicap asiático, Elo
src/engine/value.ts       EV, Kelly, value bets, arbitraje, combinadas, CLV
src/engine/bankroll.ts    Monte Carlo de banca, liquidación y métricas de rendimiento
src/engine/sportsbook.ts  adaptador del formato de eventos del sportsbook
src/agent/                agente Claude (tool runner + web search), prompt, herramientas, historial
src/cli.ts                CLI
test/                     tests (npm test)
```

## Desarrollo

```bash
npm test          # tests del motor
npm run typecheck
```

## Juego responsable

Si apostar te genera ansiedad, persigues pérdidas o usas dinero que necesitas, para y busca ayuda (Jugadores Anónimos, o la línea de ayuda al jugador de tu país). Usa límites de depósito y autoexclusión en las casas.
