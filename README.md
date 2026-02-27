# 🤖 Survival Agent

> An AI trading agent that **dies if it doesn't make money**.

## What It Does

Simulates Chinese domestic micro-trading strategies every 2.5 seconds:
- 🛒 拼多多比价套利 (E-commerce price arbitrage)
- 🎫 优惠券批发分发 (Coupon wholesale distribution)
- 📊 信息差报告售卖 (Information gap reports)
- ♻️ 闲鱼商品翻转 (Secondhand goods flipping)
- ⚡ API 服务调用费 (API service fees)

Each trade costs compute credits. If balance hits ¥0 → agent dies permanently.

## Quick Start

```bash
git clone https://github.com/YOUR_USER/survival-agent
cd survival-agent
node agent.js
# Open http://localhost:7788
```

**No npm install needed. Zero external dependencies.**

## Dashboard Features

- 📡 Real-time trade stream (SSE)
- 📊 Live balance chart
- 🩺 Survival health bar
- 📄 Per-trade JSON logs (click any trade to view)
- 📁 Daily audit log in `logs/YYYY-MM-DD.log`

## File Structure

```
survival-agent/
├── agent.js          # Core engine + HTTP server
├── public/
│   └── index.html    # Real-time dashboard
├── logs/
│   ├── YYYY-MM-DD.log        # Daily audit log
│   └── trade_*.json          # Per-trade logs
└── package.json
```

## API

| Endpoint | Description |
|----------|-------------|
| `GET /` | Dashboard |
| `GET /stream` | SSE event stream |
| `GET /api/state` | Current state JSON |
| `GET /api/log/<id>.json` | Individual trade log |

## OpenClaw Skill

Install as an OpenClaw skill by placing in `~/.openclaw/workspace/skills/survival-agent/`.
Then ask OpenClaw: *"启动 survival agent"*

---

Built with zero dependencies. Pure Node.js.
