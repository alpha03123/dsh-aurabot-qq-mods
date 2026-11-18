/**
 * 今天的安排（软计划）—— 纯逻辑，不读盘、不碰模型。
 *
 * 安排只分时段（上午 / 下午 / 晚上 / 深夜），不写几点几分；到点准时触发的只有主人约好的定时提醒（timers）。
 * 条目来源：
 *   self    —— 早上她自己定的
 *   seen    —— 逛的时候看到东西临时加的
 *   promise —— 和主人聊出来的约定：后台不能删、不能挪，只有主人那边（my_agenda 工具）能改
 * 状态：todo / done / dropped。过了时段还没做的不自动判失败，留给她自己决定接着做、挪走还是算了。
 */

export const SLOTS = ['morning', 'afternoon', 'evening', 'night'];
export const SLOT_LABEL = { morning: '上午', afternoon: '下午', evening: '晚上', night: '深夜' };
const SLOT_ALIAS = [
  [/^(morning|上午|早上|早晨|清早|早)$/i, 'morning'],
  [/^(afternoon|下午|中午|午后|午)$/i, 'afternoon'],
  [/^(evening|晚上|傍晚|今晚|晚)$/i, 'evening'],
  [/^(night|深夜|夜里|半夜|睡前|夜)$/i, 'night'],
];

/** 一天最多几条（含已完成和划掉的）：防止后台一路加个没完 */
export const MAX_ITEMS = 14;
/** 后台一天最多改几次表（有变动的那几轮才算） */
export const REPLAN_MAX_PER_DAY = 8;
/** 安排里的「找主人说话」一天最多几次；答应主人的不算 */
export const SPEAK_MAX_PER_DAY = 3;
/** 没做完的事最多拖几天：自己的事拖两天就算了，答应主人的多留一天 */
const CARRY_MAX_AGE = { self: 2, seen: 2, promise: 3 };

export function slotOf(hour) {
  const h = Number(hour);
  if (h < 5) return 'night';
  if (h < 12) return 'morning';
  if (h < 18) return 'afternoon';
  if (h < 23) return 'evening';
  return 'night';
}

export function normSlot(value, fallback = '') {
  const v = String(value || '').trim();
  if (SLOTS.includes(v)) return v;
  for (const [re, slot] of SLOT_ALIAS) if (re.test(v)) return slot;
  return fallback;
}

/** 时段先后：过去的时段 < 当前 < 以后（深夜接在晚上后面） */
const slotRank = (slot) => SLOTS.indexOf(slot);

export function clip(text, max) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, max);
}

/** 字符集 Jaccard，中文短句够用：「去B站看纪录片」≈「B站上看个纪录片」 */
export function similarText(a, b) {
  const x = String(a || '').replace(/[\s，。,.!！?？、]/g, '');
  const y = String(b || '').replace(/[\s，。,.!！?？、]/g, '');
  if (!x || !y) return 0;
  if (x === y) return 1;
  const A = new Set(x);
  const B = new Set(y);
  let inter = 0;
  for (const ch of A) if (B.has(ch)) inter += 1;
  return inter / (A.size + B.size - inter);
}
const SAME_ITEM_SIM = 0.6;

export function newAgenda(date) {
  return { date, theme: '', items: [], planned: false, planTries: 0, replans: 0, speaks: 0, recap: '', nextId: 1 };
}

/** 读盘后的清洗：日期不对就给新的一天 */
export function normalizeAgenda(raw, date) {
  if (!raw || typeof raw !== 'object' || raw.date !== date) return newAgenda(date);
  const a = { ...newAgenda(date), ...raw };
  a.items = (Array.isArray(raw.items) ? raw.items : []).filter((x) => x && x.id && x.what).slice(0, MAX_ITEMS + 4);
  for (const k of ['planTries', 'replans', 'speaks', 'nextId']) a[k] = Math.max(k === 'nextId' ? 1 : 0, Number(a[k]) || 0);
  const maxId = a.items.reduce((m, x) => Math.max(m, Number(String(x.id).slice(1)) || 0), 0);
  if (a.nextId <= maxId) a.nextId = maxId + 1;
  return a;
}

const live = (a) => a.items.filter((x) => x.state !== 'dropped');

/**
 * 加一条。返回 { ok, item?, reason? }。
 * 和已有的（没划掉的）太像就不加：后台最常见的毛病就是同一件事换个说法再塞一遍。
 */
export function addItem(agenda, { slot, what, why = '', from = 'self', action = '', age = 0, at = 0 } = {}, { hour = new Date().getHours(), now = Date.now() } = {}) {
  const w = clip(what, 40);
  if (!w) return { ok: false, reason: '没写要做什么' };
  if (agenda.items.length >= MAX_ITEMS) return { ok: false, reason: `今天已经排了 ${MAX_ITEMS} 条，别再加了` };
  const dup = live(agenda).find((x) => similarText(x.what, w) >= SAME_ITEM_SIM);
  if (dup) return { ok: false, reason: `和 ${dup.id}「${dup.what}」是一件事` };
  const item = {
    id: 'a' + agenda.nextId,
    slot: normSlot(slot, slotOf(hour)),
    what: w,
    why: clip(why, 40),
    from: ['self', 'seen', 'promise'].includes(from) ? from : 'self',
    action: clip(action, 16),
    state: 'todo',
    note: '',
    age: Math.max(0, Number(age) || 0),
    addedAt: now,
    ...(at ? { at } : {}),
  };
  agenda.nextId += 1;
  agenda.items.push(item);
  return { ok: true, item };
}

/**
 * 改表。by = 'self'（后台她自己）或 'owner'（主人聊天里通过工具改）。
 * 后台改不动答应主人的条目。返回实际生效的几条说明（给日志 / 工具回执用）。
 */
export function applyOps(agenda, ops, { by = 'self', hour = new Date().getHours(), now = Date.now(), max = 3 } = {}) {
  const applied = [];
  const rejected = [];
  for (const raw of (Array.isArray(ops) ? ops : []).slice(0, max)) {
    if (!raw || typeof raw !== 'object') continue;
    const op = String(raw.op || '').toLowerCase();
    const why = clip(raw.why, 40);
    if (op === 'add') {
      const from = by === 'owner' ? 'promise' : raw.from === 'seen' ? 'seen' : 'self';
      const r = addItem(agenda, { slot: raw.slot, what: raw.what, why, from, action: raw.action }, { hour, now });
      if (r.ok) applied.push(`加了 ${r.item.id}「${r.item.what}」（${SLOT_LABEL[r.item.slot]}）`);
      else rejected.push(`没加「${clip(raw.what, 20)}」：${r.reason}`);
      continue;
    }
    const item = agenda.items.find((x) => x.id === String(raw.id || '').trim());
    if (!item) {
      rejected.push(`${op} ${raw.id || '?'}：没有这条`);
      continue;
    }
    if (item.from === 'promise' && by !== 'owner' && op !== 'done') {
      rejected.push(`${item.id} 是答应主人的，不能自己${op === 'drop' ? '划掉' : '挪'}`);
      continue;
    }
    if (op === 'drop' && item.state === 'todo') {
      item.state = 'dropped';
      item.note = why || item.note;
      applied.push(`划掉 ${item.id}「${item.what}」${why ? '：' + why : ''}`);
    } else if (op === 'defer' && item.state === 'todo') {
      const slot = normSlot(raw.slot, '');
      if (!slot || slot === item.slot) {
        rejected.push(`${item.id}：挪到哪个时段没说清`);
        continue;
      }
      item.slot = slot;
      item.note = why || item.note;
      applied.push(`${item.id}「${item.what}」挪到${SLOT_LABEL[slot]}${why ? '：' + why : ''}`);
    } else if (op === 'done' && item.state === 'todo') {
      item.state = 'done';
      item.note = why || item.note;
      item.doneAt = now;
      applied.push(`${item.id}「${item.what}」算做完了`);
    }
  }
  return { applied, rejected };
}

/** 昨天没做完、还值得带到今天的（只挑出来，要不要放进今天由早上的计划决定；约定直接保留） */
export function carryCandidates(prev) {
  if (!prev || !Array.isArray(prev.items)) return [];
  return prev.items
    .filter((x) => x && x.state === 'todo' && !x.at)
    .map((x) => ({ ...x, age: (Number(x.age) || 0) + 1 }))
    .filter((x) => x.age <= (CARRY_MAX_AGE[x.from] || 2));
}

/** 今天计划里某条是不是从昨天接过来的：像就继承天数 */
export function inheritAge(what, carries) {
  const hit = (carries || []).find((x) => similarText(x.what, what) >= SAME_ITEM_SIM);
  return hit ? hit.age : 0;
}

function itemLine(x, curSlot) {
  const tags = [];
  if (x.from === 'promise') tags.push('答应主人的，别鸽');
  if (x.from === 'seen') tags.push('看到东西临时加的');
  if (x.age) tags.push(`拖了 ${x.age} 天`);
  let state = '还没做';
  if (x.state === 'done') state = '做了' + (x.note ? '：' + x.note : '');
  else if (x.state === 'dropped') state = '划掉了' + (x.note ? '：' + x.note : '');
  else if (slotRank(x.slot) < slotRank(curSlot)) state = '时段过了还没做';
  else if (x.note) state = (Number(x.tries) > 0 ? '还没做成：' : '还没做（') + x.note + (Number(x.tries) > 0 ? '' : '）');
  return `- [${x.id}] ${SLOT_LABEL[x.slot] || ''}${x.at ? ' ' + fmtClock(x.at) : ''} · ${x.what}${x.why ? `（${x.why}）` : ''}${tags.length ? `〔${tags.join('，')}〕` : ''} —— ${state}`;
}

/** 这个时段是不是已经过去了（计划里排到过去的时段就丢掉） */
export function slotPassed(slot, hour = new Date().getHours()) {
  return slotRank(slot) >= 0 && slotRank(slot) < slotRank(slotOf(hour));
}

/**
 * 醒着的那几分钟里主人可能通过工具改了盘上的状态；这一轮最后存盘前把那边新加的约定和定时并回来，
 * 不然会被这一轮手里那份旧状态整个盖掉。
 */
export function mergeOwnerEdits(mine, disk) {
  if (!disk || typeof disk !== 'object') return mine;
  const dt = Array.isArray(disk.timers) ? disk.timers : [];
  const mt = Array.isArray(mine.timers) ? mine.timers : [];
  for (const t of dt) {
    const hit = mt.find((x) => x.id === t.id);
    if (!hit) mt.push(t);
    else if (t.fired) hit.fired = true;
  }
  mine.timers = mt;
  const da = disk.agenda && disk.agenda.date === (mine.agenda && mine.agenda.date) ? disk.agenda : null;
  if (da && Array.isArray(da.items)) {
    for (const x of da.items) {
      if (x.from !== 'promise') continue;
      const same = mine.agenda.items.find((y) => y.id === x.id);
      if (same && same.what === x.what) {
        if (same.state === 'todo' && x.state !== 'todo') Object.assign(same, { state: x.state, note: x.note });
        else if (same.state === 'todo' && x.slot !== same.slot) same.slot = x.slot;
        continue;
      }
      if (mine.agenda.items.some((y) => y.from === 'promise' && y.what === x.what)) continue;
      mine.agenda.items.push({ ...x, id: 'a' + mine.agenda.nextId });
      mine.agenda.nextId += 1;
    }
  }
  return mine;
}

/** 写进每轮决策提示词的那一段 */
export function agendaBlock(agenda, { hour = new Date().getHours(), timers = [], now = Date.now() } = {}) {
  const cur = slotOf(hour);
  const lines = ['【今天的安排】'];
  if (!agenda || !agenda.items.length) {
    lines.push(agenda && agenda.planned ? '今天没给自己排什么，随心过。' : '今天还没定安排。');
  } else {
    if (agenda.theme) lines.push(`今天大概想：${agenda.theme}`);
    for (const x of agenda.items) lines.push(itemLine(x, cur));
  }
  const pendingTimers = (timers || []).filter((t) => !t.fired && t.at > now);
  for (const t of pendingTimers) {
    const when = new Date(t.at).toDateString() === new Date(now).toDateString() ? fmtClock(t.at) : `${new Date(t.at).getMonth() + 1}/${new Date(t.at).getDate()} ${fmtClock(t.at)}`;
    lines.push(t.kind === 'followup'
      ? `- 惦记着：${when} 去问问他「${t.what}」（到点系统会叫你）`
      : `- 定好的：${when} ${t.what}（到点系统会叫你，不用自己盯）`);
  }
  const open = agenda ? agenda.items.filter((x) => x.state === 'todo' && x.slot === cur) : [];
  lines.push(`现在是${SLOT_LABEL[cur]}。${open.length ? `这个时段还没做的：${open.map((x) => x.id).join('、')}。` : '这个时段没有排着的事。'}`);
  return lines.join('\n');
}

/** 聊天时塞进上下文的一句：只说现在或刚才在干嘛，不带「接下来想做什么」以免打断聊天 */
export function statusLine(_agenda, lastDone, { now = Date.now(), clockOf = fmtClock, busy = null } = {}) {
  const did = lastDone && clip(lastDone.brief || lastDone.note, 30);
  const doing = busy && Number(busy.until) > now && busy.what ? clip(busy.what, 30) : '';
  if (doing) return `正在${doing}`;
  if (did && now - (Number(lastDone.at) || 0) < 3 * 3600_000) return `刚才（${clockOf(lastDone.at)}）${did}`;
  return '自己待着，没在忙什么（别编自己刚才在做什么）';
}

export function fmtClock(ts) {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** 「22:00」「晚上10点」「10点半」→ 今天或明天的时间戳；看不懂返回 0 */
export function parseClockToday(text, now = Date.now()) {
  const s = String(text || '').trim();
  let h;
  let m = 0;
  let mm = s.match(/^(\d{1,2})[:：](\d{2})$/);
  if (mm) {
    h = Number(mm[1]);
    m = Number(mm[2]);
  } else if ((mm = s.match(/^(早上|上午|中午|下午|傍晚|晚上|夜里|半夜)?\s*(\d{1,2})\s*点\s*(半|(\d{1,2})\s*分?)?$/))) {
    h = Number(mm[2]);
    m = mm[3] === '半' ? 30 : Number(mm[4]) || 0;
    if (/下午|傍晚|晚上|夜里/.test(mm[1] || '') && h < 12) h += 12;
    if (mm[1] === '中午' && h < 6) h += 12;
  } else return 0;
  if (!(h >= 0 && h < 24 && m >= 0 && m < 60)) return 0;
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** 模型回的 JSON：先整段解析，失败返回 null */
export function parseJsonLoose(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch (error) {
    return null;
  }
}

/**
 * 「哪天 + 几点」→ 时间戳。day = 0 今天、1 明天……；time 可空。
 * 没给时间的跟进默认那天晚上 8 点（今天已经过了 8 点就一个半小时后）；看不懂返回 0。
 */
export function parseWhen(timeText, day = 0, { now = Date.now(), defaultHour = 20 } = {}) {
  const d0 = Math.max(0, Math.min(14, Math.round(Number(day) || 0)));
  const t = String(timeText || '').trim();
  let at = 0;
  if (t) {
    at = parseClockToday(t, now);
    if (!at) return 0;
    if (d0 > 0) {
      const base = new Date(now);
      base.setDate(base.getDate() + d0);
      const hit = new Date(at);
      base.setHours(hit.getHours(), hit.getMinutes(), 0, 0);
      at = base.getTime();
    }
    return at;
  }
  const d = new Date(now);
  d.setDate(d.getDate() + d0);
  d.setHours(defaultHour, 0, 0, 0);
  if (d.getTime() <= now) return now + 90 * 60_000;
  return d.getTime();
}

/** 做一件事大概要忙多久（分钟），这期间来消息会晚点回。0 = 不算忙 */
export function busyMinutes(action, text = '', random = Math.random) {
  const r = (lo, hi) => Math.round(lo + random() * (hi - lo));
  const t = String(text || '');
  if (action === 'bili') return r(10, 20);
  if (action === 'web') return r(8, 15);
  if (action === 'draw') return r(15, 30);
  if (action === 'diary') return r(5, 12);
  if (action === 'phone') return r(10, 20);
  if (action === 'outing') return r(30, 60);
  if (['speak', 'think', 'rest', 'idle', 'timer', 'plan', 'newmod'].includes(action)) return 0;
  // 生活里的事（自己起名的动作）
  if (/午睡|午觉|小睡|眯一会|打盹/.test(t)) return r(30, 60);
  if (/洗澡|泡澡|洗头/.test(t)) return r(15, 25);
  if (/吃|饭|面|外卖|做菜|下厨/.test(t)) return r(20, 40);
  if (/散步|出门|逛|买|超市/.test(t)) return r(20, 45);
  return r(10, 25);
}

/** 对方像是有急事：别再晚回了 */
export function isUrgent(text) {
  const t = String(text || '');
  return /急|快回|速回|紧急|救命|出事|马上|赶紧|在吗[？?]?\s*在吗|[？?]{3,}|[！!]{3,}/.test(t);
}


// ── 天气（Open-Meteo，免费、不用 key）────────────────────────────
const WMO = {
  0: '晴', 1: '晴间多云', 2: '多云', 3: '阴', 45: '有雾', 48: '有雾',
  51: '毛毛雨', 53: '毛毛雨', 55: '毛毛雨', 56: '冻毛毛雨', 57: '冻毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '下雪粒',
  80: '阵雨', 81: '阵雨', 82: '强阵雨', 85: '阵雪', 86: '阵雪',
  95: '雷阵雨', 96: '雷阵雨带冰雹', 99: '雷阵雨带冰雹',
};
export const weatherText = (code) => WMO[Number(code)] || '天气说不好';
export const isWet = (code) => Number(code) >= 51;

/** Open-Meteo 的返回 → 我们存的样子 */
export function parseWeather(j, city = '') {
  if (!j || !j.current || !j.daily) return null;
  const day = (i) => ({
    code: j.daily.weather_code?.[i],
    text: weatherText(j.daily.weather_code?.[i]),
    max: Math.round(Number(j.daily.temperature_2m_max?.[i])),
    min: Math.round(Number(j.daily.temperature_2m_min?.[i])),
    pop: Number(j.daily.precipitation_probability_max?.[i]) || 0,
  });
  return {
    city,
    now: {
      temp: Math.round(Number(j.current.temperature_2m)),
      feels: Math.round(Number(j.current.apparent_temperature)),
      code: j.current.weather_code,
      text: weatherText(j.current.weather_code),
      wind: Math.round(Number(j.current.wind_speed_10m) || 0),
    },
    today: day(0),
    tomorrow: day(1),
  };
}

/** 一句话天气：full = 带今天明天 */
export function weatherLine(w, { full = true } = {}) {
  if (!w || !w.now) return '';
  const head = `${w.city || ''}现在${w.now.text}，${w.now.temp}°C${Math.abs(w.now.feels - w.now.temp) >= 3 ? `（体感 ${w.now.feels}°C）` : ''}`;
  if (!full) return head;
  const t = w.today ? `；今天 ${w.today.min}~${w.today.max}°C${w.today.pop >= 30 ? `，降水概率 ${w.today.pop}%` : ''}` : '';
  const m = w.tomorrow ? `；明天${w.tomorrow.text}，${w.tomorrow.min}~${w.tomorrow.max}°C` : '';
  return head + t + m;
}

/** 天气值不值得提一嘴（下雨下雪、明显降温、很冷很热） */
export function weatherNotable(w) {
  if (!w || !w.now) return false;
  const cooling = Boolean(w.today && w.tomorrow && (w.today.max - w.tomorrow.max >= 5 || w.today.min - w.tomorrow.min >= 5));
  const tomorrowWet = Boolean(w.tomorrow && (isWet(w.tomorrow.code) || w.tomorrow.pop >= 60));
  return isWet(w.now.code) || (w.today && w.today.pop >= 60) || tomorrowWet || cooling || w.now.temp <= 5 || w.now.temp >= 33 || Number(w.now.code) === 45;
}

// ── 精力 ──────────────────────────────────────────────────────
export const ENERGY_DRAIN_PER_HOUR = 4.5;
export function energyAt(e, now = Date.now()) {
  if (!e) return 70;
  const v = Number(e.value) - ENERGY_DRAIN_PER_HOUR * Math.max(0, now - Number(e.at)) / 3600_000;
  return Math.max(5, Math.min(100, v));
}
export function energyLabel(v) {
  return v >= 70 ? '精神不错' : v >= 45 ? '还行' : v >= 25 ? '有点累' : '困得不行';
}
/** 做完一件事精力怎么变 */
export function energyDelta(action, text = '') {
  const t = String(text || '');
  if (action === 'rest') return 12;
  if (action === 'outing') return -5;
  if (/午睡|午觉|小睡|眯一会|打盹/.test(t)) return 25;
  if (/吃|饭|面|外卖|宵夜|零食|奶茶/.test(t)) return 8;
  if (/洗澡|泡澡|泡脚/.test(t)) return 5;
  if (['bili', 'web', 'phone', 'draw'].includes(action)) return -3;
  if (['diary', 'think', 'speak', 'idle', 'timer', 'plan'].includes(action)) return 0;
  return -2;
}
