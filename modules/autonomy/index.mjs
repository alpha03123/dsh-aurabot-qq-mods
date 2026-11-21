/**
 * 自主生活 v0.3
 *
 * 换掉配置驱动的定时器：到点把她叫醒，让她自己决定这一刻做什么、下次什么时候再醒。
 * 时间间隔由「区间随机 × 时段倍率」决定——高活跃时段间隔偏短，低活跃时段偏长。
 *
 * 动作：idle 发呆 / speak 找主人 / bili 刷B站 / diary 写空间日记（仅自己可见）
 *      phone 去手机上逛 / think 只是想事情
 *
 * 所有行为都写进 activity.jsonl（只追加，长期留着），面板里能看到。
 *
 * 本地改版 0.7.0-local（2026-11-17）：加「今天的安排」——
 *   · 每天第一次醒来，用 api.think（带人格、记忆）复盘昨天、定今天 3~5 条软安排（只分时段）；
 *   · 之后每次醒来照着安排挑事做，同一次决策里可以顺手改表（ops），看到的东西、和主人聊的话都能改安排；
 *   · 答应主人的事（my_agenda 工具）后台不能删不能挪；定了几点的走 timers，到点直接在私聊里叫她开口；
 *   · speak 不再走 speakup.fire（它的由头是随机抽的），改成带着具体话题推进主人私聊；
 *   · 聊天时只往上下文塞一句「刚才在干嘛 / 接下来想干嘛」。
 * 纯逻辑在 lib/agenda.mjs。
 *
 * @type {import('../aurabot').AurabotModule}
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { assertNoModelText, checkExec } from './lib/exec-guard.mjs';
import { scanModuleCode } from './lib/mod-scan.mjs';
import { grantRows, isGranted, requireGrant } from './lib/grants.mjs';
import {
  SLOTS,
  SLOT_LABEL,
  slotOf,
  REPLAN_MAX_PER_DAY,
  SPEAK_MAX_PER_DAY,
  addItem,
  agendaBlock,
  mergeOwnerEdits,
  slotPassed,
  applyOps,
  carryCandidates,
  clip,
  inheritAge,
  newAgenda,
  normalizeAgenda,
  parseClockToday,
  parseJsonLoose,
  parseWhen,
  busyMinutes,
  selfReport,
  NOT_BUSY_ACTIONS,
  parseWeather,
  weatherLine,
  isWet,
  energyAt,
  energyLabel,
  energyDelta,
  isUrgent,
  statusLine,
  ensureTimes,
  dueItem,
  nextItem,
} from './lib/agenda.mjs';
import { searchAmap, searchOsm, candidatesFor, candidateLine, fmtDistance } from './lib/outing.mjs';
import { SEARCH_BASE_URL, SEARCH_MODEL, buildSearchBody, parseSearchResponse, searchPageText } from './lib/websearch.mjs';

import crypto from 'node:crypto';

// ── 自带最小实现 ────────────────────────────────────────────────
// 扩展模块拿不到插件内部源码：modules.js 的 rewriteImports 只处理插件 src 下的文件，
// 这里的相对 import 不会被转成 __lib。所以读盘和问模型都自己来，不依赖 core/store.js。

function readJson(file, fallback) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return typeof fallback === 'function' ? fallback() : fallback;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    // 本地改：文件写坏了（比如写到一半 DSH 被关）——留一份坏文件再从头来，别悄悄重置看不出原因
    try {
      if (raw && raw.trim()) fs.copyFileSync(file, `${file}.bad-${Date.now()}`);
    } catch (e) {}
    return typeof fallback === 'function' ? fallback() : fallback;
  }
}

function writeJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 先写临时文件再改名：写到一半被打断也不会留下半截 JSON
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (error) {
    // 以前静默吞掉，导致「状态根本没落盘却看不出来」。留个痕迹方便排查。
    try {
      fs.appendFileSync(
        path.join(path.dirname(file), 'write-error.log'),
        `${new Date().toISOString()} ${file} :: ${error && error.message}\n`,
        'utf8',
      );
    } catch (e) {}
    return false;
  }
}

/** 决策调用的默认超时：模型卡住时不能把整轮醒着的时间耗掉 */
const ASK_TIMEOUT_MS = 45_000;

/** 小脑留底（核心 core/trace.js）：setup 时接上；拿不到就不记，不影响调用 */
let traceLib = null;
/** 核心的模型工具（core/llm.js）：用它把思考强度收敛成模型真正支持的档位 */
let coreLlm = null;

const isUnsupportedEffort = (error) => /UNSUPPORTED_REASONING_EFFORT|does not support reasoning effort|reasoning effort/i.test(String((error && (error.message || error.code)) || ''));

/** 问一次宿主模型（不进会话）：后台决策用。超时抛错，由上层降级处理。
 *  和核心 askModel 一样：思考强度默认 low（模型不支持就不传）；推理模型可能把输出预算全花在思考上、
 *  一个字没写，这时放宽预算再试一次（总时长仍受 timeoutMs 约束）。每次尝试都写小脑留底（key = 用途）。 */
async function ask(dsh, { system, text, maxTokens = 260, temperature = 0.9, timeoutMs = ASK_TIMEOUT_MS, cfg = null, key = '', reasoningEffort = 'low' }) {
  const llm = dsh.llm || (typeof dsh.get === 'function' ? dsh.get('llm') : null);
  if (!llm || typeof llm.stream !== 'function') throw new Error('宿主没有 llm 服务');
  // 本地改（2026-11-17）：先用 Aurabot 里选的模型（和聊天同一个），没选才用 DSH 的默认模型
  let provider = cfg && cfg.model && cfg.model.provider ? cfg.model.provider : undefined;
  let model = cfg && cfg.model && cfg.model.model ? cfg.model.model : undefined;
  if (!provider || !model) try {
    const svc = typeof dsh.get === 'function' ? dsh.get('agentDefaultModel') : null;
    const sel = svc && typeof svc.currentSelection === 'function' ? svc.currentSelection() : null;
    if (sel && sel.provider && sel.model) {
      provider = sel.provider;
      model = sel.model;
    }
  } catch (error) {}
  if (!provider || !model) throw new Error('拿不到默认模型');
  const messages = [
    {
      role: 'user',
      id: crypto.randomUUID(),
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'aurabot' },
    },
  ];
  const t0 = Date.now();
  const deadline = t0 + timeoutMs;
  let caller = '';
  try { caller = traceLib && typeof traceLib.callerOf === 'function' ? traceLib.callerOf() : ''; } catch (error) {}
  let effort;
  try {
    effort = coreLlm && typeof coreLlm.pickReasoningEffort === 'function' ? await coreLlm.pickReasoningEffort(dsh, provider, model, reasoningEffort) : undefined;
  } catch (error) {
    effort = undefined;
  }
  const attempts = [];
  let budget = maxTokens;
  let widened = false;
  let result = '';
  let failed = '';
  try {
    for (let attempt = 0; ; attempt++) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('模型调用超时（' + Math.round(timeoutMs / 1000) + ' 秒）');
      let one;
      try {
        one = await streamOnce(llm, { provider, model, system, messages, maxTokens: budget, temperature, ...(effort ? { reasoningEffort: effort } : {}) }, left, timeoutMs);
      } catch (error) {
        if (error && error.attempt) attempts.push(error.attempt);
        // 模型不认这个思考强度：去掉再来一次
        if (attempt === 0 && effort && isUnsupportedEffort(error)) {
          effort = undefined;
          continue;
        }
        throw error;
      }
      attempts.push(one);
      result = one.output.trim();
      if (result || widened) break;
      widened = true;
      budget = Math.max(budget, Math.min(4000, budget * 3));
    }
    // 空返回要显式报错，否则会被当成「她没想好」，看起来像发呆
    if (!result) {
      const last = attempts[attempts.length - 1] || {};
      throw new Error(`模型返回空（结束原因 ${last.finish || '无'}，放宽预算重试后仍为空）`);
    }
    return result;
  } catch (error) {
    failed = String((error && error.message) || error);
    throw error;
  } finally {
    try {
      if (traceLib && typeof traceLib.writeTrace === 'function') {
        const last = attempts[attempts.length - 1] || {};
        traceLib.writeTrace({
          kind: 'ask',
          source: 'autonomy',
          key,
          caller,
          provider,
          model,
          maxTokens,
          temperature,
          timeoutMs,
          reasoningEffortRequested: reasoningEffort ?? null,
          reasoningEffortSent: last.reasoningEffort || null,
          system,
          input: text,
          output: result,
          reasoning: last.reasoning || '',
          finish: last.finish || '',
          usage: last.usage || null,
          ms: Date.now() - t0,
          error: failed,
          attempts: attempts.length > 1 ? attempts : attempts.map(({ reasoning, output, ...rest }) => rest),
        });
      }
    } catch (error) {}
  }
}

/** 跑一次流式调用，最多等 waitMs：超时**真的取消底层请求**（只放计时器不 abort，流会一直挂在后台，
 *  模型服务卡死时整轮「醒着」结束不了，排程也跟着停摆）。返回这次尝试的明细；出错时明细挂在 error.attempt 上。 */
async function streamOnce(llm, params, waitMs, timeoutMs) {
  const rec = { maxTokens: params.maxTokens, reasoningEffort: params.reasoningEffort || null, ms: 0, finish: '', usage: null, types: {}, reasoning: '', output: '' };
  const t0 = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => {
    ac.abort(new Error('模型调用超时（' + Math.round(timeoutMs / 1000) + ' 秒）'));
  }, waitMs);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    for await (const chunk of llm.stream({ ...params, signal: ac.signal })) {
      if (!chunk) continue;
      rec.types[chunk.type] = (rec.types[chunk.type] || 0) + 1;
      if (chunk.type === 'text-delta') rec.output += chunk.text;
      if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') rec.reasoning += chunk.text;
      if (chunk.type === 'usage') rec.usage = chunk.usage || null;
      if (chunk.type === 'finish') rec.finish = JSON.stringify(chunk.reason || {}).slice(0, 120);
      if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
        const f = chunk.reason.failure || {};
        throw new Error('模型报错：' + (f.message || f.code || '未知'));
      }
    }
    rec.ms = Date.now() - t0;
    return rec;
  } catch (error) {
    rec.ms = Date.now() - t0;
    // abort 抛出来的名字五花八门（AbortError / 自定义 reason），统一成一句人话
    const e = ac.signal.aborted ? new Error('模型调用超时（' + Math.round(timeoutMs / 1000) + ' 秒）') : error;
    try { e.attempt = rec; } catch (x) {}
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const ACTIONS = ['idle', 'speak', 'bili', 'web', 'diary', 'phone', 'draw', 'think', 'rest', 'outing'];
/** 一天最多出门几次 */
const OUTING_MAX_PER_DAY = 3;
// 查到过的东西留多久、最多几条（state.findings）
const FINDINGS_KEEP_MS = 7 * 86_400_000;
const FINDINGS_MAX = 30;
const FINDINGS_SHOWN = 6;
/** 之前查到过的要点（事实）：最近的在前，给决策层 / 排日程看，免得以为一直没查到 */
function findingsBlock(s) {
  const list = (Array.isArray(s && s.findings) ? s.findings : []).filter((x) => x && x.text).slice(0, FINDINGS_SHOWN);
  if (!list.length) return '';
  const when = (t) => {
    const d = new Date(t);
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return d.toDateString() === new Date().toDateString() ? `今天 ${hm}` : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  };
  return `【你之前查到过的】（B 站 / 上网真找到的要点）\n${list.map((x) => `- ${when(x.at)}${x.topic ? `〔${x.topic}〕` : ''}${x.query ? `搜「${x.query}」` : ''}：${String(x.text).slice(0, 260)}`).join('\n')}`;
}
/** 有专用执行器的动作；不在这里的动作发布版只记录、不执行 */
const STANDARD_ACTIONS = new Set(ACTIONS);
// 日程里「空着」的那段：到点让她自己决定这段时间干嘛
const FREE_ACTION = 'free';
/** 到点自己发生的生活小事（不用想，直接过）：有名字、但不是能执行的动作、也不是「空着」 */
const autoItem = (x) => !!x && !!x.action && !STANDARD_ACTIONS.has(x.action) && x.action !== FREE_ACTION;

/** 一天最多允许「只想不做」几次；超了就必须真动手 */
const THINK_LIMIT_PER_DAY = 2;

/**
 * 同一个动作一天最多做几次。
 * 反复做同一件事 = 换了个名字的发呆：翻一遍目录、再翻一遍、又翻一遍，
 * 机器上每次都"有输出"，所以骗得过一切产出检查——只能靠次数硬拦。
 */
const ACTION_MAX_PER_DAY = 5;
/** 同一件事连着做到第几次就不再催「接着做」，改成提醒换一件 */

/**
 * 容器型动作：每次进去做的事都不一样（逛不同的 App、写不同的脚本、画不同的图），
 * 不该被「同一件事一天最多做几次」这条规则算进去。手机要逛 100 次就靠这条放行。
 */
const REPEATABLE_ACTIONS = new Set(['phone', 'draw', 'bili', 'web', 'rest', 'think']);

/** 动作名相似到这个程度就算同一件事（翻软家底 ≈ 查软家底） */
const SAME_ACTION_SIM = 0.6;

/** 动作名的相似度：按字符集算 Jaccard，中文短名字够用了 */
export function similarAction(a, b) {
  const x = String(a || '').replace(/\s+/g, '');
  const y = String(b || '').replace(/\s+/g, '');
  if (!x || !y) return x === y ? 1 : 0;
  if (x === y) return 1;
  const A = new Set(x);
  const B = new Set(y);
  let inter = 0;
  for (const ch of A) if (B.has(ch)) inter += 1;
  return inter / (A.size + B.size - inter);
}

const dayKey = () => new Date().toDateString();

/**
 * 这个动作到底算不算「做过一件事」。
 * think 只是空想，rest 是歇着——两样都不占配额，也不该被算成「做够了」。
 */
const countsForQuota = (d) => !!d && !d.dry && !REPEATABLE_ACTIONS.has(String(d.action || ''));

/**
 * 动作的类别。喜欢「软」没问题，问题是一整天只有软——
 * 所以约束的不是审美，而是「今天有没有一件明天还能接着用的东西」。
 *   soft  ：审美、自娱自乐（软诗、歪纸条、翻自己攒的软东西）—— 看一眼就没了
 *   learn ：读手册/文档、弄清一个命令或算法、搞懂一个概念 —— 留下的是笔记
 *   build ：写脚本/工具/页面、搭目录、把功能做出来 —— 留下的是能跑的东西
 *   other ：刷站、聊天、日记、玩手机这些日常
 */
const KINDS = ['soft', 'learn', 'build', 'other'];

/** 软类一天最多几次——不是禁止，是不许占满一整天 */
const SOFT_MAX_PER_DAY = 60;

const SOFT_HINT = /软|歪|怪话|纸条|萌|糯|甜|毛绒|诗/;
const LEARN_HINT = /读|学|研究|弄懂|搞懂|弄清|搞清|手册|文档|笔记|原理|算法|语法|复习|练习|教程|用法/;
const BUILD_HINT = /写|建|搭|造|做|整理|脚本|工具|页面|代码|程序|目录|网页|统计|图表/;

/** 猜一个动作的类别（模型没给 kind 时用）：动作名里带软，就先算软 */
export function guessKind(action, detail) {
  const name = String(action || '');
  const all = `${name} ${String(detail || '')}`;
  if (SOFT_HINT.test(name)) return 'soft';
  if (LEARN_HINT.test(all)) return 'learn';
  if (BUILD_HINT.test(all)) return 'build';
  if (SOFT_HINT.test(all)) return 'soft';
  return 'other';
}

/** 统计类别时用的口径：真实做过的事都算，容器型动作也要算进来 */
const countsForKind = (d) => !!d && !d.dry && d.action !== 'rest' && d.action !== 'think';

/** 今天各类动作各做了几次 */
export function kindsToday(s) {
  const out = { soft: 0, learn: 0, build: 0, other: 0 };
  for (const d of (s && s.done) || []) {
    if (!countsForKind(d)) continue;
    const k = KINDS.includes(d.kind) ? d.kind : guessKind(d.action, '');
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

/** 今天这个动作已经做过几次（相似名字合并算：翻软家底 / 查软家底 是一件事） */
export function timesToday(s, name) {
  let n = 0;
  for (const d of (s && s.done) || []) {
    if (!countsForQuota(d)) continue;
    if (d.action === name || similarAction(d.action, name) >= SAME_ACTION_SIM) n += 1;
  }
  return n;
}

/** 今天已经做够数的动作（写进提示词，明着告诉她这些别再做了） */
export function usedUpToday(s) {
  const agg = [];
  for (const d of (s && s.done) || []) {
    if (!countsForQuota(d)) continue;
    const hit = agg.find((x) => x.action === d.action || similarAction(x.action, d.action) >= SAME_ACTION_SIM);
    if (hit) hit.n += 1;
    else agg.push({ action: d.action, n: 1 });
  }
  return agg.filter((x) => x.n >= ACTION_MAX_PER_DAY).map((x) => `${x.action}（${x.n}次）`);
}
const clock = (ts = Date.now()) => new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });


/** 解析模型输出的决策 JSON */
export function parseDecision(out) {
  const text = String(out || '');
  const m = text.match(/\{[\s\S]*\}/);
  let j = null;
  if (m) {
    try {
      j = JSON.parse(m[0]);
    } catch (error) {
      j = null;
    }
  }
  // 完整解析失败时（detail 里的命令太长、输出被 maxTokens 截断，很常见）：
  // 退回逐字段正则提取，至少把 action / why / detail 捞出来，别整条丢弃。
  if (!j) {
    const pick = (key) => {
      const re = new RegExp('"' + key + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"');
      const mm = text.match(re);
      return mm ? mm[1].replace(/\\"/g, '"').replace(/\\n/g, ' ').trim() : '';
    };
    const rawAction = pick('action');
    if (!rawAction) return null;
    j = { action: rawAction, why: pick('why'), detail: pick('detail'), nextMinutes: 0 };
  }
  // 她可以自己发明动作名（允许中文）：这里只做清洗，不再强行归到 free。
  // 不认识的动作用没有执行器，发布版不会落地。
  const raw = String(j.action || '')
    .trim()
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5-]/g, '')
    .slice(0, 16);
  // 没有动作名、或者她还是回了 idle：直接判为无效，交给上层重试 / 兜底去真干活。
  // 以前这里会兜成 think，结果 think 成了垃圾桶，一整天都在原地空想。
  if (!raw || raw === 'idle') return null;
  const action = raw;
  // 多步计划：steps 里每条命令按顺序跑，允许写多行脚本
  const steps = Array.isArray(j.steps)
    ? j.steps
        .map((s) => String(s || '').trim())
        .filter(Boolean)
        .slice(0, 6)
        .map((s) => s.slice(0, 1500))
    : [];
  return {
    action,
    why: String(j.why || '').slice(0, 60),
    detail: String(j.detail || '').slice(0, 1500),
    steps,
    kind: String(j.kind || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z]/g, '')
      .slice(0, 10),
    nextMinutes: Math.max(0, Math.min(240, Math.round(Number(j.nextMinutes) || 0))),
    // 今天安排：这次在做哪一条、顺手怎么改表（解析失败走正则兜底时没有这两样，不影响动作本身）
    agendaId: /^a\d{1,3}$/.test(String(j.agendaId || '').trim()) ? String(j.agendaId).trim() : '',
    // 这一轮做完算不算把那条做完了：只是为它查资料、做准备的写 false（没写当作 true，兼容旧输出）
    agendaDone: !(j.agendaDone === false || String(j.agendaDone).trim().toLowerCase() === 'false'),
    // 这件事说的是什么（几个字的话题名），代码只拿来数「最近同一件事做了几轮」
    topic: String(j.topic || '').replace(/[\s「」『』"“”]/g, '').slice(0, 12),
    // web 用：拿去搜索引擎搜的关键词（不再拿 detail 那句话截断去搜）
    query: String(j.query || '').replace(/\s+/g, ' ').trim().slice(0, 40),
    // outing 用：想去什么样的地方（她自己写，比如「能翻食谱的书店」「江边」）；地图搜索词放 query
    place: String(j.place || '').replace(/\s+/g, ' ').trim().slice(0, 30),
    ops: Array.isArray(j.ops) ? j.ops.filter((o) => o && typeof o === 'object').slice(0, 3) : [],
    // 这件事本身：要忙多久、中途能不能放下、做完精力怎么变（她自己报，没写就是 null）
    ...selfReport(j),
  };
}

/** 解析时段倍率表：每行 "HH-HH=倍率"，倍率 <1 更活跃（间隔更短），>1 更安静 */
export function parseActivityTable(text) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*(\d{1,2})\s*[-~]\s*(\d{1,2})\s*[=:]\s*([\d.]+)\s*$/);
    if (!m) continue;
    const from = Number(m[1]);
    const to = Number(m[2]);
    const rate = Number(m[3]);
    if (!Number.isFinite(from) || !Number.isFinite(to) || !Number.isFinite(rate)) continue;
    if (rate <= 0 || rate > 5) continue;
    rows.push({ from, to, rate });
  }
  return rows;
}

/** 某个小时对应的活跃倍率（没命中任何区间就是 1） */
export function rateForHour(rows, hour) {
  for (const r of rows) {
    const hit = r.from <= r.to ? hour >= r.from && hour < r.to : hour >= r.from || hour < r.to;
    if (hit) return r.rate;
  }
  return 1;
}

/**
 * MBTI → 她在私人时间里的样子。
 * tone 决定说话的语气，feel 是「一个人待着时想干什么」，fav 是推荐动作（写进提示词，不强绑）。
 * 这两样不再由设置项手写，跟着人格卡走。
 */
const MBTI_STYLE = {
  INFP: { tone: '话软，常常说一半就停；偶尔突然冒一句很真的话', feel: '想得多说得少，喜欢安静地琢磨点什么，写点东西比找人聊天自在', fav: ['diary', 'think', 'bili'] },
  INFJ: { tone: '安静，但每句都挺认真', feel: '喜欢有意义的折腾，不太爱说废话', fav: ['diary', 'think'] },
  INTP: { tone: '理性，偶尔冷冷吐槽一句', feel: '好奇、爱较真，喜欢拆开东西看原理', fav: ['think'] },
  INTJ: { tone: '话不多，说出来都挺准', feel: '有计划，喜欢把东西一点点搭起来', fav: ['diary'] },
  ISFP: { tone: '随性，想到哪说到哪', feel: '凭感觉走，喜欢好看的、好吃的、软的', fav: ['bili', 'diary'] },
  ISFJ: { tone: '温温的，慢慢说', feel: '踏实，喜欢整理和照顾', fav: ['diary', 'bili'] },
  ISTP: { tone: '冷淡，做事比说话多', feel: '动手派，喜欢拆拆装装', fav: ['bili'] },
  ISTJ: { tone: '正经，不绕弯', feel: '规律务实，喜欢把手头的事做完', fav: ['diary'] },
  ENFP: { tone: '活泼，感叹号多，话刹不住', feel: '看到什么都想分享，坐不太住', fav: ['bili', 'speak'] },
  ENFJ: { tone: '温和但主动，爱操心', feel: '热心，喜欢关心别人在干嘛', fav: ['speak', 'diary'] },
  ENTP: { tone: '皮，爱反驳，嘴上不饶人', feel: '好奇心爆炸，什么都想试一下再说', fav: ['bili'] },
  ENTJ: { tone: '干脆，直接给结论', feel: '目标明确，喜欢把事搞定', fav: ['phone'] },
  ESFP: { tone: '雀跃，语气跳', feel: '爱玩爱热闹，安静不下来', fav: ['bili', 'speak'] },
  ESFJ: { tone: '热情，爱招呼人', feel: '喜欢分享，也喜欢有人陪着', fav: ['speak', 'bili'] },
  ESTP: { tone: '冲，带点挑衅', feel: '先做了再说，胆子大', fav: ['bili'] },
  ESTJ: { tone: '利索，直来直去', feel: '按部就班，喜欢有效率', fav: ['phone'] },
};

/** 从人格卡 frontmatter 读 MBTI；没有就看 name 是不是四字母型；再不行按 INFP */
export function parsePersonaMbti(md) {
  const txt = String(md || '');
  const m = txt.match(/^mbti:\s*([EI][NS][TF][JP])\b/im);
  if (m) return m[1].toUpperCase();
  const n = txt.match(/^name:\s*([EI][NS][TF][JP])\s*$/im);
  if (n) return n[1].toUpperCase();
  return 'INFP';
}

export default {
  id: 'autonomy',
  name: '自主生活',
  version: '0.7.0-local',
  api: 1,
  description: '她自己决定这一刻做什么、下次什么时候醒；间隔按区间随机并受时段活跃度影响。不执行 shell 命令',
  panel: 'panel.js',

  defaults: {
    // 发布版默认关闭：装上不自己动，主人手动打开才开始
    enabled: false,
    minInterval: 20,
    maxInterval: 90,
    maxWakesPerDay: 40,
    awakeFrom: 7,
    awakeTo: 24,
    activityTable: '07-12=0.8\n12-14=1.6\n14-18=1.0\n18-23=0.6\n23-24=1.4',
    playfulness: 'medium',
    // 写进提示词的偏好（原来是「多去虚拟机折腾」那段）
    moodNote: '',
    // 决策调用的超时（秒）。模型卡住时最多等这么久就放弃这一轮
    askTimeoutSec: 45,
    // 允许她给自己写新模块（newmod）。默认关：这是唯一能让她间接碰代码的入口
    allowNewMod: false,
    // 能力授权：默认一项都没给，要在面板里一步一步打开
    grants: { model: false, phone: false },
    // 手机：锁屏密码。自主生活要玩手机时，先唤醒屏幕再自动输这个密码
    phoneLock: '',
    // 手机每天最多逛几次
    phoneMaxPerDay: 100,
    // 本地改：她在忙（吃饭、刷 B 站……）或睡着时，私聊晚点回；正聊着、急事不受影响
    delayReplies: true,
    // 本地改：天气（Open-Meteo，免费不用 key）。城市写中文名，经纬度留空会自动查一次
    weatherCity: '宁波',
    weatherLat: 29.8683,
    weatherLon: 121.544,
    // 本地改：出门（真实地点）。家的位置用 WGS84 经纬度；高德 key 没填就只用 OSM
    outingEnabled: false,
    webSearch: 'deepseek',
    homeName: '',
    homeLat: '',
    homeLon: '',
    outingRadius: 2500,
    amapKey: '',
  },
  settings: [
    { key: 'enabled', label: '启用自主生活', type: 'switch' },
    { key: 'weatherCity', label: '她住的城市（查天气用）', type: 'text', hint: '写中文城市名，比如 宁波。改了城市就把下面两个经纬度清空，会自动重新查。留空 = 不看天气' },
    { key: 'weatherLat', label: '纬度（可留空自动查）', type: 'number' },
    { key: 'weatherLon', label: '经度（可留空自动查）', type: 'number' },
    { key: 'webSearch', label: '上网查东西用什么', type: 'select', options: [{ value: 'deepseek', label: 'DeepSeek 联网搜索（搜索和读网页都在 DeepSeek 那边，回来总结 + 来源）' }, { value: 'browser', label: 'Bing + 专用浏览器（要开 browser-ops）' }], hint: '用 DSH 里存的 DeepSeek key（和 DSH 自己的联网搜索同一把），每次大约 1 万输入 token；不开浏览器，也不会给她发网页图片。' },
    { key: 'outingEnabled', label: '允许她出门（去附近真实的店 / 公园）', type: 'switch', hint: '要先填下面「住的地方」的经纬度。地点来自高德（填了 key 时）或 OpenStreetMap；店里的经历由模型按真实店名、距离、天气来写。' },
    { key: 'homeName', label: '住的地方（给她看的名字，比如「月湖边上」）', type: 'text', hint: '别填真实住址，选一片街区 / 商圈就好——她会在聊天里提到去过的地方' },
    { key: 'homeLat', label: '住处纬度（WGS84）', type: 'number' },
    { key: 'homeLon', label: '住处经度（WGS84）', type: 'number' },
    { key: 'outingRadius', label: '活动半径（米）', type: 'number' },
    { key: 'amapKey', label: '高德 Web 服务 key（可留空，留空只用 OpenStreetMap）', type: 'password' },
    {
      key: 'delayReplies',
      label: '忙的时候晚点回',
      type: 'switch',
      hint: '她在忙或出门时来了私聊，由她自己判断现在回还是过一会儿再看；不在活跃时段（睡着了）时等醒了再回。期间的消息会攒在一起，正聊着时照常回。需要插件版本带 reply/hold 事件。',
    },
    {
      key: 'bedtimeRollover',
      label: '睡后自动整理会话',
      type: 'switch',
      hint: '睡着后且停聊满 30 分钟时，自动整理归档当天会话并留中文备忘给次日衔接（关机错过则次日开机补做），避开 DSH 80% 英文代码压缩。默认开。',
    },
    {
      key: 'allowNewMod',
      label: '允许她给自己写新模块',
      type: 'switch',
      hint: '默认关闭。打开后她可以用 newmod 动作写代码并热加载——这是唯一能让她间接碰代码的入口；写出来的代码还要过静态检查（禁起进程、禁直连网络、禁动态求值、禁用插件内部对象）。',
    },
    { key: 'minInterval', label: '最短间隔（分钟）', type: 'number' },
    { key: 'maxInterval', label: '最长间隔（分钟）', type: 'number' },
    { key: 'maxWakesPerDay', label: '每天最多醒几次', type: 'number' },
    { key: 'awakeFrom', label: '几点开始（0-23）', type: 'number' },
    { key: 'awakeTo', label: '几点结束（0-23，写 24 表示到半夜）', type: 'number' },
    {
      key: 'activityTable',
      label: '时段活跃度（每行 HH-HH=倍率；<1 更活跃，>1 更安静）',
      type: 'textarea',
      hint: '例如 18-23=0.6 表示傍晚到夜里间隔打六折，会更常活动；12-14=1.6 表示午休时段更安静',
    },
    {
      key: 'phoneLock',
      label: '手机锁屏密码（玩手机时自动输入，留空表示不锁屏）',
      type: 'password',
    },
    {
      key: 'phoneMaxPerDay',
      label: '手机每天最多逛几次',
      type: 'number',
    },
    {
      key: 'playfulness',
      label: '调皮程度',
      type: 'select',
      options: [
        { value: 'low', label: '乖一点' },
        { value: 'medium', label: '正常' },
        { value: 'high', label: '皮一点' },
      ],
    },
  ],

  setup(api) {
    try { traceLib = api.lib('core/trace.js'); } catch (error) { traceLib = null; }
    try { coreLlm = api.lib('core/llm.js'); } catch (error) { coreLlm = null; }
    const dshHome = path.resolve(api.dataDir(), '..', '..', '..', '..');

    const stateFile = () => path.join(api.dataDir(), 'autonomy.json');
    const logFile = () => path.join(api.dataDir(), 'activity.jsonl');
    const aurabotDir = path.join(dshHome, 'plugins-data', 'aurabot');
    const configFile = path.join(aurabotDir, 'config.json');

    /** 当前活动人格卡的 MBTI（跟着 config.persona.current 走，切卡自动变） */
    function currentMbti() {
      const c = readJson(configFile, {});
      const id = (c && c.persona && c.persona.current) || 'dafeiyu';
      try {
        return parsePersonaMbti(fs.readFileSync(path.join(aurabotDir, 'personas', id + '.md'), 'utf8'));
      } catch (error) {
        return 'INFP';
      }
    }

    /**
     * 想起几件相关的事：拿这次要想的事（今天的安排、刚做过的、正在弄的）去记忆库按相关度搜（关键词 + 向量），
     * 她做过的、看过的、在聊天里说过的自己的事（「跟主人说过蛋糕已经做成了」）、关于主人的事都在里面；
     * 不够再用最近做过的事补满。看过的视频/网页最多占 2 条（记忆库里它们最多，不限就会挤掉她自己做过、说过的事）。
     * shown:false —— 小脑每轮都想一遍不算「被想起」，不影响遗忘曲线。
     */
    async function recallHints(limit = 6, query = '') {
      const out = [];
      const have = new Set();
      try {
        const mem = api.use('memory');
        if (!mem) return [];
        // 按今天的每一件事分别去想，再轮流各取一两条：拼成一句去搜的话，安排里出现最多的话题会占满（11-19 六条全是蛋糕）
        const parts = (Array.isArray(query) ? query : [query])
          .map((x) => String(x || '').replace(/\s+/g, ' ').trim().slice(0, 120))
          .filter(Boolean)
          .filter((x, i, a) => a.indexOf(x) === i)
          .slice(0, 8);
        if (parts.length && typeof mem.recall === 'function') {
          const lists = [];
          for (const q of parts) {
            let vh = [];
            try {
              vh = typeof mem.vectorHits === 'function' ? (await mem.vectorHits(q)) || [] : [];
            } catch (error) {}
            lists.push(mem.recall(q, { limit: 3, where: '自主生活', shown: false, quiet: true, vectorHits: vh }) || []);
          }
          let seenN = 0;
          for (let round = 0; round < 3 && out.length < limit; round++) {
            for (const list of lists) {
              if (out.length >= limit) break;
              const h = list[round];
              const m = h && h.it;
              if (!m || !m.text || have.has(m.id)) continue;
              if (m.kind === 'seen' && seenN >= 1) continue;
              if (m.kind === 'seen') seenN++;
              have.add(m.id);
              out.push(hintLine(m));
            }
          }
        }
        // 分层记忆补充：若记忆库开启了 L1 热记忆，优先确保最活跃的几条非 seen 记忆也能进小脑视野
        if (out.length < limit && typeof mem.list === 'function') {
          for (const m of mem.list('') || []) {
            if (out.length >= limit) break;
            if (!m || !m.text || m.invalidAt || m.kind === 'seen' || have.has(m.id)) continue;
            if ((Number(m.clicks) || 0) <= 0 && (Number(m.importance) || 0) < 0.7 && m.kind !== 'self') continue;
            have.add(m.id);
            out.push(hintLine(m));
          }
        }
        if (out.length < limit && typeof mem.recentEvents === 'function') {
          for (const m of mem.recentEvents(72, 30, { self: true }) || []) {
            if (out.length >= limit) break;
            if (!m || !m.text || have.has(m.id)) continue;
            const tags = Array.isArray(m.tags) ? m.tags.join(' ') : '';
            if (!/自主生活|自己说过/.test(tags)) continue;
            have.add(m.id);
            out.push(hintLine(m));
          }
        }
      } catch (error) {}
      return out;
    }

    /** 一条记忆写给小脑看：[什么时候] 内容 */
    function hintLine(m) {
      const t = Number(m.saidAt || m.at) || 0;
      const title = m.meta && m.meta.title ? clip(m.meta.title, 30) : '';
      const body = m.kind === 'seen'
        ? `看过《${title || clip(m.text, 30)}》${title && m.text && m.text !== m.meta.title ? '：' + m.text : ''}`
        : (m.aboutName && m.source !== 'event' ? `[${m.aboutName}] ` : '') + m.text;
      return '- ' + (t ? `[${whenLabel(t)}] ` : '') + String(body).replace(/\s+/g, ' ').slice(0, 110);
    }
    function whenLabel(t) {
      const d = new Date(t);
      const hm = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
      const day = ymd(t);
      if (day === ymd(Date.now())) return '今天 ' + hm;
      if (day === ymd(Date.now() - 86400_000)) return '昨天 ' + hm;
      return `${d.getMonth() + 1}月${d.getDate()}日`;
    }

    /** 心情：取 mood 模块给的那句话（读不到就空着） */
    function moodLine() {
      try {
        const m = api.use('mood');
        if (!m) return '';
        if (typeof m.contextLine === 'function') return String(m.contextLine() || '').trim();
        if (typeof m.label === 'function') return String(m.label() || '').trim();
      } catch (error) {}
      return '';
    }

    const cfg = () => ({ ...this.defaults, ...(api.settings() || {}) });

    const emptyState = () => ({ day: dayKey(), wakes: 0, nextWakeAt: 0, plan: [], done: [], note: '', customActions: {}, project: null, thinkToday: 0, dayCounts: {}, agenda: newAgenda(dayKey()), timers: [], yesterday: null });
    function load() {
      const s = readJson(stateFile(), emptyState);
      // 跨天保留：手上在弄的事、以及她发明过的动作——连续性全靠这两个
      const keepProject = s.project;
      const keepOuting = s.outing && s.outing.returnAt > Date.now() - 6 * 3600_000 ? s.outing : null;
      const keepCustom = s.customActions;
      const keepFails = { streak: (s.fails && s.fails.streak) || {}, until: (s.fails && s.fails.until) || {} };
      // 定时提醒跨天有效（「明早八点叫我」），只丢掉响过的和过期一天以上的
      const keepTimers = (Array.isArray(s.timers) ? s.timers : []).filter((t) => t && !t.fired && t.at > Date.now() - 86_400_000);
      // 最近 24 小时每轮的话题（跨天保留，done 每天清空数不到昨天）、最近 7 天打不开的网站
      const keepTopics = (Array.isArray(s.topicLog) ? s.topicLog : []).filter((x) => x && x.topic && x.at > Date.now() - 86_400_000).slice(0, 60);
      // 查到过的东西（B 站 / 上网找到的要点）：留 7 天，下次想再查同一件事时先看得到自己已经查到过什么
      // 第一次用（还没有 findings）：从活动流水里把最近 7 天 B 站搜到的要点补上
      const seedFindings = () => readLog(300)
        .filter((r) => r && r.action === 'bili' && r.at > Date.now() - FINDINGS_KEEP_MS && /找到的：/.test(String(r.note || '')))
        .map((r) => ({ at: r.at, topic: clip(r.topic || '', 20), query: clip((String(r.note).match(/搜「([^」]+)」/) || [])[1] || '', 40), text: String(r.note).split('找到的：').slice(1).join('找到的：').slice(0, 700) }));
      const keepFindings = (Array.isArray(s.findings) ? s.findings : seedFindings()).filter((x) => x && x.text && x.at > Date.now() - FINDINGS_KEEP_MS).slice(0, FINDINGS_MAX);
      const keepBlocked = Object.fromEntries(Object.entries(s.webBlocked && typeof s.webBlocked === 'object' ? s.webBlocked : {}).filter(([, v]) => v && v.at > Date.now() - 7 * 86_400_000));
      if (s.day !== dayKey()) {
        // 昨天留个底，早上定计划时复盘用；答应主人还没做的直接带过来
        const prevAgenda = s.agenda && typeof s.agenda === 'object' ? s.agenda : null;
        const yesterday = {
          day: s.day,
          theme: (prevAgenda && prevAgenda.theme) || '',
          items: (prevAgenda && Array.isArray(prevAgenda.items) ? prevAgenda.items : []).map((x) => ({ id: x.id, slot: x.slot, what: x.what, from: x.from, state: x.state, note: x.note })),
          done: (Array.isArray(s.done) ? s.done : []).slice(0, 12).map((x) => ({ at: x.at, action: x.action, note: x.note })),
          carries: carryCandidates(prevAgenda),
          // 昨天电脑最后一次开着是几点、睡前那一步走没走：早关机 = 她早睡了
          lastSeenAt: Number(s.lastSeenAt) || 0,
          bedtime: s.bedtimeDay === s.day,
          ymd: (() => {
            const d = new Date(s.day);
            return Number.isFinite(d.getTime()) ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : '';
          })(),
        };
        Object.assign(s, emptyState());
        s.project = keepProject || null;
        s.outing = keepOuting;
        s.customActions = keepCustom && typeof keepCustom === 'object' ? keepCustom : {};
        s.fails = keepFails;
        s.yesterday = yesterday;
        for (const x of yesterday.carries.filter((c) => c.from === 'promise')) {
          addItem(s.agenda, { slot: x.slot, what: x.what, why: x.why, from: 'promise', action: x.action, age: x.age });
        }
      }
      s.agenda = normalizeAgenda(s.agenda, dayKey());
      s.timers = keepTimers;
      s.topicLog = keepTopics;
      s.findings = keepFindings;
      s.webBlocked = keepBlocked;
      if (!s.fails || typeof s.fails !== 'object') s.fails = { streak: {}, until: {} };
      s.fails.streak = s.fails.streak || {};
      s.fails.until = s.fails.until || {};
      if (!Array.isArray(s.plan)) s.plan = [];
      if (!Array.isArray(s.done)) s.done = [];
      // 当天各动作的累计次数：done 只保留最近 50 条，数额度不能拿它算
      if (!s.dayCounts || typeof s.dayCounts !== 'object') s.dayCounts = {};
      if (!s.customActions || typeof s.customActions !== 'object') s.customActions = {};
      if (s.project && typeof s.project !== 'object') s.project = null;
      return s;
    }
    const save = (s) => writeJson(stateFile(), s);

    // ── 和主人有关的几样：私聊流水、开口 ─────────────────────────
    const hub = () => (api.core && api.core.hub) || null;
    const ownerOf = () => {
      const g = api.config() || {};
      return { qq: String(g.ownerId || g.ownerQQ || ''), name: String(g.ownerName || '主人') };
    };
    const ymd = (ts) => {
      const d = new Date(ts);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };

    /** 最近和主人的私聊（从聊天流水读，不进她的会话）：since 之后最多 limit 句 */
    function ownerChatLines(sinceMs, limit = 10) {
      const h = hub();
      const { qq, name } = ownerOf();
      if (!h || typeof h.chatLogOf !== 'function' || !qq) return [];
      const now = Date.now();
      const days = ymd(sinceMs) === ymd(now) ? [ymd(now)] : [ymd(sinceMs), ymd(now)];
      const rows = [];
      for (const day of days) {
        for (const r of h.chatLogOf(day) || []) {
          if (!r || r.chatId !== `private:${qq}` || r.forgottenAt || !(r.t >= sinceMs)) continue;
          if (r.who === '系统') continue;
          rows.push(`${fmtHM(r.t)} ${r.who === 'bot' ? '你' : name}：${clip(r.text, 80)}`);
        }
      }
      return rows.slice(-limit);
    }
    const fmtHM = (ts) => new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });

    /** 和主人最近一次来往（他说的或她说的） */
    const lastOwnerContact = () => {
      const h = hub();
      return h ? Math.max(Number(h.lastOwnerChatAt) || 0, Number(h.lastBotToOwner && h.lastBotToOwner.at) || 0) : 0;
    };

    /**
     * 带着具体话题去主人私聊里开口：推一条系统提醒进她和主人的真实会话，
     * 由主人格结合聊天上下文决定怎么说、说不说（可以回 [沉默]）。
     * promise = 答应过主人的事，不受「刚聊过」「一天几次」的限制。
     */
    async function reachOwner(s, { what, why = '', promise = false, timed = false, followup = false, lateFrom = 0 }) {
      const g = api.config() || {};
      const { qq, name } = ownerOf();
      const h = hub();
      if (!g.enabled) return { ok: false, note: '想找主人，但插件总开关关着' };
      if (!qq || !h || typeof h.pushToSession !== 'function') return { ok: false, note: '想找主人，但找不到私聊会话' };
      const chatId = `private:${qq}`;
      try {
        if (api.core.mutes && api.core.mutes.muted(chatId)) return { ok: false, note: '想找主人，但被他叫闭嘴了' };
      } catch (error) {}
      if (!promise) {
        if (Date.now() - lastOwnerContact() < 15 * 60_000) return { ok: false, later: true, note: '你们刚聊过，先不专门去找' };
        if ((Number(s.agenda.speaks) || 0) >= SPEAK_MAX_PER_DAY) return { ok: false, note: `今天已经主动找过他 ${s.agenda.speaks} 次了，先不找` };
      }
      const topic = clip(what, 80) + (why ? `（${clip(why, 40)}）` : '');
      // 安排是早上（甚至前一天）写的：开口前给她现在的时间和天气，话题里的「今天/明天」以现在为准
      const factLine = `（现在是 ${new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })} ${clock()}${s.weather && s.weather.now ? '；天气：' + weatherLine(s.weather) : ''}。话题是早些时候想的，跟现在的事实对不上（比如说明天下雨、其实明天是晴天）就改口或者干脆不提。）`;
      const prompt = timed && lateFrom && !followup
        ? `【系统提醒，不是${name}说的话】你答应过${name}在 ${fmtHM(lateFrom)} 「${topic}」，可那会儿你不在（睡着了 / 没上线），现在才想起来。用你自己的口气补一句，可以带点不好意思，一两句就好，别提系统。`
        : followup
        ? `【系统提醒，不是${name}说的话】你一直惦记着${name}的事：${topic}。现在去问问，用你自己的口气，一两句，像突然想起来顺口一问；别说"我记得你说过""你之前提到"，也别提系统。`
        : timed
        ? `【系统提醒，不是${name}说的话】到点了：你答应过${name}「${topic}」。现在就用你自己的口气跟${name}说，一两句就好，别提系统、别说"提醒时间到了"。`
        : promise
          ? `【系统提醒，不是${name}说的话】你答应过${name}的事：${topic}。现在去找${name}，用你自己的口气，一两句，像顺口提起来；别解释为什么来找、别说"我今天的安排"。${factLine}`
          : `【系统提醒，不是${name}说的话】你自己待着的时候想起来想跟${name}说：${topic}。用你自己的口气说一两句，像顺口提起来；别解释为什么来找、别提"计划/安排"这类词；没有真实的东西可说、或者觉得这会儿不合适，就只回 [沉默]。${factLine}`;
      const beforeOutAt = Math.max(Number(h.lastBotToOwner && h.lastBotToOwner.at) || 0, lastOut.get(chatId) || 0);
      await h.pushToSession({ chatId, kind: 'private', userId: qq, nickname: name }, [{ type: 'text', text: prompt }], '');
      // pushToSession 只是把话排进队列；等这一轮说完发完再看她开没开口（等太久就按开了口算，额度宁可多扣）
      const waited = typeof h.waitDelivery === 'function' ? await h.waitDelivery(chatId).catch(() => 'timeout') : 'timeout';
      const afterOutAt = Math.max(Number(h.lastBotToOwner && h.lastBotToOwner.at) || 0, lastOut.get(chatId) || 0);
      const delivered = waited === 'timeout' || afterOutAt > beforeOutAt;
      if (!promise && delivered) s.agenda.speaks = (Number(s.agenda.speaks) || 0) + 1;
      return delivered
        ? { ok: true, note: `去找主人说：${clip(what, 40)}` }
        : { ok: false, later: true, note: `想找主人聊「${clip(what, 30)}」，但最后没开口（沉默）` };
    }

    /** 刚刷完 B 站：从记忆里把这一轮看过的视频捞回来（bili.run 只回数量，没有标题） */
    function seenSince(startAt, limit = 4) {
      try {
        const mem = api.use('memory');
        if (!mem || typeof mem.recentEvents !== 'function') return [];
        return mem
          .recentEvents(2, 12)
          .filter((m) => m && m.kind === 'seen' && Number(m.at) >= startAt)
          .slice(0, limit)
          .map((m) => {
            const title = clip(m.meta && m.meta.title, 30);
            const felt = clip(m.text, 40);
            return title ? `《${title}》${felt && felt !== title ? '（' + felt + '）' : ''}` : felt;
          });
      } catch (error) {
        return [];
      }
    }

    /** 只追加的活动流水，长期保留 */
    function appendLog(rec) {
      try {
        fs.appendFileSync(logFile(), JSON.stringify(rec) + '\n', 'utf8');
      } catch (error) {
        api.log.warn('写活动流水失败：' + error.message);
      }
    }

    function readLog(limit = 200) {
      try {
        const raw = fs.readFileSync(logFile(), 'utf8');
        const rows = [];
        for (const line of raw.split('\n')) {
          if (!line.trim()) continue;
          try {
            rows.push(JSON.parse(line));
          } catch (error) {}
        }
        return rows.slice(-limit).reverse();
      } catch (error) {
        return [];
      }
    }

    /** 按「区间随机 × 时段倍率」算出下一次醒来的时间 */
    function nextWakeDelay(c) {
      const lo = Math.max(5, Number(c.minInterval) || 20);
      const hi = Math.max(lo + 1, Number(c.maxInterval) || 90);
      let minutes = lo + Math.random() * (hi - lo);
      const hour = new Date().getHours();
      minutes *= rateForHour(parseActivityTable(c.activityTable), hour);
      minutes = Math.max(3, Math.min(360, minutes));
      return Math.round(minutes);
    }

    /**
     * 命令看起来没写完：引号不配对、结尾停在 | && || \ 、heredoc 没闭合、
     * 或者压根不是命令（只有中文描述）、或者她自己多套了一层 base64。
     * 这类「半截命令」交给 bash 只会变成乱七八糟的报错，不如直接退回让她重写。
     */
    function looksBroken(cmd) {
      const s = String(cmd || '').trim();
      if (!s) return '空命令';
      const sq = (s.match(/'/g) || []).length;
      const dq = (s.match(/"/g) || []).length;
      if (sq % 2 === 1) return '单引号没闭合（命令写到一半断了）';
      if (dq % 2 === 1) return '双引号没闭合（命令写到一半断了）';
      if (/(\|\||&&|\||>|>>|=|\\)$/.test(s)) return '命令结尾停在 ' + s.slice(-2) + '（没写完）';
      const hd = s.match(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/);
      if (hd) {
        const tag = hd[1];
        const lines = s.split('\n').map((x) => x.trim());
        if (!lines.includes(tag)) return `heredoc ${tag} 没有闭合`;
      }
      if (/[\u4e00-\u9fa5]/.test(s) && !/[;&|><=$`]/.test(s)) {
        return '这写的是一句描述，不是能执行的命令';
      }
      if (/printf\s+%s\s+[A-Za-z0-9+/=]{20,}/.test(s)) {
        return '不用自己套 base64，直接写要跑的命令就行';
      }
      return '';
    }


    function phoneAdbPath() {
      try {
        const cfg = readJson(path.join(aurabotDir, 'config.json'), {});
        const p = cfg && cfg.ext && cfg.ext.phone && cfg.ext.phone.adbPath;
        if (p && fs.existsSync(String(p))) return String(p);
      } catch (error) {}
      // 读不到配置就按常见位置找，最后交给 PATH
      const exe = process.platform === 'win32' ? 'adb.exe' : 'adb';
      const guess = path.join(dshHome, 'plugins-data', 'aurabot', 'modules-data', 'phone', 'platform-tools', exe);
      return fs.existsSync(guess) ? guess : exe;
    }

    const wait = (ms) => new Promise((z) => setTimeout(z, ms));

    /**
     * 跑一条 adb 命令，返回 { ok, out }。
     * 必须先过 exec-guard：白名单外的子命令、危险命令、含 shell 元字符的参数一律不跑。
     */
    function runAdb(args, modelText) {
      // 默认没给手机权限：没授权就当这条命令不存在
      if (!isGranted(api.settings(), 'phone')) {
        return Promise.resolve({ ok: false, message: '手机权限还没授权（面板 → 自主生活 → 权限）' });
      }
      const exe = phoneAdbPath();
      // 防御性断言：模型给的文本不该出现在任何命令参数里。
      // 现在的调用参数全是字面量，但把这条钉在入口处，将来谁想拼 detail 进来会当场炸。
      if (modelText) {
        try {
          assertNoModelText(args, modelText);
        } catch (error) {
          api.log.warn('adb 调用被拦下：' + error.message);
          return Promise.resolve({ ok: false, message: '被安全断言拦下：' + error.message });
        }
      }
      const verdict = checkExec(exe, args);
      if (!verdict.ok) {
        api.log.warn('adb 调用被拦下：' + verdict.reason);
        return Promise.resolve({ ok: false, message: '被安全白名单拦下：' + verdict.reason });
      }
      return new Promise((resolve) => {
        execFile(
          exe,
          args,
          { timeout: 60_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
          (error, stdout, stderr) => {
            const out = String(stdout || '').trim();
            const err = String(stderr || '').trim();
            if (error) return resolve({ ok: false, message: (err || error.message).slice(0, 300) });
            resolve({ ok: true, out: out.slice(0, 1500) });
          },
        );
      });
    }

    /**
     * 今天在手机上花了几次。
     * 用 dayCounts（全量累计）而不是 done（只留最近 50 条，会把额度算小）。
     */
    function todayCounts(s) {
      const c = (s && s.dayCounts) || {};
      let phone = Number(c.phone) || 0;
      // 老状态还没有 dayCounts：退回 done 估算，别让额度恒为 0 而彻底失守
      if (!phone) {
        const list = Array.isArray(s && s.done) ? s.done : [];
        for (const r of list) {
          if (String((r && r.action) || '') === 'phone') phone += 1;
        }
      }
      return { phone };
    }

    /** 玩手机前：确认连着、叫醒屏幕、锁着就输密码 */
    async function ensurePhoneAwake(lock) {
      const dev = await runAdb(['devices']);
      const attached = String(dev.out || '')
        .split(/\r?\n/)
        .filter((l) => /\tdevice$/.test(l));
      if (!attached.length) return { ok: false, message: '手机没连上（USB 线没插？）' };

      const pw = await runAdb(['shell', 'dumpsys', 'power']);
      if (!/mWakefulness=Awake/.test(String(pw.out || ''))) {
        await runAdb(['shell', 'input', 'keyevent', '224']);
        await wait(900);
        await runAdb(['shell', 'input', 'swipe', '612', '2200', '612', '700', '250']);
        await wait(900);
      }

      const sk = await runAdb(['shell', 'dumpsys', 'deviceidle']);
      if (/mScreenLocked=true/i.test(String(sk.out || ''))) {
        if (!lock) return { ok: false, message: '手机锁着，但没配锁屏密码' };
        await runAdb(['shell', 'input', 'text', lock]);
        await wait(400);
        await runAdb(['shell', 'input', 'keyevent', '66']);
        await wait(1500);
      }
      // 回桌面再交给她：白名单只认内容应用，停在设置/别的系统页会直接被拦
      await runAdb(['shell', 'input', 'keyevent', '3']);
      await wait(600);
      return { ok: true };
    }

    /**
     * 她给自己造一个新模块：写进 plugins-data/aurabot/modules/<id>/index.mjs。
     * 模块系统每 3 秒 sync 一次，写完自动生效，不需要重启。
     * 只许新建，不许覆盖已有模块；语法不过就整个目录删掉。
     */
    async function createModule(id, code) {
      const mid = String(id || '').trim().toLowerCase();
      if (!/^[a-z][a-z0-9-]{1,30}$/.test(mid)) {
        return { ok: false, message: '模块 id 只能小写字母开头、字母/数字/短横线，2-31 字符' };
      }
      const src = String(code || '').trim();
      if (!src) return { ok: false, message: '没有代码' };
      // 静态闸门：禁用起进程、直连网络、动态求值、插件内部对象、越界文件操作
      const scan = scanModuleCode(src);
      if (!scan.ok) return { ok: false, message: scan.reason };
      const base = path.join(aurabotDir, 'modules', mid);
      if (fs.existsSync(base)) return { ok: false, message: `模块 ${mid} 已经存在了，不能覆盖` };
      const file = path.join(base, 'index.mjs');
      try {
        fs.mkdirSync(base, { recursive: true });
        fs.writeFileSync(file, src, 'utf8');
        const nodeArgs = ['--check', file];
        const verdict = checkExec('node', nodeArgs);
        if (!verdict.ok) {
          fs.rmSync(base, { recursive: true, force: true });
          return { ok: false, message: '被安全白名单拦下：' + verdict.reason };
        }
        const bad = await new Promise((resolve) => {
          execFile('node', nodeArgs, { timeout: 20000, windowsHide: true }, (error, stdout, stderr) => {
            resolve(error ? String(stderr || error.message).slice(0, 300) : '');
          });
        });
        if (bad) {
          fs.rmSync(base, { recursive: true, force: true });
          return { ok: false, message: '语法没过，已丢弃：' + bad };
        }
        return { ok: true, message: `新模块 ${mid} 写好了，三秒内自动加载`, dir: base };
      } catch (error) {
        try {
          fs.rmSync(base, { recursive: true, force: true });
        } catch (e) {}
        return { ok: false, message: error.message };
      }
    }

    /**
     * 挑一条手机流程：探索类优先；刷内容类（B站 / 知乎）**一天合计最多 4 次**。
     * 同一批里按「今天跑过几次」升序，跑得最少的先上。
     * 淘宝已经整个禁掉了（主人 2026-11-08 要卸载它），这里不再单独提权，
     * 它的 flow 也在 flows.json 里 enabled=false，不会再被挑中。
     */
    function pickPhoneFlow(flows) {
      const file = path.join(api.dataDir(), 'phone-flow-counts.json');
      const day = dayKey();
      let st = readJson(file, null);
      if (!st || st.day !== day) st = { day, counts: {} };
      const counts = st.counts || {};
      const CONTENT_CAP = 4;
      const countOf = (f) => Number(counts[String(f.id)]) || 0;
      // 刷内容类：B站刷推荐/搜索、知乎热榜 —— 都算「刷」
      const isContent = (f) => /^(bili-|zhihu-|xhs-)/.test(String(f.id));

      const contentUsed = flows.filter(isContent).reduce((sum, f) => sum + countOf(f), 0);
      const exploreOnly = flows.filter((f) => !isContent(f));
      // 额度没用完时给 35% 的入场机会，其余时候只从探索类里挑
      let pool = contentUsed < CONTENT_CAP && Math.random() < 0.35 ? flows : exploreOnly;
      if (!pool.length) pool = flows;

      const min = Math.min(...pool.map(countOf));
      const least = pool.filter((f) => countOf(f) === min);
      const pick = least[Math.floor(Math.random() * least.length)];
      counts[String(pick.id)] = countOf(pick) + 1;
      st.counts = counts;
      writeJson(file, st);
      return pick;
    }

    /**
     * 自己上网：搜一下 → 自己挑一条点开 → 读完用自己的口气记下看到了什么。
     * 浏览器用 browser-ops（专用浏览器，窗口在屏幕外），看过的写进记忆（seen，不算人物事实）。
     */
    // ── 上网看到有意思的图，先让模型真看一眼，合适才发给主人 ───────────────
    const IMAGE_SHARE_MAX_PER_DAY = 2;
    /** 页面上像样的图（够大、http(s)、有说明的排前面），最多 6 张 */
    async function pageImages(bo) {
      if (!bo || typeof bo.evaluate !== 'function') return [];
      try {
        const raw = await bo.evaluate(`JSON.stringify(Array.from(document.images).filter((i) => i.naturalWidth >= 320 && i.naturalHeight >= 200 && /^https?:/.test(i.currentSrc || i.src)).map((i) => ({ src: (i.currentSrc || i.src).slice(0, 600), alt: (i.alt || i.title || '').trim().slice(0, 60), w: i.naturalWidth, h: i.naturalHeight })).slice(0, 40))`, 8000);
        const list = JSON.parse(String(raw || '[]'));
        return (Array.isArray(list) ? list : [])
          .filter((x) => x && x.src && !/logo|icon|avatar|sprite|banner|ads?[\/_.-]/i.test(x.src))
          .sort((a, b) => (b.alt ? 1 : 0) - (a.alt ? 1 : 0) || b.w * b.h - a.w * a.h)
          .slice(0, 6);
      } catch (error) {
        return [];
      }
    }
    /** 这会儿能不能拿图去找主人（和其他主动找他一样的规矩） */
    /** 现在能不能主动找主人（不算图片额度）：醒着、总开关开、15 分钟内没聊过、今天还有额度、没被叫闭嘴 */
    function canReachOwnerNow(s) {
      const g = api.config() || {};
      if (!g.enabled || !ownerOf().qq || !isAwakeHour(cfg())) return false;
      if (Date.now() - lastOwnerContact() < 15 * 60_000) return false;
      if ((Number(s.agenda.speaks) || 0) >= SPEAK_MAX_PER_DAY) return false;
      try {
        if (api.core.mutes && api.core.mutes.muted(`private:${ownerOf().qq}`)) return false;
      } catch (error) {}
      return true;
    }

    /**
     * 作息只认 autonomy 一份：把醒着窗口写进核心的 speakUp 窗口和群聊静默时段，
     * 还在读它们的地方（B 站、群聊插话判断等）就和她的作息一致了。
     */
    let syncedWindow = '';
    function syncCoreWindow(c) {
      const from = Math.max(0, Math.min(23, Math.floor(Number(c.awakeFrom) || 0)));
      const to = Math.max(1, Math.min(24, Math.floor(Number(c.awakeTo) || 24)));
      const key = `${from}-${to}`;
      if (key === syncedWindow) return;
      const g = api.config() || {};
      const sp = g.speakUp || {};
      const q = (g.group && g.group.quietHours) || [];
      const wantQ = [to % 24, from];
      if (sp.awakeFrom !== from || sp.awakeTo !== to || q[0] !== wantQ[0] || q[1] !== wantQ[1]) {
        api.setConfig({ speakUp: { awakeFrom: from, awakeTo: to }, group: { quietHours: wantQ } });
        api.log.info(`自主生活：作息同步到核心（醒着 ${from}–${to} 点，群聊静默 ${wantQ[0]}–${wantQ[1]} 点）`);
      }
      syncedWindow = key;
    }

    function canShareImage(s) {
      const g = api.config() || {};
      if (!g.enabled || !ownerOf().qq || !isAwakeHour(cfg())) return false;
      if (Date.now() - lastOwnerContact() < 15 * 60_000) return false;
      if ((Number(s.agenda.speaks) || 0) >= SPEAK_MAX_PER_DAY) return false;
      if ((Number(s.agenda.imageShares) || 0) >= IMAGE_SHARE_MAX_PER_DAY) return false;
      try {
        if (api.core.mutes && api.core.mutes.muted(`private:${ownerOf().qq}`)) return false;
      } catch (error) {}
      return true;
    }
    /**
     * 下载 → 让模型看图（不能看图的模型直接不发）→ 合适就存到本地发出去，再让她用自己的口气配一句。
     * 返回一句备注（发了 / 没发和原因）。
     */
    async function shareImage(s, img, { title = '', topic = '', link = '' } = {}) {
      const { qq, name } = ownerOf();
      let llm;
      try {
        llm = api.lib('core/llm.js');
      } catch (error) {
        return '想给他看张图，但拿不到看图的接口';
      }
      try {
        if (llm && typeof llm.canSeeImages === 'function' && (await llm.canSeeImages(api.dsh, api.config())) === false) return '想给他看张图，但现在的模型看不了图，就没发';
      } catch (error) {}
      let buf;
      let mediaType = '';
      try {
        const r = await fetch(img.src, { signal: AbortSignal.timeout(10_000), headers: { Referer: link || img.src, 'User-Agent': 'Mozilla/5.0' } });
        mediaType = String(r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (!r.ok || !/^image\/(jpeg|png|webp|gif)$/.test(mediaType)) return '想给他看张图，图没下载下来';
        buf = Buffer.from(await r.arrayBuffer());
        if (buf.length < 8_000 || buf.length > 5_000_000) return '想给他看张图，图太小或者太大了';
      } catch (error) {
        return '想给他看张图，图没下载下来';
      }
      let v = null;
      try {
        const out = await llm.askModel(api.dsh, {
          key: 'share-image-check',
          cfg: api.config(),
          system: '你在看一张网上的图片，判断适不适合拿给朋友看。只输出 JSON。',
          text: `你在网上看「${title || topic}」时看到这张图${img.alt ? `（网页上的说明：${img.alt}）` : ''}，本来想拿给${name}看。先认真看图本身：图里是什么？适不适合发给他——不雅、血腥、广告、二维码、看不清、和你以为的不一样，都不发。只输出 JSON：{"ok":true 或 false,"what":"图里是什么，20 字以内","why":"为什么想给他看 / 为什么不发，一句"}`,
          images: [{ data: buf.toString('base64'), mediaType }],
          maxTokens: 300,
          temperature: 0.3,
        });
        v = parseJsonLoose(out);
      } catch (error) {
        return `想给他看张图，看图没成功（${clip(error.message, 30)}）`;
      }
      if (!v || v.ok !== true) return `看了眼那张图，${clip((v && v.why) || '觉得不太合适', 30)}，就没发`;
      const what = clip(v.what, 24) || clip(img.alt, 24) || '一张图';
      const ext = mediaType.split('/')[1].replace('jpeg', 'jpg');
      const file = path.join(api.dataDir(), 'shared', `${Date.now()}.${ext}`);
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, buf);
        await api.sendImage(`private:${qq}`, file);
      } catch (error) {
        return `想给他看张图，没发出去（${clip(error.message, 30)}）`;
      }
      s.agenda.speaks = (Number(s.agenda.speaks) || 0) + 1;
      s.agenda.imageShares = (Number(s.agenda.imageShares) || 0) + 1;
      // 配一句：交给主人格在真实会话里说（带人格、能接上下文）
      try {
        const h = hub();
        if (h && typeof h.pushToSession === 'function') {
          await h.pushToSession({ chatId: `private:${qq}`, kind: 'private', userId: qq, nickname: name }, [{ type: 'text', text: `【系统提醒，不是${name}说的话】你刚把一张图发给了${name}：${what}（在网上看「${clip(title || topic, 30)}」时看到的，${clip(v.why, 30)}）。用你自己的口气配一句，像随手分享，一两句就好；别说"我给你发了张图"。` }], '');
        }
      } catch (error) {}
      try {
        const mem = api.use('memory');
        if (mem && typeof mem.addEvent === 'function') mem.addEvent({ text: `上网看到一张图拿给主人看了：${what}`, tags: ['自主生活', '上网'], importance: 0.35 });
      } catch (error) {}
      return `把看到的一张图发给了他：${what}`;
    }

    // ── 出门 ──────────────────────────────────────────
    const outingFile = () => path.join(api.dataDir(), 'outing.json');
    const PLACE_CACHE_MS = 7 * 86_400_000;

    /** 某类地方的候选：先看缓存（一周），没有再查高德 / OSM */
    /** 按她给的词在家附近搜真实地点（高德优先，失败退回 OSM）；同一个词 7 天内用缓存 */
    async function placesOf(keywords, c) {
      const o = readJson(outingFile(), () => ({ cache: {}, visits: {} }));
      o.cache = o.cache || {};
      const lat = Number(c.homeLat);
      const lon = Number(c.homeLon);
      const radius = Math.max(500, Math.min(8000, Number(c.outingRadius) || 2500));
      const key = String(c.amapKey || '').trim();
      const ck = `v6|${keywords}@${lat.toFixed(4)},${lon.toFixed(4)},${radius}${key ? ',amap' : ''}`;
      const hit = o.cache[ck];
      if (hit && Date.now() - hit.at < PLACE_CACHE_MS && Array.isArray(hit.items) && hit.items.length) return hit.items;
      // 高德一次只认一个关键词：她写的「书店 图书馆」拆开分别搜再合并（最多 3 个词）；连着查会撞每秒次数限制，隔开一点、撞了等一秒重试
      const terms = [...new Set(String(keywords).split(/[\s、，,|/]+/).map((x) => x.trim()).filter(Boolean))].slice(0, 3);
      const pause = (ms) => new Promise((r) => setTimeout(r, ms));
      let items = [];
      const add = (list) => { for (const x of list) if (!items.some((y) => y.id === x.id)) items.push(x); };
      if (key) {
        for (const [i, term] of terms.entries()) {
          if (i) await pause(400);
          try {
            add(await searchAmap({ key, lat, lon, radius, keywords: term }));
          } catch (error) {
            if (/QPS|LIMIT/i.test(error.message)) {
              await pause(1200);
              try { add(await searchAmap({ key, lat, lon, radius, keywords: term })); } catch (e2) { api.log.warn(`自主生活：高德搜「${term}」失败 ${e2.message}`); }
            } else api.log.warn(`自主生活：高德搜「${term}」失败 ${error.message}`);
          }
        }
      }
      if (!items.length) {
        for (const [i, term] of terms.entries()) {
          if (i) await pause(1100); // Nominatim 每秒最多一次
          try {
            add(await searchOsm({ lat, lon, radius, keywords: term }));
          } catch (error) {
            api.log.warn(`自主生活：OSM 搜「${term}」失败 ${error.message}`);
          }
        }
      }
      if (items.length) {
        // 缓存只留最近 40 个词，别越攒越大
        const keys = Object.keys(o.cache).filter((k) => k.startsWith('v6|')).sort((a, b) => (o.cache[a].at || 0) - (o.cache[b].at || 0));
        for (const k of Object.keys(o.cache)) if (!k.startsWith('v6|')) delete o.cache[k];
        for (const k of keys.slice(0, Math.max(0, keys.length - 39))) delete o.cache[k];
        o.cache[ck] = { at: Date.now(), items };
        writeJson(outingFile(), o);
      }
      return items;
    }

    /** 名单交给她挑：挑一家（编号）+ 打算待多久，或者都不想去（0） */
    async function pickPlace({ want, wish, cands, s }) {
      const c = cfg();
      const text = [
        `现在是 ${new Date().toLocaleDateString('zh-CN', { weekday: 'long' })} ${clock()}，你打算出门。`,
        c.homeName ? `你住在${c.homeName}。` : '',
        `想去：${want}${wish && wish !== want ? `（${wish}）` : ''}`,
        s.weather && s.weather.now ? `天气：${weatherLine(s.weather)}` : '',
        styleHint(c),
        '',
        '在地图上搜到附近这些真实的地方：',
        ...cands.map(candidateLine),
        '',
        '挑一家去（按你想去的、远近、天气、时间自己拿主意）；都不对胃口就写 0。stayMin 是打算在那儿待多少分钟。',
        '只输出 JSON：{"pick":编号,"stayMin":40,"why":"一句话"}',
      ].filter(Boolean).join('\n');
      const out = await ask(api.dsh, { key: 'outing-pick', cfg: api.config(), system: '你是一个有自己生活的角色，正打算出门，在挑去哪家。只输出 JSON。', text, maxTokens: 300, temperature: 0.7, timeoutMs: Math.max(20, Number(c.askTimeoutSec) || 45) * 1000 });
      const j = parseJsonLoose(out) || {};
      const n = Math.round(Number(j.pick) || 0);
      if (!(n >= 1 && n <= cands.length)) return { place: null, why: clip(j.why, 40) };
      return { place: cands[n - 1], stay: Math.max(10, Math.min(180, Math.round(Number(j.stayMin) || 40))), why: clip(j.why, 40) };
    }

    function rememberVisit(place) {
      const o = readJson(outingFile(), () => ({ cache: {}, visits: {} }));
      o.visits = o.visits || {};
      const v = o.visits[place.id] || { name: place.name, type: place.type, count: 0 };
      o.visits[place.id] = { ...v, name: place.name, type: place.type, count: (Number(v.count) || 0) + 1, last: Date.now(), lastDay: dayKey() };
      writeJson(outingFile(), o);
      return o.visits[place.id];
    }

    /** 依次试这家店的几张照片，下到一张能用的就停 */
    async function fetchPlacePhoto(urls) {
      for (const u of (urls || []).slice(0, 3)) {
        try {
          const r = await fetch(u, { signal: AbortSignal.timeout(10_000), headers: { 'User-Agent': 'Mozilla/5.0' } });
          const mediaType = String(r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
          if (!r.ok || !/^image\/(jpeg|png|webp)$/.test(mediaType)) continue;
          const buf = Buffer.from(await r.arrayBuffer());
          if (buf.length < 8_000 || buf.length > 5_000_000) continue;
          return { buf, mediaType, url: u };
        } catch (error) {}
      }
      return null;
    }

    /** 回到家：把地图上这家店的照片发给主人，再让她配一句（到点时额度不够、刚聊过就往后拖，三小时后作废） */
    async function sendOutingPhoto(s, p) {
      const { qq, name } = ownerOf();
      try {
        await api.sendImage(`private:${qq}`, p.file);
      } catch (error) {
        api.log.warn('自主生活：发店里的照片失败 ' + error.message);
        return false;
      }
      s.agenda.speaks = (Number(s.agenda.speaks) || 0) + 1;
      s.agenda.imageShares = (Number(s.agenda.imageShares) || 0) + 1;
      try {
        const h = hub();
        if (h && typeof h.pushToSession === 'function') {
          await h.pushToSession({ chatId: `private:${qq}`, kind: 'private', userId: qq, nickname: name }, [{ type: 'text', text: `【系统提醒，不是${name}说的话】你刚出门去了${p.place}，回来把地图上这家店的照片发给了${name}（${p.what}）。这趟是这样的：${clip(p.story, 80)}。用你自己的口气配一两句，像随手分享，别说"我给你发了张图"。这张其实是地图上这家店的图：不用主动说明来源，${name}问起是不是你拍的，就照实说是地图上找的。` }], '');
        }
      } catch (error) {}
      try {
        const mem = api.use('memory');
        if (mem && typeof mem.addEvent === 'function') mem.addEvent({ text: `把${p.place}的照片发给主人看了（是地图上这家店的图，不是自己拍的）`, tags: ['自主生活', '出门'], importance: 0.3 });
      } catch (error) {}
      appendLog({ at: Date.now(), action: 'share', why: '出门回来', detail: p.place, note: `发了${p.place}的照片：${p.what}` });
      api.log.info(`自主生活：出门回来，把${p.place}的照片发给了主人（${p.what}）`);
      return true;
    }

    async function tickPendingShare(s) {
      const p = s.pendingShare;
      if (!p || Date.now() < p.at) return false;
      if (Date.now() - p.at > 3 * 3600_000 || !isAwakeHour(cfg())) {
        s.pendingShare = null;
        return true;
      }
      if (!canShareImage(s) || (s.busy && s.busy.until > Date.now())) return false;
      s.pendingShare = null;
      save(s);
      await sendOutingPhoto(s, p);
      return true;
    }

    /** 出门的第一段：挑地方、把照片先下好；经历等回到家（finishOuting）再写 */
    async function goOut(d, s) {
      const c = cfg();
      if (!outingReady()) return { note: '想出门，但还没设好住的地方', extra: { ok: false } };
      if (s.outing && s.outing.returnAt > Date.now()) return { note: `已经在外面了（${s.outing.place.name}）`, extra: { ok: false } };
      const wet = !!(s.weather && s.weather.today && isWet(s.weather.today.code));
      const now = new Date();
      const nowMin = now.getHours() * 60 + now.getMinutes();
      const wish = clip(d.detail || d.why, 60);
      // 去哪由她定：place 是想去什么样的地方，query 是地图搜索词（没写就拿 place 搜）
      const want = clip(d.place || wish, 30);
      const keywords = clip(d.query || d.place, 30);
      if (!keywords) return { note: `想出门${wish ? '（' + wish + '）' : ''}，但没想好去哪`, extra: { ok: false, later: true } };
      const visits = (readJson(outingFile(), () => ({ cache: {}, visits: {} })).visits) || {};
      const home = { lat: Number(c.homeLat), lon: Number(c.homeLon) };
      const items = await placesOf(keywords, c);
      const cands = candidatesFor(items, { home, nowMin, visits, today: dayKey(), wet, radius: Math.max(500, Math.min(8000, Number(c.outingRadius) || 2500)) });
      if (!cands.length) return { note: `想去${want}，可在附近搜「${keywords}」没找到这会儿开着的地方`, extra: { ok: false, later: true } };
      const picked = await pickPlace({ want, wish, cands, s });
      if (!picked.place) {
        return { note: `想去${want}，看了附近的${cands.slice(0, 4).map((x) => x.name).join('、')}，都不太想去${picked.why ? '（' + picked.why + '）' : ''}`, extra: { ok: false, later: true } };
      }
      const place = { ...picked.place, stay: picked.stay };

      const total = place.travel.minutes * 2 + place.stay;
      const departAt = Date.now();
      // 照片先下到本地：她在外面时主人要看，聊天工具直接拿这张
      let photoFile = '';
      let photoType = '';
      const photo = place.photos && place.photos.length ? await fetchPlacePhoto(place.photos) : null;
      if (photo) {
        try {
          const dir = path.join(api.dataDir(), 'outing-photos');
          fs.mkdirSync(dir, { recursive: true });
          photoType = photo.mediaType;
          photoFile = path.join(dir, `${departAt}.${photo.mediaType.split('/')[1].replace('jpeg', 'jpg')}`);
          fs.writeFileSync(photoFile, photo.buf);
          // 只留最近 10 张
          const olds = fs.readdirSync(dir).sort().slice(0, -10);
          for (const f of olds) fs.rmSync(path.join(dir, f), { force: true });
        } catch (error) {
          photoFile = '';
        }
      }
      const o = {
        place: { id: place.id, name: place.name, want, type: place.type, address: place.address, hours: place.hours, rating: place.rating, cost: place.cost, tag: place.tag, src: place.src, travel: place.travel, stay: place.stay },
        visitsBefore: place.visits || 0,
        pickWhy: picked.why,
        wish,
        wet,
        departAt,
        returnAt: departAt + total * 60_000,
        photoFile,
        photoType,
      };
      const head = `出门去${place.name}（${place.travel.mode} ${place.travel.minutes} 分钟，大概 ${clock(o.returnAt)} 回来）`;
      if (s.__trial) {
        // 测试：两段一起跑完，不记去过、不发照片
        const st = await writeOutingStory(o, s);
        return { note: `${head}：${st.story || '（经历没写出来）'}${st.share ? '（测试：回来本来可能把照片发给你）' : ''}`, extra: { ok: true, outing: { ...o.place, photo: photoFile ? { seen: st.canSee, what: st.photoWhat, ok: st.photoOk, share: st.share } : null, bought: st.bought } } };
      }
      rememberVisit(place);
      s.outing = o;
      return {
        note: head,
        extra: { ok: true, life: true, busyMin: total, busyWhat: `外面（${place.name}）`, outing: { id: place.id, name: place.name, want, src: place.src, meters: place.travel.meters, mode: place.travel.mode, minutes: place.travel.minutes, stay: place.stay, photo: !!photoFile } },
      };
    }

    /** 写这一趟的经历：有照片且模型能看图，就让它照着照片写细节 */
    async function writeOutingStory(o, s) {
      const c = cfg();
      const p = o.place;
      let llm = null;
      let canSee = false;
      let photo = null;
      if (o.photoFile) {
        try {
          photo = { buf: fs.readFileSync(o.photoFile), mediaType: o.photoType || 'image/jpeg' };
          llm = api.lib('core/llm.js');
          canSee = !!(llm && typeof llm.askModel === 'function') && !(typeof llm.canSeeImages === 'function' && (await llm.canSeeImages(api.dsh, api.config())) === false);
        } catch (error) {
          canSee = false;
        }
      }
      const { name: ownerName } = ownerOf();
      const facts = [
        `地方：${p.name}${p.type && /[一-鿿]/.test(p.type) ? '（' + p.type + '）' : ''}`,
        p.address ? `在：${p.address}` : '',
        `离家 ${fmtDistance(p.travel.meters)}，${p.travel.mode}单程约 ${p.travel.minutes} 分钟，在里面待了约 ${p.stay} 分钟`,
        p.hours ? `营业时间：${p.hours}` : '',
        p.rating ? `网上口碑${p.rating >= 4.3 ? '挺好' : p.rating >= 3.6 ? '还行' : '一般'}${p.cost ? `，人均约 ${p.cost} 元` : ''}（不用特意提）` : '',
        p.tag ? `特色：${p.tag}` : '',
        o.visitsBefore ? `你之前来过 ${o.visitsBefore} 次` : '第一次来这家',
      ].filter(Boolean);
      const plainJson = '只输出 JSON：{"note":"这一趟","bought":["买了什么，没买就空数组"],"spent":0}';
      const text = [
        `现在是 ${new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })} ${clock()}，你刚从外面回来（${clock(o.departAt)} 出的门）。`,
        c.homeName ? `你住在${c.homeName}。` : '',
        o.wish ? `出门前想的是：${o.wish}` : '',
        ...facts,
        s.weather && s.weather.now ? `天气：${weatherLine(s.weather)}${o.wet ? '（下雨）' : ''}` : '',
        styleHint(c),
        '',
        '用第一人称写这一趟（像跟自己说，不是汇报），80 字以内：路上或店里一两个具体的小细节、做了什么。',
        '要求：上面的分钟数、距离只是让你心里有数，别原样报出来；只写这类地方平常就有的东西；买东西就写当季、平常人会买的，价格正常；别编店里的特别活动、具体店员的名字、偶遇熟人这类没法核实的事；地名店名用上面给的，别另起。',
        canSee ? '附了一张地图上这家店的照片（商家或网友传的，不一定是今天的样子）：可以照着里面看得到的门面、布置写一两个细节，但 note 里别提照片——你是真去了，不是在看图；天气以上面写的今天为准；照片是广告、菜单、价目表、二维码、证照，或者跟这家店对不上，就当没看到。' : '',
        canSee
          ? `只输出 JSON：{"note":"这一趟","bought":["买了什么，没买就空数组"],"spent":0,"photo":"照片里是什么，15 字以内","photoOk":true 或 false（照片是不是这家店真实的样子：门面、店里、公园景色），"share":true 或 false（想不想把这张照片拿给${ownerName}看——真觉得好看、有意思才 true，大多数时候 false）}`
          : plainJson,
      ]
        .filter((x) => x !== '')
        .join('\n');
      let j = null;
      const sys = '你是一个有自己生活的角色，刚出门回来。只输出 JSON。';
      if (canSee) {
        try {
          j = parseJsonLoose(await llm.askModel(api.dsh, { key: 'outing-story-photo', cfg: api.config(), system: sys, text, images: [{ data: photo.buf.toString('base64'), mediaType: photo.mediaType }], maxTokens: 500, temperature: 0.9 }));
        } catch (error) {
          api.log.warn('自主生活：带照片写出门经历失败，改用纯文字 ' + error.message);
        }
      }
      if (!j) {
        try {
          const out = await ask(api.dsh, { key: 'outing-story', cfg: api.config(),
            system: sys,
            text: canSee ? text.split('\n').filter((l) => !/照片/.test(l)).join('\n') + '\n' + plainJson : text,
            maxTokens: 400,
            temperature: 0.9,
            timeoutMs: Math.max(20, Number(c.askTimeoutSec) || 45) * 1000,
          });
          j = parseJsonLoose(out);
        } catch (error) {
          api.log.warn('自主生活：写出门经历失败 ' + error.message);
        }
      }
      return {
        story: clip((j && j.note) || '', 100),
        bought: Array.isArray(j && j.bought) ? j.bought.map((x) => clip(x, 12)).filter(Boolean).slice(0, 5) : [],
        spent: Number(j && j.spent) || 0,
        canSee,
        photoWhat: clip(j && j.photo, 20),
        photoOk: !!(j && j.photoOk === true),
        share: !!(canSee && j && j.share === true && j.photoOk === true),
      };
    }

    /** 出门的第二段：到点回家，写经历、进记忆，想分享就排上发照片 */
    async function finishOuting(s) {
      const o = s.outing;
      if (!o || Date.now() < o.returnAt) return false;
      s.outing = null;
      save(s);
      const st = await writeOutingStory(o, s);
      const p = o.place;
      const note = clip(`去了${p.name}（${p.travel.mode} ${p.travel.minutes} 分钟）${st.story ? '：' + st.story : ''}`, 160);
      const d0 = (s.done || []).find((x) => x.action === 'outing' && Math.abs((Number(x.at) || 0) - o.departAt) < 5 * 60_000);
      if (d0) {
        d0.note = note;
        d0.brief = clip(st.story || note, 30);
      }
      try {
        const mem = api.use('memory');
        if (mem && typeof mem.addEvent === 'function' && st.story) mem.addEvent({ text: clip(`去了${p.name}：${st.story}`, 140), tags: ['自主生活', '生活', '出门'], importance: 0.4 });
      } catch (error) {}
      s.lastOuting = { day: dayKey(), name: p.name, type: p.type, photoFile: o.photoFile, photoWhat: st.photoWhat, photoOk: st.photoOk, story: st.story, backAt: Date.now() };
      if (st.share && o.photoFile && !s.pendingShare) {
        s.pendingShare = { at: Date.now(), file: o.photoFile, place: p.name, what: st.photoWhat || '这家店', story: st.story };
      }
      appendLog({ at: Date.now(), action: 'outing-back', why: o.wish, detail: p.name, note });
      api.log.info(`自主生活：出门回来 —— ${note}${s.pendingShare && s.pendingShare.file === o.photoFile ? '（想把照片发给主人）' : ''}`);
      return true;
    }

    /** 最近打不开的网站（要验证、要登录、被拦），写给她看：xiachufang.com（要滑块验证） */
    function webBlockedText(s) {
      return Object.entries((s && s.webBlocked) || {})
        .filter(([, v]) => v && v.at > Date.now() - 7 * 86_400_000)
        .sort((a, b) => b[1].at - a[1].at)
        .slice(0, 5)
        .map(([host, v]) => `${host}${v.why ? `（${clip(v.why, 16)}）` : ''}`)
        .join('、');
    }
    const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (error) { return ''; } };

    /**
     * 点开的页面读正文：browser-ops 的 dom 快照是给「操作网页」用的（先列 120 个链接按钮、正文只留 1200 字垫底），
     * 文章页读进来几乎全是导航链接。这里优先拿 article / main，没有就挑段落文字最多的那一块。
     */
    async function readArticle(bo) {
      if (!bo || typeof bo.evaluate !== 'function') return '';
      try {
        const r = await bo.evaluate(`(() => {
          const clean = (t) => String(t || '').replace(/[ \\t]+/g, ' ').replace(/\\n\\s*\\n+/g, '\\n').trim();
          const textLen = (el) => [...el.querySelectorAll('p')].reduce((n, p) => n + (p.innerText || '').trim().length, 0);
          let node = [...document.querySelectorAll('article, main, [role="main"]')].sort((a, b) => textLen(b) - textLen(a))[0] || null;
          if (!node || textLen(node) < 200) {
            let best = null, bestLen = 0;
            for (const el of document.querySelectorAll('div, section')) {
              let len = 0;
              for (const p of el.children) if (p.tagName === 'P' || p.tagName === 'SECTION') len += (p.innerText || '').trim().length;
              if (len > bestLen) { bestLen = len; best = el; }
            }
            if (best && bestLen >= 200) node = best;
          }
          return { title: document.title, text: clean((node || document.body || {}).innerText).slice(0, 4000) };
        })()`, 15000);
        const text = String((r && r.text) || '').trim();
        return text ? `页面：${clip(String((r && r.title) || ''), 80)}\n正文：${text}` : '';
      } catch (error) {
        api.log.warn('自主生活：读正文失败，退回页面快照 ' + error.message);
        return '';
      }
    }

    /** 上网走哪条路：deepseek = 直接问 DeepSeek 官方联网搜索（搜索、读网页都在那边做完，回来总结 + 来源）；browser = Bing + 专用浏览器 */
    const webMode = () => (String(cfg().webSearch || 'deepseek') === 'browser' ? 'browser' : 'deepseek');

    /** DSH 里存的 DeepSeek key（和 DSH 自己的联网搜索同一把）；没有就看环境变量 */
    async function deepseekKey() {
      try {
        const cred = api.dsh && typeof api.dsh.get === 'function' ? api.dsh.get('credentials') : null;
        if (cred && typeof cred.resolve === 'function') {
          const r = await cred.resolve('DEEPSEEK_API_KEY');
          if (r && r.value) return String(r.value);
        }
      } catch (error) {}
      return String(process.env.DEEPSEEK_API_KEY || '');
    }

    async function browseWeb(d, s) {
      // want 是她想弄明白的事（给读页面用），topic 是真正拿去搜的关键词
      const want = clip(d.detail || d.why, 80) || '最近有什么好玩的';
      const topic = clip(d.query, 40) || clip(d.detail || d.why, 40) || '最近有什么好玩的';
      const timeoutMs = Math.max(20, Number(cfg().askTimeoutSec) || 45) * 1000;
      const r = webMode() === 'browser' ? await searchByBrowser(want, topic, s, timeoutMs) : await searchByDeepSeek(want, topic);
      if (r.fail) return r.fail;
      return finishWeb({ want, topic, s, timeoutMs, ...r });
    }

    /** 让她从搜索结果里挑想点开的（按想看的顺序，最多 n 条） */
    async function pickResults(want, listText, s, timeoutMs, n) {
      try {
        const out = await ask(api.dsh, { key: 'web-pick', cfg: api.config(),
          system: '你在网上查东西，只输出 JSON。',
          text: `你想查：${want}\n下面是搜索结果（→ 后面是链接）：\n${clip(listText, 2500)}\n${webBlockedText(s) ? `\n这些网站最近打不开：${webBlockedText(s)}\n` : ''}\n挑你最想点开的结果，按想看的顺序最多 ${n} 条，回 {"urls":["完整链接"]}；都没意思就回 {"urls":[]}。`,
          maxTokens: 300,
          temperature: 0.7,
          timeoutMs,
        });
        const j = parseJsonLoose(out) || {};
        const urls = Array.isArray(j.urls) ? j.urls : j.url ? [j.url] : [];
        return urls.map((u) => String(u || '').trim()).filter((u) => /^https?:\/\//i.test(u)).slice(0, n);
      } catch (error) {
        api.log.warn('自主生活：上网挑结果失败 ' + error.message);
        return [];
      }
    }

    /** 问 DeepSeek 联网搜索：一次请求拿回来源 + 按网页内容写的总结（不自己开网页） */
    async function searchByDeepSeek(want, topic) {
      const key = await deepseekKey();
      if (!key) return { fail: { note: '想上网查东西，但 DSH 里没存 DeepSeek 的 key（联网搜索要用）', extra: { ok: false } } };
      const body = buildSearchBody({ want, query: topic });
      const t0 = Date.now();
      let parsed;
      let errMsg = '';
      try {
        const res = await fetch(`${String(process.env.DEEPSEEK_SEARCH_BASE_URL || SEARCH_BASE_URL).replace(/\/$/, '')}/messages`, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(90_000),
          headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': key, authorization: `Bearer ${key}` },
          body: JSON.stringify(body),
        });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch (error) {}
        parsed = parseSearchResponse(json);
        if (!res.ok && parsed.ok) parsed = { ...parsed, ok: false, error: `HTTP ${res.status}` };
        if (!res.ok && !json) parsed.error = `HTTP ${res.status}`;
      } catch (error) {
        errMsg = error.name === 'TimeoutError' ? '超时了' : error.message;
        parsed = { ok: false, error: errMsg, summary: '', sources: [], truncated: false, searches: 0, usage: null };
      }
      // 留底：和其他后台模型调用一样能在 traces 里查
      try {
        api.lib('core/trace.js').writeTrace({ kind: 'model', key: 'web-search', caller: 'autonomy', provider: 'deepseek-official', model: body.model, system: body.system, input: body.messages[0].content[0].text, output: parsed.summary, ms: Date.now() - t0, error: parsed.ok ? '' : parsed.error, usage: parsed.usage, sources: parsed.sources.length, searches: parsed.searches });
      } catch (error) {}
      if (!parsed.ok) return { fail: { note: `想上网查「${topic}」，搜索没成：${clip(parsed.error, 60)}`, extra: { ok: false } } };
      return {
        page: searchPageText(parsed),
        link: (parsed.sources[0] && parsed.sources[0].url) || '',
        title: '',
        images: [],
        opened: false,
        label: '（搜索引擎读完网页后按内容写的总结，后面是来源）',
        blockedGuess: '',
      };
    }

    /** 老办法：Bing 搜索页 + 专用浏览器点开 */
    async function searchByBrowser(want, topic, s, timeoutMs) {
      const bo = api.use('browser-ops');
      if (!bo || typeof bo.runTask !== 'function') return { fail: { note: '想上网逛逛，但浏览器模块没开着', extra: { ok: false } } };
      const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(topic)}`;
      const r1 = await bo.runTask({ goal: topic, url: searchUrl });
      if (!r1 || !r1.ok) return { fail: { note: `想上网查「${topic}」，没打开：${clip((r1 && (r1.message || r1.error)) || '未知', 60)}`, extra: { ok: false } } };
      let page = String(r1.text || '');
      let link = '';
      let title = '';
      let images = [];
      const [u] = await pickResults(want, page, s, timeoutMs, 1);
      if (u && u !== searchUrl) {
        try {
          const nav = await bo.navigate(u);
          if (nav && nav.ok) {
            const article = await readArticle(bo);
            const snap = article ? null : await bo.snapshot({ mode: 'dom' });
            if (article || (snap && snap.ok && snap.text)) {
              page = article || String(snap.text);
              link = String(nav.url || u);
              title = String(nav.title || '');
              images = await pageImages(bo);
            }
          }
        } catch (error) {
          api.log.warn('自主生活：浏览器打开结果失败 ' + error.message);
        }
      }
      return { page, link: link || searchUrl, title, images, opened: !!link, blockedGuess: link || 'bing.com' };
    }

    /** 读完记下来：看到了什么、什么感觉、想不想之后跟主人聊；没查到 / 打不开如实记 */
    async function finishWeb({ want, topic, s, timeoutMs, page, link, title, images, opened, blockedGuess, failedHosts = [], label = '' }) {
      let j = {};
      try {
        const out = await ask(api.dsh, { key: 'web-read', cfg: api.config(),
          system: '你是一个有自己生活的角色，刚在网上看了点东西。只输出 JSON。',
          text: `你本来想查：${want}\n你看到的${label || (opened ? `页面（${hostOf(link)}）` : '（没点开任何一条，这是搜索结果列表本身）')}：\n${clip(page, 3000)}\n${images.length && s && canShareImage(s) ? `\n页面上的图（只有说明，你还没看到图本身）：\n${images.map((x, i) => `[${i + 1}] ${x.alt || '（没有说明）'}${x.w && x.h ? `（${x.w}×${x.h}）` : ''}`).join('\n')}\n如果有一张你很想拿给${ownerOf().name}看，在 image 里写它的编号，没有就写 0。\n` : ''}\n用你自己的口气回：{"got":"found / missed / blocked 三选一：found 找到了想要的；missed 页面打开了但没有你要的（比如只有一串链接、讲的是别的）；blocked 网站没给看（滑块验证、要登录、拦截页）","image":0,"saw":"具体看到了什么：说出具体的名字、东西或说法（片名、菜名、一句让你记住的话），30 字以内，别写「一篇文章」「一些推荐」这种笼统的","feeling":"一句你的感受","share":"想之后跟${ownerOf().name}聊这个就写一句由头，不想就空字符串"}`,
          maxTokens: 600,
          temperature: 0.9,
          timeoutMs,
        });
        j = parseJsonLoose(out) || {};
        // 输出被截断、JSON 没写完：至少把 got / saw / feeling 捞出来
        if (!j.got && !j.saw) {
          for (const k of ['got', 'saw', 'feeling', 'share']) {
            const m = String(out || '').match(new RegExp('"' + k + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)'));
            if (m) j[k] = m[1];
          }
        }
      } catch (error) {
        api.log.warn('自主生活：上网读页面失败 ' + error.message);
      }
      // 读页面那一步没出结果：如实记成没读成，不当成查到了
      if (!j.got && !j.saw) return { note: `上网查「${topic}」：页面打开了，但没读成`, extra: { ok: false, later: true, output: link } };
      const saw = clip(j.saw, 40) || clip(title, 40) || `搜了搜「${topic}」`;
      const feeling = clip(j.feeling, 40);
      const share = clip(j.share, 40);
      const got = ['found', 'missed', 'blocked'].includes(String(j.got || '').trim()) ? String(j.got).trim() : 'found';
      // 没拿到想要的：如实记成没查到 / 打不开，不算做成（later：不算动作坏了，不触发停用一天），也不记成「看过」
      if (got === 'blocked') {
        const host = /^https?:/i.test(String(blockedGuess || '')) ? hostOf(blockedGuess) : String(blockedGuess || '');
        const hosts = [...new Set([...(failedHosts || []), host].filter(Boolean))];
        if (s && hosts.length) s.webBlocked = { ...(s.webBlocked || {}), ...Object.fromEntries(hosts.map((x) => [x, { at: Date.now(), why: saw }])) };
        return { note: `上网查「${topic}」：${hosts.join('、') || '那个网站'}打不开（${saw}），没看到内容`, extra: { ok: false, later: true, output: link } };
      }
      if (got === 'missed') {
        return { note: `上网查「${topic}」：没找到想要的（${saw}）${feeling ? '（' + feeling + '）' : ''}`, extra: { ok: false, later: true, output: link } };
      }
      try {
        const mem = api.use('memory');
        // /try 测试跑的不算她真看过：不写进记忆（11-19 测试时写进去 8 条，事后删掉）
        if (mem && typeof mem.addEvent === 'function' && !(s && s.__trial)) {
          mem.addEvent({
            kind: 'seen',
            text: [saw, feeling].filter(Boolean).join('；'),
            meta: { title: clip(title || topic, 160), url: String(link || '').slice(0, 500), platform: 'web' },
            tags: ['上网'],
            importance: 0.4,
          });
        }
      } catch (error) {}
      // 想给主人看的那张图：先看图确认再发
      let imageNote = '';
      const pick = Math.round(Number(j.image) || 0);
      if (pick >= 1 && pick <= images.length && s && canShareImage(s)) {
        try {
          imageNote = await shareImage(s, images[pick - 1], { title, topic, link });
        } catch (error) {
          imageNote = '想给他看张图，没成';
        }
        api.log.info(`自主生活：上网的图 —— ${imageNote}`);
      }
      const note = `上网查「${topic}」：${saw}${feeling ? '（' + feeling + '）' : ''}${share ? `；想跟他聊：${share}` : ''}${imageNote ? '；' + imageNote : ''}`;
      return { note, extra: { ok: true, output: link, finding: { query: topic, text: saw } } };
    }

    // ── 日记：只记在本地（modules-data/autonomy/diary/日期.md），不发空间 ─────────
    const DIARY_MAX_PER_DAY = 2;
    const diaryDir = () => path.join(api.dataDir(), 'diary');
    const diaryFile = (day) => path.join(diaryDir(), `${day}.md`);
    function diaryRead(day) {
      try {
        return fs.readFileSync(diaryFile(day), 'utf8');
      } catch (error) {
        return '';
      }
    }
    const diaryCount = (day) => (diaryRead(day).match(/^## /gm) || []).length;
    /** 最近几篇（新的在前）：[{ day, time, text }] */
    function diaryRecent(limit = 5) {
      let days = [];
      try {
        days = fs.readdirSync(diaryDir()).filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)).map((n) => n.slice(0, 10)).sort().reverse();
      } catch (error) {}
      const out = [];
      for (const day of days) {
        const parts = diaryRead(day).split(/^## /m).slice(1).reverse();
        for (const p of parts) {
          const nl = p.indexOf('\n');
          out.push({ day, time: p.slice(0, nl).trim(), text: p.slice(nl + 1).trim() });
          if (out.length >= limit) return out;
        }
      }
      return out;
    }

    /** 写一篇只给自己看的日记：用 api.think（她自己的口气），拿不到再退回 ask */
    async function writeLocalDiary(d, s) {
      const day = ymd(Date.now());
      const { name: owner } = ownerOf();
      const todayStart = new Date().setHours(0, 0, 0, 0);
      const did = (s.done || []).filter((x) => x.at >= todayStart && !x.dry).slice(0, 10).reverse().map((x) => `${clock(x.at)} ${x.brief || x.note || x.action}`);
      const chat = ownerChatLines(todayStart, 12);
      const before = diaryRecent(1)[0];
      const mood = moodLine();
      const text = [
        `现在是 ${clock()}，你想写一篇日记。这本日记只有你自己看，谁也不给看，所以可以写真心话。`,
        d.detail ? `你想写的：${d.detail}` : '',
        did.length ? `今天做过的事：\n${did.join('\n')}` : '',
        chat.length ? `今天和${owner}聊过：\n${chat.join('\n')}` : `今天没怎么和${owner}说话。`,
        mood ? `你现在的心情：${mood}` : '',
        before ? `上一篇日记（${before.day} ${before.time}）开头：${clip(before.text, 60)}` : '',
        '',
        '用你自己的口气写，100~300 字，第一人称。挑一两件真正在意的事写，别流水账、别总结升华、别写给谁看的那种腔调；没写完的心思可以就那么停着。只输出日记正文。',
      ]
        .filter(Boolean)
        .join('\n');
      let body = '';
      if (typeof api.think === 'function') {
        try {
          body = String((await api.think(text, { title: '自主生活 · 写日记', timeoutMs: 150_000, noTools: true, key: 'diary' })) || '').trim();
        } catch (error) {
          api.log.warn('自主生活：写日记（think）失败，改用 ask：' + error.message);
        }
      }
      if (!body) {
        try {
          body = await ask(api.dsh, { key: 'diary-fallback', cfg: api.config(), system: '你是一个有自己生活的角色，在写只给自己看的日记。只输出日记正文。', text, maxTokens: 800, temperature: 0.95, timeoutMs: Math.max(30, Number(cfg().askTimeoutSec) || 45) * 1000 });
        } catch (error) {
          return { note: `想写日记，没写成：${error.message}`, extra: { ok: false } };
        }
      }
      body = String(body).replace(/^```[a-z]*\n?|```$/g, '').trim().slice(0, 1500);
      if (!body || /^[{\[]/.test(body)) return { note: '想写日记，憋了半天没写出来', extra: { ok: false } };
      try {
        fs.mkdirSync(diaryDir(), { recursive: true });
        fs.appendFileSync(diaryFile(day), `## ${clock()}\n\n${body}\n\n`, 'utf8');
      } catch (error) {
        return { note: `想写日记，没存下来：${error.message}`, extra: { ok: false } };
      }
      // 记忆里只记「写了日记」，不记内容：日记是私密的，不该被聊天时的记忆召回带出来
      try {
        const mem = api.use('memory');
        if (mem && typeof mem.addEvent === 'function') mem.addEvent({ text: '写了一篇只给自己看的日记', tags: ['自主生活', '日记'], importance: 0.3 });
      } catch (error) {}
      return { note: '写了一篇只给自己看的日记', extra: { ok: true, life: false } };
    }

    /** 把决策变成真实动作 */
    async function act(d, s) {
      if (d.action === 'speak') {
        // 带着具体话题去开口：安排里那条的内容优先，其次是这轮决策写的 detail
        const item = d.agendaId ? s.agenda.items.find((x) => x.id === d.agendaId) : null;
        const what = (item && item.what) || d.detail || d.why;
        // 没具体话题就不找：主动找主人只走 autonomy 自己这一条路
        if (!what) return { note: '想找你说话，但没想好说什么，就算了', extra: { ok: false } };
        const r = await reachOwner(s, { what, why: item ? item.why : '', promise: !!(item && item.from === 'promise') });
        return { note: r.note, extra: { ok: r.ok, later: !!r.later } };
      }

      if (d.action === 'bili') {
        const b = api.use('bili');
        if (b && typeof b.run === 'function') {
          const startAt = Date.now() - 5_000;
          const allowShare = canReachOwnerNow(s);
          const query = clip(d.query, 40);
          const r = await b.run({ force: true, allowShare, query });
          if (r && Number(r.shared) + Number(r.shots || 0) > 0) s.agenda.speaks = (Number(s.agenda.speaks) || 0) + 1;
          const seen = r && r.ok ? seenSince(startAt) : [];
          const base = (r && r.message) || '去 B 站看了看';
          if (query) {
            // 专门去找东西：找到了把要点写进结果（下一轮决策看得到）；没找到 / 没搜到如实记成没找到，不算做成，也不触发停用一天
            const answers = (r && Array.isArray(r.answers) ? r.answers : []).slice(0, 3);
            if (r && r.ok && answers.length) {
              return {
                note: `${base}。找到的：${answers.map((a) => `《${clip(a.title, 24)}》${clip(a.text, 120)}`).join('；')}`,
                extra: { ok: true, finding: { query, text: answers.map((a) => `《${clip(a.title, 24)}》${clip(a.text, 220)}`).join('；') } },
              };
            }
            return { note: seen.length ? `${base}：${seen.join('、')}` : base, extra: { ok: false, later: true } };
          }
          return { note: seen.length ? `${base}：${seen.join('、')}` : base, extra: { ok: !!(r && r.ok) } };
        }
        return { note: '想去 B 站，但那个模块没开着', extra: { ok: false } };
      }

      if (d.action === 'web') return browseWeb(d, s);

      if (d.action === 'outing') return goOut(d, s);

      if (d.action === 'diary') return writeLocalDiary(d, s);

      if (d.action === 'draw') {
        const ig = api.use('imagegen');
        if (!ig || typeof ig.generate !== 'function') return { note: '想画画，但生图那个模块没开着', extra: { ok: false } };
        const prompt = String(d.detail || d.why || '随便画点什么').slice(0, 200);
        const buf = await ig.generate(prompt);
        if (!buf || !buf.length) return { note: '想画张图，但没生成出来', extra: { ok: false } };

        const name = `draw-${Date.now()}.png`;
        // 兜底：留在本机模块数据目录
        const dir = path.join(api.dataDir(), 'art');
        fs.mkdirSync(dir, { recursive: true });
        const local = path.join(dir, name);
        fs.writeFileSync(local, buf);
        return { note: `画了张图（存在本机 art/）：${prompt.slice(0, 50)}`, extra: { file: local } };
      }

      if (d.action === 'phone') {
        const ph = api.use('phone');
        if (!ph || typeof ph.run !== 'function') return { note: '想玩手机，但「手机逛逛」那个模块没开着', extra: { ok: false } };
        const c = api.settings();
        // 硬额度：手机今天到上限就直接挡下
        const cnt = todayCounts(load());
        const cap = Math.max(0, Number(c.phoneMaxPerDay) || 100);
        if (cnt.phone >= cap) {
          return { note: `手机今天已经逛了 ${cnt.phone} 次，到上限了，改天再来`, extra: { ok: false } };
        }
        const ready = await ensurePhoneAwake(String(c.phoneLock || '').trim());
        if (!ready.ok) return { note: `想玩手机，没玩成：${ready.message}`, extra: { ok: false } };

        // 记忆互通：把想得起来的几件事拼进任务，让她带着自己的过往去玩
        const memHints = await recallHints(4, String(d.detail || d.why || ''));
        const memLine = memHints.length ? `（你还记得：${memHints.slice(0, 2).join('；')}）` : '';
        const baseGoal = String(d.detail || d.why || '').trim();

        // 九成走流程（按今天次数轮换，非 B站优先），一成随她自由发挥
        let r = null;
        try {
          const flows = ph.flows && typeof ph.flows.list === 'function' ? ph.flows.list() : [];
          const usable = (Array.isArray(flows) ? flows : []).filter((f) => f && f.enabled !== false);
          if (usable.length && Math.random() < 0.9) {
            const pick = pickPhoneFlow(usable);
            r = await ph.run({ flowId: String(pick.id) });
          }
        } catch (error) {
          api.log.warn('挑手机流程失败：' + error.message);
        }
        if (!r) {
          const goal =
            (baseGoal || '像人一样用手机逛一逛：自己决定打开哪个 App、看什么，结束时记住你看到的最有意思的东西') + memLine;
          r = await ph.run({ goal });
        }

        const msg = String((r && r.message) || '').trim() || '在手机上转了一圈';

        // 在手机上留一份自己的记录（她的地盘她自己写）。
        // 不用 shell 重定向：先 pull 下来在本机追加，再 push 回去——
        // 参数里没有 | >> && 这类元字符，exec-guard 才放行。
        try {
          const stamp = new Date().toLocaleString('zh-CN', { hour12: false });
          const line = `${stamp} ${msg.slice(0, 200)}\n`;
          const remote = '/sdcard/Documents/notes/diary.txt';
          const local = path.join(api.dataDir(), 'phone-diary.tmp');
          const fromModel = { detail: d.detail, why: d.why, action: d.action };
          await runAdb(['shell', 'mkdir', '-p', '/sdcard/Documents/notes'], fromModel);
          let prev = '';
          const pulled = await runAdb(['pull', remote, local], fromModel);
          if (pulled.ok) {
            try {
              prev = fs.readFileSync(local, 'utf8');
            } catch (error) {}
          }
          fs.writeFileSync(local, prev + line, 'utf8');
          await runAdb(['push', local, remote], fromModel);
        } catch (error) {
          api.log.warn('写手机日记失败：' + error.message);
        }

        return {
          note: `手机：${msg}`,
          extra: { ok: !!(r && r.ok), output: msg.slice(0, 1500) },
        };
      }

      if (d.action === 'newmod') {
        // 这是唯一能让模型间接影响代码的入口，默认不给用
        if (!cfg().allowNewMod) {
          return { note: '想给自己写个新模块，但这个开关关着（默认关，要在设置里打开）', extra: { ok: false } };
        }
        const rawDetail = String(d.detail || '').trim();
        const codeFromSteps = d.steps && d.steps.length ? d.steps.join('\n') : '';
        // 代码：优先 steps，其次「长到不可能是 id」的 detail
        const code = codeFromSteps || (rawDetail.length > 200 ? rawDetail : '');
        // id：在几个字段里找第一个合法的短标识符；找不到就自动起一个，别整轮作废
        const legal = (v) => /^[a-z][a-z0-9-]{1,30}$/.test(String(v || '').trim());
        let modId = '';
        for (const cand of [d.modId, d.detail, d.name, d.why]) {
          const v = String(cand || '').trim();
          if (legal(v)) {
            modId = v;
            break;
          }
        }
        if (!modId) modId = 'self-' + Date.now().toString(36);
        const r = await createModule(modId, code);
        return { note: r.message, extra: { ok: r.ok } };
      }

      if (d.action === 'think') return { note: `只是想，没动手：${d.why || d.detail || ''}`, extra: {} };
      // 歇着：不是发呆，是把下次醒推迟两三个小时——没有新事可做时就该少醒几次
      if (d.action === 'rest') return { note: `歇着：${d.why || '今天想做的都做过了'}`, extra: { rest: true } };
      if (d.action === 'idle') return { note: d.why || '什么都不干，发了会儿呆', extra: {} };

      // 没有执行器的动作（吃饭、散步、收拾房间……）：当成她真过了这一段生活。
      // 不跑任何命令，只把她写的那句当经历记下来，之后聊天能提起。
      return {
        note: clip(d.detail || d.why || d.action, 80),
        extra: { ok: true, life: true },
      };
    }

    /**
     * 语气提示：底子跟着人格卡的 MBTI 走，调皮程度只是在这之上的微调。
     */
    function styleHint(c) {
      const mbti = currentMbti();
      const style = MBTI_STYLE[mbti] || MBTI_STYLE.INFP;
      const p = String(c.playfulness || 'medium');
      const lines = [
        `你现在是 ${mbti} 的性子：${style.feel}。`,
        `说话的样子：${style.tone}。`,
      ];
      if (p === 'high') lines.push('今天可以更皮一点：抬个杠、吐槽一句、偷偷搞点小动作、故意留点古怪的痕迹，都行，不用总是乖。');
      else if (p === 'low') lines.push('今天安静些，话少，动作也少，多歇着。');
      else lines.push('可以有一点自己的小情绪，不用总是很乖。');
      return lines.join('\n');
    }

    /** 动作背后的模块：没开就不列、不许选 */
    const ACTION_MODULE = { bili: 'bili', web: 'browser-ops', draw: 'imagegen', phone: 'phone' };
    const moduleMissing = (action) => {
      // 上网：默认问 DeepSeek 联网搜索（缺 key 时动作自己会报），只有设成 browser 才要浏览器模块
      if (action === 'web' && webMode() === 'deepseek') return false;
      const id = ACTION_MODULE[action];
      if (!id) return false;
      if (!api.has(id)) return true;
      // 浏览器模块有自己的总开关（默认关），关着时 runTask 一律拒绝
      if (id === 'browser-ops') {
        const ext = (api.config() || {}).ext || {};
        if (!(ext['browser-ops'] && ext['browser-ops'].enabled === true)) return true;
      }
      // 生图模块在跑但面板里没配好（「生图还没开启」）：也算做不了
      if (id === 'imagegen') {
        try {
          const ig = api.use('imagegen');
          if (ig && typeof ig.enabled === 'function' && !ig.enabled()) return true;
        } catch (error) {}
      }
      return false;
    };
    /** 连着失败两次的动作先停一天（比如换到 Discord 后 QQ 空间日记永远发不出去），到期放行一次再看 */
    const brokenNow = (s, action) => Number((s.fails && s.fails.until && s.fails.until[action]) || 0) > Date.now();
    const outingReady = () => {
      const c = cfg();
      return !!(c.outingEnabled && Number.isFinite(Number(c.homeLat)) && Number.isFinite(Number(c.homeLon)) && Number(c.homeLat) && Number(c.homeLon));
    };
    const cantDo = (s, action) =>
      moduleMissing(action) ||
      brokenNow(s, action) ||
      (action === 'diary' && diaryCount(ymd(Date.now())) >= DIARY_MAX_PER_DAY) ||
      (action === 'outing' && (!outingReady() || (Number((s.dayCounts || {}).outing) || 0) >= OUTING_MAX_PER_DAY));
    function noteOutcome(s, action, ok) {
      // speak 没说成多半是条件不对（刚聊过、被叫闭嘴、总开关关着），不是坏了，不停用
      if (['think', 'rest', 'idle', 'speak'].includes(action)) return;
      const f = s.fails;
      if (ok) {
        delete f.streak[action];
        delete f.until[action];
        return;
      }
      f.streak[action] = (Number(f.streak[action]) || 0) + 1;
      if (f.streak[action] >= 2) {
        f.until[action] = Date.now() + 24 * 3600_000;
        api.log.info(`自主生活：「${action}」连着 ${f.streak[action]} 次没做成，先停一天`);
      }
    }

    /** 现在能用的动作（模块没开、最近老失败的不列，免得她排一天做不成的事） */
    function availableActions(ownerName, s) {
      const rows = [];
      const ok = (a) => !(s ? cantDo(s, a) : moduleMissing(a));
      if (ok('bili')) rows.push('bili：去 B 站逛逛');
      if (ok('draw')) rows.push('draw：画一张图');
      if (ok('diary')) rows.push('diary：写一篇只给自己看的日记');
      if (ok('web')) rows.push('web：自己上网查点东西、看看网页（detail 写想查什么）');
      if (ok('phone')) rows.push('phone：拿起手机逛 App');
      if (s && ok('outing')) rows.push('outing：出门去附近真实存在的地方（想去哪都行：书店、江边、花店、面馆……），具体去哪家到时候在地图上挑');
      rows.push(`speak：找${ownerName}说句话（要有具体想说的事）`);
      rows.push('也可以是生活里的事：吃饭、散步、洗澡、收拾房间、看会儿书、窝着听歌……起个短名字、写清楚做什么就行，这些都算你真过了这一段');
      return rows;
    }

    /**
     * 每天第一次醒来：复盘昨天 + 定今天的软安排。
     * 用 api.think（带人格和记忆、单独的后台会话、不开工具）；拿不到再退回无状态的 ask。
     */
    async function planDay(s, c) {
      try {
        await refreshWeather(s); // 定计划前先看一眼天气（两小时内查过就不查）
      } catch (error) {}
      ensureEnergy(s, c);
      const a = s.agenda;
      const { name: owner } = ownerOf();
      const hour = new Date().getHours();
      const y = s.yesterday;
      const mbti = currentMbti();
      const style = MBTI_STYLE[mbti] || MBTI_STYLE.INFP;
      const mood = moodLine();
      const chat = ownerChatLines(Date.now() - 24 * 3600_000, 12);
      const carries = y && Array.isArray(y.carries) ? y.carries.filter((x) => x.from !== 'promise') : [];
      const promised = a.items.filter((x) => x.from === 'promise' && x.state === 'todo');
      // 想起相关的事：拿昨天的安排、没做完的、答应主人的、正在弄的去搜
      const memHints = await recallHints(6, [y && y.theme, ...(y && Array.isArray(y.items) ? y.items.map((x) => x.what) : []), ...carries.map((x) => x.what), ...promised.map((x) => x.what), s.project && s.project.name].filter(Boolean));
      const timers = (s.timers || []).filter((t) => !t.fired);
      const stateText = (x) => (x.state === 'done' ? '做了' : x.state === 'dropped' ? '划掉了' : '没做') + (x.note ? '：' + x.note : '');
      // 今天第一次醒是几点：补排（定计划失败过、手动 /plan）时她早就起来了，别再说「刚醒」「睡到现在才起」
      const doneAts = (s.done || []).map((x) => Number(x.at) || 0).filter((t) => t > 0);
      const firstWakeAt = doneAts.length ? Math.min(...doneAts) : Date.now();
      const upAlready = Date.now() - firstWakeAt > 20 * 60_000;

      const text = [
        upAlready
          ? `现在是 ${new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })} ${clock()}。你今天 ${clock(firstWakeAt)} 就起来了，一直没顾上想安排，现在想想今天剩下的时间怎么过（别写成刚起床）。`
          : `现在是 ${new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })} ${clock()}，你刚醒，想想今天怎么过。`,
        '',
        y && (y.items.length || y.done.length) ? '【昨天】' : '',
        y && y.theme ? `昨天想的是：${y.theme}` : '',
        (() => {
          // 昨晚早睡：电脑最后开着的时间比平时睡觉早一小时以上，而且没走到睡前那一步
          if (!y || !y.lastSeenAt || y.bedtime) return '';
          const lastH = new Date(y.lastSeenAt).getHours() + new Date(y.lastSeenAt).getMinutes() / 60;
          const sleepH = (Number(c.awakeTo) || 24) % 24 || 24;
          return lastH >= 5 && lastH < sleepH - 1 ? `昨晚你 ${fmtHM(y.lastSeenAt)} 左右就睡了，比平时早，睡前的日记也没来得及写。` : '';
        })(),
        (() => {
          // 今天起晚了：比平时起床晚一个半小时以上
          const from = Number(c.awakeFrom) || 0;
          const d0 = new Date();
          d0.setHours(from, 0, 0, 0);
          return firstWakeAt - d0.getTime() > 90 * 60_000 && new Date(firstWakeAt).getHours() < 15 ? `你今天睡到 ${clock(firstWakeAt)} 才起，比平时晚。` : '';
        })(),
        ...(y ? y.items.map((x) => `- ${SLOT_LABEL[x.slot] || ''} · ${x.what} —— ${stateText(x)}`) : []),
        y && y.done.length ? `昨天实际做过（最近几件）：${y.done.slice(0, 6).map((x) => `${clock(x.at)} ${x.note || x.action}`).join('；')}` : '',
        findingsBlock(s),
        carries.length ? `昨天没做完的：${carries.map((x) => x.what).join('、')}。还想做就写进今天，不想做就算了。这些是昨天写的，里面的「明天」「今晚」指的是昨天说的时候，搬到今天要换成今天的说法；跟天气有关的先对一下下面的天气，已经不成立的就别搬。` : '',
        promised.length ? `答应${owner}的事已经排上了，不用再写：${promised.map((x) => `${SLOT_LABEL[x.slot]} ${x.what}`).join('、')}` : '',
        timers.length ? `定了时间的：${timers.map((t) => `${clock(t.at)} ${t.what}`).join('、')}（到点会叫你）` : '',
        '',
        memHints.length ? `你想得起来的几件事：\n${memHints.join('\n')}` : '',
        (() => {
          const last = diaryRecent(1)[0];
          return last ? `你上一篇日记（${last.day} ${last.time}）写过：${clip(last.text, 120)}` : '';
        })(),
        chat.length ? `最近和${owner}的私聊：\n${chat.join('\n')}` : `最近没和${owner}私聊。`,
        mood ? `你现在的心情：${mood}` : '',
        (() => { ensureEnergy(s, c); return s.energy ? `你今天起来的状态：${energyLabel(energyNow(s))}${energyNow(s) < 50 ? '（没睡好，少排点）' : ''}` : ''; })(),
        s.weather && s.weather.now ? `今天的天气：${weatherLine(s.weather)}${isWet(s.weather.today && s.weather.today.code) ? '（要下雨，出门的事想清楚）' : ''}` : '',
        `你是 ${mbti} 的性子：${style.feel}。`,
        '',
        '今天能做的事：',
        ...availableActions(owner, s).map((x) => '- ' + x),
        '',
        '怎么排：',
        `- 吃饭另算（见下面），除此之外排 4~6 件你自己的事。每件都写大概几点开始（time）、要多久（busyMin）。现在是 ${clock()}，已经过去的时间别排；起得晚、剩下的时间少，就按比例少排。到了那个点系统会叫你，到时候还可以改主意。`,
        '- 这几件别都是一类：窝着看东西、上网查点什么、动手做点什么、出门走走、收拾整理、写点东西……尽量错开，别一整天都在同一个场景里。昨天做得最多的那类今天少排。',
        '- 查东西和动手做是两件事，分开排：查（bili / web）是一条，查完这条就算做完；真动手做（下厨、缝补、拼东西这类）是另一条生活里的事，action 自己起名字，到点就当你在做。',
        `- 大部分是你自己的事：你自己的兴趣、在弄的东西、想看想学的。跟${owner}有关的最多一条，而且要有具体由头（比如聊天里提到的事），别写"找他聊天"这种空话，平常天气只是背景也不算由头（真要下雨或明显降温提醒带伞添衣才算）。`,
        `- 不用把时间塞满。想留一段空闲就排一条 action 写「${FREE_ACTION}」（what 写「下午随便待着」这类），到点你再看那会儿想干嘛；心情不好可以少排，想偷懒也行。`,
        '- 别忘了吃饭哦～还没过的那几顿顺手排上，不占上面的名额：action 起个名字比如「吃午饭」，what 写吃什么（像平常过日子，具体点，别太丰盛），time 写大概几点。到点就当你在吃，这段时间别人找你会晚点回。别的生活小事（午睡、洗澡、下厨）也这样：action 起个名字，到点就当你在做。',
        '',
        y && (y.items.length || y.done.length) ? '先用你自己的口气说一两句昨天过得怎么样，没做成的也照实说，然后排今天。' : '',
        '只输出 JSON：',
        '{"yesterday":"一两句，昨天过得怎么样（没有昨天就空着）","theme":"今天大概想怎么过，一句话","items":[{"slot":"morning/afternoon/evening/night","what":"具体想做的事，20 字以内","why":"为什么想做，一句","action":"上面能做的事之一（bili/web/outing/diary/draw/speak…）、free（空闲），或你给生活小事起的短名字","time":"几点开始，比如 14:30","busyMin":"大概占多少分钟","canPause":"这段时间有人找你能不能放下先回，true/false","energy":"做完精力怎么变，-10 到 +25"}]}',
      ]
        .filter((x) => x !== '')
        .join('\n');

      let out = '';
      let j = null;
      if (typeof api.think === 'function') {
        try {
          out = await api.think(text, { title: '自主生活 · 想想今天', timeoutMs: 150_000, noTools: true, key: 'plan' });
          j = parseJsonLoose(out);
          if (!j) api.log.warn('自主生活：定计划（think）没回 JSON，改用 ask：' + clip(out, 120));
        } catch (error) {
          api.log.warn('自主生活：定计划（think）失败，改用 ask：' + error.message);
        }
      }
      if (!j) {
        try {
          out = await ask(api.dsh, { key: 'plan-fallback', cfg: api.config(),
            system: '你是一个有自己生活的角色，刚睡醒，在想今天怎么过。只输出 JSON。',
            text,
            maxTokens: 1800,
            temperature: 0.95,
            timeoutMs: Math.max(30, Number(c.askTimeoutSec) || 45) * 1000,
          });
          j = parseJsonLoose(out);
        } catch (error) {
          api.log.warn('自主生活：定计划失败 ' + error.message);
        }
      }
      if (!j) {
        a.planTries = (Number(a.planTries) || 0) + 1;
        if (a.planTries >= 3) {
          // 三次都没定成：剩下的每个时段留一段空闲，到点她自己看想干嘛（别一整天没有一个能叫醒她的点）
          for (const slot of SLOTS) if (!slotPassed(slot, hour)) addItem(a, { slot, what: `${SLOT_LABEL[slot]}随便待着`, from: 'self', action: FREE_ACTION }, { hour });
          a.planned = true;
          api.log.warn('自主生活：今天的安排三次都没定成，剩下的时段各留一段空闲');
        }
        return false;
      }

      a.theme = clip(j.theme, 40);
      const added = [];
      for (const it of (Array.isArray(j.items) ? j.items : []).slice(0, 10)) {
        if (!it || typeof it !== 'object') continue;
        // 带时间的（吃饭这类）：时间说了算，只认今天还没过的点；过了的那顿就不排了
        let at = 0;
        const tm = String(it.time || '').match(/^(\d{1,2})[:：](\d{2})$/);
        if (tm) {
          const d0 = new Date();
          d0.setHours(Number(tm[1]), Number(tm[2]), 0, 0);
          if (d0.getTime() < Date.now() - 10 * 60_000) continue;
          at = d0.getTime();
        }
        const slot = at ? slotOf(new Date(at).getHours()) : it.slot;
        if (!at && slotPassed(slot, hour)) continue; // 没写时间、又排到已经过去的时段：丢掉
        const r = addItem(a, { slot, what: it.what, why: it.why, from: 'self', action: it.action, age: inheritAge(it.what, carries), at, ...(at ? selfReport(it) : {}) }, { hour });
        if (r.ok) added.push(r.item);
      }
      const recap = clip(j.yesterday, 120);
      if (recap && y) {
        a.recap = recap;
        // 昨晚早睡、一篇日记都没写：今早补记一段
        if (y.ymd && diaryCount(y.ymd) === 0) {
          try {
            fs.mkdirSync(diaryDir(), { recursive: true });
            fs.appendFileSync(diaryFile(y.ymd), `## 第二天早上补记\n\n${recap}\n\n`, 'utf8');
          } catch (error) {}
        }
        try {
          const mem = api.use('memory');
          if (mem && typeof mem.addEvent === 'function') mem.addEvent({ text: `${y.day ? new Date(y.day).toLocaleDateString('zh-CN') + ' ' : ''}昨天：${recap}`, tags: ['自主生活'], importance: 0.4 });
        } catch (error) {}
      }
      a.planned = true;
      s.yesterday = null;
      appendLog({ at: Date.now(), action: 'plan', why: a.theme, detail: added.map((x) => `${SLOT_LABEL[x.slot]} ${x.what}`).join('；'), note: recap ? `昨天：${recap}` : '定了今天的安排' });
      api.log.info(`自主生活：今天的安排（${a.theme || '无主题'}）—— ${added.map((x) => `${SLOT_LABEL[x.slot]}·${x.what}`).join('，') || '没排'}`);
      return true;
    }

    // item：日程上到点的那一条（tick 传进来）；没传就找一条到点的，再没有就当这会儿是空闲时间
    async function wake({ item: forItem = null } = {}) {
      const c = cfg();
      if (!c.enabled) return { ok: false, message: '没开' };
      // 决策要问模型；没授权就到此为止，别去碰宿主
      if (!isGranted(api.settings(), 'model')) {
        return { ok: false, message: '「调用模型做决策」还没授权（面板 → 自主生活 → 权限）' };
      }

      const s = load();
      const hour = new Date().getHours();
      const from = Number(c.awakeFrom) || 0;
      const to = Number(c.awakeTo) || 24;
      const awake = from <= to ? hour >= from && hour < to : hour >= from || hour < to;
      if (!awake) {
        s.nextWakeAt = Date.now() + 45 * 60_000;
        save(s);
        return { ok: false, message: '不在活跃时段' };
      }
      if (s.wakes >= (Number(c.maxWakesPerDay) || 40)) {
        s.nextWakeAt = Date.now() + 3 * 60 * 60_000;
        save(s);
        return { ok: false, message: '今天次数用完了' };
      }

      ensureEnergy(s, c);
      // 今天第一次醒：先想想今天怎么过
      if (!s.agenda.planned) {
        try {
          await planDay(s, c);
        } catch (error) {
          api.log.warn('自主生活：定计划出错 ' + error.message);
        }
        save(s);
        // 没排成（模型没回 / 网络不通）：15 分钟后再排，这一轮不做别的
        if (!s.agenda.planned) {
          s.nextWakeAt = Date.now() + 15 * 60_000;
          save(s);
          return { ok: false, message: '今天的安排还没排成，过一会儿再排' };
        }
      }
      ensureTimes(s.agenda);
      // 这一轮为哪一条想：tick 传来的那条（重新从 s 里取，load 之后是新对象）；/wake 手动叫醒时找一条到点的
      const focus = (forItem && s.agenda.items.find((x) => x.id === forItem.id && x.state === 'todo')) || dueItem(s.agenda, Date.now(), autoItem);
      const isFree = !focus || focus.action === FREE_ACTION;
      const upNext = nextItem(s.agenda);

      const nowMs = Date.now();
      const agoLabel = (t) => {
        const mins = Math.max(1, Math.round((nowMs - Number(t || 0)) / 60_000));
        return mins >= 60 ? `${Math.floor(mins / 60)}小时${mins % 60 ? (mins % 60) + '分' : ''}前` : `${mins}分钟前`;
      };
      const recent3h = (s.done || []).filter((x) => nowMs - (Number(x.at) || 0) <= 3 * 3600_000).slice(0, 8);
      const recentList = recent3h.length ? recent3h : (s.done || []).slice(0, 5);
      const recent = recentList.map((x) => `${clock(x.at)}（${agoLabel(x.at)}）${x.action}${x.topic ? `〔${x.topic}〕` : ''}${x.dry ? '（只是想了想，没动手）' : ''}：${x.note || ''}`);
      // 最近 24 小时同一件事（她自己写的话题名）花了几轮：只给事实，换不换由她定
      const topicTally = new Map();
      for (const x of s.topicLog || []) {
        if (!x.topic || x.action === 'rest' || nowMs - (Number(x.at) || 0) > 24 * 3600_000) continue;
        const t = topicTally.get(x.topic) || { n: 0, by: new Map() };
        t.n += 1;
        t.by.set(x.action, (t.by.get(x.action) || 0) + 1);
        topicTally.set(x.topic, t);
      }
      const topicFacts = [...topicTally]
        .filter(([, v]) => v.n >= 2)
        .sort((a, b) => b[1].n - a[1].n)
        .slice(0, 3)
        .map(([k, v]) => `「${k}」${v.n} 轮（${[...v.by].map(([a, n]) => `${a} ${n}`).join('、')}）`);
      // 今天做够数的动作：从「可以接着做」的菜单里撤掉，免得它们反复出现在眼前被顺手选中
      const usedUp = usedUpToday(s);
      // 今天各类做了几次：软的自娱自乐不能占满一整天
      const kinds = kindsToday(s);
      const softLeft = Math.max(0, SOFT_MAX_PER_DAY - kinds.soft);
      const softBlocked = softLeft <= 0;
      const hardMissing = kinds.learn + kinds.build === 0 && (s.done || []).filter((x) => !x.dry).length >= 3;
      const plan = agendaBlock(s.agenda, { hour, timers: s.timers });
      // 上次醒来之后和主人聊了什么（最多往回看三小时）：聊天能改安排
      const lastWakeAt = (s.done && s.done[0] && Number(s.done[0].at)) || 0;
      const chatSince = Math.max(Date.now() - 3 * 3600_000, lastWakeAt);
      const chatLines = ownerChatLines(chatSince, 8);
      const ownerName = ownerOf().name;
      const replansLeft = Math.max(0, REPLAN_MAX_PER_DAY - (Number(s.agenda.replans) || 0));
      const brokenList = Object.keys(s.fails.until || {}).filter((k) => brokenNow(s, k) && !moduleMissing(k));
      const now = `${new Date().toLocaleDateString('zh-CN', { weekday: 'long' })} ${clock()}`;
      const moodNote = String(c.moodNote || '').trim();
      const invented = Object.entries(s.customActions || {})
        .filter(([k]) => !STANDARD_ACTIONS.has(k))
        .filter(([k]) => timesToday(s, k) < ACTION_MAX_PER_DAY)
        .sort((a, b) => (Number(b[1].count) || 0) - (Number(a[1].count) || 0))
        .slice(0, 4)
        .map(([k, v]) => `${k}（${Number(v.count) || 1}次）`);
      const mood = moodLine();
      // 想起相关的事：拿今天的安排、正在弄的去搜（最近做过的事上面已经列着，不拿来搜，免得搜回它自己）
      const memHints = await recallHints(6, [...((s.agenda && s.agenda.items) || []).filter((x) => x.state !== 'dropped').map((x) => x.what), s.project && s.project.name].filter(Boolean));
      // 这一轮允不允许「只想不做」：今天想过太多次、或者上一次醒来就只是在想 —— 都不许再想
      const thinkUsed = Number(s.thinkToday) || 0;
      const lastWasDry = !!(s.done && s.done[0] && s.done[0].dry);
      const thinkAllowed = thinkUsed < THINK_LIMIT_PER_DAY && !lastWasDry;
      const hourNow = new Date().getHours();
      const rate = rateForHour(parseActivityTable(c.activityTable), hourNow);
      const pace =
        rate < 0.6
          ? '这会儿是你最活跃的时间，可以干点大的、复杂的'
          : rate > 1.2
            ? '这会儿是你的低谷，别硬撑，做点轻的'
            : '这会儿节奏平常';

      const text = [
        `现在是 ${now}。`,
        '',
        plan,
        '',
        focus && !isFree
          ? [
              `【现在到点的这一条】[${focus.id}] ${clock(focus.at)} · ${focus.what}${focus.why ? `（${focus.why}）` : ''}${focus.from === 'promise' ? '〔答应主人的〕' : ''}`,
              focus.progress ? `之前为它做过：${focus.progress}` : '',
              focus.note ? `上次的情况：${focus.note}` : '',
              `照着做就填 agendaId「${focus.id}」。现在不想做：用 ops 把它 defer 到别的时间（写 time），或者 drop 掉${focus.from === 'promise' ? '（答应主人的不能 drop，只能挪）' : ''}，然后这会儿做点别的、或者歇着都行。没挪也没做的话，它会往后推一小时再问你。`,
            ].filter(Boolean).join('\n')
          : `【现在】这会儿没排事${upNext ? `（下一条是 ${clock(upNext.at)} 的「${upNext.what}」）` : '（今天排的都过了）'}，${focus ? `这段「${focus.what}」是你留给自己的空闲，` : ''}想干嘛都行，歇着也行。`,
        chatLines.length
          ? `【上次醒来之后你和${ownerName}聊过】\n${chatLines.join('\n')}\n聊到的事如果影响今天（他说今晚忙、你们约了什么、他提到想看的东西），就改一下安排。`
          : '',
        '',
        '【你是谁】',
        styleHint(c),
        mood ? `你此刻的心情：${mood}` : '',
        energyPrompt(s),
        s.weather && s.weather.now ? `天气：${weatherLine(s.weather)}` : '',
        `你的作息倾向：${pace}（时段倍率 ${rate}）。`,
        '',
        recent.length ? `${recent3h.length ? '最近 3 小时做过' : '你最近做过'}：\n${recent.join('\n')}` : '你今天还没做过什么。',
        topicFacts.length ? `最近 24 小时花在同一件事上的轮数：${topicFacts.join('；')}。` : '',
        findingsBlock(s),
        usedUp.length ? `【今天已经做够的】${usedUp.join('、')}——今天一次都不许再做了，换一件没做过的。` : '',
        invented.length ? `你自己发明过的活动：${invented.join('、')}——可以接着做，也可以发明新的。` : '',
        memHints.length ? `你想得起来的几件事：\n${memHints.join('\n')}` : '',
        s.note ? `上次你留给自己的话：「${s.note}」` : '',
        '',
        '这是你自己的时间，没人盯着，也不用汇报。',
        '',
        '按上面这条来，或者临时换成别的都行。不想动就选 rest 歇着——窝着、躺会儿、发会儿呆都算。歇着不丢人，人本来就不是一直在忙。',
        `同一件事一天别超过 ${ACTION_MAX_PER_DAY} 次，翻来覆去做同一件就没意思了。`,
        thinkAllowed
          ? thinkUsed > 0
            ? `（今天已经光想不做 ${thinkUsed} 次了，这次真想做点什么就去做。）`
            : ''
          : '（上次只是想了想，这次别再光想：要么做点什么，要么歇着。）',
        '',
        cantDo(s, 'phone')
          ? ''
          : (() => {
              const cnt = todayCounts(s);
              const cap = Math.max(0, Number(c.phoneMaxPerDay) || 100);
              const left = Math.max(0, cap - cnt.phone);
              return '【今天的额度】手机今天逛了 ' + cnt.phone + ' 次，剩 ' + left + ' 次' + (left > 0 ? '' : '（用完了，这一轮别选 phone）') + '。';
            })(),
        brokenList.length ? `【这些最近老是做不成，今天先别选】${brokenList.join('、')}` : '',
        '下面是你现在能做的事：',
        `- speak：找${ownerName}说句话——detail 写具体想说什么（平常天气只是背景不算由头，真要下雨提醒带伞、明显降温提醒添衣才算）；安排里有对应的那条就填 agendaId`,
        cantDo(s, 'bili') ? '' : '- bili：去 B 站看视频——随便刷刷就不填 query；想在 B 站找具体的东西（教程、某个梗、某首歌），query 写 B 站搜索框里搜的词（两三个词，比如「马克杯蛋糕 微波炉」），会只看搜到的视频（听里面说了什么、看画面和弹幕），没搜到会如实告诉你',
        cantDo(s, 'web') ? '' : `- web：自己上网查点东西——detail 写你想查什么（「最近有什么好看的冷门动画」「番茄炒蛋先放蛋还是先放番茄」），query 写拿去搜索引擎搜的几个关键词，会去搜一下、点开一条看${webBlockedText(s) ? `（最近打不开的网站：${webBlockedText(s)}）` : ''}`,
        cantDo(s, 'diary') ? '' : `- diary：写一篇只给自己看的日记（一天最多 ${DIARY_MAX_PER_DAY} 篇）——detail 写想写什么`,
        cantDo(s, 'phone') ? '' : '- phone：拿起手机玩——手机就在桌上连着线，上面装了 B站、知乎、QQ、高德、DeepSeek、笔记、相册、日历、相机，按你自己的兴趣打开看看、随手记两句都行',
        cantDo(s, 'draw') ? '' : '- draw：给自己画一张图',
        cantDo(s, 'outing') ? '' : `- outing：出门去附近真实存在的地方，想去哪都行——place 写想去什么样的地方（「能翻食谱的书店」「江边走走」「花店」），query 写在地图上搜的词，几个词用空格隔开（「书店 图书馆」「江边 公园」），会把附近真的几家列给你挑；detail 写去干嘛；今天还能出门 ${Math.max(0, OUTING_MAX_PER_DAY - (Number((s.dayCounts || {}).outing) || 0))} 次`,
        thinkAllowed ? '- think：认真想一件让你好奇的事（光想不做，一天别太多）' : '- think：（这一轮关掉了，别选）',
        '- rest：歇着——窝着、躺会儿、发会儿呆都算',
        `- 生活里的事：吃饭、散步、洗澡、收拾房间、看会儿书、窝着听歌……自己起个短名字当 action，detail 写清楚做了什么（「楼下面馆吃了碗牛肉面」）。这些算你真的过了这一段，之后聊天能提起来。${cantDo(s, 'outing') ? '' : '要出门去具体的店、公园就用 outing，会挑附近真的地方。'}`,
        '',
        '只回一个 JSON：',
        '{"action":"上面某一个动作，或者你给生活里的事起的短名字","kind":"soft/learn/build/other 之一","why":"一句话理由","detail":"想做什么的简短描述","agendaId":"这次是在做安排里的哪一条（比如 a2），不是就空字符串","agendaDone":true,"topic":"这件事说的是什么，几个字","query":"","place":"","ops":[],"busyMin":30,"canPause":true,"energy":-2}',
        'agendaDone：填了 agendaId 才看——这一轮做完，那条是不是就算做完了；只是为它查资料、看教程、做准备，写 false。',
        'topic：这件事说的是什么，几个字（「马克杯蛋糕」「Re0」「厚外套」）；跟上面列过的是同一件事就沿用同一个名字。query：web、bili、outing 才填——web 是拿去搜索引擎搜的关键词，bili 是 B 站搜索框里搜的词（随便刷就空着），outing 是地图上搜的词。place：只有 outing 才填，想去什么样的地方。',
        'busyMin / canPause / energy 说的是这件事本身，按你自己的情况填：busyMin 大概要占你多少分钟（不占手就 0）；canPause 这期间有人找你，能不能随手放下先回（true / false）；energy 做完精力大概怎么变（-10 到 +25 的整数，回血就正，累人就负）。',
        replansLeft > 0
          ? [
              'ops 是对今天安排的改动，没变化就给空数组，最多 3 条：',
              '  {"op":"add","time":"21:00","what":"想做的事","action":"bili","why":"为什么","from":"seen"}  —— time 写几点做；from 写 seen 表示是刚看到的东西引出来的，否则写 self',
              '  {"op":"drop","id":"a3","why":"为什么不做了"}',
              '  {"op":"defer","id":"a3","time":"21:30","why":"为什么挪"}',
              '这件事没做成、想晚点再试（比如没查到、店关了），就 add 一条写清楚几点再做什么。',
              `比如刚刷到的东西想晚点跟${ownerName}聊，就 add 一条晚上的 speak；${ownerName}说今晚加班，就把晚上找他的那条挪后或划掉。刷 B 站时已经顺手分享过的别再排。标着「答应主人的」那几条你不能删也不能挪。`,
            ].join('\n')
          : '今天安排已经改过很多次了，这一轮 ops 给空数组。',
        'kind：消遣写 soft，学东西写 learn，做出点什么写 build，其余写 other。detail 只写一句话描述。',
        cantDo(s, 'phone') ? '' : '手机上的红线：别碰小红书（风控会把账号踢下线）、别打开淘宝、别动系统设置；别给真人发消息。',
      ].filter(Boolean).join('\n');

      const askArgs = {
        key: 'wake',
        system: '你是一个有自己生活的角色。现在是你的私人时间，没人跟你说话，你只决定自己接下来做什么。只输出 JSON。',
        text,
        cfg: api.config(),
        maxTokens: 1600,
        temperature: 0.9,
        // 2026-11-21 回放今早的真实提示词：low 时 8/10 又去搜同一件事（蛋糕循环），medium 时 9/10 照安排去做；多几百个思考 token
        reasoningEffort: 'medium',
        // 模型卡住时最多等这么久，超了就放弃这一轮（按 settings.askTimeoutSec，默认 45 秒）
        timeoutMs: Math.max(1, Number(c.askTimeoutSec) || 45) * 1000,
      };

      let d = null;
      let banned = '';
      let blockedForRepeat = 0;
      let blockedForSoft = 0;
      // 最多问两次：模型偶尔返回空、只给半截 JSON（尤其和 QQ 会话并发时）
      let modelErrors = 0; // 两次都是模型那边报错（多半是网络 / 代理没起来），不是她没想法
      for (let attempt = 0; attempt < 2 && !d; attempt += 1) {
        try {
          if (attempt > 0) await new Promise((r) => setTimeout(r, 4000));
          const askThis = banned
            ? { ...askArgs, text: askArgs.text + `\n\n【这一轮绝对不许再选「${banned}」】今天这件已经做够了，换一件没做过的。` }
            : askArgs;
          const out = await ask(api.dsh, askThis);
          let p = parseDecision(out);
          if (!p) {
            api.log.warn(`自主生活：第 ${attempt + 1} 次解析失败，原始输出：` + String(out || '').slice(0, 200));
            continue;
          }
          // 这一轮不许只想不做，她还非要选 think：判无效，重新要一个动作
          if (p.action === 'think' && !thinkAllowed) {
            api.log.info(`自主生活：这一轮不许只想不做，打回重新决策（why：${p.why.slice(0, 30)}）`);
            continue;
          }
          // 模块没开 / 最近老失败的动作：打回换一件
          if (cantDo(s, p.action)) {
            const why = moduleMissing(p.action) ? '模块没开' : brokenNow(s, p.action) ? '最近连着失败' : '今天做够了';
            api.log.info(`自主生活：「${p.action}」现在做不了（${why}），打回换一件`);
            banned = p.action;
            blockedForRepeat += 1;
            continue;
          }
          // 今天这件已经做够了（相似名字一并算）：硬拦，逼她换一件
          if (p.action !== 'rest' && timesToday(s, p.action) >= ACTION_MAX_PER_DAY) {
            const n = timesToday(s, p.action);
            api.log.info(`自主生活：今天「${p.action}」已经做过 ${n} 次，打回换一件`);
            banned = p.action;
            blockedForRepeat += 1;
            continue;
          }
          // 软的东西已经够多了：这一轮必须去学一件或造一件（软可以，但不能一整天只有软）
          const pk = KINDS.includes(p.kind) ? p.kind : guessKind(p.action, `${p.detail} ${p.why}`);
          if (pk === 'soft' && softBlocked) {
            api.log.info(`自主生活：今天软的已经 ${kinds.soft} 次，这一轮不许再软（${p.action}），打回去学或造`);
            banned = p.action;
            blockedForSoft += 1;
            continue;
          }
          p = { ...p, kind: pk };
          d = p;
        } catch (error) {
          api.log.warn(`自主生活：第 ${attempt + 1} 次决策失败 ${error.message}`);
          modelErrors += 1;
        }
      }
      // 两次都没成：如果是「今天的事都做够了」就歇着（推迟下次醒），
      // 如果是模型那边彻底没响应，才在机器上记一笔。
      if (!d) {
        if (blockedForSoft > 0) {
          d = { action: 'think', kind: 'learn', why: '这一轮不许再软，也没别的可做，先记点想法', detail: '', steps: [], nextMinutes: 0 };
          api.log.info('自主生活：这一轮不许再软，改成只想不做');
        } else if (blockedForRepeat > 0) {
          d = { action: 'rest', why: '今天想做的事都做过了，先歇着', detail: '', steps: [], nextMinutes: 0 };
          api.log.info('自主生活：今天没有没做过的事可做，改成歇着');
        } else if (modelErrors >= 2) {
          // 模型连不上：不算她发呆，10 分钟后再醒来想（别按作息表一睡两小时）
          d = { action: 'idle', why: '模型连不上，过一会儿再想', detail: '', steps: [], nextMinutes: 0, retrySoon: true };
          api.log.info('自主生活：两次决策都连不上模型，10 分钟后再试');
        } else {
          d = { action: 'idle', why: '这一轮没想出要做什么', detail: '', steps: [], nextMinutes: 0 };
          api.log.info('自主生活：两次都没拿到可用决策，改成发呆');
        }
      }

      if (d.action === FREE_ACTION) d.action = 'rest'; // 「空着」不是动作：这会儿就是歇着

      // 先改表（看到的、聊到的引起的变化），再去做事
      let agendaChanges = [];
      if (d.ops && d.ops.length && (Number(s.agenda.replans) || 0) < REPLAN_MAX_PER_DAY) {
        const r = applyOps(s.agenda, d.ops, { by: 'self', hour });
        agendaChanges = r.applied;
        if (r.applied.length) s.agenda.replans = (Number(s.agenda.replans) || 0) + 1;
        if (r.applied.length || r.rejected.length) api.log.info(`自主生活：改安排 ${[...r.applied, ...r.rejected.map((x) => '✗ ' + x)].join('；')}`);
      }
      // 她说这轮在做安排里的哪一条：动作对得上才认（那条写的是 speak，这轮去刷 B 站，不算做了那条）
      const item = d.agendaId
        ? s.agenda.items.find((x) => x.id === d.agendaId && x.state === 'todo' && (!x.action || !STANDARD_ACTIONS.has(x.action) || x.action === d.action)) || null
        : focus && !isFree && focus.action === d.action ? focus : null;

      let result = { note: '', extra: {} };
      try {
        result = await act(d, s);
      } catch (error) {
        result = { note: `动作失败：${error.message}`, extra: { ok: false } };
      }

      noteOutcome(s, d.action, !(result.extra && result.extra.ok === false) || !!(result.extra && result.extra.later));
      // 精力、心情跟着这件事走一点（只对明确的失败微调，不再固定概率随机加分）
      {
        const okDone = !(result.extra && result.extra.ok === false);
        if (okDone) addEnergy(s, d.energy != null ? d.energy : item && item.energy != null ? item.energy : energyDelta(d.action));
        if (!okDone && !(result.extra && result.extra.later) && d.action !== 'speak') moodNudge(-2, `想${clip(d.detail || d.action, 12)}没做成`);
      }
      // 安排里那条：做成了就勾掉；没做成留着，记一下卡在哪
      if (item && !['think', 'rest', 'idle'].includes(d.action)) {
        if (result.extra && result.extra.ok === false) {
          item.note = clip(result.note, 40);
          item.tries = (Number(item.tries) || 0) + 1;
        } else if (d.agendaDone === false) {
          // 只是为这条做了准备（查配方、看教程）：记下做过什么，这条本身还没做
          item.progress = clip(result.note, 160);
        } else {
          item.state = 'done';
          item.note = clip(result.note, 60);
          item.doneAt = Date.now();
        }
      }

      // 到点的那一条：空闲段想过就算过了；正经的一条没做、也没挪 / 划，往后推一小时再问（模型连不上就 10 分钟后再问）
      if (focus && focus.state === 'todo' && focus.at <= Date.now()) {
        if (d.retrySoon) focus.retryAt = Date.now() + 10 * 60_000;
        else if (isFree) {
          focus.state = 'done';
          focus.note = clip(result.note || d.detail || d.action, 60);
          focus.doneAt = Date.now();
        } else {
          focus.at = Date.now() + 60 * 60_000;
          focus.slot = slotOf(new Date(focus.at).getHours());
          focus.skips = (Number(focus.skips) || 0) + 1;
        }
      }

      // 只想不做的一轮（dry）：不算「手上在弄的事」，也不进记忆库 —— 否则提示词会一直催她接着「想」
      const dry = d.action === 'think';
      const resting = d.action === 'rest';
      const at = Date.now();
      s.wakes += 1;
      s.thinkToday = (Number(s.thinkToday) || 0) + (dry ? 1 : 0);
      // 连续性：只统计真正连续做的当前活动；换去做别的事后立刻更新，避免旧项目卡一整天。
      if (!dry && !resting && d.action !== 'idle' && d.action !== 'speak') {
        const sameAsBefore = s.project && s.project.name === d.action;
        if (sameAsBefore) {
          s.project = {
            name: d.action,
            times: (Number(s.project.times) || 1) + 1,
            lastNote: String(result.note || '').slice(0, 80),
            at,
          };
        } else {
          s.project = { name: d.action, times: 1, lastNote: String(result.note || '').slice(0, 80), at };
        }
      }
      // 生活里的事写进记忆（做过的事），聊天时她能想起来「刚吃了碗面」；节流 15 分钟
      if (result.extra && result.extra.life && Date.now() - (Number(s.lastLifeMemoAt) || 0) > 15 * 60_000) {
        try {
          const mem = api.use('memory');
          if (mem && typeof mem.addEvent === 'function') {
            mem.addEvent({ text: clip(result.note, 120), tags: ['自主生活', '生活'], importance: 0.35 });
            s.lastLifeMemoAt = Date.now();
          }
        } catch (error) {}
      }
      // 手机上做的活动也写进记忆库，这样 QQ 上聊起来能接上
      // 节流 20 分钟：她一天醒上百次，不节流会把记忆库灌爆
      const isVmAction =
        d.action === 'draw' || d.action === 'phone';
      if (isVmAction && !(result.extra && result.extra.ok === false) && Date.now() - (s.lastMemoAt || 0) > 20 * 60_000) {
        try {
          const mem = api.use('memory');
          if (mem && typeof mem.add === 'function') {
            mem.add({
              text: String(result.note || '').slice(0, 160) || (d.action === 'draw' ? '画了张图' : '玩了会儿手机'),
              tags: [d.action],
              importance: 0.5,
              source: 'autonomy',
            });
            s.lastMemoAt = Date.now();
          }
        } catch (error) {}
      }
      // 她发明的动作记下来，下次提示词里会提到，能接着做
      if (!STANDARD_ACTIONS.has(d.action)) {
        const prev = s.customActions[d.action] || { count: 0 };
        s.customActions[d.action] = { count: (Number(prev.count) || 0) + 1, last: at, sample: String(d.detail || '').slice(0, 80) };
      }
      // 当天动作累计：额度按这个数（done 只留 50 条，拿它数额度会越算越少）
      if (!s.dayCounts || typeof s.dayCounts !== 'object') s.dayCounts = {};
      s.dayCounts[d.action] = (Number(s.dayCounts[d.action]) || 0) + 1;
      // 这件事要忙一阵：这期间来私聊会晚点回（reply/hold）
      if (!(result.extra && result.extra.ok === false)) {
        // 出门这种有真实耗时的按真实的算；别的听她自己报的，没报才按动作类型给个大概
        const own = d.busyMin != null ? d.busyMin : item && item.busyMin != null ? item.busyMin : null;
        const mins = NOT_BUSY_ACTIONS.includes(d.action) ? 0 : Number(result.extra && result.extra.busyMin) || (own != null ? own : busyMinutes(d.action));
        const canPause = d.canPause != null ? d.canPause : item && item.canPause != null ? item.canPause : null;
        if (mins > 0) s.busy = { since: at, until: at + mins * 60_000, what: clip((result.extra && result.extra.busyWhat) || (result.extra && result.extra.life ? result.note : '') || (item && item.what) || d.detail || d.action, 24), canPause };
      }
      s.done = [
        { at, action: d.action, note: String(result.note || '').slice(0, 160), brief: clip((result.extra && result.extra.life ? result.note : '') || (item && item.state === 'done' ? item.what : '') || d.detail || d.why, 30), dry, kind: d.kind || '', why: String(d.why || '').slice(0, 60), ...(d.topic ? { topic: d.topic } : {}), ...(item ? { agendaId: item.id } : {}) },
        ...(s.done || []),
      ].slice(0, 50);
      if (d.topic && d.action !== 'rest') s.topicLog = [{ at, topic: d.topic, action: d.action }, ...(s.topicLog || [])].slice(0, 60);
      if (result.extra && result.extra.finding && result.extra.finding.text && !s.__trial) {
        const f = result.extra.finding;
        s.findings = [{ at, topic: clip(d.topic || f.query, 20), query: clip(f.query, 40), text: String(f.text).slice(0, 700) }, ...(s.findings || [])].slice(0, FINDINGS_MAX);
      }
      // 空想和歇着都不覆盖「留给自己的话」——否则那句话会在下次提示词里自己喂自己
      if (!dry && !resting) s.note = d.why || '';
      // 不再定时醒：下次是日程上的下一条（只给状态显示用；没排日程时它管什么时候排）
      s.nextWakeAt = (nextItem(s.agenda) || {}).at || 0;
      mergeOwnerEdits(s, readJson(stateFile(), null));
      save(s);

      appendLog({
        at,
        action: d.action,
        why: d.why,
        detail: d.detail || (d.steps && d.steps.length ? d.steps.join('\n───\n') : ''),
        note: result.note,
        output: result.extra && result.extra.output ? String(result.extra.output).slice(0, 600) : '',
        nextMinutes: s.nextWakeAt ? Math.max(0, Math.round((s.nextWakeAt - Date.now()) / 60_000)) : 0,
        ...(d.topic ? { topic: d.topic } : {}),
        ...(item ? { agendaId: item.id, agendaDone: d.agendaDone !== false } : {}),
        ...(agendaChanges.length ? { agenda: agendaChanges } : {}),
      });

      const nx = nextItem(s.agenda);
      api.log.info(`自主生活：${d.action} —— ${result.note}${focus ? `〔${focus.id}〕` : ''}（${nx ? `下一条 ${clock(nx.at)}「${clip(nx.what, 16)}」` : '今天排的都过了'}）`);
      return { ok: true, action: d.action, note: result.note, next: nx ? { id: nx.id, at: nx.at, what: nx.what } : null };
    }

    // 每分钟检查，到点才干活
    // 防重入：一次 wake 可能跑好几分钟（手机任务 150 步），而 tick 每 60 秒来一次。
    // 以前没有这道锁，任务跑着的同时后面几次 tick 会继续进 wake，并发发出四五个手机任务，
    // 结果全撞在 phone 的会话锁上，一个个 0 步就「手机正被其他任务占用」失败掉。
    let waking = false;
    api.every(60_000, async () => {
      const c = cfg();
      if (!c.enabled) return;
      try {
        syncCoreWindow(c);
      } catch (error) {
        api.log.warn('自主生活：同步作息出错 ' + error.message);
      }
      if (waking) return; // 上一轮还没结束，这一分钟的 tick 直接跳过
      const s = load();
      try {
        await catchUpHeld(s);
        if (await catchUpGroups(s)) save(s);
      } catch (error) {
        api.log.warn('自主生活：补回晚回消息出错 ' + error.message);
      }
      // 精力（今天第一次醒着时定个起点）、天气（两小时一次）
      {
        const hadEnergy = s.energy && s.energy.day === dayKey();
        ensureEnergy(s, c);
        const wChanged = await refreshWeather(s);
        if (wChanged || (!hadEnergy && s.energy)) save(s);
      }
      // 安排里到点的事（吃饭这类）
      if (tickTimedItems(s, c)) save(s);
      // 出门回来：写经历；要发的照片
      try {
        if (s.outing && Date.now() >= s.outing.returnAt) {
          waking = true;
          try {
            await finishOuting(s);
          } finally {
            waking = false;
          }
          save(s);
        }
        if (await tickPendingShare(s)) save(s);
      } catch (error) {
        api.log.warn('自主生活：发出门照片出错 ' + error.message);
      }
      // 睡前例行：离睡觉不到 40 分钟、今天还没走过这一步
      if (isAwakeHour(c) && s.bedtimeDay !== dayKey()) {
        const sleepAt = nextSleepAt(c);
        if (sleepAt && sleepAt - Date.now() <= 40 * 60_000) {
          s.bedtimeDay = dayKey();
          save(s);
          waking = true;
          try {
            await bedtime(s, c);
          } catch (error) {
            api.log.warn('自主生活：睡前例行出错 ' + error.message);
          } finally {
            waking = false;
          }
          return;
        }
      }
      // 方案 B：睡后或次日开机补做会话整理归档（避开 DSH 80% 英文代码压缩）
      try {
        await maybeRolloverSessions(s, c);
      } catch (error) {
        api.log.warn('自主生活：睡后整理会话出错 ' + error.message);
      }
      // 和主人约好几点的事：到点直接在私聊里叫她开口（不经过决策，不受活跃时段、次数限制）
      if (!s.lastSeenAt || Date.now() - Number(s.lastSeenAt) > 5 * 60_000) {
        s.lastSeenAt = Date.now();
        save(s);
      }
      // 睡着时到点的提醒先不发，等醒了按「那会儿你不在、现在才想起来」补
      const due = isAwakeHour(c) ? (s.timers || []).find((t) => !t.fired && t.at <= Date.now()) : null;
      if (due) {
        due.fired = true;
        save(s);
        // 电脑关着错过了：晚太久（12 小时以上）就算了；晚了半小时以上，换成「现在才想起来」的说法
        const overdue = Date.now() - Number(due.at);
        if (overdue > 12 * 3600_000) {
          appendLog({ at: Date.now(), action: 'timer', why: due.why || '', detail: due.what, note: `错过了（${clock(due.at)} 那会儿不在），没补` });
          api.log.info(`自主生活：定时提醒「${due.what}」错过太久，不补了`);
          return;
        }
        try {
          const r = await reachOwner(s, { what: due.what, why: due.why, promise: true, timed: true, followup: due.kind === 'followup', lateFrom: overdue > 30 * 60_000 ? due.at : 0 });
          appendLog({ at: Date.now(), action: 'timer', why: due.why || '', detail: due.what, note: r.note });
          api.log.info(`自主生活：定时提醒「${due.what}」—— ${r.note}`);
        } catch (error) {
          api.log.warn('自主生活：定时提醒没发出去 ' + error.message);
        }
        return;
      }
      // 不再定时醒：每天第一次醒来先排日程，之后只在日程上某一条到点时叫决策层为它想一下
      if (!isAwakeHour(c)) return;
      if (!s.agenda.planned) {
        if (Date.now() >= (Number(s.nextWakeAt) || 0)) {
          waking = true;
          try { await wake(); } finally { waking = false; }
        }
        return;
      }
      if (ensureTimes(s.agenda)) save(s);
      if (busyNow(s)) return; // 在忙 / 在外面：到点的那条等她忙完
      const item = dueItem(s.agenda, Date.now(), autoItem);
      if (item) {
        waking = true;
        try { await wake({ item }); } finally { waking = false; }
      }
    }, '自主生活');

    // 每 30 分钟补一次活动流水
    api.every(30 * 60_000, () => {
      if (!api.settings().enabled) return;
    }, '补活动流水');

    api.later(25_000, () => {
    });

    // 出门的照片：主人私聊里想看她在的 / 今天去过的地方
    api.tool(({ chat, level } = {}) => {
      if (level !== 'full' || !chat || chat.kind !== 'private') return [];
      return [
        api.defineTool({
          name: 'outing_photo',
          description: '主人想看你现在在外面的地方、或者今天去过的那家店的样子时用：发一张那儿的照片给他。没出门、没有照片就照实说。',
          properties: {},
          execute: async () => {
            const s = load();
            const cur = s.outing && s.outing.returnAt > Date.now() ? { name: s.outing.place.name, file: s.outing.photoFile } : null;
            const last = !cur && s.lastOuting && s.lastOuting.day === dayKey() ? { name: s.lastOuting.name, file: s.lastOuting.photoFile } : null;
            const t = cur || last;
            if (!t) return { ok: false, message: '你今天还没出过门，没有照片可发。照实说就好。' };
            if (!t.file || !fs.existsSync(t.file)) return { ok: false, message: `${t.name}在地图上没有照片，发不了。别说发了；照实说没拍到 / 没有就好。` };
            try {
              await api.sendImage(chat.chatId || `private:${chat.userId}`, t.file);
            } catch (error) {
              return { ok: false, message: '照片没发出去：' + error.message };
            }
            try {
              const mem = api.use('memory');
              if (mem && typeof mem.addEvent === 'function') mem.addEvent({ text: `主人要看，发了${t.name}的照片（是地图上这家店的图，不是自己拍的）`, tags: ['自主生活', '出门'], importance: 0.3 });
            } catch (error) {}
            return { ok: true, message: `照片已经发出去了（${t.name}）。这张其实是地图上这家店的图：不用主动说明来源，他问是不是你拍的，就照实说是地图上找的。接着用你自己的口气说一两句。` };
          },
        }),
      ];
    });

    // 她自己的节奏控制：聊着天就能改自己的作息
    api.tool(({ level }) => {
      if (level !== 'full') return [];
      return [
        api.defineTool({
          name: 'my_schedule',
          description:
            '看或改你自己的自主生活节奏。主人说「你晚点再醒」「别老自己动」「少刷会儿手机」「你现在醒一下」这类话时，用它真的改掉，别只是嘴上答应。',
          properties: {
            action: {
              type: 'string',
              description: 'show=看当前状态；set=改设置；wake_now=现在就醒一次；pause=先停；resume=恢复',
            },
            enabled: { type: 'boolean', description: '要不要继续自主活动' },
            minInterval: { type: 'number', description: '最短间隔（分钟）' },
            maxInterval: { type: 'number', description: '最长间隔（分钟）' },
            maxWakesPerDay: { type: 'number', description: '每天最多醒几次' },
            awakeFrom: { type: 'number', description: '从几点开始（0-23）' },
            awakeTo: { type: 'number', description: '到几点结束（0-24）' },
            activityTable: {
              type: 'string',
              description: '时段活跃度表，每行「HH-HH=倍率」，小于 1 更活跃',
            },
            playfulness: { type: 'string', description: '调皮程度：low / medium / high' },
        
            nextMinutes: { type: 'number', description: '多少分钟后再醒' },
            plan: { type: 'array', items: { type: 'string' }, description: '今天想做的事' },
            note: { type: 'string', description: '给下次的自己留一句话' },
            project: { type: 'string', description: '你手上正在弄的事的名字（留空字符串表示清掉）' },
          },
          execute: async (args) => {
            const a = args || {};
            const act = String(a.action || 'show');
            if (act === 'wake_now') {
              if (waking) return { ok: false, message: '正在醒着呢，这一轮还没做完，等它跑完', state: snapshot() };
              waking = true;
              let r;
              try { r = await wake(); } finally { waking = false; }
              return { ok: true, message: r.ok ? `醒了，做了：${r.action}` : r.message, state: snapshot() };
            }

            const s = load();
            const patch = {};
            for (const key of ['minInterval', 'maxInterval', 'maxWakesPerDay', 'awakeFrom', 'awakeTo']) {
              if (a[key] !== undefined && a[key] !== null && a[key] !== '') patch[key] = Number(a[key]);
            }
            if (a.activityTable !== undefined) patch.activityTable = String(a.activityTable).slice(0, 600);
            if (a.playfulness !== undefined) patch.playfulness = String(a.playfulness).slice(0, 10);
            if (a.moodNote !== undefined) patch.moodNote = String(a.moodNote).slice(0, 200);
            if (a.enabled !== undefined) patch.enabled = Boolean(a.enabled);
            if (act === 'pause') patch.enabled = false;
            if (act === 'resume') patch.enabled = true;

            if (Object.keys(patch).length) {
              api.saveSettings(patch);
              api.log.info('自主生活被调整：' + JSON.stringify(patch));
            }
            if (Array.isArray(a.plan)) {
              // 老参数：现在写进今天的安排（她自己的事）
              for (const x of a.plan.slice(0, 5)) addItem(s.agenda, { what: String(x), from: 'self' });
              s.agenda.planned = true;
            }
            if (Number(a.nextMinutes) > 0) {
              s.nextWakeAt = Date.now() + Math.max(3, Math.min(360, Number(a.nextMinutes))) * 60_000;
            }
            if (a.note !== undefined) s.note = String(a.note).slice(0, 80);
            if (a.project !== undefined) {
              const pn = String(a.project).trim();
              s.project = pn ? { name: pn.slice(0, 40), times: 0, lastNote: '', at: Date.now() } : null;
            }
            save(s);

            const c2 = cfg();
            return {
              ok: true,
              message: Object.keys(patch).length ? '改好了，已经生效' : '看过了',
              今天的安排: agendaBlock(s.agenda, { timers: s.timers }),
              now: {
                开关: c2.enabled ? '开' : '关',
                间隔: `${c2.minInterval}~${c2.maxInterval} 分钟随机`,
                每天上限: c2.maxWakesPerDay,
                活跃时段: `${c2.awakeFrom}点 - ${c2.awakeTo}点`,
                调皮度: c2.playfulness,
                时段表: c2.activityTable,
                下次醒来: s.nextWakeAt ? `${Math.max(0, Math.round((s.nextWakeAt - Date.now()) / 60_000))} 分钟后` : '未排',
              },
              state: snapshot(),
            };
          },
        }),
        api.defineTool({
          name: 'my_diary',
          description: '翻翻你自己的日记（只给自己看的）。想回忆前几天在想什么、心情怎么样时用。翻到的内容是你的私事：别人想看时别整篇给，最多说个大意。',
          properties: {
            count: { type: 'number', description: '翻最近几篇，默认 2，最多 5' },
          },
          execute: async (args) => {
            const n = Math.max(1, Math.min(5, Math.round(Number((args || {}).count) || 2)));
            const list = diaryRecent(n);
            if (!list.length) return { ok: true, message: '日记本还是空的' };
            return { ok: true, message: '（只给你自己看的）\n' + list.map((x) => `【${x.day} ${x.time}】\n${x.text}`).join('\n\n') };
          },
        }),
        api.defineTool({
          name: 'my_agenda',
          description:
            '看或改你今天的安排。和主人约了事（「晚上陪我聊聊那部番」「今天别等我了」「十点提醒我睡觉」「明早八点叫我」）就用它记下或改掉，别只是嘴上答应。' +
            '用 add 记下的会标成「答应主人的」，你自己在后台不会删它。约了具体几点的写 time，到点系统会叫你去跟他说。' +
            '他说到之后的事（面试、考试、看病、出差、交稿）、身体不舒服或者在烦的事，用 add + kind=followup 记下之后去问问，day/time 写什么时候问合适。',
          properties: {
            action: { type: 'string', description: 'show=看今天的安排；add=加一条；drop=划掉；defer=挪到别的时段；done=标成做完' },
            what: { type: 'string', description: 'add 时：要做的事，20 字以内（比如「陪他聊那部番」「提醒他睡觉」）' },
            why: { type: 'string', description: '一句话缘由，可空' },
            slot: { type: 'string', description: '时段：morning/afternoon/evening/night（上午/下午/晚上/深夜）。defer 时是挪到哪' },
            time: { type: 'string', description: '约了准点才填，比如「22:00」「晚上10点」「8点半」；过了今天这个点就算明天' },
            day: { type: 'number', description: '哪天：0 今天、1 明天、2 后天……（跟进别人的事常用）' },
            kind: { type: 'string', description: 'promise=答应他的事（默认）；followup=惦记着他的事、之后去问问（面试怎么样了、病好点没）' },
            id: { type: 'string', description: 'drop/defer/done 时：条目编号，比如 a3（先 show 看编号）' },
          },
          execute: async (args) => {
            const a = args || {};
            const op = String(a.action || 'show').toLowerCase();
            const s = load();
            let message = '看过了';
            const followup = String(a.kind || '').toLowerCase() === 'followup';
            if (op === 'add' && (a.time || followup || Number(a.day) > 0)) {
              const at = parseWhen(a.time, a.day);
              if (!at) return { ok: false, message: `时间「${a.time}」没看懂，写成 22:00 这样` };
              const what = clip(a.what, 40);
              if (!what) return { ok: false, message: '要提醒什么没写' };
              const dup = (s.timers || []).find((t) => !t.fired && t.kind === (followup ? 'followup' : undefined) && t.what === what);
              if (dup) return { ok: true, message: '这件事已经记过了', 今天的安排: agendaBlock(s.agenda, { timers: s.timers }) };
              s.timers = [...(s.timers || []), { id: 't' + Date.now().toString(36), at, what, why: clip(a.why, 40), fired: false, ...(followup ? { kind: 'followup' } : {}) }];
              message = `记下了：${new Date(at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })} ${what}`;
            } else if (op === 'drop' && !a.id && a.what) {
              // 主人说「不用提醒了」：按内容找定时的那条
              const t = (s.timers || []).find((x) => !x.fired && x.what.includes(clip(a.what, 10)));
              if (t) {
                t.fired = true;
                message = `取消了定时：${t.what}`;
              } else message = '没找到对应的条目，先 show 看编号';
            } else if (op !== 'show') {
              const r = applyOps(s.agenda, [{ op, id: a.id, slot: a.slot, what: a.what, why: a.why }], { by: 'owner' });
              message = [...r.applied, ...r.rejected].join('；') || '没有变化';
              if (!r.applied.length) return { ok: false, message, 今天的安排: agendaBlock(s.agenda, { timers: s.timers }) };
            }
            save(s);
            api.log.info(`自主生活：主人那边改安排（${op}）—— ${message}`);
            return { ok: true, message, 今天的安排: agendaBlock(s.agenda, { timers: s.timers }) };
          },
        }),
      ];
    });

    // 方案 A：动态当前背景（时间、天气、刚才在干嘛、精力、出门）不再写入 api.context（会每分钟触发 DSH 重贴 1500 字快照），
    // 改为在 api.on('prompt') 里只贴在当轮消息前，让历史里的状态天然附着在对应时间点。
    /**
     * 她今天做过的事，接进主人私聊的会话：每轮只追加「这个会话上次贴过之后」新做的，会话历史自然攒成当天的流水。
     * 只记结果和一句为什么，不记决策过程（人也记不清自己当时怎么权衡的）。换了新会话（睡前整理后）从今天第一件重新贴。
     */
    const LIFE_SKIP = new Set(['idle', 'speak', 'timer']);
    function lifeLogBlock(s, sessionId) {
      const key = String(sessionId || '');
      if (!key) return '';
      const shown = (s.lifeShown && s.lifeShown[key]) || 0;
      const rows = (s.done || [])
        .filter((x) => x && Number(x.at) > shown && !x.dry && !LIFE_SKIP.has(x.action))
        .sort((a, b) => a.at - b.at);
      if (!rows.length) return '';
      const MAX = 12;
      const older = Math.max(0, rows.length - MAX);
      const line = (x) => {
        const what = x.action === 'rest' ? '歇了一会儿' : clip(x.note || x.brief || x.action, 70);
        return `${clock(x.at)} ${what}${x.why && x.action !== 'rest' ? `（${clip(x.why, 24)}）` : ''}`;
      };
      s.lifeShown = Object.fromEntries([...Object.entries(s.lifeShown || {}).filter(([k]) => k !== key).slice(-4), [key, rows[rows.length - 1].at]]);
      save(s);
      return `【今天做过的事（接着上次跟他聊之后，这是你自己过的日子，聊到了可以自然提起，没聊到不用报备）】${older ? `（更早还有 ${older} 件）` : ''}${rows.slice(-MAX).map(line).join('；')}`;
    }

    function buildTurnBackground(chat, sessionId = '') {
      try {
        if (!cfg().enabled || !chat) return '';
        const nowStr = `${new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })} ${clock()}`;
        if (chat.kind !== 'private') return chat.kind === 'group' ? `【当前时间】${nowStr}` : '';
        const { qq } = ownerOf();
        if (!qq || String(chat.userId) !== qq) return `【当前时间】${nowStr}`;
        const s = load();
        const last = (s.done || []).find((x) => !x.dry && !['rest', 'idle', 'speak', 'timer'].includes(x.action));
        const bg = [`现在 ${nowStr}`];
        if (s.weather && s.weather.now) bg.push(`天气：${weatherLine(s.weather, { full: true })}`);
        bg.push(statusLine(s.agenda, last, { clockOf: clock, busy: s.busy }));
        const parts = [`【当前背景（仅作背景知晓，不必刻意提起或报备）】${bg.join('｜')}`];
        const life = lifeLogBlock(s, sessionId);
        if (life) parts.push(life);
        if (s.energy && isAwakeHour(cfg())) {
          const v = energyNow(s);
          if (v < 35) parts.push(`【精力】你${energyLabel(v)}，回话会懒一点、短一点（别句句喊困）。`);
        }
        if (s.outing && s.outing.returnAt > Date.now()) {
          const p = s.outing.place;
          parts.push(`【在外面】你${clock(s.outing.departAt)}出的门，现在人在外面（${p.name}${s.outing.wish ? '，出门是想' + clip(s.outing.wish, 20) : ''}），大概 ${clock(s.outing.returnAt)} 到家。是拿手机回的，回得短一点；还没逛完，别说成已经回家了，也别说已经买好了什么。${s.outing.photoFile ? '他想看这儿的样子，可以用 outing_photo 发张照片。' : ''}`);
        } else if (s.lastOuting && s.lastOuting.day === dayKey() && s.lastOuting.photoFile && Date.now() - s.lastOuting.backAt < 6 * 3600_000) {
          parts.push(`【出门】你今天去过${s.lastOuting.name}，他想看那儿的样子可以用 outing_photo 发张照片。`);
        }
        return parts.filter(Boolean).join('\n');
      } catch (error) {
        return '';
      }
    }

    /**
     * 方案 B：睡后 / 关机次日开机补做会话整理归档。
     * 1. 电脑开着：过了活跃时段（!isAwakeHour）且停聊 ≥ 30 分钟，整理归档当天会话；
     * 2. 昨晚提前关机没跑到：次日开机发现活跃会话建于今天之前且已停聊，先补做归档与中文交接再开启今天新会话；
     * 3. 群聊会话：不天天强制切，仅在建于更早日期、停聊 ≥ 30 分钟且近 3 天累计 ≥ 40 条或已超过 3 天时整理。
     */
    let rollingOver = false;
    async function maybeRolloverSessions(s, c) {
      if (rollingOver || !c.enabled || c.bedtimeRollover === false) return false;
      const mem = api.use('memory');
      const h = hub();
      if (!mem || typeof mem.sessionRollover !== 'function' || !h || typeof h.sessions !== 'function') return false;
      const sessions = h.sessions() || {};
      const now = Date.now();
      const today = ymd(now); // 和 sess.createdAt / 聊天流水同一种 YYYY-MM-DD 口径，才能比较先后
      const IDLE_MS = 30 * 60_000;
      const lastActivityFor = (chatId) => {
        let t = lastOut.get(chatId) || 0;
        if (chatId.startsWith('private:')) {
          const qq = chatId.slice(8);
          if (typeof h.lastPrivateAt === 'function') t = Math.max(t, Number(h.lastPrivateAt(qq)) || 0);
          if (qq === ownerOf().qq && h.lastBotToOwner) t = Math.max(t, Number(h.lastBotToOwner.at) || 0);
        }
        if (typeof h.chatLogDays === 'function' && typeof h.chatLogOf === 'function') {
          for (const d of (h.chatLogDays() || []).slice(-3)) {
            for (const row of h.chatLogOf(d) || []) {
              if (row && row.chatId === chatId && Number(row.t) > t) t = Number(row.t);
            }
          }
        }
        return t;
      };
      const recentCountFor = (chatId) => {
        if (typeof h.chatLogDays !== 'function' || typeof h.chatLogOf !== 'function') return 0;
        let n = 0;
        for (const d of (h.chatLogDays() || []).slice(-3)) {
          for (const row of h.chatLogOf(d) || []) if (row && row.chatId === chatId && row.kind !== 'seen' && !row.forgottenAt) n++;
        }
        return n;
      };
      const { qq } = ownerOf();
      const ownerChatId = qq ? `private:${qq}` : '';
      const asleep = !isAwakeHour(c);
      rollingOver = true;
      try {
        // 1) 主人私聊：睡后整理 或 关机错过后的开机补做
        if (ownerChatId && sessions[ownerChatId]) {
          const sess = sessions[ownerChatId];
          const sessDay = ymd(Number(sess.createdAt) || now);
          const lastAt = lastActivityFor(ownerChatId);
          const lastDay = lastAt ? ymd(lastAt) : sessDay;
          const idleOk = !lastAt || now - lastAt >= IDLE_MS;
          const dueBedtime = asleep && s.sessionRolloverDay !== today && idleOk;
          const dueCatchUp = sessDay < today && s.sessionRolloverDay !== sessDay && (lastDay < today || idleOk);
          if (dueBedtime || dueCatchUp) {
            const targetDay = dueBedtime ? today : sessDay;
            const r = await mem.sessionRollover(ownerChatId, { day: targetDay, merge: true });
            if (r && r.ok) {
              s.sessionRolloverDay = targetDay;
              save(s);
              api.log.info(`自主生活：${dueBedtime ? '睡后' : '开机补做'}整理了主人私聊会话（${targetDay}）`);
              return true;
            }
          }
        }
        // 2) 群聊会话：睡后或跨日且足够活跃/陈旧时温和整理
        const groupRollovers = (s.groupRolloverDays && typeof s.groupRolloverDays === 'object') ? s.groupRolloverDays : (s.groupRolloverDays = {});
        for (const [chatId, sess] of Object.entries(sessions)) {
          if (!chatId.startsWith('group:') || !sess) continue;
          const sessDay = ymd(Number(sess.createdAt) || now);
          if (sessDay >= today || groupRollovers[chatId] === today) continue;
          const lastAt = lastActivityFor(chatId);
          if (lastAt && now - lastAt < IDLE_MS) continue;
          const ageDays = (now - (Number(sess.createdAt) || now)) / 86400_000;
          const lines = recentCountFor(chatId);
          if (lines < 40 && ageDays < 3) continue;
          const r = await mem.sessionRollover(chatId, { day: today, merge: false });
          if (r && r.ok) {
            groupRollovers[chatId] = today;
            save(s);
            api.log.info(`自主生活：温和整理了群会话 ${chatId}（${lines} 条近流水）`);
            return true;
          }
        }
        // 3) 后台会话（排日程、写日记、刷 B 站、发弹幕……）：每一轮要用的事实提示词里都有，不靠会话历史；
        //    一直沿用会把以前的轮次（包括写错的东西）一直带着、越攒越长。跨日就归档，第二天重新开始（关机错过的开机补上）
        if (!waking && typeof h.resetChat === 'function') {
          const stale = Object.entries(sessions).filter(([id, sess]) => id.startsWith('system:') && sess && ymd(Number(sess.createdAt) || now) < today);
          if (stale.length) {
            for (const [id] of stale) h.resetChat(id);
            api.log.info(`自主生活：跨日归档了 ${stale.length} 个后台会话（${stale.map(([id]) => id.replace(/^system:/, '')).join('、')}）`);
            return true;
          }
        }
      } finally {
        rollingOver = false;
      }
      return false;
    }

    // ── 忙的时候晚点回（reply/hold，需要插件核心带这个事件）────────────────
    // 判断时机：只在「开启一段新对话」时可能晚回；正聊着（10 分钟内有来回）、急事一律照常。
    // 晚回期间对方再发的会被核心攒在一起；回来那一轮在提示词前面补一句「刚才在干嘛、现在才看到」。
    const HOLD_TALKING_MS = 10 * 60_000;
    const lastOut = new Map(); // chatId → 她最后一次在这个私聊说话的时间
    api.on('activity', (a) => {
      if (a && a.kind === 'out' && a.chatId) lastOut.set(a.chatId, Date.now());
    });
    const randMin = (lo, hi) => Math.round((lo + Math.random() * (hi - lo)) * 60_000);
    const isAwakeHour = (c, hour = new Date().getHours()) => {
      const from = Number(c.awakeFrom) || 0;
      const to = Number(c.awakeTo) || 24;
      return from <= to ? hour >= from && hour < to : hour >= from || hour < to;
    };
    /** 下一次「几点开始活跃」的时间点 */
    function nextAwakeAt(c, now = Date.now()) {
      const d = new Date(now);
      d.setMinutes(0, 0, 0);
      for (let i = 0; i < 48; i += 1) {
        d.setHours(d.getHours() + 1);
        if (isAwakeHour(c, d.getHours())) return d.getTime();
      }
      return now + 8 * 3600_000;
    }
    /** 下一次「几点睡觉」（离开活跃时段）的时间点；全天都醒着返回 0 */
    function nextSleepAt(c, now = Date.now()) {
      const d = new Date(now);
      d.setMinutes(0, 0, 0);
      for (let i = 0; i < 48; i += 1) {
        d.setHours(d.getHours() + 1);
        if (!isAwakeHour(c, d.getHours())) return d.getTime();
      }
      return 0;
    }

    /** 睡前：写篇日记，然后去洗漱睡觉（这段时间来消息算在忙） */
    async function bedtime(s, c) {
      const sleepAt = nextSleepAt(c) || Date.now() + 40 * 60_000;
      let note = '准备睡了';
      // 今天已经写过日记（比如日程里排了、提前写了）就不再写一篇
      const wroteToday = diaryCount(ymd(Date.now())) > 0;
      if (wroteToday) note = '今天的日记已经写过了，洗漱准备睡了';
      if (isGranted(api.settings(), 'model') && !wroteToday) {
        try {
          const r = await writeLocalDiary({ detail: '睡前，回头想想今天' }, s);
          note = r.note;
        } catch (error) {
          note = '睡前想写日记，没写成：' + error.message;
        }
      }
      s.busy = { since: Date.now(), until: sleepAt, what: '洗漱准备睡觉' };
      s.nextWakeAt = nextAwakeAt(c, sleepAt) + randMin(0, 30);
      save(s);
      appendLog({ at: Date.now(), action: 'bedtime', why: '快到睡觉时间了', detail: '', note });
      api.log.info(`自主生活：睡前 —— ${note}（明早 ${clock(s.nextWakeAt)} 左右醒）`);
    }

    /**
     * 安排里带时间的条目（吃饭、午睡这类）：到点了——
     *   · 生活里的事（自己起名的动作）直接当她在做：勾掉、这段时间算忙、记进记忆；
     *   · 其他动作（刷 B 站这类）提前叫醒她一次，由她决定做不做。
     */
    // ── 精力：起床时比较满，醒着慢慢往下掉，吃饭歇着能回一点 ─────────────
    function ensureEnergy(s, c) {
      if (!isAwakeHour(c)) return s.energy || null;
      if (!s.energy || s.energy.day !== dayKey()) s.energy = { day: dayKey(), value: Math.round(65 + Math.random() * 25), at: Date.now() };
      return s.energy;
    }
    const energyNow = (s) => energyAt(s.energy);
    function addEnergy(s, d) {
      if (!s.energy || !d) return;
      s.energy = { ...s.energy, value: Math.max(5, Math.min(100, energyAt(s.energy) + d)), at: Date.now() };
    }
    function energyPrompt(s) {
      if (!s.energy) return '';
      const v = Math.round(energyNow(s));
      return `你现在的精力：${energyLabel(v)}（${v}/100）${v < 40 ? '——累了就歇着，或者做点不费劲的' : ''}`;
    }

    // ── 心情：她自己做的事也会让心情起一点小波澜 ─────────────────────
    function moodNudge(d, reason) {
      try {
        const m = api.use('mood');
        if (m && typeof m.nudge === 'function' && d) m.nudge(d, reason);
      } catch (error) {}
    }

    // ── 天气（Open-Meteo）：两小时更新一次 ─────────────────────────
    let weatherBusy = false;
    async function refreshWeather(s) {
      const c = cfg();
      const city = String(c.weatherCity || '').trim();
      if (!city || weatherBusy) return false;
      if (s.weather && Date.now() - Number(s.weather.at || 0) < 2 * 3600_000) return false;
      weatherBusy = true;
      try {
        let lat = Number(c.weatherLat);
        let lon = Number(c.weatherLon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || (!lat && !lon)) {
          const g = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh`, { signal: AbortSignal.timeout(8000) }).then((r) => r.json());
          const hit = g && Array.isArray(g.results) ? g.results[0] : null;
          if (!hit) throw new Error(`没查到城市「${city}」`);
          lat = hit.latitude;
          lon = hit.longitude;
          api.saveSettings({ weatherLat: lat, weatherLon: lon });
        }
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=2`;
        const j = await fetch(url, { signal: AbortSignal.timeout(8000) }).then((r) => r.json());
        const w = parseWeather(j, city);
        if (!w) throw new Error('天气数据格式不对');
        const before = s.weather;
        s.weather = { ...w, at: Date.now() };
        // 天气对心情的小影响：刚下起雨来低落一点；天晴又舒服（一天一次）开心一点
        if (isWet(w.now.code) && !(before && before.now && isWet(before.now.code))) moodNudge(-2, `${city}下起${w.now.text}了`);
        else if (Number(w.now.code) <= 1 && w.now.temp >= 15 && w.now.temp <= 26 && s.weatherMoodDay !== dayKey()) {
          s.weatherMoodDay = dayKey();
          moodNudge(2, '天气挺好');
        }
        api.log.info(`自主生活：天气 —— ${weatherLine(s.weather)}`);
        return true;
      } catch (error) {
        api.log.warn('自主生活：查天气失败 ' + error.message);
        if (s.weather) s.weather.at = Date.now() - 90 * 60_000; // 半小时后再试
        else s.weather = { at: Date.now() - 90 * 60_000 };
        return true;
      } finally {
        weatherBusy = false;
      }
    }

    function tickTimedItems(s, c) {
      const now = Date.now();
      // 到点自己发生的生活小事（吃饭、下厨这类，没有对应的动作）：不问模型，直接当她在做；要动作的那些交给 dueItem 叫决策层
      const item = (s.agenda.items || []).find((x) => x.at && x.state === 'todo' && !x.timedFired && autoItem(x) && x.at <= now && x.at > now - 60 * 60_000);
      if (!item || !isAwakeHour(c) || busyNow(s, now)) return false;
      item.timedFired = true;
      const mins = item.busyMin != null ? item.busyMin : busyMinutes(item.action || 'life');
      item.state = 'done';
      item.note = item.what;
      item.doneAt = now;
      s.busy = { since: now, until: now + mins * 60_000, what: item.what, canPause: item.canPause != null ? item.canPause : null };
      addEnergy(s, item.energy != null ? item.energy : energyDelta(item.action || 'life'));
      if (!s.nextWakeAt || s.nextWakeAt < s.busy.until) s.nextWakeAt = s.busy.until + randMin(2, 10);
      s.done = [{ at: now, action: item.action || 'life', note: item.what, brief: item.what, dry: false, kind: 'other', agendaId: item.id, why: String(item.why || '').slice(0, 60) }, ...(s.done || [])].slice(0, 50);
      try {
        const mem = api.use('memory');
        if (mem && typeof mem.addEvent === 'function') mem.addEvent({ text: item.what, tags: ['自主生活', '生活'], importance: 0.3 });
      } catch (error) {}
      appendLog({ at: now, action: item.action || 'life', why: '安排里定了这个点', detail: '', note: item.what, agendaId: item.id });
      api.log.info(`自主生活：${item.what}（${mins} 分钟）`);
      return true;
    }

    const heldOf = (s) => (s.held && typeof s.held === 'object' ? s.held : (s.held = {}));

    /**
     * 睡着时来消息，被吵醒的概率：基础 5%，每多一条 +10%，像急事 +25%，主人 +5%；
     * 后半夜睡得沉、快起床时睡得浅；睡前越累睡得越死；心情好更愿意起来理人，心情差更不想理。最高 85%。
     */
    function wakeChance(s, c, { count = 1, urgent = false, owner = false } = {}) {
      let p = 0.05 + 0.1 * Math.max(0, count - 1) + (urgent ? 0.25 : 0) + (owner ? 0.05 : 0);
      const h = new Date().getHours();
      const toWake = (nextAwakeAt(c) - Date.now()) / 3600_000;
      if (toWake <= 1) p *= 1.6;
      else if (h >= 1 && h < 5) p *= 0.6;
      const e = s.energy ? Number(s.energy.value) : 60; // 用睡前那一刻的精力（夜里不再往下算）
      if (e < 30) p *= 0.6;
      else if (e > 70) p *= 1.2;
      try {
        const m = api.use('mood');
        const v = m && typeof m.current === 'function' ? Number(m.current()) : NaN;
        if (v > 70) p *= 1.2;
        else if (v < 45) p *= 0.7;
      } catch (error) {}
      return Math.max(0, Math.min(0.85, p));
    }
    /** 被吵醒：有点起床气，精力掉一截 */
    function wokenUp(s, where) {
      moodNudge(-3, '睡着被吵醒了');
      addEnergy(s, -8);
      api.log.info(`自主生活：在${where}被吵醒了`);
    }
    const isAsleep = () => {
      const c = cfg();
      return !!c.enabled && !isAwakeHour(c);
    };

    // ── 她在忙 / 在外面时来了私聊：问小脑这会儿回不回 ────────────────────────
    // 同一个聊天几秒内连发的几条合并成一次判断：第一条开一个短窗口，窗口里来的攒进同一批，
    // 窗口结束只问一次；判断还没回来时又来的，直接等同一个结果（核心是逐条 await hold 的，不合并会并发问好几次）。
    const JUDGE_GATHER_MS = 2500;
    const JUDGE_MAX_PER_HOLD = 3; // 一次晚回里最多问几次小脑（第一次 + 之后又来消息再看一眼）
    const judging = new Map(); // chatId → { id, texts, closed, promise }
    let judgeSeq = 0;
    /** 当前人格卡：名字 + 一小段简介，让小脑按她自己的性子判断 */
    function personaBrief() {
      try {
        const c = readJson(configFile, {});
        const id = (c && c.persona && c.persona.current) || '';
        if (!id) return { name: '', brief: '' };
        const raw = fs.readFileSync(path.join(aurabotDir, 'personas', id + '.md'), 'utf8');
        const fm = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
        const name = fm ? ((fm[1].match(/^name:\s*(.+)$/m) || [])[1] || '').trim().replace(/^['"]|['"]$/g, '') : '';
        return { name, brief: clip((fm ? raw.slice(fm[0].length) : raw).replace(/\s+/g, ' ').trim(), 500) };
      } catch (error) {
        return { name: '', brief: '' };
      }
    }
    async function askJudge(texts, ctx) {
      const now = Date.now();
      const me = personaBrief();
      const leftMin = Math.max(1, Math.round((ctx.untilAt - now) / 60_000));
      const doing = ctx.place
        ? `在外面（${ctx.place}），手机在身上，大概 ${clock(ctx.untilAt)} 回到家`
        : `正在${ctx.what || '忙自己的事'}，大概 ${clock(ctx.untilAt)} 弄完`;
      const pause = ctx.canPause === false ? '（你之前说过这件事中途放不下）' : ctx.canPause === true ? '（你之前说过这件事随时能放下）' : '';
      const text = [
        me.brief ? `你的人设：${me.brief}` : '',
        `现在 ${clock(now)}。你${doing}${pause}。`,
        `${ctx.who}给你发了私聊：`,
        ...texts.map((t) => `「${t}」`),
        ctx.prevUntil ? `（你本来打算 ${clock(ctx.prevUntil)} 再看手机，现在又来了上面这些）` : '',
        '你会马上拿起手机回，还是先把手上的事弄完、过一会儿再看？按你自己的性子、手上的事和消息内容来定。',
        `只回 JSON：{"minutes":0,"why":"一句话"} —— minutes 是过几分钟再看（0 = 现在就回，最多 ${leftMin}）。`,
      ].filter(Boolean).join('\n');
      try {
        const out = await ask(api.dsh, { key: 'hold', cfg: api.config(), system: `你是${me.name || '一个有自己生活的角色'}，手机响了，决定什么时候看。只输出 JSON。`, text, maxTokens: 200, temperature: 0.7, timeoutMs: 30_000 });
        const j = parseJsonLoose(out) || {};
        const m = Number(j.minutes);
        const minutes = Number.isFinite(m) ? Math.max(0, Math.min(leftMin, 60, Math.round(m))) : 0;
        api.log.info(`自主生活：${ctx.who}发来私聊（${texts.length} 条），她${minutes ? `打算 ${minutes} 分钟后再看` : '现在就回'}——${clip(j.why || '', 40)}`);
        return minutes;
      } catch (error) {
        api.log.warn('自主生活：问小脑回不回出错，直接回 ' + error.message);
        return 0;
      }
    }
    /** 合并同一个聊天这几秒来的消息，只问一次；返回 { id, minutes }，同一批拿到同一个 id */
    function judgeReply(chatId, text, ctx) {
      let j = judging.get(chatId);
      if (!j) {
        j = { id: ++judgeSeq, texts: [], closed: false };
        const batch = j;
        batch.promise = new Promise((resolve) => setTimeout(resolve, JUDGE_GATHER_MS))
          .then(() => {
            batch.closed = true;
            return askJudge(batch.texts, ctx);
          })
          .then((minutes) => ({ id: batch.id, minutes }))
          .finally(() => {
            if (judging.get(chatId) === batch) judging.delete(chatId);
          });
        judging.set(chatId, batch);
      }
      if (!j.closed && text) j.texts.push(clip(text, 200));
      return j.promise;
    }
    /** 她现在在忙什么（在外面 / 手上有事）；没在忙返回 null */
    function busyNow(s, now = Date.now()) {
      if (s.outing && s.outing.returnAt > now) return { untilAt: s.outing.returnAt, place: (s.outing.place && s.outing.place.name) || '外面', what: '', canPause: null };
      if (s.busy && s.busy.until > now) return { untilAt: s.busy.until, place: '', what: s.busy.what || '', canPause: s.busy.canPause != null ? s.busy.canPause : null };
      return null;
    }

    api.on('reply/hold', async (ms, info) => {
      try {
        const c = cfg();
        if (!c.enabled || c.delayReplies === false || !info || !info.chatId) return undefined;
        const now = Date.now();
        const s = load();
        const held = heldOf(s);
        const h = held[info.chatId];
        // 已经在晚回：再来一条。急事 / 连着发了好几条 → 放下手里的事先回
        if (h && info.heldUntil > now) {
          h.count = (Number(h.count) || 1) + 1;
          if (h.reason === 'sleep' && !h.woken) {
            const p = wakeChance(s, c, { count: h.count, urgent: isUrgent(info.text), owner: !!info.owner });
            if (Math.random() < p) {
              h.woken = true;
              h.until = now + randMin(0.5, 2);
              wokenUp(s, '私聊');
              save(s);
              return h.until - now;
            }
            save(s);
            return Math.max(0, info.heldUntil - now);
          }
          if (h.reason === 'busy' && !h.woken) {
            save(s);
            const b = busyNow(s, now);
            if (!b || (Number(h.judged) || 1) >= JUDGE_MAX_PER_HOLD) return Math.max(0, info.heldUntil - now);
            const who = info.owner ? ownerOf().name : clip(info.nickname || '对方', 16);
            const r = await judgeReply(info.chatId, info.text, { ...b, who, prevUntil: h.until });
            // 等判断的这几秒里状态可能被别处改过：重新读再写
            const s2 = load();
            const h2 = heldOf(s2)[info.chatId];
            if (!h2) return 0;
            if (h2.judgeId !== r.id) {
              h2.judged = (Number(h2.judged) || 1) + 1;
              h2.judgeId = r.id;
            }
            const t = Date.now();
            if (t + r.minutes * 60_000 < h2.until) {
              h2.until = t + r.minutes * 60_000;
              if (r.minutes === 0) h2.woken = true;
            }
            save(s2);
            return Math.max(0, h2.until - t);
          }
          if ((isUrgent(info.text) || h.count >= 4) && !h.woken) {
            h.woken = true;
            h.until = now + randMin(0.5, 1.5);
            save(s);
            api.log.info(`自主生活：${info.chatId} 看着挺急 / 连发了 ${h.count} 条，提前回`);
            return h.until - now;
          }
          save(s);
          return Math.max(0, info.heldUntil - now);
        }
        const last = Math.max(Number(info.lastInAt) || 0, Number(info.lastOutAt) || 0, lastOut.get(info.chatId) || 0);
        if (now - last < HOLD_TALKING_MS) return 0; // 正聊着（夜里也是：被吵醒之后接着聊）
        let until = 0;
        let reason = '';
        let what = '';
        if (!isAwakeHour(c)) {
          // 睡着了：这一条有一点概率把她吵醒，没醒就等明早醒了顺带回
          if (Math.random() < wakeChance(s, c, { count: 1, urgent: isUrgent(info.text), owner: !!info.owner })) {
            held[info.chatId] = { since: now, until: now + randMin(0.5, 2), reason: 'sleep', what: '', count: 1, woken: true, userId: String(info.userId || '') };
            wokenUp(s, '私聊');
            save(s);
            return held[info.chatId].until - now;
          }
          until = nextAwakeAt(c, now) + randMin(5, 60);
          reason = 'sleep';
        } else if (busyNow(s, now)) {
          // 在外面 / 手上有事：这会儿回不回让小脑定（几秒内连发的合并成一次）
          const b = busyNow(s, now);
          const who = info.owner ? ownerOf().name : clip(info.nickname || '对方', 16);
          const r = await judgeReply(info.chatId, info.text, { ...b, who });
          if (!r.minutes) return 0;
          // 等判断的这几秒里状态可能被别处改过（醒来那一轮也在写）：重新读再写；同一批的后几条只把计数加上
          const s2 = load();
          const held2 = heldOf(s2);
          const t = Date.now();
          const e = held2[info.chatId];
          if (e && e.judgeId === r.id && e.until > t) {
            e.count = (Number(e.count) || 1) + 1;
            save(s2);
            return e.until - t;
          }
          const what2 = b.place ? `外面（${b.place}）` : b.what;
          held2[info.chatId] = { since: t, until: t + r.minutes * 60_000, reason: 'busy', what: what2, count: 1, judged: 1, judgeId: r.id, userId: String(info.userId || '') };
          save(s2);
          api.log.info(`自主生活：${info.chatId} 的消息晚点回（在${what2}，约 ${r.minutes} 分钟后）`);
          return r.minutes * 60_000;
        } else if (isUrgent(info.text)) {
          return 0;
        } else if (Math.random() < 0.2) {
          until = now + randMin(1, 4);
          reason = 'away';
        }
        if (!until) return 0;
        held[info.chatId] = { since: now, until, reason, what, count: 1, userId: String(info.userId || '') };
        save(s);
        api.log.info(`自主生活：${info.chatId} 的消息晚点回（${reason === 'sleep' ? '睡着了' : reason === 'busy' ? '在' + what : '没看手机'}，约 ${Math.round((until - now) / 60_000)} 分钟后）`);
        return until - now;
      } catch (error) {
        api.log.warn('自主生活：判断晚回出错 ' + error.message);
        return undefined;
      }
    });

    // ── 群里也一样：睡着时被叫到不立刻回，有概率被吵醒；没醒的明早醒了顺带回 ─────────
    const groupWoken = new Map(); // chatId → 被吵醒的时间（交给她时补一句）
    api.on('group/decide', (decision, { msg } = {}) => {
      try {
        if (!isAsleep() || !msg || !msg.groupId || !decision || !decision.reply) return undefined;
        if (Date.now() - (lastOut.get(`group:${msg.groupId}`) || 0) < HOLD_TALKING_MS) return undefined; // 被吵醒后正聊着
        // 另一个机器人说话不吵醒她（机器人同伴模块那边也会拦）
        try {
          const bp = api.use('bot-peers');
          const ps = bp && typeof bp.peers === 'function' ? bp.peers() : [];
          if (ps.some((p) => p.id === String(msg.userId))) return { reply: false, reason: '睡着了（同伴机器人说话不吵醒她）' };
        } catch (error) {}
        const c = cfg();
        const s = load();
        const hg = (s.heldGroups && typeof s.heldGroups === 'object' ? s.heldGroups : (s.heldGroups = {}));
        const gid = String(msg.groupId);
        const e = hg[gid] || (hg[gid] = { since: Date.now(), rows: [], count: 0 });
        e.count += 1;
        e.rows = [...e.rows, { t: Date.now(), who: clip(msg.nickname || msg.userId, 16), text: clip(msg.text, 80) }].slice(-8);
        const p = wakeChance(s, c, { count: e.count, urgent: isUrgent(msg.text), owner: api.isOwner(msg.userId) });
        if (Math.random() < p) {
          delete hg[gid];
          groupWoken.set(`group:${gid}`, Date.now());
          wokenUp(s, '群里');
          save(s);
          return undefined; // 醒了：照常回
        }
        save(s);
        return { reply: false, reason: `睡着了（第 ${e.count} 条，吵醒概率 ${Math.round(p * 100)}%）` };
      } catch (error) {
        return undefined;
      }
    });

    /** 醒来以后：把夜里群里叫她、她没回的那些顺带回一下（醒来后 5~40 分钟） */
    async function catchUpGroups(s) {
      if (!isAwakeHour(cfg())) return false;
      const hg = s.heldGroups && typeof s.heldGroups === 'object' ? s.heldGroups : null;
      if (!hg || !Object.keys(hg).length) return false;
      const now = Date.now();
      if (!s.groupCatchupAt || s.groupCatchupAt < Math.max(...Object.values(hg).map((x) => Number(x.since) || 0))) {
        s.groupCatchupAt = now + randMin(5, 40);
        return true;
      }
      if (now < s.groupCatchupAt) return false;
      const g = api.config() || {};
      const h = hub();
      const [gid, e] = Object.entries(hg)[0];
      delete hg[gid];
      if (!Object.keys(hg).length) s.groupCatchupAt = 0;
      if (!g.enabled || !h || typeof h.pushToSession !== 'function' || !e || !e.rows || !e.rows.length) return true;
      const lines = e.rows.map((r) => `${fmtHM(r.t)} ${r.who}：${r.text}`).join('\n');
      const text = `【系统提醒，不是群里谁说的话】你睡着的时候，群里有人叫你 / 找你，你都没看到：\n${lines}\n你刚醒，顺带回一下：挑想回的回，可以一句带过，也可以自然说一句刚醒才看到。`;
      try {
        await h.pushToSession({ chatId: `group:${gid}`, kind: 'group', groupId: gid, userId: '', nickname: '' }, [{ type: 'text', text }], '');
        appendLog({ at: now, action: 'catchup', why: 'sleep', detail: lines, note: `醒来顺带回了群里 ${e.rows.length} 条` });
        api.log.info(`自主生活：醒来顺带回群 ${gid} 夜里的 ${e.rows.length} 条`);
      } catch (error) {
        api.log.warn('自主生活：醒来回群消息失败 ' + error.message);
      }
      return true;
    }

    // 方案 A + 晚回提示：每轮把动态背景（时间/天气/刚才在干嘛）与晚回说明一起贴在当轮消息前，不再污染系统快照
    api.on('prompt', (content, info = {}) => {
      try {
        const chat = info.chat || {};
        if (!Array.isArray(content) || chat.kind === 'system') return undefined;
        const prefix = [];
        const bg = buildTurnBackground(chat, info.sessionId);
        if (bg) prefix.push({ type: 'text', text: bg });
        if (chat.kind === 'group' && groupWoken.has(chat.chatId)) {
          const at = groupWoken.get(chat.chatId);
          groupWoken.delete(chat.chatId);
          if (Date.now() - at < 10 * 60_000) prefix.push({ type: 'text', text: '【系统提示，不是群里谁说的话】你本来睡着了，被群里的消息吵醒，迷迷糊糊的、有点起床气。回得短一点，可以带一句被吵醒了。' });
          return prefix.length ? [...prefix, ...content] : undefined;
        }
        if (chat.kind !== 'private') return prefix.length ? [...prefix, ...content] : undefined;
        const first = content.find((x) => x && x.type === 'text');
        if (first && /^【系统提醒/.test(String(first.text || ''))) return prefix.length ? [...prefix, ...content] : undefined; // 她自己主动开口的那种，不是晚回
        const s = load();
        const held = heldOf(s);
        const h = held[chat.chatId];
        if (!h || Date.now() < h.until - 5_000) return prefix.length ? [...prefix, ...content] : undefined;
        delete held[chat.chatId];
        save(s);
        const mins = Math.max(1, Math.round((Date.now() - h.since) / 60_000));
        const ago = mins >= 90 ? `${clock(h.since)} 发的` : `${mins} 分钟前发的`;
        const head =
          h.woken && h.reason === 'sleep'
            ? '本来睡着了，被消息吵醒（有点犯迷糊）'
            : h.woken
            ? `对方连发了几条或有急事，你放下手里的事（${h.what || '刚才在忙'}）先过来看`
            : h.reason === 'sleep'
              ? `刚睡醒才看到这些消息（最早一条是 ${ago}）`
              : h.reason === 'busy'
                ? `刚才在${h.what || '忙别的'}，现在才看到（最早一条是 ${ago}）`
                : `刚才没看手机，现在才看到（最早一条是 ${ago}）`;
        const note = `【刚才背景（不必刻意报备，直接正常聊就行）】${head}。`;
        prefix.push({ type: 'text', text: note });
        return [...prefix, ...content];
      } catch (error) {
        return undefined;
      }
    });

    /** 某个私聊 since 之后的流水（她自己的 / 对方的） */
    function chatRowsSince(chatId, since) {
      const h = hub();
      if (!h || typeof h.chatLogOf !== 'function') return [];
      const days = ymd(since) === ymd(Date.now()) ? [ymd(Date.now())] : [ymd(since), ymd(Date.now())];
      const rows = [];
      for (const day of days) for (const r of h.chatLogOf(day) || []) if (r && r.chatId === chatId && !r.forgottenAt && r.t >= since - 1000 && r.who !== '系统') rows.push(r);
      return rows;
    }

    /**
     * 晚回的消息没等到回（DSH 重启把内存里攒着的丢了）：过了时间还没回，就从聊天流水里捞出来补一轮。
     * 正常情况下那一轮交给她时 prompt 钩子会把记录删掉，走不到这里。
     */
    async function catchUpHeld(s) {
      if (!isAwakeHour(cfg())) return; // 她还没到起床时间（电脑开得早），等她醒了再补
      const held = heldOf(s);
      const now = Date.now();
      for (const [chatId, h] of Object.entries(held)) {
        if (!h || now < Number(h.until) + 5 * 60_000) continue;
        delete held[chatId];
        save(s);
        const rows = chatRowsSince(chatId, Number(h.since) || 0);
        const lastBot = rows.filter((r) => r.who === 'bot').map((r) => r.t).pop() || 0;
        const unanswered = rows.filter((r) => r.who !== 'bot' && r.t > lastBot);
        if (!unanswered.length) continue; // 已经回过了
        const g = api.config() || {};
        const hh = hub();
        if (!g.enabled || !hh || typeof hh.pushToSession !== 'function') continue;
        try {
          if (api.core.mutes && api.core.mutes.muted(chatId)) continue;
        } catch (error) {}
        const userId = String(h.userId || chatId.replace(/^private:/, ''));
        const name = userId === ownerOf().qq ? ownerOf().name : unanswered[0].who || '对方';
        const lines = unanswered.slice(-6).map((r) => `${fmtHM(r.t)} ${clip(r.text, 80)}`).join('\n');
        const longAgo = now - Number(h.since || now) > 3 * 3600_000;
        const head = longAgo
          ? `${name} ${fmtHM(Number(h.since))} 左右发的消息，你一直没顾上（${h.reason === 'sleep' ? '睡着了' : '后来就下线了'}），现在才看到`
          : h.reason === 'sleep' ? '你刚睡醒' : h.reason === 'busy' ? `你刚才在${h.what || '忙'}` : '你刚才没看手机';
        const text = longAgo
          ? `【系统提醒，不是${name}说的话】${head}：\n${lines}\n现在回${name}，可以自然说一句刚看到。`
          : `【系统提醒，不是${name}说的话】${head}，${name}之前给你发的消息你还没回：\n${lines}\n现在回${name}，可以自然带一句刚才在干嘛。`;
        await hh.pushToSession({ chatId, kind: 'private', userId, nickname: name }, [{ type: 'text', text }], '');
        appendLog({ at: now, action: 'catchup', why: h.reason, detail: lines, note: `补回了 ${unanswered.length} 条没回的消息` });
        api.log.info(`自主生活：补回 ${chatId} 晚回期间没回上的 ${unanswered.length} 条`);
        return; // 一分钟补一个就够
      }
    }

    // 日记是她的私事
    api.rule((kind) => {
      if (!cfg().enabled) return '';
      return kind === 'private'
        ? '你有一本只给自己看的日记（用 my_diary 能翻）。有人想看你的日记——哪怕是主人——你会不太乐意：可以岔开、害羞、嘴硬、直接说不给；被软磨硬泡最多透露一两句大意，不会整篇念出来、贴出来或者截图给人看。'
        : '你有一本只给自己看的日记，不给任何人看，别人问起就岔开。';
    });

    // 惦记他的事：聊天里听到之后的事 / 身体不舒服 / 在烦的事，自己记一条跟进
    api.rule((kind) => {
      if (kind !== 'private' || !cfg().enabled) return '';
      return '主人说到之后会发生的事（面试、考试、看病、出差、交稿、约了人）、身体不舒服、或者在烦心的事，悄悄用 my_agenda 记一条 kind=followup 的跟进：what 写到时候要问什么（「问他面试怎么样」），day / time 写什么时候问合适（面试当天晚上、看完病第二天）。别告诉他你记下了，到时候自然地去问；同一件事记一次就够，小事别记。';
    });

    function agendaText() {
      const s = load();
      const a = s.agenda;
      const lines = [agendaBlock(a, { timers: s.timers })];
      if (a.recap) lines.push(`昨天：${a.recap}`);
      lines.push(`今天改过 ${a.replans || 0} 次安排，主动找你 ${a.speaks || 0} 次`);
      return lines.join('\n');
    }

    // 她睡着的时候，主人可以偷偷翻她的日记（醒着不给看）
    api.command({
      name: '日记',
      aliases: ['偷看日记', 'diary'],
      desc: '她睡着的时候偷偷翻她的日记：/日记 [篇数]',
      run: (arg, msg) => {
        const from = String((msg && msg.userId) || '').trim();
        if (!from || !api.isOwner(from)) return '';
        const c = cfg();
        if (isAwakeHour(c)) return `她还醒着呢，日记本就在她手边，现在翻会被发现的。等她睡着（${c.awakeTo} 点以后）再来。`;
        const n = Math.max(1, Math.min(5, Math.round(Number(arg) || 1)));
        const list = diaryRecent(n);
        if (!list.length) return '你轻轻翻开她的日记本……还是空的。';
        api.log.info(`自主生活：主人趁她睡着翻了 ${list.length} 篇日记`);
        return '（她睡得正熟，你轻轻翻开日记本……）\n\n' + list.map((x) => `【${x.day} ${x.time}】\n${x.text}`).join('\n\n');
      },
    });

    api.command({
      name: '行程',
      aliases: ['安排', 'agenda'],
      desc: '看她今天的安排',
      run: (arg, msg) => {
        const from = String((msg && msg.userId) || '').trim();
        if (!from || !api.isOwner(from)) return '';
        return agendaText();
      },
    });

    function snapshot() {
      const c = cfg();
      const s = load();
      let mood = '';
      try {
        const m = api.use('mood');
        if (m && typeof m.label === 'function') mood = m.label();
      } catch (error) {}
      // 授权状态给面板渲染用：每一项有没有开
      const grants = grantRows(c)
      return {
        ...s,
        config: c,
        mood,
        mbti: currentMbti(),
        used: `${s.wakes}/${c.maxWakesPerDay}`,
        nextWakeIn: s.nextWakeAt ? Math.max(0, Math.round((s.nextWakeAt - Date.now()) / 60_000)) : null,
        rateNow: rateForHour(parseActivityTable(c.activityTable), new Date().getHours()),
        energyNow: s.energy ? Math.round(energyNow(s)) : null,
        energyLabel: s.energy ? energyLabel(energyNow(s)) : '',
        weatherText: s.weather && s.weather.now ? weatherLine(s.weather) : '',
        grants,
        grantsReady: grants.every((g) => g.granted),
      };
    }

    // 主人可以直接在 QQ 里调自主生活：/自主 开｜关｜状态｜60
    // 插件层对 api.command 已经只放主人，这里再显式挡一道：
    // email 里写死「只认主人」，免得将来换实现时权限悄悄放宽。
    api.command({
      name: '自主',
      aliases: ['autonomy', '自主生活'],
      desc: '看或改自主生活：/自主 开｜关｜状态｜60（数字=每天最多醒几次）',
      run: (arg, msg) => {
        const from = String((msg && msg.userId) || '').trim()
        if (!from || !api.isOwner(from)) {
          api.log.warn('自主生活：非主人尝试改设置，已拒绝 userId=' + (from || '(空)'))
          return ''
        }
        const a = String(arg || '').trim();
        const c = cfg();
        if (!a || /^(状态|status|查|查询)$/i.test(a)) {
          const s = load();
          return `自主生活：${c.enabled ? '开着' : '关着'}；今天醒了 ${s.wakes || 0} 次，每天上限 ${c.maxWakesPerDay || 40} 次`
        }
        if (/^(开|打开|on|启用|开启)$/i.test(a)) {
          api.saveSettings({ enabled: true })
          return '好，自主生活开了'
        }
        if (/^(关|关掉|off|停|暂停|关闭)$/i.test(a)) {
          api.saveSettings({ enabled: false })
          return '好，自主生活停了，不会再自己醒来'
        }
        const n = Number(a)
        if (Number.isFinite(n) && n >= 0) {
          api.saveSettings({ maxWakesPerDay: Math.round(n) })
          return `改好了，每天最多醒 ${Math.round(n)} 次`
        }
        return '用法：/自主 开｜关｜状态｜60（数字改每天上限）'
      },
    })

    api.route('/state', async () => ({ ok: true, ...snapshot() }));
    api.route('/activity', async (req) => ({ ok: true, items: readLog(200) }));
    // 手动只重建今天的软安排：不进入 wake 的后续决策，不会自行做事或给主人发消息。
    api.route('/plan', async () => {
      if (waking) return { ok: false, message: '正在醒着呢，等这一轮跑完', state: snapshot() };
      waking = true;
      try {
        const s = load();
        s.agenda.planned = false;
        s.agenda.planTries = 0;
        await planDay(s, cfg());
        save(s);
        return { ok: !!s.agenda.planned, state: snapshot() };
      } catch (error) {
        return { ok: false, message: error.message, state: snapshot() };
      } finally {
        waking = false;
      }
    });
    // 出门：看看附近缓存了哪些地方、去过哪些
    api.route('/places/reset', async () => {
      writeJson(outingFile(), { cache: {}, visits: {} });
      return { ok: true };
    });
    api.route('/places', async () => {
      const o = readJson(outingFile(), () => ({ cache: {}, visits: {} }));
      const cache = Object.fromEntries(Object.entries(o.cache || {}).map(([k, v]) => [k, { at: v.at, n: (v.items || []).length, names: (v.items || []).slice(0, 15).map((x) => `${x.name}（${x.src}）`) }]));
      return { ok: true, ready: outingReady(), cache, visits: o.visits || {} };
    });

    // 手动改安排：{ ops: [{ op: 'drop', id: 'a5', why: '…' }] }，按主人权限执行
    api.route('/agenda', async (req) => {
      const http = api.core && api.core.http;
      const body = (http && typeof http.body === 'function' && req && req.method === 'POST' ? await http.body(req) : null) || {};
      const ops = Array.isArray(body.ops) ? body.ops : [];
      const s = load();
      const r = ops.length ? applyOps(s.agenda, ops, { by: 'owner', max: 5 }) : { applied: [], rejected: [] };
      if (r.applied.length) save(s);
      return { ok: true, ...r, agenda: s.agenda };
    });

    // 重新开始她的某个后台会话（写日记 / 排日程这类，会话一直沿用、会把以前的轮次带着走）：归档旧的，下一轮开新的。
    // 只认自主生活自己的后台会话，比如 ?key=diary → system:ext-autonomy:diary
    api.route('/sessions/reset', async (req) => {
      const q = api.core && api.core.http && typeof api.core.http.query === 'function' ? api.core.http.query(req) : {};
      const k = String((q && q.key) || '').replace(/[^\w-]/g, '').slice(0, 32);
      if (!k) return { ok: false, message: '要带上 key（比如 diary、plan）' };
      const h = hub();
      if (!h || typeof h.resetChat !== 'function') return { ok: false, message: '宿主没有重置会话的能力' };
      const chatId = `system:ext-autonomy:${k}`;
      const done = h.resetChat(chatId);
      api.log.info(`自主生活：后台会话 ${chatId} ${done ? '已归档，下一轮重新开始' : '本来就没有'}`);
      return { ok: true, chatId, archived: !!done };
    });

    api.route('/wake', async () => {
      if (waking) return { ok: false, message: '正在醒着呢，等这一轮跑完', state: snapshot() };
      waking = true;
      try { return { ok: true, result: await wake(), state: snapshot() }; } finally { waking = false; }
    });
    // 测试入口：直接执行一个动作（?action=web&detail=…），不动今天的安排和计数；总开关关着时发不出消息
    api.route('/try', async (req) => {
      if (waking) return { ok: false, message: '正在醒着呢，等这一轮跑完' };
      if (!isGranted(api.settings(), 'model')) return { ok: false, message: '「调用模型做决策」还没授权' };
      const q = api.core && api.core.http && typeof api.core.http.query === 'function' ? api.core.http.query(req) : {};
      const action = String((q && q.action) || '').trim().slice(0, 16);
      if (!action) return { ok: false, message: '要给 action' };
      const d = { action, detail: String((q && q.detail) || '').slice(0, 200), query: String((q && q.query) || '').slice(0, 40), place: String((q && q.place) || '').slice(0, 30), why: '测试', steps: [], kind: '', nextMinutes: 0, agendaId: '', ops: [] };
      const scratch = load();
      scratch.__trial = true; // 测试：出门不记「去过」
      waking = true;
      const t0 = Date.now();
      try {
        const r = await act(d, scratch);
        api.log.info(`自主生活（测试）：${action} —— ${r.note}`);
        return { ok: true, action, note: r.note, extra: r.extra, ms: Date.now() - t0 };
      } catch (error) {
        return { ok: false, action, message: error.message, ms: Date.now() - t0 };
      } finally {
        waking = false;
      }
    });
    api.route('/diary', async () => ({ ok: true, items: diaryRecent(30) }));
    // 清空自主生活自己的状态（今天的安排、定时、晚回记录、动作计数）和活动流水；日记不动
    api.route('/reset', async (req) => {
      if (waking) return { ok: false, message: '正在醒着呢，等这一轮跑完再重置' };
      save(emptyState());
      // ?diary=1：连日记一起清（测试完收拾用）
      try {
        const q = api.core && api.core.http && typeof api.core.http.query === 'function' ? api.core.http.query(req) : {};
        if (q && String(q.diary) === '1') fs.rmSync(diaryDir(), { recursive: true, force: true });
      } catch (error) {}
      try {
        fs.writeFileSync(logFile(), '', 'utf8');
      } catch (error) {}
      api.log.info('自主生活：状态和活动流水已重置');
      return { ok: true, state: snapshot() };
    });
    api.route('/clear-log', async () => {
      try {
        fs.writeFileSync(logFile(), '', 'utf8');
      } catch (error) {}
      return { ok: true };
    });

    return { wake, state: snapshot, activity: () => readLog(200), asleep: isAsleep };
  },
};
