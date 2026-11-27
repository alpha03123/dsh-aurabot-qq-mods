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
import { AUTO_LIMITS } from './lib/limits.mjs';
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
  similarText,
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


// ── 自带最小实现 ────────────────────────────────────────────────
// 扩展模块拿不到插件内部源码：modules.js 的 rewriteImports 只处理插件 src 下的文件，
// 这里的相对 import 不会被转成 __lib。所以读盘和问模型都自己来，不依赖 core/store.js。

import {
  readJson, writeJson, ACTIONS, OUTING_MAX_PER_DAY, FINDINGS_KEEP_MS, FINDINGS_MAX, FINDINGS_SHOWN,
  findingsBlock, STANDARD_ACTIONS, FREE_ACTION, autoItem, THINK_LIMIT_PER_DAY, ACTION_MAX_PER_DAY,
  REPEATABLE_ACTIONS, SAME_ACTION_SIM, similarAction, dayKey, countsForQuota, KINDS, SOFT_MAX_PER_DAY,
  guessKind, kindsToday, timesToday, usedUpToday, clock, parseDecision, parseActivityTable,
  rateForHour, MBTI_STYLE, parsePersonaMbti,
} from './lib/helpers.mjs';
export * from './lib/helpers.mjs';
import { createPhoneFlow } from './lib/phone-flow.mjs';
import { createOutingFlow } from './lib/outing-flow.mjs';
import { createWebFlow } from './lib/web-flow.mjs';
import { createDiaryFlow } from './lib/diary-flow.mjs';
import { createLifeTick } from './lib/life-tick.mjs';

/** 决策调用的默认超时：模型卡住时不能把整轮醒着的时间耗掉 */
const ASK_TIMEOUT_MS = 45_000;

/** 核心的模型工具（core/llm.js）：后台决策都走它的 askModel */
let coreLlm = null;

/** 问一次宿主模型（不进会话）：后台决策用。走核心的 askModel（选模型、思考档位、预算放宽重试、超时、小脑留底都在那里），
 *  这里只多一条自己的约定：空返回要显式报错，否则会被当成「她没想好」，看起来像发呆。超时抛错，由上层降级处理。 */
async function ask(dsh, { system, text, maxTokens = 260, temperature = 0.9, timeoutMs = ASK_TIMEOUT_MS, cfg = null, key = '', reasoningEffort = 'low' }) {
  if (!coreLlm || typeof coreLlm.askModel !== 'function') throw new Error('拿不到核心的模型工具（core/llm.js）');
  const out = await coreLlm.askModel(dsh, { system, text, maxTokens, temperature, timeoutMs, cfg, key, reasoningEffort, source: 'autonomy' });
  if (!out) {
    const info = typeof coreLlm.lastEmptyInfo === 'function' ? coreLlm.lastEmptyInfo() : '';
    throw new Error(`模型返回空（${info || '放宽预算重试后仍为空'}）`);
  }
  return out;
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
    fixedSchedule: false,
    awakeFrom: 7,
    awakeTo: 24,
    activityTable: '07-12=0.8\n12-14=1.6\n14-18=1.0\n18-23=0.6\n23-24=1.4',
    playfulness: 'medium',
    // 写进提示词的偏好（原来是「多去虚拟机折腾」那段）
    moodNote: '',
    // 决策调用的超时（秒）。模型卡住时最多等这么久就放弃这一轮
    askTimeoutSec: 75,
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
    {
      key: 'fixedSchedule',
      label: '固定作息时间',
      type: 'switch',
      hint: '开启后严格按下面的起床/睡觉时间作息；关闭（默认）后由她每天自己决定今晚几点睡、明早几点起（可能起得比你早或睡得比你晚）。',
    },
    { key: 'awakeFrom', label: '几点开始（0-23，仅固定作息时生效）', type: 'number' },
    { key: 'awakeTo', label: '几点结束（0-23，写 24 表示到半夜，仅固定作息时生效）', type: 'number' },
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
      const title = m.meta && m.meta.title ? clip(m.meta.title, AUTO_LIMITS.WEB_TITLE) : '';
      const body = m.kind === 'seen'
        ? `看过《${title || clip(m.text, AUTO_LIMITS.WEB_TITLE)}》${title && m.text && m.text !== m.meta.title ? '：' + m.text : ''}`
        : (m.aboutName && m.source !== 'event' ? `[${m.aboutName}] ` : '') + m.text;
      return '- ' + (t ? `[${whenLabel(t)}] ` : '') + String(body).replace(/\s+/g, ' ').slice(0, AUTO_LIMITS.HINT_LINE);
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
      const keepSleepSchedule = s.sleepSchedule && Number(s.sleepSchedule.wakeAt) > Date.now() - 6 * 3600_000 ? s.sleepSchedule : null;
      const keepBedtimeForSleepAt = Number(s.bedtimeForSleepAt) > Date.now() - 12 * 3600_000 ? Number(s.bedtimeForSleepAt) : 0;
      const keepCustomStatus = s.customStatus && typeof s.customStatus === 'object' ? s.customStatus : null;
      const keepCustom = s.customActions;
      const keepFails = { streak: (s.fails && s.fails.streak) || {}, until: (s.fails && s.fails.until) || {} };
      // 定时提醒跨天有效（「明早八点叫我」），保留未响且未过期一天以上的，另留 1 小时内的取消墓碑防并发复活
      const keepTimers = (Array.isArray(s.timers) ? s.timers : []).filter((t) => t && ((!t.fired && !t.dropped && t.at > Date.now() - 86_400_000) || (t.dropped && Number(t.updatedAt) > Date.now() - 3600_000)));
      // 最近 24 小时每轮的话题（跨天保留，done 每天清空数不到昨天）、最近 7 天打不开的网站
      const keepTopics = (Array.isArray(s.topicLog) ? s.topicLog : []).filter((x) => x && x.topic && x.at > Date.now() - 86_400_000).slice(0, 60);
      // 查到过的东西（B 站 / 上网找到的要点）：留 7 天，下次想再查同一件事时先看得到自己已经查到过什么
      // 第一次用（还没有 findings）：从活动流水里把最近 7 天 B 站搜到的要点补上
      const seedFindings = () => readLog(300)
        .filter((r) => r && r.action === 'bili' && r.at > Date.now() - FINDINGS_KEEP_MS && /找到的：/.test(String(r.note || '')))
        .map((r) => ({ at: r.at, topic: clip(r.topic || '', AUTO_LIMITS.FINDING_QUERY), query: clip((String(r.note).match(/搜「([^」]+)」/) || [])[1] || '', AUTO_LIMITS.FINDING_QUERY), text: String(r.note).split('找到的：').slice(1).join('找到的：').slice(0, AUTO_LIMITS.FINDING_TEXT) }));
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
        s.sleepSchedule = keepSleepSchedule;
        if (keepBedtimeForSleepAt) s.bedtimeForSleepAt = keepBedtimeForSleepAt;
        if (keepCustomStatus) s.customStatus = keepCustomStatus;
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
    let lastDiscordStatusKey = '';
    let lastDiscordStatusAt = 0;
    function syncDiscordStatus(s) {
      try {
        const g = api.config() || {};
        if (!g.enabled) return;
        const now = Date.now();
        const c = cfg();
        let status = 'online';
        let text = '';
        if (!isAwakeHour(c)) {
          status = 'idle';
          text = (s.customStatus && s.customStatus.sleepText) || '💤 睡着了';
        } else if (s.outing && s.outing.returnAt > now) {
          const placeName = typeof s.outing.place === 'string' ? s.outing.place : (s.outing.place && s.outing.place.name) || '';
          text = (s.busy && s.busy.status) || (s.customStatus && s.customStatus.text) || `${placeName || s.outing.what || '出门溜达中'}`;
        } else if (s.busy && s.busy.until > now && (s.busy.status || s.busy.what)) {
          text = clip(s.busy.status || (s.customStatus && s.customStatus.text) || s.busy.what, 48);
        } else if (s.customStatus && s.customStatus.text) {
          text = clip(s.customStatus.text, 48);
        } else {
          const lastDone = (s.done || [])[0];
          text = lastDone && (lastDone.brief || lastDone.note) ? clip(lastDone.brief || lastDone.note, 36) : '';
        }
        const key = `${status}|${text}`;
        if (key === lastDiscordStatusKey && now - lastDiscordStatusAt < 5 * 60_000) return;
        const call = (api.core && api.core.onebot && typeof api.core.onebot.call === 'function')
          ? (act, p) => api.core.onebot.call(act, p, { timeoutMs: 5000 })
          : (typeof api.onebot === 'function' ? (act, p) => api.onebot(act, p, { timeoutMs: 5000 }) : null);
        if (!call) return;
        lastDiscordStatusKey = key;
        lastDiscordStatusAt = now;
        Promise.resolve(call('set_self_status', { text, status })).catch(() => {});
      } catch (error) {}
    }

    const save = (s) => {
      writeJson(stateFile(), s);
      syncDiscordStatus(s);
    };
    setTimeout(() => { try { syncDiscordStatus(load()); } catch {} }, 8000).unref?.();

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

    /** 最近和主人的私聊（从聊天流水读，不进她的会话）：since 之后最多 limit 句，带月-日 时:分 */
    function ownerChatLines(sinceMs, limit = 10) {
      const h = hub();
      const { qq, name } = ownerOf();
      if (!h || typeof h.chatLogOf !== 'function' || !qq) return [];
      const now = Date.now();
      const days = [];
      const cur = new Date(Math.min(sinceMs, now));
      cur.setHours(0, 0, 0, 0);
      const endYmd = ymd(now);
      for (let i = 0; i < 5; i += 1) {
        const dStr = ymd(cur.getTime());
        days.push(dStr);
        if (dStr >= endYmd) break;
        cur.setDate(cur.getDate() + 1);
      }
      const rows = [];
      for (const day of days) {
        for (const r of h.chatLogOf(day) || []) {
          if (!r || r.chatId !== `private:${qq}` || r.forgottenAt || !(r.t >= sinceMs)) continue;
          if (r.who === '系统') continue;
          rows.push(`[${fmtMDHM(r.t)}] ${r.who === 'bot' ? '你' : name}：${clip(r.text, AUTO_LIMITS.CHAT_LINE)}`);
        }
      }
      return rows.slice(-limit);
    }
    const fmtHM = (ts) => new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
    const fmtMDHM = (ts) => {
      const d = new Date(ts);
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return `${mm}-${dd} ${fmtHM(ts)}`;
    };

    /** 和主人最近一次来往（他说的或她说的；重启后回退读今天流水） */
    const lastOwnerContact = () => {
      const h = hub();
      let t = h ? Math.max(Number(h.lastOwnerChatAt) || 0, Number(h.lastBotToOwner && h.lastBotToOwner.at) || 0) : 0;
      const { qq } = ownerOf();
      if (!t && h && typeof h.chatLogOf === 'function' && qq) {
        const chatId = `private:${qq}`;
        for (const r of h.chatLogOf(ymd(Date.now())) || []) {
          if (r && r.chatId === chatId && !r.forgottenAt && r.who !== '系统' && Number(r.t) > t) t = Number(r.t);
        }
      }
      return t;
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
      const topic = clip(what, AUTO_LIMITS.REACH_WHAT) + (why ? `（${clip(why, AUTO_LIMITS.REACH_WHY)}）` : '');
      // 安排是早上（甚至前一天）写的：开口前给她现在的时间、天气与最近私聊（带日期时间戳），话题里的「今天/明天」以现在为准
      const recentChat = ownerChatLines(Date.now() - 48 * 3600_000, 4);
      const chatSnap = recentChat.length ? `\n最近私聊：\n${recentChat.join('\n')}` : '';
      const factLine = `（现在是 ${new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })} ${clock()}${s.weather && s.weather.now ? '；天气：' + weatherLine(s.weather) : ''}。话题是早些时候想的，跟现在的事实对不上（比如说明天下雨、其实明天是晴天）就改口或者干脆不提。${chatSnap}）`;
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
      const actualSent = h.lastBotToOwner && Number(h.lastBotToOwner.at) > beforeOutAt
        ? String(h.lastBotToOwner.text || '').replace(/\s+/g, ' ').trim()
        : '';
      return delivered
        ? { ok: true, note: `去找主人说：${actualSent ? clip(actualSent, AUTO_LIMITS.REACH_SENT_NOTE) : clip(what, AUTO_LIMITS.REACH_SENT_NOTE)}` }
        : { ok: false, later: true, note: `想找主人聊「${clip(what, AUTO_LIMITS.REACH_SENT_NOTE)}」，但最后没开口（沉默）` };
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
            const title = clip(m.meta && m.meta.title, AUTO_LIMITS.WEB_TITLE);
            const felt = clip(m.text, AUTO_LIMITS.WEB_SAW);
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
    const { looksBroken, phoneAdbPath, runAdb, todayCounts, ensurePhoneAwake, createModule, pickPhoneFlow } = createPhoneFlow({ api, aurabotDir, dshHome, dayKey });

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

    const { outingFile, placesOf, pickPlace, rememberVisit, fetchPlacePhoto, sendOutingPhoto, tickPendingShare, goOut, writeOutingStory, finishOuting } = createOutingFlow({
      api, cfg, ask, save, clock, dayKey, ownerOf, hub, appendLog,
      canReachOwnerNow, canShareImage,
      isAwakeHour: (...a) => isAwakeHour(...a),
      outingReady: (...a) => outingReady(...a),
      reachOwner,
      styleHint: (...a) => styleHint(...a),
      moodNudge: (...a) => moodNudge(...a),
      energyPrompt: (...a) => energyPrompt(...a),
    });
    const { webBlockedText, hostOf, readArticle, webMode, deepseekKey, browseWeb, pickResults, searchByDeepSeek, searchByBrowser, finishWeb } = createWebFlow({
      api, cfg, ask, ownerOf, canShareImage, shareImage, pageImages,
    });
    const { DIARY_MAX_PER_DAY, diaryDir, diaryFile, diaryRead, diaryCount, diaryRecent, writeLocalDiary } = createDiaryFlow({
      api, cfg, ask, clock, ymd, ownerOf, ownerChatLines, seenSince, moodLine,
      styleHint: (...a) => styleHint(...a),
    });

    async function act(d, s) {
      if (d.action === 'speak') {
        // 带着具体话题去开口：安排里那条的内容优先，其次是这轮决策写的 detail
        const item = d.agendaId ? s.agenda.items.find((x) => x.id === d.agendaId) : null;
        // 决策层这一轮写的 detail 优先（刚想好的具体说法），没有再用安排里那条的标题
        const what = d.detail || (item && item.what) || d.why;
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
          const query = clip(d.query, AUTO_LIMITS.FINDING_QUERY);
          const r = await b.run({ force: true, allowShare, query });
          if (r && Number(r.shared) + Number(r.shots || 0) > 0) s.agenda.speaks = (Number(s.agenda.speaks) || 0) + 1;
          const seen = r && r.ok ? seenSince(startAt) : [];
          const base = (r && r.message) || '去 B 站看了看';
          if (query) {
            // 专门去找东西：找到了把要点写进结果（下一轮决策看得到）；没找到 / 没搜到如实记成没找到，不算做成，也不触发停用一天
            const answers = (r && Array.isArray(r.answers) ? r.answers : []).slice(0, 5);
            if (r && r.ok && answers.length) {
              return {
                note: `${base}。找到的：${answers.map((a) => `《${clip(a.title, AUTO_LIMITS.WEB_TITLE)}》${clip(a.text, AUTO_LIMITS.SEARCH_ANSWER)}`).join('；')}`,
                extra: { ok: true, finding: { query, text: answers.map((a) => `《${clip(a.title, AUTO_LIMITS.WEB_TITLE)}》${clip(a.text, AUTO_LIMITS.SEARCH_ANSWER)}`).join('；') } },
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
        const prompt = String(d.detail || d.why || '随便画点什么').slice(0, AUTO_LIMITS.DRAW_PROMPT);
        const buf = await ig.generate(prompt);
        if (!buf || !buf.length) return { note: '想画张图，但没生成出来', extra: { ok: false } };

        const name = `draw-${Date.now()}.png`;
        // 兜底：留在本机模块数据目录
        const dir = path.join(api.dataDir(), 'art');
        fs.mkdirSync(dir, { recursive: true });
        const local = path.join(dir, name);
        fs.writeFileSync(local, buf);
        return { note: `画了张图（存在本机 art/）：${prompt.slice(0, AUTO_LIMITS.DONE_BRIEF)}`, extra: { file: local } };
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
        note: clip(d.detail || d.why || d.action, AUTO_LIMITS.DONE_NOTE),
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
      const me = personaBrief();
      const lines = [
        me.brief ? `你的人设（保持这个口气和性格，别变成通用旁白）：${clip(me.brief, AUTO_LIMITS.PERSONA_BRIEF)}` : '',
        `你现在的性子偏 ${mbti}：${style.feel}。`,
        `说话的样子：${style.tone}（自然一点，不用刻意堆感叹号）。`,
      ].filter(Boolean);
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
      if (ok('bili')) rows.push('bili：去 B 站刷会儿视频放松，或搜感兴趣的内容/教程看看（刷到有意思的还能顺手分享给主人）');
      if (ok('draw')) rows.push('draw：画一张图');
      if (ok('diary')) rows.push('diary：写一篇只给自己看的日记');
      if (ok('web')) rows.push('web：自己上网查点东西、看看网页（detail 写想查什么）');
      if (ok('phone')) rows.push('phone：拿起手机逛 App');
      if (s && ok('outing')) rows.push('outing：出门去附近某个真实地方逛逛或办事（按你的兴趣、心情和天气自己想，到时候在地图上挑具体哪家）');
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
      const chat = ownerChatLines(Date.now() - 48 * 3600_000, 10);
      const carries = y && Array.isArray(y.carries) ? y.carries.filter((x) => x.from !== 'promise') : [];
      const promised = a.items.filter((x) => x.from === 'promise' && x.state === 'todo');
      // 想起相关的事：拿近期真实私聊、没做完的、答应主人的、正在弄的去搜（不拿昨天已完成小事反搜自己）
      const memHints = await recallHints(6, [...carries.map((x) => x.what), ...promised.map((x) => x.what), s.project && s.project.name, ...chat.slice(-4)].filter(Boolean));
      const timers = (s.timers || []).filter((t) => t && !t.fired && !t.dropped);
      const yDoneTitles = y && Array.isArray(y.items) ? y.items.filter((x) => x && x.state === 'done' && x.what).map((x) => x.what) : [];
      const yDropped = y && Array.isArray(y.items) ? y.items.filter((x) => x && x.state === 'dropped' && x.what).map((x) => `${x.what}${x.note ? `（${clip(x.note, 24)}）` : ''}`) : [];
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
        yDoneTitles.length ? `昨天做过的（简记，已做完的今天不用接着翻炒）：${yDoneTitles.slice(0, 8).join('、')}` : '',
        yDropped.length ? `昨天划掉的：${yDropped.slice(0, 4).join('；')}` : '',
        findingsBlock(s),
        carries.length ? `昨天没做完的：${carries.map((x) => x.what).join('、')}。还想做就写进今天，不想做就算了。这些是昨天写的，里面的「明天」「今晚」指的是昨天说的时候，搬到今天要换成今天的说法；跟天气有关的先对一下下面的天气，已经不成立的就别搬。` : '',
        promised.length ? `答应${owner}的事已经排上了，不用再写：${promised.map((x) => `${SLOT_LABEL[x.slot]} ${x.what}`).join('、')}` : '',
        (() => {
          if (!timers.length) return '';
          const todayYmd = ymd(Date.now());
          const fmtDay = (at) => new Date(at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
          const todayT = timers.filter((t) => ymd(t.at) === todayYmd);
          const futureT = timers.filter((t) => ymd(t.at) !== todayYmd);
          return [
            todayT.length ? `今天定了时间的：${todayT.map((t) => `${clock(t.at)} ${t.what}`).join('、')}（到点会叫你）` : '',
            futureT.length ? `之后几天约好的（不是今天，仅作知晓）：${futureT.map((t) => `${fmtDay(t.at)} ${t.what}`).join('、')}` : '',
          ].filter(Boolean).join('\n');
        })(),
        '',
        memHints.length ? `你想得起来的几件事：\n${memHints.join('\n')}` : '',
        (() => {
          const last = diaryRecent(1)[0];
          return last ? `你上一篇日记（${last.day} ${last.time}）写过：${clip(last.text, AUTO_LIMITS.DIARY_EXCERPT)}` : '';
        })(),
        chat.length ? `最近和${owner}的私聊：\n${chat.join('\n')}` : `最近没和${owner}私聊。`,
        mood ? `你现在的心情：${mood}` : '',
        (() => { ensureEnergy(s, c); return s.energy ? `你今天起来的状态：${energyLabel(energyNow(s))}${energyNow(s) < 50 ? '（没睡好，少排点）' : ''}` : ''; })(),
        s.weather && s.weather.now ? `今天的天气：${weatherLine(s.weather)}${isWet(s.weather.today && s.weather.today.code) ? '（要下雨，出门的事想清楚）' : ''}` : '',
        `你是 ${mbti} 的性子：${style.feel}。`,
        '',
        '今天能做的事：',
        ...availableActions(owner, s).map((x) => '- ' + x),
        personaLimits() ? `你做不到的事（排的时候别排进去）：\n${personaLimits()}` : '',
        '',
        '怎么排：',
        `- 吃饭另算（见下面），除此之外排 4~6 件你自己的事。每件都写大概几点开始（time）、要多久（busyMin）。现在是 ${clock()}，已经过去的时间别排；起得晚、剩下的时间少，就按比例少排。到了那个点系统会叫你，到时候还可以改主意。`,
        '- 这几件别都是一类：刷会儿 B 站（bili）、上网查点什么（web）、动手做点什么、出门逛逛（outing）、收拾整理、写点东西……尽量错开，别一整天都在同一个场景里。昨天做得最多的那类今天少排。',
        '- 查东西和动手做是两件事，分开排：查（bili / web）是一条，查完这条就算做完；真动手做（下厨、缝补、拼东西这类）是另一条生活里的事，action 自己起名字，到点就当你在做。',
        `- 大部分是你自己的事：你自己的兴趣、在弄的东西、想看想学的。跟${owner}有关的最多一条，而且要有具体由头（比如聊天里提到的事），别写"找他聊天"这种空话，平常天气只是背景也不算由头（真要下雨或明显降温提醒带伞添衣才算）。`,
        `- 不用把时间塞满。想留一段空闲就排一条 action 写「${FREE_ACTION}」（what 写「下午随便待着」这类），到点你再看那会儿想干嘛；心情不好可以少排，想偷懒也行。`,
        '- 别忘了吃饭哦～还没过的那几顿顺手排上，不占上面的名额：action 起个名字比如「吃午饭」，what 写吃什么（像平常过日子，具体点，别太丰盛），time 写大概几点。到点就当你在吃，这段时间别人找你会晚点回。别的生活小事（午睡、洗澡、下厨）也这样：action 起个名字，到点就当你在做。',
        '',
        y && (y.items.length || y.done.length) ? '先用你自己的口气说一两句昨天过得怎么样，没做成的也照实说，然后排今天。' : '',
        '只输出 JSON：',
        '{"yesterday":"一两句，昨天过得怎么样（没有昨天就空着）","theme":"今天大概想怎么过，一句话","sleepTime":"你今晚大概打算几点睡（22:00 到 01:30 之间自己定，比如 23:25 或 00:20）","wakeTime":"明早大概打算几点起（06:30 到 10:30 之间自己定，比如 07:45 或 09:15）","status":"你刚醒这会儿想挂在自己 Discord 状态栏上的一句小状态（15字以内，用你自己的语气，可带1个小emoji）","items":[{"slot":"morning/afternoon/evening/night","what":"具体想做的事，20 字以内","why":"为什么想做，一句","action":"上面能做的事之一（bili/web/outing/diary/draw/speak…）、free（空闲），或你给生活小事起的短名字","time":"几点开始，比如 14:30","busyMin":"大概占多少分钟","canPause":"这段时间有人找你能不能放下先回，true/false","energy":"做完精力怎么变，-10 到 +25","status":"做这件事时挂在自己 Discord 状态栏上的一句短话（15字以内，用你自己的语气，可带1个小emoji）"}]}',
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
            timeoutMs: Math.max(30, Number(c.askTimeoutSec) || 75) * 1000,
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

      a.theme = clip(j.theme, AUTO_LIMITS.AGENDA_WHAT);
      if (j.status) s.customStatus = { text: clip(j.status, AUTO_LIMITS.STATUS_BAR), at: Date.now() };
      if (!c.fixedSchedule) {
        const parseHM = (str) => {
          const mm = String(str || '').trim().match(/^(\d{1,2})[:：](\d{2})$/);
          if (!mm) return null;
          const h = Number(mm[1]), m = Number(mm[2]);
          if (!(h >= 0 && h < 24 && m >= 0 && m < 60)) return null;
          return { h, m };
        };
        const sp = parseHM(j.sleepTime);
        const wk = parseHM(j.wakeTime);
        const now0 = Date.now();
        let sleepAt = 0;
        if (sp && (sp.h >= 21 || sp.h <= 2)) {
          const dS = new Date(now0);
          if (sp.h <= 2) dS.setDate(dS.getDate() + 1);
          dS.setHours(sp.h, sp.m, 0, 0);
          if (dS.getTime() > now0 + 15 * 60_000) sleepAt = dS.getTime();
        }
        if (!sleepAt) {
          const dS = new Date(now0);
          dS.setHours(23, Math.floor(Math.random() * 50), 0, 0);
          if (dS.getTime() <= now0 + 15 * 60_000) dS.setTime(now0 + 2 * 3600_000);
          sleepAt = dS.getTime();
        }
        let wakeAt = 0;
        if (wk && wk.h >= 6 && wk.h <= 11) {
          const dW = new Date(sleepAt);
          if (dW.getHours() >= 18) dW.setDate(dW.getDate() + 1);
          dW.setHours(wk.h, wk.m, 0, 0);
          if (dW.getTime() > sleepAt + 4 * 3600_000) wakeAt = dW.getTime();
        }
        if (!wakeAt) {
          const dW = new Date(sleepAt);
          if (dW.getHours() >= 18) dW.setDate(dW.getDate() + 1);
          dW.setHours(7 + Math.floor(Math.random() * 3), Math.floor(Math.random() * 60), 0, 0);
          wakeAt = dW.getTime();
        }
        s.sleepSchedule = { sleepAt, wakeAt, sleepText: clock(sleepAt), wakeText: clock(wakeAt), at: now0 };
        api.log.info(`自主生活：她今天自定作息 —— 今晚 ${clock(sleepAt)} 左右睡，明早 ${clock(wakeAt)} 左右起`);
      }
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
        const r = addItem(a, { slot, what: it.what, why: it.why, from: 'self', action: it.action, age: inheritAge(it.what, carries), at, ...selfReport(it) }, { hour });
        if (r.ok) added.push(r.item);
      }
      const recap = clip(j.yesterday, AUTO_LIMITS.RECAP_NOTE);
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
      if (!isAwakeHour(c)) {
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
        mergeOwnerEdits(s, readJson(stateFile(), null));
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
      // 最近 48 小时和主人的真实私聊（带日期时间戳），不按上次醒来时间截断
      const chatLines = ownerChatLines(Date.now() - 48 * 3600_000, 8);
      const ownerName = ownerOf().name;
      const replansLeft = Math.max(0, REPLAN_MAX_PER_DAY - (Number(s.agenda.replans) || 0));
      const brokenList = Object.keys(s.fails.until || {}).filter((k) => brokenNow(s, k) && !moduleMissing(k));
      const now = `${new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })} ${clock()}`;
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
              focus.from === 'promise'
                ? `照着做就填 agendaId「${focus.id}」。这是答应主人的事，后台不能自己删也不能挪；如果确实已经改期或这会儿做不了，先做别的或歇着，等聊天时再跟主人确认或用 my_agenda 改。`
                : `照着做就填 agendaId「${focus.id}」。现在不想做：用 ops 把它 defer 到别的时间（写 time），或者 drop 掉，然后这会儿做点别的、或者歇着都行。没挪也没做的话，它会往后推一小时再问你。`,
            ].filter(Boolean).join('\n')
          : `【现在】这会儿没排事${upNext ? `（下一条是 ${clock(upNext.at)} 的「${upNext.what}」）` : '（今天排的都过了）'}，${focus ? `这段「${focus.what}」是你留给自己的空闲，` : ''}想干嘛都行，歇着也行。`,
        chatLines.length
          ? `【和${ownerName}的最近私聊】\n${chatLines.join('\n')}`
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
        personaLimits() ? `你做不到的事（安排里写了也做不成，换个做法或者划掉）：\n${personaLimits()}` : '',
        '',
        '只回一个 JSON：',
        '{"action":"上面某一个动作，或者你给生活里的事起的短名字","kind":"soft/learn/build/other 之一","why":"一句话理由","detail":"想做什么的简短描述","status":"你现在想挂在自己 Discord 状态栏上的一句小状态（15字以内，用你自己的口气，可带1个小emoji）","agendaId":"这次是在做安排里的哪一条（比如 a2），不是就空字符串","agendaDone":true,"topic":"这件事说的是什么，几个字","query":"","place":"","ops":[],"busyMin":30,"canPause":true,"energy":-2}',
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
        // 2026-11-21 回放：low 时 8/10 又去搜同一件事（蛋糕循环）。deepseek-flash 没有 medium 档，之前写 medium 实际一直按 high 跑；直接写明 high
        reasoningEffort: 'high',
        // 模型卡住时最多等这么久，超了就放弃这一轮（按 settings.askTimeoutSec，默认 45 秒）
        timeoutMs: Math.max(1, Number(c.askTimeoutSec) || 75) * 1000,
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
      // 她说这轮在做安排里的哪一条，就认哪一条；做没做完听她的 agendaDone，不再拿动作类型去对
      const item = d.agendaId
        ? s.agenda.items.find((x) => x.id === d.agendaId && x.state === 'todo') || null
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
      if (item) {
        if (result.extra && result.extra.ok === false) {
          item.note = clip(result.note, AUTO_LIMITS.DONE_NOTE);
          item.tries = (Number(item.tries) || 0) + 1;
        } else if (d.agendaDone === false) {
          // 只是为这条做了准备（查配方、看教程）：记下做过什么，这条本身还没做
          item.progress = clip(result.note, AUTO_LIMITS.DONE_NOTE);
        } else {
          item.state = 'done';
          item.note = clip(result.note, AUTO_LIMITS.DONE_NOTE);
          item.doneAt = Date.now();
        }
      }

      // 到点的那一条：空闲段想过就算过了；正经的一条没做、也没挪 / 划，往后推一小时再问（模型连不上就 10 分钟后再问）
      if (focus && focus.state === 'todo' && focus.at <= Date.now()) {
        if (d.retrySoon) focus.retryAt = Date.now() + 10 * 60_000;
        else if (isFree) {
          focus.state = 'done';
          focus.note = clip(result.note || d.detail || d.action, AUTO_LIMITS.DONE_NOTE);
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
            lastNote: String(result.note || '').slice(0, AUTO_LIMITS.DONE_NOTE),
            at,
          };
        } else {
          s.project = { name: d.action, times: 1, lastNote: String(result.note || '').slice(0, AUTO_LIMITS.DONE_NOTE), at };
        }
      }
      // 生活里的事写进记忆（做过的事），聊天时她能想起来「刚吃了碗面」；节流 15 分钟
      // 出门例外：回来时 finishOuting 写一条「去了X：…」，出发这一刻不再另记一条
      if (result.extra && result.extra.life && !result.extra.outing && Date.now() - (Number(s.lastLifeMemoAt) || 0) > 15 * 60_000) {
        try {
          const mem = api.use('memory');
          if (mem && typeof mem.addEvent === 'function') {
            mem.addEvent({ text: clip(result.note, AUTO_LIMITS.EVENT_MEM), tags: ['自主生活', '生活'], importance: 0.35 });
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
              text: String(result.note || '').slice(0, AUTO_LIMITS.EVENT_MEM) || (d.action === 'draw' ? '画了张图' : '玩了会儿手机'),
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
        s.customActions[d.action] = { count: (Number(prev.count) || 0) + 1, last: at, sample: String(d.detail || '').slice(0, AUTO_LIMITS.DONE_BRIEF) };
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
        const stText = clip(d.status || (item && item.status) || '', AUTO_LIMITS.STATUS_BAR);
        if (stText) s.customStatus = { text: stText, at };
        if (mins > 0) s.busy = { since: at, until: at + mins * 60_000, what: clip((result.extra && result.extra.busyWhat) || (result.extra && result.extra.life ? result.note : '') || (item && item.what) || d.detail || d.action, AUTO_LIMITS.AGENDA_BRIEF), canPause, ...(stText ? { status: stText } : {}) };
      }
      s.done = [
        { at, action: d.action, note: String(result.note || '').slice(0, AUTO_LIMITS.DONE_NOTE), brief: clip((result.extra && result.extra.life ? result.note : '') || (item && item.state === 'done' ? item.what : '') || d.detail || d.why, AUTO_LIMITS.DONE_BRIEF), dry, kind: d.kind || '', why: String(d.why || '').slice(0, AUTO_LIMITS.AGENDA_WHY), ...(d.topic ? { topic: d.topic } : {}), ...(item ? { agendaId: item.id } : {}) },
        ...(s.done || []),
      ].slice(0, 50);
      if (d.topic && d.action !== 'rest') s.topicLog = [{ at, topic: d.topic, action: d.action }, ...(s.topicLog || [])].slice(0, 60);
      if (result.extra && result.extra.finding && result.extra.finding.text && !s.__trial) {
        const f = result.extra.finding;
        s.findings = [{ at, topic: clip(d.topic || f.query, AUTO_LIMITS.FINDING_QUERY), query: clip(f.query, AUTO_LIMITS.FINDING_QUERY), text: String(f.text).slice(0, AUTO_LIMITS.FINDING_TEXT) }, ...(s.findings || [])].slice(0, FINDINGS_MAX);
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
        output: result.extra && result.extra.output ? String(result.extra.output).slice(0, AUTO_LIMITS.EXEC_OUTPUT) : '',
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
      if (!c.enabled || api.config()?.enabled === false) return;
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
        if (wChanged || (!hadEnergy && s.energy)) {
          mergeOwnerEdits(s, readJson(stateFile(), null));
          save(s);
        }
      }
      // 生活小事忙完了：补一句做得怎么样（先于下一件到点的事）
      try {
        waking = true;
        try {
          if (await tickLifeRecaps(s, c)) {
            mergeOwnerEdits(s, readJson(stateFile(), null));
            save(s);
          }
        } finally {
          waking = false;
        }
      } catch (error) {
        api.log.warn('自主生活：生活小结出错 ' + error.message);
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
          mergeOwnerEdits(s, readJson(stateFile(), null));
          save(s);
        }
        if (await tickPendingShare(s)) {
          mergeOwnerEdits(s, readJson(stateFile(), null));
          save(s);
        }
      } catch (error) {
        api.log.warn('自主生活：发出门照片出错 ' + error.message);
      }
      // 睡前例行：离睡觉不到 40 分钟、且针对这一次 sleepAt 还没走过（防跨午夜 00:01 重跑）
      if (isAwakeHour(c) && s.bedtimeDay !== dayKey()) {
        const sleepAt = nextSleepAt(c);
        if (sleepAt && sleepAt - Date.now() <= 40 * 60_000 && Number(s.bedtimeForSleepAt) !== sleepAt) {
          s.bedtimeDay = dayKey();
          s.bedtimeForSleepAt = sleepAt;
          mergeOwnerEdits(s, readJson(stateFile(), null));
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
        if (await maybeRolloverSessions(s, c)) {
          mergeOwnerEdits(s, readJson(stateFile(), null));
        }
      } catch (error) {
        api.log.warn('自主生活：睡后整理会话出错 ' + error.message);
      }
      // 和主人约好几点的事：到点直接在私聊里叫她开口（不经过决策，不受活跃时段、次数限制）
      if (!s.lastSeenAt || Date.now() - Number(s.lastSeenAt) > 5 * 60_000) {
        s.lastSeenAt = Date.now();
        save(s);
      }
      // 睡着时到点的提醒先不发，等醒了按「那会儿你不在、现在才想起来」补
      const due = isAwakeHour(c) ? (s.timers || []).find((t) => t && !t.fired && !t.dropped && t.at <= Date.now()) : null;
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
          name: 'my_status',
          description: '更新你自己挂在 Discord 头像旁边的自定义状态栏文字（15字以内，用你自己的口气，可带1个小emoji，比如「🌧️ 窝窗边听雨发呆喵」「🍅 刚炫完番茄鸡蛋盖饭」）。主人让你改状态，或者你心情/在做的事变了想换个状态时调用。',
          properties: {
            text: { type: 'string', description: '想挂在状态栏上的一句短话（15字以内）' },
            status: { type: 'string', description: '在线圆点：online（绿，默认）/ idle（黄月亮）/ dnd（红请勿打扰）' },
          },
          execute: async (args) => {
            const a = args || {};
            const text = clip(a.text, 36);
            const st = ['online', 'idle', 'dnd'].includes(a.status) ? a.status : 'online';
            const s = load();
            s.customStatus = { text, status: st, at: Date.now() };
            if (s.busy && s.busy.until > Date.now() && text) s.busy.status = text;
            lastDiscordStatusKey = '';
            save(s);
            return { ok: true, message: `状态栏已换成：${text || '（清空）'}` };
          },
        }),
        api.defineTool({
          name: 'my_agenda',
          description:
            '看或改你今天的安排。和主人约了事（「晚上陪我聊聊那部番」「今天别等我了」「十点提醒我睡觉」「明早八点叫我」）就用它记下或改掉，别只是嘴上答应。' +
            '用 add 记下的会标成「答应主人的」，你自己在后台不会删它。还没敲定具体日期的口头想法不要调用 add；改约新时间时记得顺手 drop 掉旧的。约了具体几点的写 time，到点系统会叫你去跟他说。' +
            '他说到之后的事（面试、考试、看病、出差、交稿）、身体不舒服或者在烦的事，用 add + kind=followup 记下之后去问问，day/time 写什么时候问合适。',
          properties: {
            action: { type: 'string', description: 'show=看今天的安排；add=加一条；drop=划掉；defer=挪到别的时段；done=标成做完' },
            what: { type: 'string', description: 'add 时：要做的事，20 字以内（比如「陪他聊那部番」「提醒他睡觉」）' },
            why: { type: 'string', description: '一句话缘由，可空' },
            slot: { type: 'string', description: '时段：morning/afternoon/evening/night（上午/下午/晚上/深夜）。defer 时是挪到哪' },
            time: { type: 'string', description: '约了准点才填，比如「22:00」「晚上10点」「8点半」；过了今天这个点就算明天' },
            day: { type: 'number', description: '哪天：0 今天、1 明天、2 后天……（跟进别人的事常用）' },
            kind: { type: 'string', description: 'promise=答应他的事（默认）；followup=惦记着他的事、之后去问问（面试怎么样了、病好点没）' },
            id: { type: 'string', description: 'drop/defer/done 时：条目编号，如 a3（今日日程）或 t...（定时/跨天约定，先 show 看编号）' },
          },
          execute: async (args) => {
            const a = args || {};
            const op = String(a.action || 'show').toLowerCase();
            const s = load();
            const now = Date.now();
            let message = '看过了';
            const followup = String(a.kind || '').toLowerCase() === 'followup';
            const fmtTimer = (ts) => new Date(ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
            const activeTimers = () => (s.timers || []).filter((x) => x && !x.fired && !x.dropped);
            const findTimer = () => {
              const id = String(a.id || '').trim();
              if (id) return activeTimers().find((x) => x.id === id) || null;
              const q = clip(a.what, AUTO_LIMITS.AGENDA_WHAT);
              if (!q) return null;
              return activeTimers().find((x) => x.what === q || similarText(x.what, q) >= 0.6 || x.what.includes(clip(q, 10)) || q.includes(clip(x.what, 10))) || null;
            };
            const targetId = String(a.id || '').trim();
            if (op === 'add' && (a.time || followup || Number(a.day) > 0)) {
              const at = parseWhen(a.time, a.day, { now, slot: a.slot });
              if (!at) return { ok: false, message: `时间「${a.time}」没看懂，写成 22:00 这样` };
              const what = clip(a.what, AUTO_LIMITS.AGENDA_WHAT);
              if (!what) return { ok: false, message: '要提醒什么没写' };
              const wantKind = followup ? 'followup' : undefined;
              const dup = activeTimers().find((t) => t.kind === wantKind && (t.what === what || similarText(t.what, what) >= 0.6));
              if (dup) {
                return {
                  ok: true,
                  message: `已经记过类似的 [${dup.id}]「${dup.what}」（${fmtTimer(dup.at)}）；若要改时间请用 action="defer", id="${dup.id}"`,
                  今天的安排: agendaBlock(s.agenda, { timers: s.timers }),
                };
              }
              const tid = 't' + now.toString(36);
              s.timers = [...(s.timers || []), { id: tid, at, what, why: clip(a.why, AUTO_LIMITS.AGENDA_WHY), fired: false, updatedAt: now, ...(followup ? { kind: 'followup' } : {}) }];
              message = `记下了 [${tid}]：${fmtTimer(at)} ${what}`;
            } else if (op === 'defer' && ((targetId && targetId.startsWith('t')) || (!targetId && a.what && findTimer()) || (targetId && findTimer()))) {
              const t = findTimer();
              if (!t) return { ok: false, message: `没有找到编号为 ${targetId || a.what || '?'} 的定时约定，先 show 看编号`, 今天的安排: agendaBlock(s.agenda, { timers: s.timers }) };
              const startOfDay = (ts) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };
              const hasDay = a.day !== undefined && a.day !== null && a.day !== '';
              const targetDay = hasDay ? Number(a.day) : Math.max(0, Math.round((startOfDay(t.at) - startOfDay(now)) / 86_400_000));
              const prevDate = new Date(t.at);
              let at = parseWhen(a.time, targetDay, { now, defaultHour: prevDate.getHours(), slot: a.slot });
              if (at && !a.time && !a.slot && prevDate.getMinutes()) {
                const d = new Date(at);
                d.setMinutes(prevDate.getMinutes(), 0, 0);
                at = d.getTime();
              }
              if (!at || at <= now) {
                return { ok: false, message: `时间「${a.time || a.slot || a.day}」没看懂或已过期，写成 10:00 或给 day`, 今天的安排: agendaBlock(s.agenda, { timers: s.timers }) };
              }
              t.at = at;
              t.fired = false;
              t.dropped = false;
              t.updatedAt = now;
              if (a.why) t.why = clip(a.why, AUTO_LIMITS.AGENDA_WHY);
              message = `已把 [${t.id}]「${t.what}」改到 ${fmtTimer(at)}`;
            } else if ((op === 'drop' || op === 'done') && ((targetId && targetId.startsWith('t')) || findTimer())) {
              const t = findTimer();
              if (!t) return { ok: false, message: `没有找到编号为 ${targetId || a.what || '?'} 的定时约定，先 show 看编号`, 今天的安排: agendaBlock(s.agenda, { timers: s.timers }) };
              t.fired = true;
              if (op === 'drop') t.dropped = true;
              t.updatedAt = now;
              message = op === 'drop' ? `取消了定时 [${t.id}]：${t.what}` : `标为已完成 [${t.id}]：${t.what}`;
            } else if (op !== 'show') {
              const r = applyOps(s.agenda, [{ op, id: a.id, slot: a.slot, time: a.time, what: a.what, why: a.why }], { by: 'owner', now });
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
      const safeClip = (text, n) => {
        const s0 = String(text || '').replace(/\s+/g, ' ').trim();
        if (s0.length <= n) return s0;
        let out = s0.slice(0, n).replace(/[（(][^）)]*$/, '').trim() || s0.slice(0, n);
        return out + '…';
      };
      const line = (x) => {
        const what = x.action === 'rest' ? safeClip(x.brief || x.note || '歇了一会儿', AUTO_LIMITS.LIFELOG_LINE) : safeClip(x.note || x.brief || x.action, AUTO_LIMITS.LIFELOG_LINE);
        return `${clock(x.at)} ${what}${x.why && x.action !== 'rest' ? `（${safeClip(x.why, AUTO_LIMITS.LIFELOG_WHY)}）` : ''}`;
      };
      s.lifeShown = Object.fromEntries([...Object.entries(s.lifeShown || {}).filter(([k]) => k !== key).slice(-4), [key, rows[rows.length - 1].at]]);
      save(s);
      return `【今天做过的事】${older ? `（更早还有 ${older} 件）` : ''}${rows.slice(-MAX).map(line).join('；')}`;
    }

    function buildTurnBackground(chat, sessionId = '') {
      try {
        if (!cfg().enabled || !chat) return '';
        const nowStr = `${new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })} ${clock()}`;
        if (chat.kind !== 'private') return chat.kind === 'group' ? `【当前时间】${nowStr}` : '';
        const { qq } = ownerOf();
        if (!qq || String(chat.userId) !== qq) return `【当前时间】${nowStr}`;
        const s = load();
        const last = (s.done || []).find((x) => !x.dry && !['idle', 'speak', 'timer'].includes(x.action));
        const bg = [`现在 ${nowStr}`];
        if (s.weather && s.weather.now) bg.push(`天气：${weatherLine(s.weather, { full: true })}`);
        bg.push(statusLine(s.agenda, last, { clockOf: clock, busy: s.busy }));
        const curStatus = (s.busy && Number(s.busy.until) > Date.now() && s.busy.status) || (s.customStatus && s.customStatus.text) || '';
        if (curStatus) bg.push(`当前 Discord 状态栏：「${clip(curStatus, AUTO_LIMITS.STATUS_BAR)}」`);
        const parts = [`【当前背景】${bg.join('｜')}`];
        const todoItems = ((s.agenda && s.agenda.items) || [])
          .filter((x) => x && x.state === 'todo' && x.what)
          .sort((a, b) => (Number(a.at) || Infinity) - (Number(b.at) || Infinity));
        const todayYmd = ymd(Date.now());
        const pendingTimers = (s.timers || [])
          .filter((t) => t && !t.fired && !t.dropped && t.at > Date.now() && t.what)
          .sort((a, b) => Number(a.at) - Number(b.at));
        const todayTimers = pendingTimers.filter((t) => ymd(t.at) === todayYmd);
        const futureTimers = pendingTimers.filter((t) => ymd(t.at) !== todayYmd);
        const cNow = cfg();
        const sleepHint = !cNow.fixedSchedule && s.sleepSchedule && Number(s.sleepSchedule.sleepAt) > Date.now()
          ? `今晚打算 ${clock(s.sleepSchedule.sleepAt)} 左右睡（明早 ${clock(s.sleepSchedule.wakeAt)} 左右起）`
          : `平时大概 ${Number(cNow.awakeTo) === 24 ? '半夜12点' : (Number(cNow.awakeTo) || 23) + '点'} 左右睡`;
        if (todoItems.length || todayTimers.length || sleepHint) {
          const slotZh = { morning: '上午', afternoon: '下午', evening: '晚上', night: '深夜' };
          const briefItems = todoItems.slice(0, 8).map((x) => `${x.at ? clock(x.at) + '·' : (slotZh[x.slot] ? slotZh[x.slot] + '·' : '')}${clip(x.what, AUTO_LIMITS.AGENDA_BRIEF)}`);
          for (const t of todayTimers.slice(0, 4)) briefItems.push(`${clock(t.at)}·${clip(t.what, AUTO_LIMITS.AGENDA_BRIEF)}`);
          if (sleepHint) briefItems.push(sleepHint);
          parts.push(`【今天还打算】${briefItems.join('、')}`);
        }
        if (futureTimers.length) {
          const fmtFuture = (t) => `${new Date(t.at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}·${clip(t.what, AUTO_LIMITS.AGENDA_BRIEF)}`;
          parts.push(`【之后约好的】${futureTimers.slice(0, 5).map(fmtFuture).join('、')}`);
        }
        const life = lifeLogBlock(s, sessionId);
        if (life) parts.push(life);
        if (s.energy && isAwakeHour(cfg())) {
          const v = energyNow(s);
          if (v < 35) parts.push(`【精力】你${energyLabel(v)}，回话会懒一点、短一点（别句句喊困）。`);
        }
        if (s.outing && s.outing.returnAt > Date.now()) {
          const p = s.outing.place;
          parts.push(`【在外面】你${clock(s.outing.departAt)}出的门，现在人在外面（${p.name}${s.outing.wish ? '，出门是想' + clip(s.outing.wish, AUTO_LIMITS.OUTING_WISH) : ''}），大概 ${clock(s.outing.returnAt)} 到家。是拿手机回的，回得短一点；还没逛完，别说成已经回家了，也别说已经买好了什么。${s.outing.photoFile ? '他想看这儿的样子，可以用 outing_photo 发张照片。' : ''}`);
        } else if (s.lastOuting && s.lastOuting.day === dayKey() && s.lastOuting.photoFile && s.lastOuting.photoOk !== false && s.lastOuting.story && Date.now() - s.lastOuting.backAt < 6 * 3600_000) {
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
          const dueCatchUp = sessDay < today && s.lastRolledSessionId !== sess.sessionId && (lastDay < today || idleOk);
          if (dueBedtime || dueCatchUp) {
            const targetDay = dueBedtime ? today : sessDay;
            const ctxLines = [];
            const activeT = (s.timers || []).filter((t) => t && !t.fired && !t.dropped && t.at > now).sort((a, b) => a.at - b.at).slice(0, 10);
            if (activeT.length) {
              ctxLines.push('已敲定的约定：' + activeT.map((t) => `${new Date(t.at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })} ${clip(t.what, AUTO_LIMITS.AGENDA_WHAT)}`).join('；'));
            }
            const recentF = (s.findings || []).filter((f) => f && f.text && f.at > now - FINDINGS_KEEP_MS).slice(0, 8);
            if (recentF.length) {
              ctxLines.push('近期查到的事实线索：\n' + recentF.map((f) => `- [${ymd(f.at)}] ${clip(f.query || f.topic, AUTO_LIMITS.FINDING_QUERY)}：${clip(f.text, AUTO_LIMITS.FINDING_SHOWN)}`).join('\n'));
            }
            const extraContext = ctxLines.join('\n');
            const r = await mem.sessionRollover(ownerChatId, { day: targetDay, merge: true, dream: true, lastLines: 0, extraContext });
            if (r && r.ok) {
              const fresh = load();
              fresh.sessionRolloverDay = today;
              fresh.lastRolledSessionId = sess.sessionId;
              save(fresh);
              s.sessionRolloverDay = today;
              s.lastRolledSessionId = sess.sessionId;
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
          const r = await mem.sessionRollover(chatId, { day: today, merge: false, lastLines: 0 });
          if (r && r.ok) {
            const fresh = load();
            fresh.groupRolloverDays = { ...(fresh.groupRolloverDays || {}), [chatId]: today };
            save(fresh);
            groupRollovers[chatId] = today;
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
    const fixedIsAwakeHour = (c, hour = new Date().getHours()) => {
      const from = Number(c.awakeFrom) || 0;
      const to = Number(c.awakeTo) || 24;
      return from <= to ? hour >= from && hour < to : hour >= from || hour < to;
    };
    const isAwakeHour = (c, hour = null) => {
      if (hour !== null && hour !== undefined) return fixedIsAwakeHour(c, hour);
      if (c.fixedSchedule) return fixedIsAwakeHour(c, new Date().getHours());
      try {
        const sc = readJson(stateFile(), null)?.sleepSchedule;
        if (sc && Number(sc.sleepAt) > 0 && Number(sc.wakeAt) > Number(sc.sleepAt)) {
          const now = Date.now();
          if (now >= Number(sc.sleepAt) && now < Number(sc.wakeAt)) return false;
          if (now < Number(sc.sleepAt)) return true;
          if (now >= Number(sc.wakeAt) && now < Number(sc.wakeAt) + 18 * 3600_000) return true;
        }
      } catch (error) {}
      return fixedIsAwakeHour(c, new Date().getHours());
    };
    /** 下一次「几点开始活跃」的时间点 */
    function nextAwakeAt(c, now = Date.now()) {
      if (!c.fixedSchedule) {
        try {
          const sc = readJson(stateFile(), null)?.sleepSchedule;
          if (sc && Number(sc.wakeAt) > now) return Number(sc.wakeAt);
        } catch (error) {}
      }
      const d = new Date(now);
      d.setMinutes(0, 0, 0);
      for (let i = 0; i < 48; i += 1) {
        d.setHours(d.getHours() + 1);
        if (fixedIsAwakeHour(c, d.getHours())) return d.getTime();
      }
      return now + 8 * 3600_000;
    }
    /** 下一次「几点睡觉」（离开活跃时段）的时间点；全天都醒着返回 0 */
    function nextSleepAt(c, now = Date.now()) {
      if (!c.fixedSchedule) {
        try {
          const sc = readJson(stateFile(), null)?.sleepSchedule;
          if (sc && Number(sc.sleepAt) > now) return Number(sc.sleepAt);
        } catch (error) {}
      }
      const d = new Date(now);
      d.setMinutes(0, 0, 0);
      for (let i = 0; i < 48; i += 1) {
        d.setHours(d.getHours() + 1);
        if (!fixedIsAwakeHour(c, d.getHours())) return d.getTime();
      }
      return 0;
    }

    const { bedtime, ensureEnergy, energyNow, addEnergy, energyPrompt, moodNudge, refreshWeather, tickTimedItems, tickLifeRecaps } = createLifeTick({
      api, cfg, ask, save, stateFile, clock, dayKey, ymd, randMin, ownerOf,
      isAwakeHour, nextSleepAt, nextAwakeAt,
      busyNow: (...a) => busyNow(...a),
      autoItem: (...a) => autoItem(...a),
      appendLog, diaryCount, writeLocalDiary, canReachOwnerNow, reachOwner, styleHint,
    });

    const heldOf = (s) => (s.held && typeof s.held === 'object' ? s.held : (s.held = {}));

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
        return { name, brief: clip((fm ? raw.slice(fm[0].length) : raw).replace(/\s+/g, ' ').trim(), AUTO_LIMITS.PERSONA_BRIEF) };
      } catch (error) {
        return { name: '', brief: '' };
      }
    }
    /** 人设卡里【做不到的事】那一节（语言层看的是整张卡；排日程、决策只拿这一节，规则只写在人设卡一处） */
    function personaLimits() {
      try {
        const c = readJson(configFile, {});
        const id = (c && c.persona && c.persona.current) || '';
        if (!id) return '';
        const raw = fs.readFileSync(path.join(aurabotDir, 'personas', id + '.md'), 'utf8');
        const m = raw.match(/【做不到的事】[^\n]*\n([\s\S]*?)(?=\n【|$)/);
        return m ? clip(m[1].trim(), 400) : '';
      } catch (error) {
        return '';
      }
    }
    async function askJudge(texts, ctx) {
      const now = Date.now();
      const me = personaBrief();
      const leftMin = Math.max(1, Math.round((ctx.untilAt - now) / 60_000));
      // 只有真正脱不开身（canPause === false）才允许晚回较久；出门逛街/书店/轻松状态最多延后 2 分钟，避免故意晾人
      const maxDelay = ctx.canPause === false ? Math.min(leftMin, 15) : Math.min(leftMin, 2);
      const doing = ctx.place
        ? `在外面（${ctx.place}），手机在身上，大概 ${clock(ctx.untilAt)} 回到家`
        : `正在${ctx.what || '忙自己的事'}，大概 ${clock(ctx.untilAt)} 弄完`;
      const pause = ctx.canPause === false ? '（你之前说过这件事中途放不下）' : ctx.canPause === true ? '（你之前说过这件事随时能放下）' : '（在外面闲逛/歇脚时通常能随手看手机）';
      const text = [
        me.brief ? `你的人设：${me.brief}` : '',
        `现在 ${clock(now)}。你${doing}${pause}。`,
        `${ctx.who}给你发了私聊：`,
        ...texts.map((t) => `「${t}」`),
        ctx.prevUntil ? `（你本来打算 ${clock(ctx.prevUntil)} 再看手机，现在又来了上面这些）` : '',
        '你会马上拿起手机回，还是过一会儿再看？如果不是真的脱不开身（比如只是在逛店、躲雨、发呆），通常 0 分钟直接回，顶多延后 1~2 分钟，别故意晾对方太久。',
        `只回 JSON：{"minutes":0,"why":"一句话"} —— minutes 是过几分钟再看（0 = 现在就回，最多 ${maxDelay}）。`,
      ].filter(Boolean).join('\n');
      try {
        const out = await ask(api.dsh, { key: 'hold', cfg: api.config(), system: `你是${me.name || '一个有自己生活的角色'}，手机响了，决定什么时候看。只输出 JSON。`, text, maxTokens: 200, temperature: 0.7, timeoutMs: 30_000 });
        const j = parseJsonLoose(out) || {};
        const m = Number(j.minutes);
        const minutes = Number.isFinite(m) ? Math.max(0, Math.min(maxDelay, Math.round(m))) : 0;
        const why = clip(j.why || '', AUTO_LIMITS.HOLD_WHY);
        api.log.info(`自主生活：${ctx.who}发来私聊（${texts.length} 条），她${minutes ? `打算 ${minutes} 分钟后再看` : '现在就回'}——${clip(why, AUTO_LIMITS.HOLD_WHY)}`);
        return { minutes, why };
      } catch (error) {
        api.log.warn('自主生活：问小脑回不回出错，直接回 ' + error.message);
        return { minutes: 0, why: '' };
      }
    }
    /** 合并同一个聊天这几秒来的消息，只问一次；返回 { id, minutes, why }，同一批拿到同一个 id */
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
          .then(({ minutes, why }) => ({ id: batch.id, minutes, why }))
          .finally(() => {
            if (judging.get(chatId) === batch) judging.delete(chatId);
          });
        judging.set(chatId, batch);
      }
      if (!j.closed && text) j.texts.push(clip(text, AUTO_LIMITS.CHAT_LINE));
      return j.promise;
    }
    /** 她现在在忙什么（在外面 / 手上有事）；没在忙返回 null */
    function busyNow(s, now = Date.now()) {
      if (s.outing && s.outing.returnAt > now) return { untilAt: s.outing.returnAt, place: (s.outing.place && s.outing.place.name) || '外面', what: '', canPause: null };
      if (s.busy && s.busy.until > now) return { untilAt: s.busy.until, place: '', what: s.busy.what || '', canPause: s.busy.canPause != null ? s.busy.canPause : null };
      return null;
    }

    // 排今天的日程用 high：一天只排一次，定了一整天怎么过（2026-11-21 回放：比 low 每天多排点不同的事；成本是每天一次调用）
    api.on('model', (sel, chat) => (sel && chat && chat.chatId === 'system:ext-autonomy:plan' ? { ...sel, reasoningEffort: 'high' } : undefined));

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
              if (r.why) h2.why = r.why;
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
          held2[info.chatId] = { since: t, until: t + r.minutes * 60_000, reason: 'busy', what: what2, why: r.why || '', count: 1, judged: 1, judgeId: r.id, userId: String(info.userId || '') };
          save(s2);
          api.log.info(`自主生活：${info.chatId} 的消息晚点回（在${what2}，约 ${r.minutes} 分钟后）`);
          return r.minutes * 60_000;
        } else if (isUrgent(info.text)) {
          return 0;
        }
        // 本地改：去掉闲着时 20% 随机「没看手机」晚回，仅在真正睡着或日程正忙时触发晚回
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
        e.rows = [...e.rows, { t: Date.now(), who: clip(msg.nickname || msg.userId, 24), text: clip(msg.text, AUTO_LIMITS.CHAT_LINE) }].slice(-12);
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
                ? `刚才在${h.what || '忙别的'}${h.why ? `（你当时心里想的是：${clip(h.why, AUTO_LIMITS.HOLD_WHY)}）` : ''}，现在才回（最早一条是 ${ago}）`
                : (() => {
                    const recentRest = (s.done || []).find((x) => x && x.action === 'rest' && Date.now() - (Number(x.at) || 0) < 60 * 60_000 && (x.brief || x.why));
                    return recentRest
                      ? `刚才在发呆/歇着（${clip(recentRest.brief || recentRest.why, AUTO_LIMITS.DONE_BRIEF)}），没看手机，现在才看到（最早一条是 ${ago}）`
                      : `刚才没看手机，现在才看到（最早一条是 ${ago}）`;
                  })();
        const note = mins >= 2 || h.reason === 'sleep'
          ? `【晚回提醒】${head}。晚回了一会儿，回复时可以自然顺嘴带一句刚才在干嘛（像平时跟朋友聊那样随口一提，别像写检讨）。`
          : `【刚才背景（不必刻意报备，直接正常聊就行）】${head}。`;
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
        const lines = unanswered.slice(-10).map((r) => `${fmtHM(r.t)} ${clip(r.text, AUTO_LIMITS.CHAT_LINE)}`).join('\n');
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

    // 自己的日程管理 + 惦记他的事
    api.rule((kind) => {
      if (kind !== 'private' || !cfg().enabled) return '';
      return [
        '你有自己的每日日程（由 my_agenda 管理）：想看完整时间/编号，或主人临时约事、改时间、让你加/删/挪某项安排时，用 my_agenda（action=show/add/drop/defer/done）处理，别只嘴上答应。',
        '主人说到之后会发生的事（面试、考试、看病、出差、交稿、约了人）、身体不舒服、或者在烦心的事，悄悄用 my_agenda 记一条 kind=followup 的跟进：what 写到时候要问什么（「问他面试怎么样」），day / time 写什么时候问合适（面试当天晚上、看完病第二天）。别告诉他你记下了，到时候自然地去问；同一件事记一次就够，小事别记。',
      ];
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
