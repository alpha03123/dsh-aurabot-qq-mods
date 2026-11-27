// autonomy 通用纯工具：JSON 原子读写、去重/限额、决策解析、活跃度表与 MBTI 解析。
import fs from 'node:fs';
import path from 'node:path';
import { clip, normSlot, parseJsonLoose, selfReport } from './agenda.mjs';
import { AUTO_LIMITS } from './limits.mjs';

export function readJson(file, fallback) {
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

export function writeJson(file, data) {
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

export const ACTIONS = ['idle', 'speak', 'bili', 'web', 'diary', 'phone', 'draw', 'think', 'rest', 'outing'];
/** 一天最多出门几次 */
export const OUTING_MAX_PER_DAY = 3;
// 查到过的东西留多久、最多几条（state.findings）
export const FINDINGS_KEEP_MS = 7 * 86_400_000;
export const FINDINGS_MAX = 30;
export const FINDINGS_SHOWN = 6;
/** 之前查到过的要点（事实）：最近的在前，给决策层 / 排日程看，免得以为一直没查到 */
export function findingsBlock(s) {
  const list = (Array.isArray(s && s.findings) ? s.findings : []).filter((x) => x && x.text).slice(0, FINDINGS_SHOWN);
  if (!list.length) return '';
  const when = (t) => {
    const d = new Date(t);
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return d.toDateString() === new Date().toDateString() ? `今天 ${hm}` : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  };
  return `【你之前查到过的】（B 站 / 上网真找到的要点）\n${list.map((x) => `- ${when(x.at)}${x.topic ? `〔${x.topic}〕` : ''}${x.query ? `搜「${x.query}」` : ''}：${String(x.text).slice(0, AUTO_LIMITS.FINDING_SHOWN)}`).join('\n')}`;
}
/** 有专用执行器的动作；不在这里的动作发布版只记录、不执行 */
export const STANDARD_ACTIONS = new Set(ACTIONS);
// 日程里「空着」的那段：到点让她自己决定这段时间干嘛
export const FREE_ACTION = 'free';
/** 到点自己发生的生活小事（不用想，直接过）：有名字、但不是能执行的动作、也不是「空着」 */
export const autoItem = (x) => !!x && !!x.action && !STANDARD_ACTIONS.has(x.action) && x.action !== FREE_ACTION;

/** 一天最多允许「只想不做」几次；超了就必须真动手 */
export const THINK_LIMIT_PER_DAY = 2;

/**
 * 同一个动作一天最多做几次。
 * 反复做同一件事 = 换了个名字的发呆：翻一遍目录、再翻一遍、又翻一遍，
 * 机器上每次都"有输出"，所以骗得过一切产出检查——只能靠次数硬拦。
 */
export const ACTION_MAX_PER_DAY = 5;
/** 同一件事连着做到第几次就不再催「接着做」，改成提醒换一件 */

/**
 * 容器型动作：每次进去做的事都不一样（逛不同的 App、写不同的脚本、画不同的图），
 * 不该被「同一件事一天最多做几次」这条规则算进去。手机要逛 100 次就靠这条放行。
 */
export const REPEATABLE_ACTIONS = new Set(['phone', 'draw', 'bili', 'web', 'rest', 'think']);

/** 动作名相似到这个程度就算同一件事（翻软家底 ≈ 查软家底） */
export const SAME_ACTION_SIM = 0.6;

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

export const dayKey = () => new Date().toDateString();

/**
 * 这个动作到底算不算「做过一件事」。
 * think 只是空想，rest 是歇着——两样都不占配额，也不该被算成「做够了」。
 */
export const countsForQuota = (d) => !!d && !d.dry && !REPEATABLE_ACTIONS.has(String(d.action || ''));

/**
 * 动作的类别。喜欢「软」没问题，问题是一整天只有软——
 * 所以约束的不是审美，而是「今天有没有一件明天还能接着用的东西」。
 *   soft  ：审美、自娱自乐（软诗、歪纸条、翻自己攒的软东西）—— 看一眼就没了
 *   learn ：读手册/文档、弄清一个命令或算法、搞懂一个概念 —— 留下的是笔记
 *   build ：写脚本/工具/页面、搭目录、把功能做出来 —— 留下的是能跑的东西
 *   other ：刷站、聊天、日记、玩手机这些日常
 */
export const KINDS = ['soft', 'learn', 'build', 'other'];

/** 软类一天最多几次——不是禁止，是不许占满一整天 */
export const SOFT_MAX_PER_DAY = 60;

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
export const clock = (ts = Date.now()) => new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });


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
    why: String(j.why || '').slice(0, AUTO_LIMITS.AGENDA_WHY),
    detail: String(j.detail || '').slice(0, AUTO_LIMITS.EXEC_OUTPUT),
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
    topic: String(j.topic || '').replace(/[\s「」『』"“”]/g, '').slice(0, 24),
    // web 用：拿去搜索引擎搜的关键词（不再拿 detail 那句话截断去搜）
    query: String(j.query || '').replace(/\s+/g, ' ').trim().slice(0, AUTO_LIMITS.FINDING_QUERY),
    // outing 用：想去什么样的地方（她自己写，比如「能翻食谱的书店」「江边」）；地图搜索词放 query
    place: String(j.place || '').replace(/\s+/g, ' ').trim().slice(0, AUTO_LIMITS.OUTING_PLACE),
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
export const MBTI_STYLE = {
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
