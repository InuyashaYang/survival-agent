/**
 * strategies/github-bounty.js — GitHub 悬赏猎人（全真实版）
 *
 * 唯一"假"的：余额是虚拟货币，不是真实银行账户
 * 其他全真：
 *   1. 真实 GitHub 悬赏 issue（Search API）
 *   2. 真实 AI 分析 issue 内容（Anthropic Claude Haiku）
 *   3. 真实 fork + clone + 代码修改（gh CLI + git）
 *   4. 真实 PR 提交（gh pr create）
 *   5. 真实 PR 状态监控（GitHub API 轮询 merge 状态）
 *
 * ENV:
 *   GH_TOKEN         — GitHub 访问令牌（已通过 gh auth 配置）
 *   AI_API_KEY       — Anthropic 代理 API Key（默认读内置值）
 *   AI_BASE_URL      — Anthropic 代理 URL（默认内置）
 *   BOUNTY_TEMP_DIR  — 临时工作目录（默认 /tmp/survival-bounties）
 */

const https = require('https');
const http  = require('http');
const { execSync, exec: execAsync } = require('child_process');
const fs   = require('fs');
const path = require('path');

// ─── CONFIG ────────────────────────────────────────────────────────────────────
const CFG = {
  AI_BASE:    process.env.AI_BASE_URL   || 'http://152.53.52.170:3003',
  AI_KEY:     process.env.AI_API_KEY    || 'sk-kVuOcCKOYEiXyL0qF8De8d1293314b598f7e360197CaD408',
  AI_FAST:    'claude-haiku-4-5-20251001',   // 分析 issue 用（便宜快）
  AI_SMART:   'claude-sonnet-4-6',           // 写代码用（聪明）
  TEMP_DIR:   process.env.BOUNTY_TEMP_DIR || '/tmp/survival-bounties',
  MIN_CONFIDENCE: 0.55,    // 置信度低于此不尝试
  MAX_ACTIVE: 2,           // 最多同时进行中的 PR
  PR_TIMEOUT_MS: 5 * 60 * 1000,  // 5分钟无反应视为超时
  // Telegram 通知（PR merge 时发送）
  TG_BOT_TOKEN: process.env.TG_BOT_TOKEN || '8642375853:AAFi55AcgCz-NaWc_uDbFgu8zQH9vopDMlQ',
  TG_CHAT_ID:   process.env.TG_CHAT_ID   || '8323001155',
};

// ─── STATE ─────────────────────────────────────────────────────────────────────
const state = {
  activePRs: new Map(),     // id → { issue, prUrl, repoPath, submittedAt, expectedReward }
  completedPRs: [],         // { ...issue, prUrl, state, pnl, settledAt }
  issueAnalysisCache: new Map(), // issueId → { canSolve, confidence, approach, taskType }
  scanBounties: [],         // 当前扫描到的悬赏列表（带 AI 分析结果）
};

// ─── GITHUB API ────────────────────────────────────────────────────────────────
function ghGet(path) {
  return new Promise((resolve, reject) => {
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
    const opts = {
      hostname: 'api.github.com', path,
      headers: {
        'User-Agent': 'SurvivalAgent/3',
        'Accept': 'application/vnd.github.v3+json',
        ...(token ? { Authorization: `token ${token}` } : {}),
      },
      timeout: 10000,
    };
    https.get(opts, res => {
      let b = ''; res.on('data', d => b += d);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch(e) { reject(e); } });
    }).on('error', reject).on('timeout', () => reject(new Error('github timeout')));
  });
}

// ─── AI API (Anthropic format) ────────────────────────────────────────────────
function callAI(model, prompt, systemPrompt, maxTokens = 1000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: prompt }],
    });
    const parsed = new URL(CFG.AI_BASE + '/v1/messages');
    const isHttp = parsed.protocol === 'http:';
    const lib = isHttp ? http : https;
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttp ? 80 : 443),
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'x-api-key': CFG.AI_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 60000,
    };
    const req = lib.request(opts, res => {
      let b = ''; res.on('data', d => b += d);
      res.on('end', () => {
        try {
          const d = JSON.parse(b);
          if (d.error) return reject(new Error(d.error.message || JSON.stringify(d.error)));
          const text = d.content?.[0]?.text || '';
          resolve(text);
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject).on('timeout', () => { req.destroy(); reject(new Error('AI timeout')); });
    req.write(body); req.end();
  });
}

// ─── EXTRACT REWARD ───────────────────────────────────────────────────────────
function extractReward(title, body) {
  const text = title + ' ' + (body || '').slice(0, 800);
  const usd  = text.match(/\$\s?([\d,]+)/);     if (usd)  return parseFloat(usd[1].replace(',',''));
  const usdt = text.match(/([\d,]+)\s*USDT/i);  if (usdt) return parseFloat(usdt[1].replace(',',''));
  const usdc = text.match(/([\d,]+)\s*USDC/i);  if (usdc) return parseFloat(usdc[1].replace(',',''));
  const rtc  = text.match(/([\d,]+)\s*RTC/i);   if (rtc)  return parseFloat(rtc[1]) * 0.05;
  const eth  = text.match(/([\d.]+)\s*ETH/i);   if (eth)  return parseFloat(eth[1]) * 2000;
  return 0;
}

// ─── SCAN ─────────────────────────────────────────────────────────────────────
async function scan() {
  // 三类搜索：文档类（最容易）、good-first + bounty、普通 bounty
  const queries = [
    '/search/issues?q=label:bounty+label:documentation+state:open+is:issue&sort=updated&per_page=10',
    '/search/issues?q=label:bounty+"good+first+issue"+state:open+is:issue&sort=updated&per_page=10',
    '/search/issues?q=label:bounty+state:open+is:issue&sort=updated&per_page=15',
  ];

  const issueMap = new Map();
  for (const q of queries) {
    try {
      const r = await ghGet(q);
      (r.items || []).forEach(i => issueMap.set(i.id, i));
    } catch(e) { /* ignore */ }
  }

  // 过滤有奖励的
  const candidates = [];
  for (const issue of issueMap.values()) {
    const reward = extractReward(issue.title, issue.body);
    if (reward < 1) continue;
    candidates.push({ issue, reward });
  }
  candidates.sort((a, b) => b.reward - a.reward);

  state.scanBounties = candidates.slice(0, 12).map(({ issue, reward }) => ({
    id: `gh_${issue.id}`,
    issueId: issue.id,
    issueNumber: issue.number,
    title: issue.title.slice(0, 80),
    body: (issue.body || '').slice(0, 2000),
    repo: issue.html_url.split('/').slice(3, 5).join('/'),
    repoOwner: issue.html_url.split('/')[3],
    repoName: issue.html_url.split('/')[4],
    url: issue.html_url,
    labels: (issue.labels || []).map(l => l.name),
    comments: issue.comments,
    reward,
    analysis: state.issueAnalysisCache.get(issue.id) || null,
  }));

  // 异步 AI 分析（不阻塞 scan 返回）
  analyzeNewIssues(state.scanBounties);

  return state.scanBounties;
}

// ─── AI ANALYSIS ───────────────────────────────────────────────────────────────
async function analyzeNewIssues(bounties) {
  for (const b of bounties) {
    if (state.issueAnalysisCache.has(b.issueId)) continue;
    if (state.activePRs.size >= CFG.MAX_ACTIVE) break;

    try {
      const analysis = await analyzeIssue(b);
      state.issueAnalysisCache.set(b.issueId, analysis);
      b.analysis = analysis;
    } catch(e) {
      // silently skip
    }
    await sleep(500); // 避免 API burst
  }
}

async function analyzeIssue(bounty) {
  const system = `You are an AI software engineer evaluating GitHub issues for potential resolution.
Analyze the issue and respond ONLY with valid JSON in this exact format:
{
  "canSolve": true/false,
  "confidence": 0.0-1.0,
  "taskType": "documentation|bug|test|feature|configuration|other",
  "techStack": ["language/framework"],
  "approach": "1-2 sentence approach description",
  "estimatedMinutes": 15,
  "reason": "why you can or cannot solve this"
}

Be honest. Set canSolve=false for:
- Complex architectural changes
- Issues requiring proprietary access or credentials  
- Security vulnerabilities (responsible disclosure needed)
- Very vague requirements
- Issues that already have an open PR

Set canSolve=true for:
- Documentation fixes, typo corrections, missing docs
- Clear, small bug fixes with reproduction steps
- Adding tests for documented behavior
- Configuration/setup improvements
- Simple feature additions with clear specs`;

  const prompt = `Repository: ${bounty.repo}
Issue #${bounty.issueNumber}: ${bounty.title}
Labels: ${bounty.labels.join(', ')}
Reward: $${bounty.reward}
Comments: ${bounty.comments}

Issue body:
${bounty.body || '(no body)'}

Can you solve this? Analyze carefully.`;

  const raw = await callAI(CFG.AI_FAST, prompt, system, 600);

  // JSON 解析
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in AI response');
  return JSON.parse(jsonMatch[0]);
}

// ─── CLAIM BOUNTY (real fork + code + PR) ─────────────────────────────────────
async function claimBounty(bounty, onSettle) {
  if (state.activePRs.has(bounty.id)) return null;
  if (state.activePRs.size >= CFG.MAX_ACTIVE) return null;

  const analysis = bounty.analysis || state.issueAnalysisCache.get(bounty.issueId);
  if (!analysis) return null; // 还没分析完
  if (!analysis.canSolve || analysis.confidence < CFG.MIN_CONFIDENCE) return null;

  // 标记为进行中（避免重复接单）
  state.activePRs.set(bounty.id, { bounty, status: 'starting', startedAt: Date.now() });

  // 异步执行（不阻塞主循环）
  _runBountyAttempt(bounty, analysis, onSettle).catch(e => {
    console.error(`[BOUNTY] Attempt failed for ${bounty.title}: ${e.message}`);
    state.activePRs.delete(bounty.id);
  });

  return { id: bounty.id, status: 'started', analysis };
}

async function _runBountyAttempt(bounty, analysis, onSettle) {
  const workDir = path.join(CFG.TEMP_DIR, `${bounty.id}_${Date.now()}`);

  try {
    // 1. Fork repo
    updatePRState(bounty.id, 'forking');
    execSync(`gh repo fork ${bounty.repo} --clone=false 2>&1`, { timeout: 30000 });

    // 2. Clone fork
    updatePRState(bounty.id, 'cloning');
    fs.mkdirSync(workDir, { recursive: true });
    const forkRepo = `https://github.com/InuyashaYang/${bounty.repoName}.git`;
    execSync(`git clone --depth=1 ${forkRepo} ${workDir} 2>&1`, { timeout: 60000 });

    // 3. Create branch
    const branchName = `survival-agent/fix-${bounty.issueNumber}`;
    execSync(`git -C ${workDir} checkout -b ${branchName}`, { timeout: 10000 });

    // 4. Read repo context
    updatePRState(bounty.id, 'reading');
    const repoContext = readRepoContext(workDir, analysis.taskType);

    // 5. AI 写代码
    updatePRState(bounty.id, 'coding');
    const { changes, commitMessage } = await generateFix(bounty, analysis, repoContext);

    // 6. Apply changes
    if (!changes || changes.length === 0) {
      throw new Error('AI generated no changes');
    }
    applyChanges(workDir, changes);

    // 7. Commit
    execSync(`git -C ${workDir} add -A`, { timeout: 10000 });
    execSync(`git -C ${workDir} -c user.email="survival@agent.ai" -c user.name="Survival Agent" commit -m "${commitMessage.replace(/"/g, "'")}"`, { timeout: 10000 });

    // 8. Push
    updatePRState(bounty.id, 'pushing');
    execSync(`git -C ${workDir} push origin ${branchName} 2>&1`, { timeout: 30000 });

    // 9. Create PR
    updatePRState(bounty.id, 'pr-creating');
    const prTitle = `[Survival Agent] Fix #${bounty.issueNumber}: ${bounty.title.slice(0, 50)}`;
    const prBody = `Automated fix for #${bounty.issueNumber} by [Survival Agent](https://github.com/InuyashaYang/survival-agent).

**Issue**: ${bounty.title}
**Approach**: ${analysis.approach}
**Confidence**: ${(analysis.confidence * 100).toFixed(0)}%

---
*This PR was generated autonomously as part of a GitHub bounty hunting demo.*`;

    const prOutput = execSync(
      `gh pr create --repo ${bounty.repo} --head "InuyashaYang:${branchName}" --title "${prTitle.replace(/"/g, "'")}" --body "${prBody.replace(/"/g, "'")}" 2>&1`,
      { timeout: 30000 }
    ).toString().trim();

    const prUrl = prOutput.split('\n').find(l => l.startsWith('https://')) || prOutput;

    state.activePRs.set(bounty.id, {
      bounty, status: 'pr-open', prUrl,
      repoPath: workDir, submittedAt: Date.now(),
      expectedReward: bounty.reward,
      analysis, onSettle, branchName,
    });

    console.log(`[BOUNTY] ✅ PR created: ${prUrl}`);

  } catch(e) {
    // Clean up on failure
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch(_) {}
    state.activePRs.delete(bounty.id);
    const result = { ...bounty, pnl: 0, won: false, error: e.message, prUrl: null };
    if (onSettle) onSettle(result);
    throw e;
  }
}

// ─── READ REPO CONTEXT ─────────────────────────────────────────────────────────
function readRepoContext(workDir, taskType) {
  const files = [];

  // README
  for (const name of ['README.md', 'readme.md', 'README.rst']) {
    const f = path.join(workDir, name);
    if (fs.existsSync(f)) { files.push({ path: name, content: fs.readFileSync(f, 'utf8').slice(0, 2000) }); break; }
  }

  // 根据 taskType 读不同文件
  if (taskType === 'documentation') {
    // 找所有 .md 文件
    const mds = findFiles(workDir, '.md', 8);
    mds.forEach(f => files.push({ path: f.rel, content: f.content.slice(0, 1500) }));
  } else {
    // 读主要代码文件
    const codeFiles = findFiles(workDir, null, 10, ['.js', '.py', '.ts', '.go', '.rs', '.java', '.cpp', '.c']);
    codeFiles.forEach(f => files.push({ path: f.rel, content: f.content.slice(0, 2000) }));
  }

  return files.slice(0, 8); // 最多8个文件
}

function findFiles(dir, ext, limit, exts) {
  const results = [];
  function walk(d, rel) {
    if (results.length >= limit) return;
    if (d.includes('node_modules') || d.includes('.git') || d.includes('vendor')) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch(_) { return; }
    for (const e of entries) {
      if (results.length >= limit) return;
      const full = path.join(d, e.name);
      const relPath = path.join(rel, e.name);
      if (e.isDirectory()) { walk(full, relPath); }
      else if (e.isFile()) {
        const ok = ext ? e.name.endsWith(ext) : (exts ? exts.some(x => e.name.endsWith(x)) : true);
        if (ok) {
          try {
            results.push({ rel: relPath, content: fs.readFileSync(full, 'utf8') });
          } catch(_) {}
        }
      }
    }
  }
  walk(dir, '');
  return results;
}

// ─── AI CODE GENERATION ───────────────────────────────────────────────────────
async function generateFix(bounty, analysis, repoContext) {
  const filesText = repoContext.map(f => `=== ${f.path} ===\n${f.content}`).join('\n\n');

  const system = `You are an AI software engineer making precise code fixes for GitHub issues.
Output ONLY valid JSON in this format:
{
  "commitMessage": "fix: brief description (closes #N)",
  "changes": [
    {
      "action": "modify|create|delete",
      "filePath": "relative/path/to/file",
      "content": "complete new file content (for modify/create)",
      "reason": "why this change"
    }
  ]
}

Rules:
- Make minimal, targeted changes
- For documentation: fix typos, add missing sections, improve clarity
- For bugs: find the root cause and fix it properly
- Prefer modifying existing files over creating new ones
- Ensure changes are syntactically correct
- commitMessage must follow conventional commits format`;

  const prompt = `Fix this GitHub issue:

Repository: ${bounty.repo}
Issue #${bounty.issueNumber}: ${bounty.title}
Task type: ${analysis.taskType}
Approach: ${analysis.approach}

Issue body:
${bounty.body}

Repository files:
${filesText}

Generate the minimal fix. Output JSON only.`;

  const raw = await callAI(CFG.AI_SMART, prompt, system, 4000);
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in code generation response');
  return JSON.parse(jsonMatch[0]);
}

// ─── APPLY CHANGES ────────────────────────────────────────────────────────────
function applyChanges(workDir, changes) {
  for (const change of changes) {
    const filePath = path.join(workDir, change.filePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (change.action === 'delete') {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } else {
      fs.writeFileSync(filePath, change.content || '');
    }
  }
}

// ─── CHECK PR STATUS ──────────────────────────────────────────────────────────
async function checkPRStatus() {
  const settled = [];

  for (const [id, entry] of state.activePRs.entries()) {
    if (entry.status !== 'pr-open') continue;

    try {
      const prInfo = JSON.parse(
        execSync(`gh pr view "${entry.prUrl}" --json state,merged,mergedAt,closedAt 2>/dev/null`, { timeout: 15000 }).toString()
      );

      if (prInfo.merged) {
        // 合并了！发 Telegram 通知 + 结算
        const pnl = entry.expectedReward;
        const result = { ...entry.bounty, prUrl: entry.prUrl, pnl, won: true, mergedAt: prInfo.mergedAt };
        state.activePRs.delete(id);
        state.completedPRs.unshift(result);
        settled.push(result);
        // 先通知，再结算
        notifyMerge(entry.bounty, entry.prUrl, pnl).catch(() => {});
        if (entry.onSettle) entry.onSettle(result);
        cleanup(entry.repoPath);

      } else if (prInfo.state === 'CLOSED') {
        // 被关了（未合并）
        const result = { ...entry.bounty, prUrl: entry.prUrl, pnl: 0, won: false, closedAt: prInfo.closedAt };
        state.activePRs.delete(id);
        state.completedPRs.unshift(result);
        settled.push(result);
        if (entry.onSettle) entry.onSettle(result);
        cleanup(entry.repoPath);

      } else if (Date.now() - entry.submittedAt > CFG.PR_TIMEOUT_MS) {
        // 超时仍 open — 保持挂单状态，不结算（等 maintainer 审查）
      }
    } catch(e) { /* gh pr view 失败，忽略 */ }
  }

  return settled;
}

// ─── TELEGRAM MERGE NOTIFICATION ─────────────────────────────────────────────
// PR merged → 通知用户去 IssueHunt 手动领钱
function notifyMerge(bounty, prUrl, rewardUsd) {
  const claimUrl = `https://issuehunt.io/r/${bounty.repo}/issues/${bounty.issueNumber}`;
  const cnyAmount = (rewardUsd * 7.25).toFixed(0);

  const text = [
    `🎉 *PR Merged！Survival Agent 赚到钱了*`,
    ``,
    `📌 *${escTg(bounty.title)}*`,
    `🏦 奖励：$${rewardUsd} USD（约 ¥${cnyAmount}）`,
    ``,
    `🔗 [查看 PR](${prUrl})`,
    `💰 [去 IssueHunt 领取](${claimUrl})`,
    ``,
    `_点击领取链接 → 登录 IssueHunt → Claim Bounty_`,
  ].join('\n');

  return tgSend(text, 'Markdown');
}

function escTg(s) {
  return (s || '').replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
}

function tgSend(text, parseMode) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      chat_id: CFG.TG_CHAT_ID,
      text,
      parse_mode: parseMode || 'Markdown',
      disable_web_page_preview: false,
    });
    const opts = {
      hostname: 'api.telegram.org',
      path: `/bot${CFG.TG_BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 10000,
    };
    const req = https.request(opts, res => {
      let b = ''; res.on('data', d => b += d);
      res.on('end', () => resolve(JSON.parse(b)));
    });
    req.on('error', reject).on('timeout', () => { req.destroy(); reject(new Error('tg timeout')); });
    req.write(body); req.end();
  });
}

function cleanup(dir) {
  try { if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); } catch(_) {}
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function updatePRState(id, status) {
  const entry = state.activePRs.get(id);
  if (entry) entry.status = status;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getPending() {
  return Array.from(state.activePRs.values()).map(e => ({
    id: e.bounty.id,
    title: e.bounty.title,
    repo: e.bounty.repo,
    url: e.bounty.url,
    prUrl: e.prUrl,
    reward: e.bounty.reward,
    status: e.status,
    startedAt: e.startedAt,
    analysis: e.analysis,
  }));
}

function getCompleted() { return state.completedPRs.slice(0, 20); }
function getScanBounties() { return state.scanBounties; }

module.exports = { scan, claimBounty, checkPRStatus, getPending, getCompleted, getScanBounties };
