// 出门全流程：选地点、拉照片、出门与回家故事、发照片分享（从 autonomy/index.mjs 拆出）。
import fs from 'node:fs';
import path from 'node:path';
import { clip, parseJsonLoose, weatherLine, isWet } from './agenda.mjs';
import { AUTO_LIMITS } from './limits.mjs';
import { searchAmap, searchOsm, candidatesFor, candidateLine, fmtDistance } from './outing.mjs';
import { readJson, writeJson } from './helpers.mjs';

export function createOutingFlow({
  api, cfg, ask, save, clock, dayKey, ownerOf, hub, appendLog,
  canReachOwnerNow, canShareImage, isAwakeHour, outingReady, reachOwner, styleHint, moodNudge, energyPrompt,
}) {
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
      const out = await ask(api.dsh, { key: 'outing-pick', cfg: api.config(), system: '你是一个有自己生活的角色，正打算出门，在挑去哪家。只输出 JSON。', text, maxTokens: 300, temperature: 0.7, timeoutMs: Math.max(20, Number(c.askTimeoutSec) || 75) * 1000 });
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
          await h.pushToSession({ chatId: `private:${qq}`, kind: 'private', userId: qq, nickname: name }, [{ type: 'text', text: `【系统提醒，不是${name}说的话】你刚出门去了${p.place}，回来把地图上这家店的照片发给了${name}（${p.what}）。这趟是这样的：${clip(p.story, AUTO_LIMITS.OUTING_STORY)}。用你自己的口气配一两句，像随手分享，别说"我给你发了张图"。这张其实是地图上这家店的图：不用主动说明来源，${name}问起是不是你拍的，就照实说是地图上找的。` }], '');
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
      const wish = clip(d.detail || d.why, AUTO_LIMITS.OUTING_WISH);
      // 去哪由她定：place 是想去什么样的地方，query 是地图搜索词（没写就拿 place 搜）
      const want = clip(d.place || wish, AUTO_LIMITS.OUTING_PLACE);
      const keywords = clip(d.query || d.place, AUTO_LIMITS.OUTING_PLACE);
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
            timeoutMs: Math.max(20, Number(c.askTimeoutSec) || 75) * 1000,
          });
          j = parseJsonLoose(out);
        } catch (error) {
          api.log.warn('自主生活：写出门经历失败 ' + error.message);
        }
      }
      return {
        story: clip((j && j.note) || '', AUTO_LIMITS.OUTING_STORY),
        bought: Array.isArray(j && j.bought) ? j.bought.map((x) => clip(x, 30)).filter(Boolean).slice(0, 8) : [],
        spent: Number(j && j.spent) || 0,
        canSee,
        photoWhat: clip(j && j.photo, 60),
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
      const note = clip(`去了${p.name}（${p.travel.mode} ${p.travel.minutes} 分钟）${st.story ? '：' + st.story : ''}`, AUTO_LIMITS.DONE_NOTE);
      const d0 = (s.done || []).find((x) => x.action === 'outing' && Math.abs((Number(x.at) || 0) - o.departAt) < 5 * 60_000);
      if (d0) {
        d0.note = note;
        d0.brief = clip(st.story || note, AUTO_LIMITS.DONE_BRIEF);
      }
      try {
        const mem = api.use('memory');
        if (mem && typeof mem.addEvent === 'function' && st.story) mem.addEvent({ text: clip(`去了${p.name}：${st.story}`, AUTO_LIMITS.EVENT_MEM), tags: ['自主生活', '生活', '出门'], importance: 0.4 });
      } catch (error) {}
      s.lastOuting = { day: dayKey(), name: p.name, type: p.type, photoFile: o.photoFile, photoWhat: st.photoWhat, photoOk: st.photoOk, story: st.story, backAt: Date.now() };
      if (st.share && o.photoFile && !s.pendingShare) {
        s.pendingShare = { at: Date.now(), file: o.photoFile, place: p.name, what: st.photoWhat || '这家店', story: st.story };
      } else if (st.share && st.story && canReachOwnerNow(s)) {
        try {
          const r = await reachOwner(s, { what: `刚从${p.name}回来，想顺手聊聊：${clip(st.story, AUTO_LIMITS.OUTING_STORY)}`, why: o.wish || '' });
          if (r && r.ok) api.log.info(`自主生活：出门回来顺手找主人聊了（${p.name}）`);
        } catch (error) {
          api.log.warn('自主生活：出门回来顺手找主人失败 ' + error.message);
        }
      }
      appendLog({ at: Date.now(), action: 'outing-back', why: o.wish, detail: p.name, note });
      api.log.info(`自主生活：出门回来 —— ${note}${s.pendingShare && s.pendingShare.file === o.photoFile ? '（想把照片发给主人）' : ''}`);
      return true;
    }

  return { outingFile, placesOf, pickPlace, rememberVisit, fetchPlacePhoto, sendOutingPhoto, tickPendingShare, goOut, writeOutingStory, finishOuting };
}
