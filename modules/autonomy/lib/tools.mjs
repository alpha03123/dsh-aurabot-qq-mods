// 聊天内暴露给主模型的自主生活工具：outing_photo / my_schedule / my_diary / my_status / my_agenda。
import fs from 'node:fs';
import { addItem, agendaBlock, applyOps, clip, parseWhen, similarText } from './agenda.mjs';
import { AUTO_LIMITS } from './limits.mjs';

export function registerAutonomyTools({
  api,
  cfg,
  load,
  save,
  dayKey,
  diaryRecent,
  isWaking,
  setWaking,
  wake,
  snapshot,
  resetDiscordStatusKey,
}) {
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

  // 她自己的节奏控制、私密日记、状态栏与日程约定工具
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
            if (isWaking()) return { ok: false, message: '正在醒着呢，这一轮还没做完，等它跑完', state: snapshot() };
            setWaking(true);
            let r;
            try { r = await wake(); } finally { setWaking(false); }
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
            for (const x of a.plan.slice(0, 5)) addItem(s.agenda, { what: String(x), from: 'self' });
            s.agenda.planned = true;
          }
          if (Number(a.nextMinutes) > 0) {
            s.nextWakeAt = Date.now() + Math.max(3, Math.min(360, Number(a.nextMinutes))) * 60_000;
          }
          if (a.note !== undefined) s.note = String(a.note).slice(0, AUTO_LIMITS.AGENDA_WHY);
          if (a.project !== undefined) {
            const pn = String(a.project).trim();
            s.project = pn ? { name: pn.slice(0, AUTO_LIMITS.AGENDA_BRIEF), times: 0, lastNote: '', at: Date.now() } : null;
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
          const text = clip(a.text, AUTO_LIMITS.STATUS_BAR);
          const st = ['online', 'idle', 'dnd'].includes(a.status) ? a.status : 'online';
          const s = load();
          s.customStatus = { text, status: st, at: Date.now() };
          if (s.busy && s.busy.until > Date.now() && text) s.busy.status = text;
          resetDiscordStatusKey();
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
}
