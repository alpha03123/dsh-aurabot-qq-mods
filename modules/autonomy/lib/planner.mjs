// 每日早起软日程规划（planDay）：复盘昨日、自定睡眠作息、排今日软安排。
import fs from 'node:fs';
import {
  SLOTS,
  SLOT_LABEL,
  slotOf,
  addItem,
  slotPassed,
  clip,
  inheritAge,
  parseJsonLoose,
  selfReport,
  weatherLine,
  isWet,
  energyLabel,
} from './agenda.mjs';
import { findingsBlock, FREE_ACTION, MBTI_STYLE } from './helpers.mjs';
import { AUTO_LIMITS } from './limits.mjs';

export function createPlanner({
  api,
  ask,
  clock,
  ymd,
  fmtHM,
  ownerOf,
  ownerChatLines,
  recallHints,
  currentMbti,
  moodLine,
  ensureEnergy,
  energyNow,
  refreshWeather,
  availableActions,
  personaLimits,
  diaryRecent,
  diaryCount,
  diaryDir,
  diaryFile,
  appendLog,
}) {
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
        if (!y || !y.lastSeenAt || y.bedtime) return '';
        const lastH = new Date(y.lastSeenAt).getHours() + new Date(y.lastSeenAt).getMinutes() / 60;
        const sleepH = (Number(c.awakeTo) || 24) % 24 || 24;
        return lastH >= 5 && lastH < sleepH - 1 ? `昨晚你 ${fmtHM(y.lastSeenAt)} 左右就睡了，比平时早，睡前的日记也没来得及写。` : '';
      })(),
      (() => {
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
      memHints.length ? `你的长期记忆与近期约定：\n${memHints.join('\n')}` : '',
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
        out = await ask(api.dsh, {
          key: 'plan-fallback',
          cfg: api.config(),
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
      let at = 0;
      const tm = String(it.time || '').match(/^(\d{1,2})[:：](\d{2})$/);
      if (tm) {
        const d0 = new Date();
        d0.setHours(Number(tm[1]), Number(tm[2]), 0, 0);
        if (d0.getTime() < Date.now() - 10 * 60_000) continue;
        at = d0.getTime();
      }
      const slot = at ? slotOf(new Date(at).getHours()) : it.slot;
      if (!at && slotPassed(slot, hour)) continue;
      const r = addItem(a, { slot, what: it.what, why: it.why, from: 'self', action: it.action, age: inheritAge(it.what, carries), at, ...selfReport(it) }, { hour });
      if (r.ok) added.push(r.item);
    }
    const recap = clip(j.yesterday, AUTO_LIMITS.RECAP_NOTE);
    if (recap && y) {
      a.recap = recap;
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

  return { planDay };
}
