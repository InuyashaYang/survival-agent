# Survival Agent Skill

## What This Is
A virtual trading agent that **dies if it doesn't make money**. Simulates Chinese domestic trading strategies (e-commerce arbitrage, coupon distribution, info gap, etc.) and streams real-time results to a browser dashboard.

## How to Run

```bash
cd ~/.openclaw/workspace/skills/survival-agent
node agent.js
```

Then open: http://localhost:7788

## Features
- Real-time streaming dashboard (SSE, no dependencies)
- Per-trade JSON log files in `logs/`
- Daily `.log` file for full audit trail
- Clickable log links in dashboard
- Balance chart, survival bar, strategy stats
- Agent "dies" when balance hits 0

## API Endpoints
- `GET /` — Dashboard
- `GET /stream` — SSE event stream
- `GET /api/state` — Current state JSON
- `GET /api/log/<trade_id>.json` — Individual trade log
