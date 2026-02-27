# 🤖 Survival Agent v2

> 不赚钱就会死的 AI Agent — 接入真实市场数据，支持多交易所实盘接口

## 运行

```bash
git clone https://github.com/InuyashaYang/survival-agent
cd survival-agent
node agent.js       # 默认 paper 模式，打开 http://localhost:7788
```

零依赖，纯 Node.js 标准库。

---

## 数据源

| 品种 | 来源 | API Key | 说明 |
|------|------|---------|------|
| BTC/ETH/SOL | OKX Public API | 不需要 | 国内可访问，实时行情 |
| 上证/茅台/宁德 | 新浪财经 | 不需要 | A股实时，收盘后冻结 |

---

## Broker 切换（真实下单）

通过 `BROKER` 环境变量选择交易接口：

### 默认：纸面交易（推荐测试用）
```bash
BROKER=paper node agent.js
```

### OKX 现货实盘
```bash
OKX_API_KEY=xxx OKX_SECRET_KEY=xxx OKX_PASSPHRASE=xxx \
DRY_RUN=false BROKER=okx node agent.js
```
申请：https://www.okx.com → API 管理

### OKX 模拟盘（有真实 API 的安全测试）
```bash
OKX_API_KEY=xxx OKX_SECRET_KEY=xxx OKX_PASSPHRASE=xxx \
BROKER=okx-demo DRY_RUN=false node agent.js
```

### Gate.io 现货实盘
```bash
GATEIO_API_KEY=xxx GATEIO_SECRET=xxx \
DRY_RUN=false BROKER=gateio node agent.js
```
申请：https://www.gate.io → 账户 → API 管理

### HTX 火币现货
```bash
HTX_API_KEY=xxx HTX_SECRET=xxx HTX_ACCOUNT_ID=xxx \
DRY_RUN=false BROKER=htx node agent.js
```
`HTX_ACCOUNT_ID`：调用 `GET /v1/account/accounts` 获取现货账户 ID

### Hyperliquid 永续合约（链上，需 ethers.js）
```bash
npm install ethers
HL_PRIVATE_KEY=0x... HL_WALLET=0x... \
DRY_RUN=false BROKER=hyperliquid node agent.js
```
无需 API Key，用以太坊私钥签名。无法访问时加 `HL_TESTNET=true`

---

## 环境变量速查

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DRY_RUN` | `true` | false = 真实下单 |
| `BROKER` | `paper` | 交易所选择 |
| `DEBUG_LEVEL` | `2` | 0=静默 / 2=标准 / 3=含原始数据 / 4=全追踪 |
| `BALANCE` | `10000` | 初始余额（CNY）|
| `PORT` | `7788` | Dashboard 端口 |

---

## 策略说明

**动量 + 双均线策略**
- 每 8s 获取一次行情，计算 3 期动量
- 动量 > 0.4% 且 MA5 > MA10 → BUY
- 动量 < -0.4% 且 MA5 < MA10 → SELL
- 止损 2% / 止盈 4% / 持仓超 30min 强制平仓

**8 个 Debug 断点（控制台 + Dashboard 可见）：**
- BP0 SCAN：每轮扫描状态
- BP1 FETCH：原始行情数据
- BP2-3 SIGNAL：动量+均线计算过程
- BP4 EXEC：仓位大小计算
- BP5 PAPER/REAL：开仓指令
- BP6 EXEC：SL/TP/时间止损检查
- BP7 PAPER/REAL：平仓 + PnL

---

## 添加新 Broker

实现 `brokers/mybroker.js`，导出以下接口：

```js
module.exports = {
  name: 'My Broker',
  TYPE: 'live',          // 'paper' | 'live'
  async fetchTicker(symbol) { return { symbol, price, bid, ask, volume, source }; },
  async placeOrder({ symbol, side, qty, price }) { return { orderId, status }; },
  async cancelOrder(orderId, symbol) { return { ok: true }; },
  async getBalance() { return 0; },  // 返回 USDT/CNY 可用余额
};
```

然后 `BROKER=mybroker node agent.js`

---

## 国内可访问的交易所 API（已验证）

| 交易所 | HTTP状态 | 备注 |
|--------|----------|------|
| OKX | ✅ 200 | 行情+交易，推荐首选 |
| Gate.io | ✅ 200 | 现货交易 |
| MEXC | ✅ 200 | 行情可用 |
| HTX 火币 | ✅ 200 | 现货交易 |
| Hyperliquid | ✅ 200 | 永续，链上，需私钥 |
| Bybit | ❌ 403 | 国内被封 |
| Binance | ❌ 封锁 | 国内无法访问 |
