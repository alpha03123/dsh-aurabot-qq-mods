// 日常后台节拍：睡前例行、精力与心情、天气刷新、到点生活小事与生活小结。
import { clip, parseJsonLoose, busyMinutes, energyAt, energyLabel, energyDelta, parseWeather, weatherLine, isWet } from './agenda.mjs';
import { isGranted } from './grants.mjs';
import { mergeOwnerEdits } from './agenda.mjs';
import { readJson } from './helpers.mjs';

export function createLifeTick({
  api, cfg, ask, save, stateFile, clock, dayKey, ymd, randMin, ownerOf,
  isAwakeHour, nextSleepAt, nextAwakeAt, busyNow, autoItem, appendLog,
  diaryCount, writeLocalDiary, canReachOwnerNow, reachOwner, styleHint,
}) {
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
      mergeOwnerEdits(s, readJson(stateFile(), null));
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
      const stText = clip(item.status || item.what, 36);
      if (stText) s.customStatus = { text: stText, at: now };
      s.busy = { since: now, until: now + mins * 60_000, what: item.what, canPause: item.canPause != null ? item.canPause : null, ...(stText ? { status: stText } : {}) };
      addEnergy(s, item.energy != null ? item.energy : energyDelta(item.action || 'life'));
      if (!s.nextWakeAt || s.nextWakeAt < s.busy.until) s.nextWakeAt = s.busy.until + randMin(2, 10);
      s.done = [{ at: now, action: item.action || 'life', note: item.what, brief: item.what, dry: false, kind: 'other', agendaId: item.id, why: String(item.why || '').slice(0, 60) }, ...(s.done || [])].slice(0, 50);
      // 做得怎么样等忙完再写（tickLifeRecaps），记忆也那时候再进
      item.recapAt = s.busy.until;
      appendLog({ at: now, action: item.action || 'life', why: '安排里定了这个点', detail: '', note: item.what, agendaId: item.id });
      api.log.info(`自主生活：${item.what}（${mins} 分钟）`);
      return true;
    }

    /** 到点自己发生的生活小事忙完了：让她用一两句写下做得怎么样，写进当天流水和记忆，之后聊天照这个说 */
    async function tickLifeRecaps(s, c) {
      const now = Date.now();
      const item = (s.agenda.items || []).find((x) => x.recapAt && !x.recapped && x.recapAt <= now);
      if (!item) return false;
      item.recapped = true;
      save(s);
      const startAt = Number(item.doneAt) || now;
      const before = (s.done || [])
        .filter((x) => x && !x.dry && Number(x.at) < startAt && startAt - Number(x.at) <= 3 * 3600_000)
        .slice(0, 5)
        .reverse()
        .map((x) => `${clock(x.at)} ${clip(x.note || x.brief || x.action, 80)}`);
      const canShare = canReachOwnerNow(s);
      const ownerName = ownerOf().name;
      const text = [
        `现在是 ${new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })} ${clock()}，你刚忙完：${item.what}（${clock(startAt)} 开始${item.why ? `，当时想的是：${item.why}` : ''}）。`,
        before.length ? `这之前做过：\n${before.join('\n')}` : '',
        styleHint(c),
        '',
        '用第一人称写一两句这件事做得怎么样（像跟自己说，不是汇报），50 字以内：成没成、结果怎样、一个具体的小细节（细节要自然写实、符合生活常识，别编奇怪或夸张的物理细节）。顺便写一句忙完之后现在挂在自己 Discord 状态栏上的小状态（15字以内，用你自己的口气，可带1个小emoji）。',
        canShare
          ? `如果这件事做得特别开心、有趣或翻车了，你真有冲动顺手跟${ownerName}显摆或吐槽一句，就在 share 里写一句想聊什么；普通例行小事（比如普通吃顿饭）不用每件都报备，share 留空字符串。`
          : '',
        canShare
          ? '只输出 JSON：{"note":"做得怎么样","status":"现在的状态栏短句","share":"想顺手跟他说什么（不想说就空字符串）"}'
          : '只输出 JSON：{"note":"做得怎么样","status":"现在的状态栏短句"}',
      ]
        .filter((x) => x !== '')
        .join('\n');
      let recap = '';
      let nextStatus = '';
      let wantShare = '';
      try {
        const out = await ask(api.dsh, { key: 'life-recap', cfg: api.config(),
          system: '你是一个有自己生活的角色，刚忙完一件事。只输出 JSON。',
          text,
          maxTokens: 320,
          temperature: 0.9,
          timeoutMs: Math.max(20, Number(c.askTimeoutSec) || 75) * 1000,
        });
        const j = parseJsonLoose(out);
        recap = clip((j && j.note) || '', 60);
        nextStatus = clip((j && j.status) || '', 36);
        wantShare = canShare ? clip((j && j.share) || '', 80) : '';
      } catch (error) {
        api.log.warn('自主生活：写生活小结失败 ' + error.message);
      }
      if (nextStatus) {
        s.customStatus = { text: nextStatus, at: Date.now() };
      }
      const note = recap ? clip(`${item.what}，${recap}`, 90) : item.what;
      if (recap) item.note = clip(recap, 60);
      const d0 = (s.done || []).find((x) => x.agendaId === item.id && Math.abs((Number(x.at) || 0) - startAt) < 5 * 60_000);
      if (d0 && recap) {
        d0.note = note;
        d0.brief = clip(recap, 30);
      }
      try {
        const mem = api.use('memory');
        if (mem && typeof mem.addEvent === 'function') mem.addEvent({ text: clip(note, 140), tags: ['自主生活', '生活'], importance: 0.3 });
      } catch (error) {}
      if (recap) appendLog({ at: now, action: 'life-recap', why: item.what, detail: '', note: recap, agendaId: item.id });
      api.log.info(`自主生活：${item.what} 忙完了${recap ? ' —— ' + recap : ''}`);
      if (wantShare && canReachOwnerNow(s)) {
        try {
          const r = await reachOwner(s, { what: wantShare, why: `刚忙完「${item.what}」${recap ? `：${recap}` : ''}` });
          if (r && r.ok) {
            appendLog({ at: Date.now(), action: 'speak', why: `刚忙完「${item.what}」顺手分享`, detail: wantShare, note: r.note, agendaId: item.id });
            api.log.info(`自主生活：忙完「${item.what}」后顺手找主人聊了 —— ${clip(wantShare, 40)}`);
          }
        } catch (error) {
          api.log.warn('自主生活：忙完后顺手找主人失败 ' + error.message);
        }
      }
      return true;
    }

    const heldOf = (s) => (s.held && typeof s.held === 'object' ? s.held : (s.held = {}));

    /**
     * 睡着时来消息，被吵醒的概率：基础 5%，每多一条 +10%，像急事 +25%，主人 +5%；
     * 后半夜睡得沉、快起床时睡得浅；睡前越累睡得越死；心情好更愿意起来理人，心情差更不想理。最高 85%。
     */

  return { bedtime, ensureEnergy, addEnergy, energyPrompt, moodNudge, refreshWeather, tickTimedItems, tickLifeRecaps };
}
