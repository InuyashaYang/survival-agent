/**
 * strategies/github-bounty.js — GitHub 悬赏猎人
 *
 * 真实数据：GitHub Search API（public，无需 key）
 * 逻辑：
 *   1. 每轮扫描搜索带有 bounty 标签 / $ 金额的 open issues
 *   2. 基于 label/语言/已有 PR 数量评估难度得分
 *   3. 对于可接单的 issue，"提交解决方案"（模拟），N 分钟后按概率结算赏金
 */

const https = require('https');

const SKILL_TAGS = ['javascript','typescript','python','nodejs','react','bug','documentation','good first issue'];
const PENDING = new Map(); // orderId → { reward, resolve_at, issue }

function gh(path) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.github.com',
      path,
      headers: {
        'User-Agent': 'SurvivalAgent/2',
        'Accept': 'application/vnd.github.v3+json',
        ...(process.env.GITHUB_TOKEN ? { Authorization: `token ${process.env.GITHUB_TOKEN}` } : {}),
      },
      timeout: 8000,
    };
    https.get(opts, res => {
      let b = '';
      res.on('data', d => b += d);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch(e) { reject(e); } });
    }).on('error', reject).on('timeout', () => reject(new Error('timeout')));
  });
}

// 从标题 + body 里提取金额（USD/USDT/ETH 等）
function extractReward(title, body) {
  const text = title + ' ' + (body || '').slice(0, 500);
  // 美元
  const usd = text.match(/\$\s?([\d,]+)/);
  if (usd) return parseFloat(usd[1].replace(',', ''));
  // USDT / USDC
  const usdt = text.match(/([\d,]+)\s*(?:USDT|USDC)/i);
  if (usdt) return parseFloat(usdt[1].replace(',', ''));
  // RTC / 其他代币（按0.1 USD折算示意）
  const rtc = text.match(/([\d,]+)\s*RTC/i);
  if (rtc) return parseFloat(rtc[1]) * 0.1;
  // ETH
  const eth = text.match(/([\d.]+)\s*ETH/i);
  if (eth) return parseFloat(eth[1]) * 2000;
  return 0;
}

// 评估难度 → 成功率 0.0-1.0
function assessDifficulty(issue) {
  let score = 0.4; // base
  const labels = (issue.labels || []).map(l => l.name.toLowerCase());
  if (labels.some(l => ['good first issue','easy','beginner'].includes(l))) score += 0.25;
  if (labels.some(l => ['hard','complex','difficult'].includes(l))) score -= 0.2;
  if (labels.some(l => SKILL_TAGS.includes(l))) score += 0.15;
  if (labels.includes('documentation')) score += 0.2;
  if (labels.includes('bug')) score += 0.05;
  if (issue.comments > 10) score -= 0.1; // 已有很多讨论，竞争大
  if (issue.comments === 0) score += 0.1; // 没人发现，机会好
  return Math.max(0.1, Math.min(0.85, score));
}

// 搜索当前可接的悬赏
async function scan() {
  // 两种搜索：有明确 label:bounty 的 + 标题含 $ 的
  const [r1, r2] = await Promise.allSettled([
    gh('/search/issues?q=label:bounty+state:open+is:issue&sort=updated&per_page=15'),
    gh('/search/issues?q=%22%5BBounty%5D%22+state:open+is:issue&sort=created&per_page=15'),
  ]);

  const issues = new Map();
  for (const r of [r1, r2]) {
    if (r.status === 'fulfilled' && r.value.items) {
      r.value.items.forEach(i => issues.set(i.id, i));
    }
  }

  const opportunities = [];
  for (const issue of issues.values()) {
    const reward = extractReward(issue.title, issue.body);
    if (reward < 1) continue; // 过滤掉没有明确奖励的
    const successRate = assessDifficulty(issue);
    opportunities.push({
      id: `gh_${issue.id}`,
      title: issue.title.slice(0, 60),
      repo: issue.html_url.split('/').slice(3, 5).join('/'),
      url: issue.html_url,
      reward,           // USD 等值
      successRate,
      labels: (issue.labels || []).map(l => l.name).slice(0, 3),
      comments: issue.comments,
    });
  }

  // 按预期价值排序 (reward × successRate)
  opportunities.sort((a, b) => (b.reward * b.successRate) - (a.reward * a.successRate));
  return opportunities.slice(0, 10);
}

// 接单并异步结算
function claimBounty(opp, onSettle) {
  if (PENDING.has(opp.id)) return null; // 已在进行中

  const resolveMins = 1 + Math.random() * 3; // 1-4 分钟"完成"
  const resolve_at = Date.now() + resolveMins * 60 * 1000;
  PENDING.set(opp.id, { opp, resolve_at, onSettle });

  return {
    id: opp.id,
    expectedReward: opp.reward,
    successRate: opp.successRate,
    resolve_at,
    status: 'working',
  };
}

// 检查待结算的单
function checkSettlements() {
  const settled = [];
  const now = Date.now();
  for (const [id, entry] of PENDING.entries()) {
    if (now >= entry.resolve_at) {
      const won = Math.random() < entry.opp.successRate;
      const pnl = won ? entry.opp.reward : -2; // 失败损耗：-2（机会成本）
      PENDING.delete(id);
      settled.push({ ...entry.opp, won, pnl });
      if (entry.onSettle) entry.onSettle({ ...entry.opp, won, pnl });
    }
  }
  return settled;
}

function getPending() {
  return Array.from(PENDING.values()).map(e => ({
    ...e.opp,
    resolve_at: e.resolve_at,
    status: 'working',
  }));
}

module.exports = { scan, claimBounty, checkSettlements, getPending };
