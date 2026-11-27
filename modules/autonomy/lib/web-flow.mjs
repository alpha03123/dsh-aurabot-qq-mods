// 上网搜索与正文读取流程：DeepSeek 联网搜索 / 浏览器搜索 / web-read 归纳与记忆落库。
import { clip, parseJsonLoose } from './agenda.mjs';
import { AUTO_LIMITS } from './limits.mjs';
import { SEARCH_BASE_URL, SEARCH_MODEL, buildSearchBody, parseSearchResponse, searchPageText } from './websearch.mjs';

export function createWebFlow({ api, cfg, ask, ownerOf, canShareImage, shareImage, pageImages }) {
    /** 最近打不开的网站（要验证、要登录、被拦），写给她看：xiachufang.com（要滑块验证） */
    function webBlockedText(s) {
      return Object.entries((s && s.webBlocked) || {})
        .filter(([, v]) => v && v.at > Date.now() - 7 * 86_400_000)
        .sort((a, b) => b[1].at - a[1].at)
        .slice(0, 5)
        .map(([host, v]) => `${host}${v.why ? `（${clip(v.why, 16)}）` : ''}`)
        .join('、');
    }
    const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (error) { return ''; } };

    /**
     * 点开的页面读正文：browser-ops 的 dom 快照是给「操作网页」用的（先列 120 个链接按钮、正文只留 1200 字垫底），
     * 文章页读进来几乎全是导航链接。这里优先拿 article / main，没有就挑段落文字最多的那一块。
     */
    async function readArticle(bo) {
      if (!bo || typeof bo.evaluate !== 'function') return '';
      try {
        const r = await bo.evaluate(`(() => {
          const clean = (t) => String(t || '').replace(/[ \\t]+/g, ' ').replace(/\\n\\s*\\n+/g, '\\n').trim();
          const textLen = (el) => [...el.querySelectorAll('p')].reduce((n, p) => n + (p.innerText || '').trim().length, 0);
          let node = [...document.querySelectorAll('article, main, [role="main"]')].sort((a, b) => textLen(b) - textLen(a))[0] || null;
          if (!node || textLen(node) < 200) {
            let best = null, bestLen = 0;
            for (const el of document.querySelectorAll('div, section')) {
              let len = 0;
              for (const p of el.children) if (p.tagName === 'P' || p.tagName === 'SECTION') len += (p.innerText || '').trim().length;
              if (len > bestLen) { bestLen = len; best = el; }
            }
            if (best && bestLen >= 200) node = best;
          }
          return { title: document.title, text: clean((node || document.body || {}).innerText).slice(0, ${AUTO_LIMITS.WEB_PAGE}) };
        })()`, 15000);
        const text = String((r && r.text) || '').trim();
        return text ? `页面：${clip(String((r && r.title) || ''), AUTO_LIMITS.WEB_TITLE)}\n正文：${text}` : '';
      } catch (error) {
        api.log.warn('自主生活：读正文失败，退回页面快照 ' + error.message);
        return '';
      }
    }

    /** 上网走哪条路：deepseek = 直接问 DeepSeek 官方联网搜索（搜索、读网页都在那边做完，回来总结 + 来源）；browser = Bing + 专用浏览器 */
    const webMode = () => (String(cfg().webSearch || 'deepseek') === 'browser' ? 'browser' : 'deepseek');

    /** DSH 里存的 DeepSeek key（和 DSH 自己的联网搜索同一把）；没有就看环境变量 */
    async function deepseekKey() {
      try {
        const cred = api.dsh && typeof api.dsh.get === 'function' ? api.dsh.get('credentials') : null;
        if (cred && typeof cred.resolve === 'function') {
          const r = await cred.resolve('DEEPSEEK_API_KEY');
          if (r && r.value) return String(r.value);
        }
      } catch (error) {}
      return String(process.env.DEEPSEEK_API_KEY || '');
    }

    async function browseWeb(d, s) {
      // want 是她想弄明白的事（给读页面用），topic 是真正拿去搜的关键词
      const want = clip(d.detail || d.why, AUTO_LIMITS.FINDING_QUERY) || '最近有什么好玩的';
      const topic = clip(d.query, AUTO_LIMITS.FINDING_QUERY) || clip(d.detail || d.why, AUTO_LIMITS.FINDING_QUERY) || '最近有什么好玩的';
      const timeoutMs = Math.max(20, Number(cfg().askTimeoutSec) || 75) * 1000;
      const r = webMode() === 'browser' ? await searchByBrowser(want, topic, s, timeoutMs) : await searchByDeepSeek(want, topic);
      if (r.fail) return r.fail;
      return finishWeb({ want, topic, s, timeoutMs, ...r });
    }

    /** 让她从搜索结果里挑想点开的（按想看的顺序，最多 n 条） */
    async function pickResults(want, listText, s, timeoutMs, n) {
      try {
        const out = await ask(api.dsh, { key: 'web-pick', cfg: api.config(),
          system: '你在网上查东西，只输出 JSON。',
          text: `你想查：${want}\n下面是搜索结果（→ 后面是链接）：\n${clip(listText, AUTO_LIMITS.WEB_LIST)}\n${webBlockedText(s) ? `\n这些网站最近打不开：${webBlockedText(s)}\n` : ''}\n挑你最想点开的结果，按想看的顺序最多 ${n} 条，回 {"urls":["完整链接"]}；都没意思就回 {"urls":[]}。`,
          maxTokens: 300,
          temperature: 0.7,
          timeoutMs,
        });
        const j = parseJsonLoose(out) || {};
        const urls = Array.isArray(j.urls) ? j.urls : j.url ? [j.url] : [];
        return urls.map((u) => String(u || '').trim()).filter((u) => /^https?:\/\//i.test(u)).slice(0, n);
      } catch (error) {
        api.log.warn('自主生活：上网挑结果失败 ' + error.message);
        return [];
      }
    }

    /** 问 DeepSeek 联网搜索：一次请求拿回来源 + 按网页内容写的总结（不自己开网页） */
    async function searchByDeepSeek(want, topic) {
      const key = await deepseekKey();
      if (!key) return { fail: { note: '想上网查东西，但 DSH 里没存 DeepSeek 的 key（联网搜索要用）', extra: { ok: false } } };
      const body = buildSearchBody({ want, query: topic });
      const t0 = Date.now();
      let parsed;
      let errMsg = '';
      try {
        const res = await fetch(`${String(process.env.DEEPSEEK_SEARCH_BASE_URL || SEARCH_BASE_URL).replace(/\/$/, '')}/messages`, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(90_000),
          headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': key, authorization: `Bearer ${key}` },
          body: JSON.stringify(body),
        });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch (error) {}
        parsed = parseSearchResponse(json);
        if (!res.ok && parsed.ok) parsed = { ...parsed, ok: false, error: `HTTP ${res.status}` };
        if (!res.ok && !json) parsed.error = `HTTP ${res.status}`;
      } catch (error) {
        errMsg = error.name === 'TimeoutError' ? '超时了' : error.message;
        parsed = { ok: false, error: errMsg, summary: '', sources: [], truncated: false, searches: 0, usage: null };
      }
      // 留底：和其他后台模型调用一样能在 traces 里查
      try {
        api.lib('core/trace.js').writeTrace({ kind: 'model', key: 'web-search', caller: 'autonomy', provider: 'deepseek-official', model: body.model, system: body.system, input: body.messages[0].content[0].text, output: parsed.summary, ms: Date.now() - t0, error: parsed.ok ? '' : parsed.error, usage: parsed.usage, sources: parsed.sources.length, searches: parsed.searches });
      } catch (error) {}
      if (!parsed.ok) return { fail: { note: `想上网查「${topic}」，搜索没成：${clip(parsed.error, 60)}`, extra: { ok: false } } };
      return {
        page: searchPageText(parsed),
        link: (parsed.sources[0] && parsed.sources[0].url) || '',
        title: '',
        images: [],
        opened: false,
        label: '（搜索引擎读完网页后按内容写的总结，后面是来源）',
        blockedGuess: '',
      };
    }

    /** 老办法：Bing 搜索页 + 专用浏览器点开 */
    async function searchByBrowser(want, topic, s, timeoutMs) {
      const bo = api.use('browser-ops');
      if (!bo || typeof bo.runTask !== 'function') return { fail: { note: '想上网逛逛，但浏览器模块没开着', extra: { ok: false } } };
      const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(topic)}`;
      const r1 = await bo.runTask({ goal: topic, url: searchUrl });
      if (!r1 || !r1.ok) return { fail: { note: `想上网查「${topic}」，没打开：${clip((r1 && (r1.message || r1.error)) || '未知', 60)}`, extra: { ok: false } } };
      let page = String(r1.text || '');
      let link = '';
      let title = '';
      let images = [];
      const [u] = await pickResults(want, page, s, timeoutMs, 1);
      if (u && u !== searchUrl) {
        try {
          const nav = await bo.navigate(u);
          if (nav && nav.ok) {
            const article = await readArticle(bo);
            const snap = article ? null : await bo.snapshot({ mode: 'dom' });
            if (article || (snap && snap.ok && snap.text)) {
              page = article || String(snap.text);
              link = String(nav.url || u);
              title = String(nav.title || '');
              images = await pageImages(bo);
            }
          }
        } catch (error) {
          api.log.warn('自主生活：浏览器打开结果失败 ' + error.message);
        }
      }
      return { page, link: link || searchUrl, title, images, opened: !!link, blockedGuess: link || 'bing.com' };
    }

    /** 读完记下来：看到了什么、什么感觉、想不想之后跟主人聊；没查到 / 打不开如实记 */
    async function finishWeb({ want, topic, s, timeoutMs, page, link, title, images, opened, blockedGuess, failedHosts = [], label = '' }) {
      let j = {};
      try {
        const todayStr = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
        const out = await ask(api.dsh, { key: 'web-read', cfg: api.config(),
          system: '你是一个有自己生活的角色，刚在网上看了点东西。只输出 JSON。',
          text: `今天是 ${todayStr}。\n你本来想查：${want}\n你看到的${label || (opened ? `页面（${hostOf(link)}）` : '（没点开任何一条，这是搜索结果列表本身）')}：\n${clip(page, AUTO_LIMITS.WEB_PAGE)}\n${images.length && s && canShareImage(s) ? `\n页面上的图（只有说明，你还没看到图本身）：\n${images.map((x, i) => `[${i + 1}] ${x.alt || '（没有说明）'}${x.w && x.h ? `（${x.w}×${x.h}）` : ''}`).join('\n')}\n如果有一张你很想拿给${ownerOf().name}看，在 image 里写它的编号，没有就写 0。\n` : ''}\n用你自己的口气回：{"got":"found / missed / blocked 三选一：found 找到了想要的；missed 页面打开了但没有你要的（比如只有一串链接、讲的是别的）；blocked 网站没给看（滑块验证、要登录、拦截页）","image":0,"saw":"具体看到了什么：说出具体的名字、东西或说法（片名、菜名、一句让你记住的话），别写「一篇文章」「一些推荐」这种笼统的；如果查到的展览或活动结束日期早于今天，务必注明已结束","feeling":"一句你的感受","share":"想之后跟${ownerOf().name}聊这个就写一句由头，不想就空字符串"}`,
          maxTokens: 1000,
          temperature: 0.9,
          timeoutMs,
        });
        j = parseJsonLoose(out) || {};
        // 输出被截断、JSON 没写完：至少把 got / saw / feeling 捞出来
        if (!j.got && !j.saw) {
          for (const k of ['got', 'saw', 'feeling', 'share']) {
            const m = String(out || '').match(new RegExp('"' + k + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)'));
            if (m) j[k] = m[1];
          }
        }
      } catch (error) {
        api.log.warn('自主生活：上网读页面失败 ' + error.message);
      }
      // 读页面那一步没出结果：如实记成没读成，不当成查到了
      if (!j.got && !j.saw) return { note: `上网查「${topic}」：页面打开了，但没读成`, extra: { ok: false, later: true, output: link } };
      const saw = clip(j.saw, AUTO_LIMITS.WEB_SAW) || clip(title, AUTO_LIMITS.WEB_TITLE) || `搜了搜「${topic}」`;
      const feeling = clip(j.feeling, AUTO_LIMITS.WEB_SAW);
      const share = clip(j.share, AUTO_LIMITS.WEB_SAW);
      const got = ['found', 'missed', 'blocked'].includes(String(j.got || '').trim()) ? String(j.got).trim() : 'found';
      // 没拿到想要的：如实记成没查到 / 打不开，不算做成（later：不算动作坏了，不触发停用一天），也不记成「看过」
      if (got === 'blocked') {
        const host = /^https?:/i.test(String(blockedGuess || '')) ? hostOf(blockedGuess) : String(blockedGuess || '');
        const hosts = [...new Set([...(failedHosts || []), host].filter(Boolean))];
        if (s && hosts.length) s.webBlocked = { ...(s.webBlocked || {}), ...Object.fromEntries(hosts.map((x) => [x, { at: Date.now(), why: saw }])) };
        return { note: `上网查「${topic}」：${hosts.join('、') || '那个网站'}打不开（${saw}），没看到内容`, extra: { ok: false, later: true, output: link } };
      }
      if (got === 'missed') {
        const hasFact = saw && saw.length >= 6 && !/^搜了搜/.test(saw);
        if (hasFact) {
          try {
            const mem = api.use('memory');
            if (mem && typeof mem.addEvent === 'function' && !(s && s.__trial)) {
              mem.addEvent({
                kind: 'seen',
                text: [saw, feeling].filter(Boolean).join('；'),
                meta: { title: clip(title || topic, 160), url: String(link || '').slice(0, 500), platform: 'web' },
                tags: ['上网'],
                importance: 0.4,
              });
            }
          } catch (error) {}
        }
        return {
          note: `上网查「${topic}」：没找到想要的（${saw}）${feeling ? '（' + feeling + '）' : ''}`,
          extra: { ok: false, later: true, output: link, ...(hasFact ? { finding: { query: topic, text: saw } } : {}) },
        };
      }
      try {
        const mem = api.use('memory');
        // /try 测试跑的不算她真看过：不写进记忆（11-19 测试时写进去 8 条，事后删掉）
        if (mem && typeof mem.addEvent === 'function' && !(s && s.__trial)) {
          mem.addEvent({
            kind: 'seen',
            text: [saw, feeling].filter(Boolean).join('；'),
            meta: { title: clip(title || topic, 160), url: String(link || '').slice(0, 500), platform: 'web' },
            tags: ['上网'],
            importance: 0.4,
          });
        }
      } catch (error) {}
      // 想给主人看的那张图：先看图确认再发
      let imageNote = '';
      const pick = Math.round(Number(j.image) || 0);
      if (pick >= 1 && pick <= images.length && s && canShareImage(s)) {
        try {
          imageNote = await shareImage(s, images[pick - 1], { title, topic, link });
        } catch (error) {
          imageNote = '想给他看张图，没成';
        }
        api.log.info(`自主生活：上网的图 —— ${imageNote}`);
      }
      const note = `上网查「${topic}」：${saw}${feeling ? '（' + feeling + '）' : ''}${share ? `；想跟他聊：${share}` : ''}${imageNote ? '；' + imageNote : ''}`;
      return { note, extra: { ok: true, output: link, finding: { query: topic, text: saw } } };
    }

  return { webBlockedText, hostOf, readArticle, webMode, deepseekKey, browseWeb, pickResults, searchByDeepSeek, searchByBrowser, finishWeb };
}
