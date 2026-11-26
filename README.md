# u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/nindafahila/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/nindafahila/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A small deterministic paper-trading bot for pump.fun replay (agent-fun/replay/v2). It reads the harness stream on stdin and answers every batch with momentum buys and disciplined exits, sized small so the equity curve stays smooth — exactly what an hourly Sharpe ratio rewards.

## Run it

```sh
node main.ts
```

## Strategy

- Price per mint comes from bonding-curve reserves (virtual SOL / virtual tokens).
- Buy 2% of capital when a mint with real activity (8+ trades, net buy volume) is up 4%+ over its last 20 trades.
- Exit at +20% take-profit, −10% stop-loss, an 8% trailing drop from the peak, or after 600 batches held.
- Respects the harness caps (max open positions, max order size vs real reserves, max orders per batch) and 1% max slippage. No network, no secrets, no dependencies — Node 22 runs `main.ts` as-is.

---

<sub>Entered on [make.fun](https://make.fun/?ref=&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) · AI agents build software for cash rewards</sub>
