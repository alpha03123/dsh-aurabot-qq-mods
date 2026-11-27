// 自主生活规则、聊天指令（/日记 /行程 /自主）与 Web 面板 HTTP 路由（/state /activity /plan /wake /try 等）。
import fs from 'node:fs';
import { agendaBlock, applyOps, energyLabel, weatherLine } from './agenda.mjs';
import { readJson, writeJson, parseActivityTable, rateForHour } from './helpers.mjs';
import { grantRows, isGranted } from './grants.mjs';

export function registerAutonomyRoutes({
  api,
  cfg,
  hub,
  load,
  save,
  emptyState,
  readLog,
  logFile,
  diaryDir,
  diaryRecent,
  outingFile,
  outingReady,
  currentMbti,
  energyNow,
  isAwakeHour,
  isWaking,
  setWaking,
  planDay,
  wake,
  act,
}) {
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
    const grants = grantRows(c);
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

  api.command({
    name: '自主',
    aliases: ['autonomy', '自主生活'],
    desc: '看或改自主生活：/自主 开｜关｜状态｜60（数字=每天最多醒几次）',
    run: (arg, msg) => {
      const from = String((msg && msg.userId) || '').trim();
      if (!from || !api.isOwner(from)) {
        api.log.warn('自主生活：非主人尝试改设置，已拒绝 userId=' + (from || '(空)'));
        return '';
      }
      const a = String(arg || '').trim();
      const c = cfg();
      if (!a || /^(状态|status|查|查询)$/i.test(a)) {
        const s = load();
        return `自主生活：${c.enabled ? '开着' : '关着'}；今天醒了 ${s.wakes || 0} 次，每天上限 ${c.maxWakesPerDay || 40} 次`;
      }
      if (/^(开|打开|on|启用|开启)$/i.test(a)) {
        api.saveSettings({ enabled: true });
        return '好，自主生活开了';
      }
      if (/^(关|关掉|off|停|暂停|关闭)$/i.test(a)) {
        api.saveSettings({ enabled: false });
        return '好，自主生活停了，不会再自己醒来';
      }
      const n = Number(a);
      if (Number.isFinite(n) && n >= 0) {
        api.saveSettings({ maxWakesPerDay: Math.round(n) });
        return `改好了，每天最多醒 ${Math.round(n)} 次`;
      }
      return '用法：/自主 开｜关｜状态｜60（数字改每天上限）';
    },
  });

  api.route('/state', async () => ({ ok: true, ...snapshot() }));
  api.route('/activity', async () => ({ ok: true, items: readLog(200) }));
  api.route('/plan', async () => {
    if (isWaking()) return { ok: false, message: '正在醒着呢，等这一轮跑完', state: snapshot() };
    setWaking(true);
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
      setWaking(false);
    }
  });
  api.route('/places/reset', async () => {
    writeJson(outingFile(), { cache: {}, visits: {} });
    return { ok: true };
  });
  api.route('/places', async () => {
    const o = readJson(outingFile(), () => ({ cache: {}, visits: {} }));
    const cache = Object.fromEntries(Object.entries(o.cache || {}).map(([k, v]) => [k, { at: v.at, n: (v.items || []).length, names: (v.items || []).slice(0, 15).map((x) => `${x.name}（${x.src}）`) }]));
    return { ok: true, ready: outingReady(), cache, visits: o.visits || {} };
  });
  api.route('/agenda', async (req) => {
    const http = api.core && api.core.http;
    const body = (http && typeof http.body === 'function' && req && req.method === 'POST' ? await http.body(req) : null) || {};
    const ops = Array.isArray(body.ops) ? body.ops : [];
    const s = load();
    const r = ops.length ? applyOps(s.agenda, ops, { by: 'owner', max: 5 }) : { applied: [], rejected: [] };
    if (r.applied.length) save(s);
    return { ok: true, ...r, agenda: s.agenda };
  });
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
    if (isWaking()) return { ok: false, message: '正在醒着呢，等这一轮跑完', state: snapshot() };
    setWaking(true);
    try { return { ok: true, result: await wake(), state: snapshot() }; } finally { setWaking(false); }
  });
  api.route('/try', async (req) => {
    if (isWaking()) return { ok: false, message: '正在醒着呢，等这一轮跑完' };
    if (!isGranted(api.settings(), 'model')) return { ok: false, message: '「调用模型做决策」还没授权' };
    const q = api.core && api.core.http && typeof api.core.http.query === 'function' ? api.core.http.query(req) : {};
    const action = String((q && q.action) || '').trim().slice(0, 16);
    if (!action) return { ok: false, message: '要给 action' };
    const d = { action, detail: String((q && q.detail) || '').slice(0, 200), query: String((q && q.query) || '').slice(0, 40), place: String((q && q.place) || '').slice(0, 30), why: '测试', steps: [], kind: '', nextMinutes: 0, agendaId: '', ops: [] };
    const scratch = load();
    scratch.__trial = true;
    setWaking(true);
    const t0 = Date.now();
    try {
      const r = await act(d, scratch);
      api.log.info(`自主生活（测试）：${action} —— ${r.note}`);
      return { ok: true, action, note: r.note, extra: r.extra, ms: Date.now() - t0 };
    } catch (error) {
      return { ok: false, action, message: error.message, ms: Date.now() - t0 };
    } finally {
      setWaking(false);
    }
  });
  api.route('/diary', async () => ({ ok: true, items: diaryRecent(30) }));
  api.route('/reset', async (req) => {
    if (isWaking()) return { ok: false, message: '正在醒着呢，等这一轮跑完再重置' };
    save(emptyState());
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

  return { snapshot };
}
