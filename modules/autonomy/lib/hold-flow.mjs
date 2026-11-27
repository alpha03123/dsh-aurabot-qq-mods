// 晚回判断、睡眠吵醒、群聊补回与每轮 prompt 背景注入（reply/hold、group/decide、prompt、catchUpHeld）。
import fs from 'node:fs';
import path from 'node:path';
import { clip, isUrgent, parseJsonLoose } from './agenda.mjs';
import { readJson } from './helpers.mjs';
import { AUTO_LIMITS } from './limits.mjs';

const HOLD_TALKING_MS = 10 * 60_000;
const JUDGE_GATHER_MS = 2500;
const JUDGE_MAX_PER_HOLD = 3;

export function createHoldFlow({
  api,
  cfg,
  ask,
  hub,
  load,
  save,
  clock,
  ymd,
  fmtHM,
  randMin,
  ownerOf,
  isAwakeHour,
  nextAwakeAt,
  heldOf,
  moodNudge,
  addEnergy,
  lastOut,
  appendLog,
  buildTurnBackground,
  configFile,
  aurabotDir,
}) {
  function wakeChance(s, c, { count = 1, urgent = false, owner = false } = {}) {
    let p = 0.05 + 0.1 * Math.max(0, count - 1) + (urgent ? 0.25 : 0) + (owner ? 0.05 : 0);
    const h = new Date().getHours();
    const toWake = (nextAwakeAt(c) - Date.now()) / 3600_000;
    if (toWake <= 1) p *= 1.6;
    else if (h >= 1 && h < 5) p *= 0.6;
    const e = s.energy ? Number(s.energy.value) : 60;
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

  function wokenUp(s, where) {
    moodNudge(-3, '睡着被吵醒了');
    addEnergy(s, -8);
    api.log.info(`自主生活：在${where}被吵醒了`);
  }

  const isAsleep = () => {
    const c = cfg();
    return !!c.enabled && !isAwakeHour(c);
  };

  const judging = new Map();
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

  /** 人设卡里【做不到的事】那一节 */
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

  function busyNow(s, now = Date.now()) {
    if (s.outing && s.outing.returnAt > now) return { untilAt: s.outing.returnAt, place: (s.outing.place && s.outing.place.name) || '外面', what: '', canPause: null };
    if (s.busy && s.busy.until > now) return { untilAt: s.busy.until, place: '', what: s.busy.what || '', canPause: s.busy.canPause != null ? s.busy.canPause : null };
    return null;
  }

  api.on('model', (sel, chat) => (sel && chat && chat.chatId === 'system:ext-autonomy:plan' ? { ...sel, reasoningEffort: 'high' } : undefined));

  api.on('reply/hold', async (ms, info) => {
    try {
      const c = cfg();
      if (!c.enabled || c.delayReplies === false || !info || !info.chatId) return undefined;
      const now = Date.now();
      const s = load();
      const held = heldOf(s);
      const h = held[info.chatId];
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
      if (now - last < HOLD_TALKING_MS) return 0;
      let until = 0;
      let reason = '';
      let what = '';
      if (!isAwakeHour(c)) {
        if (Math.random() < wakeChance(s, c, { count: 1, urgent: isUrgent(info.text), owner: !!info.owner })) {
          held[info.chatId] = { since: now, until: now + randMin(0.5, 2), reason: 'sleep', what: '', count: 1, woken: true, userId: String(info.userId || '') };
          wokenUp(s, '私聊');
          save(s);
          return held[info.chatId].until - now;
        }
        until = nextAwakeAt(c, now) + randMin(5, 60);
        reason = 'sleep';
      } else if (busyNow(s, now)) {
        const b = busyNow(s, now);
        const who = info.owner ? ownerOf().name : clip(info.nickname || '对方', 16);
        const r = await judgeReply(info.chatId, info.text, { ...b, who });
        if (!r.minutes) return 0;
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

  // [备用 · 群聊睡着吵醒与次日补回]
  const groupWoken = new Map();
  api.on('group/decide', (decision, { msg } = {}) => {
    try {
      if (!isAsleep() || !msg || !msg.groupId || !decision || !decision.reply) return undefined;
      if (Date.now() - (lastOut.get(`group:${msg.groupId}`) || 0) < HOLD_TALKING_MS) return undefined;
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
        return undefined;
      }
      save(s);
      return { reply: false, reason: `睡着了（第 ${e.count} 条，吵醒概率 ${Math.round(p * 100)}%）` };
    } catch (error) {
      return undefined;
    }
  });

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
      if (first && /^【系统提醒/.test(String(first.text || ''))) return prefix.length ? [...prefix, ...content] : undefined;
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

  function chatRowsSince(chatId, since) {
    const h = hub();
    if (!h || typeof h.chatLogOf !== 'function') return [];
    const days = ymd(since) === ymd(Date.now()) ? [ymd(Date.now())] : [ymd(since), ymd(Date.now())];
    const rows = [];
    for (const day of days) for (const r of h.chatLogOf(day) || []) if (r && r.chatId === chatId && !r.forgottenAt && r.t >= since - 1000 && r.who !== '系统') rows.push(r);
    return rows;
  }

  async function catchUpHeld(s) {
    if (!isAwakeHour(cfg())) return;
    const held = heldOf(s);
    const now = Date.now();
    for (const [chatId, h] of Object.entries(held)) {
      if (!h || now < Number(h.until) + 5 * 60_000) continue;
      delete held[chatId];
      save(s);
      const rows = chatRowsSince(chatId, Number(h.since) || 0);
      const lastBot = rows.filter((r) => r.who === 'bot').map((r) => r.t).pop() || 0;
      const unanswered = rows.filter((r) => r.who !== 'bot' && r.t > lastBot);
      if (!unanswered.length) continue;
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
      return;
    }
  }

  return { personaBrief, personaLimits, busyNow, isAsleep, catchUpGroups, catchUpHeld };
}
