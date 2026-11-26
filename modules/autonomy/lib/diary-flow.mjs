// 本地私密日记读写与写作流程（modules-data/autonomy/diary/日期.md）。
import fs from 'node:fs';
import path from 'node:path';
import { clip } from './agenda.mjs';

export function createDiaryFlow({ api, cfg, ask, clock, ymd, ownerOf, ownerChatLines, seenSince, moodLine, styleHint }) {
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
          body = await ask(api.dsh, { key: 'diary-fallback', cfg: api.config(), system: '你是一个有自己生活的角色，在写只给自己看的日记。只输出日记正文。', text, maxTokens: 800, temperature: 0.95, timeoutMs: Math.max(30, Number(cfg().askTimeoutSec) || 75) * 1000 });
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

  return { DIARY_MAX_PER_DAY, diaryDir, diaryFile, diaryRead, diaryCount, diaryRecent, writeLocalDiary };
}
