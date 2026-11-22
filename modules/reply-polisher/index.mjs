/**
 * 回复润色器（本地 Ollama 语言层，2026-11-22）
 *
 * 工作流位置：主模型（DeepSeek 等）产出草稿 → hooks.reply → 本机 Ollama（如 aurabot-v5-ep2）润色拆气泡 → parseReply 发送。
 * 包含分流（技术/代码/长草稿跳过）与兜底校验（协议标签、数字、人称、气泡上限），异常或未通过时自动退回原草稿。
 *
 * @type {import('../aurabot').AurabotModule}
 */

const SYSTEM_PROMPT =
  '你是对话润色器。严格依据【场景】和【风格卡】，将【待润色草稿】改写为自然的人类即时通讯回复。\n' +
  '规则：1. 100%保留草稿的核心事实、数字、立场与协议标签（<sticker:...><voice><reply:...><at:...><poke>）；' +
  '2. 严禁添加括号/星号动作描写、心理旁白或Markdown格式；' +
  '3. 用 ||| 切分自然的多条气泡（私聊通常1-3条，群聊最多3条且带表情时文字≤2条，禁止在<voice>内部切分）。';

const SCENE_PRIVATE = '私聊';
const SCENE_GROUP = '群聊（最多3条气泡，带表情时文字≤2条）';

const SILENCE_SET = new Set(['', '[沉默]', '［沉默］', '(沉默)', '（沉默）']);
const TAG_RE = /<(?:sticker|reply|at):[^>]*>|<poke>|<voice>/gi;
const ALL_TAG_RE = /<[^>]*>/g;
const NUM_RE = /\d+(?:\.\d+)?/g;

function localDay(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function stripTags(s) {
  return String(s || '').replace(ALL_TAG_RE, ' ').replace(/\|\|\|/g, ' ').trim();
}

function isTechnicalDraft(draft) {
  const s = String(draft || '');
  if (/```/.test(s)) return '代码块';
  if (/`[^`\n]{2,}`/.test(s)) return '行内代码';
  if (/https?:\/\/\S+/i.test(s)) return '网址链接';
  if (/[A-Za-z]:\\[^\s\\]+/.test(s) || /(?:^|\s)(?:~\/|\/(?:home|mnt|usr|etc|var|tmp)\/)\S+/.test(s)) return '文件路径';
  if (/(?:^|\s)--[a-zA-Z0-9_-]{2,}/.test(s)) return '命令行参数';
  const plain = stripTags(s);
  if (/\b(?:function|const|let|var|import|export|class|def|return|SELECT|INSERT|UPDATE|DELETE)\b.*[(={;]/.test(plain)) return '代码语句';
  if (/[A-Za-z_]\w*\.[A-Za-z_]\w*\(/.test(plain)) return '函数调用';
  return '';
}

function shouldSkip(draft, cfg) {
  const trimmed = String(draft || '').trim();
  if (SILENCE_SET.has(trimmed)) return '沉默';
  if (/<image:/i.test(trimmed)) return '含图片标签';
  const plain = stripTags(trimmed);
  if (!plain) return '纯标签无文字';
  if (cfg.skipTechnical !== false) {
    const tech = isTechnicalDraft(trimmed);
    if (tech) return `技术内容(${tech})`;
  }
  const maxChars = Number(cfg.maxDraftChars) || 0;
  if (maxChars > 0 && plain.length > maxChars) return `超长(${plain.length}>${maxChars}字)`;
  return '';
}

function normalizeDraftForModel(draft) {
  // 主模型草稿如果已经带了 |||，在喂给润色器前换成空格（不动 <voice> 内），让润色器按训练格式重新自然拆气泡
  return String(draft || '').replace(/\s*\|\|\|\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function enforceBubbles(text, { inGroup, maxBubbles }) {
  const limit = Math.max(1, Math.min(5, Math.round(Number(maxBubbles) || 3)));
  let parts = String(text || '').split('|||').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return '';

  // 群聊带表情时文字气泡 ≤ 2 条
  if (inGroup && parts.some((p) => /<sticker:/i.test(p))) {
    const nonStickerIdx = [];
    parts.forEach((p, idx) => {
      if (!/^<sticker:[^>]*>$/i.test(p)) nonStickerIdx.push(idx);
    });
    if (nonStickerIdx.length > 2) {
      const keep = nonStickerIdx[1];
      const extras = nonStickerIdx.slice(2);
      const merged = [parts[keep], ...extras.map((i) => parts[i])].join(' ');
      parts[keep] = merged;
      const dropSet = new Set(extras);
      parts = parts.filter((_, idx) => !dropSet.has(idx));
    }
  }

  if (parts.length > limit) {
    parts = [...parts.slice(0, limit - 1), parts.slice(limit - 1).join(' ')];
  }
  return parts.join('|||');
}

function validateOutput(draft, rawOut, { inGroup, cfg }) {
  let out = String(rawOut || '').trim();
  // 剥离成对 think 块；未闭合 think 直接判失败
  out = out.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  if (/<think\b/i.test(out)) return { ok: false, reason: 'think泄漏' };
  if (!out || SILENCE_SET.has(out)) return { ok: false, reason: '输出为空或沉默' };
  if (out.length > Math.max(draft.length * 3, 280)) return { ok: false, reason: `输出过长(${out.length})` };
  if (/<voice>[\s\S]*?\|\|\|[\s\S]*?<\/voice>/i.test(out)) return { ok: false, reason: 'voice内切分' };

  // 协议标签必须完整保留
  const draftTags = draft.match(TAG_RE) || [];
  for (const tag of draftTags) {
    if (!out.includes(tag)) return { ok: false, reason: `缺标签${tag}` };
  }

  const draftPlain = stripTags(draft);
  const outPlain = stripTags(out);

  // 阿拉伯数字忠实度（不丢数字、不凭空编造数字）
  if (cfg.checkNumbers !== false) {
    const draftNums = new Set(draftPlain.match(NUM_RE) || []);
    const outNums = new Set(outPlain.match(NUM_RE) || []);
    for (const n of draftNums) {
      if (!outNums.has(n)) return { ok: false, reason: `缺数字${n}` };
    }
    for (const n of outNums) {
      if (!draftNums.has(n)) return { ok: false, reason: `多出数字${n}` };
    }
  }

  // 人称忠实度：草稿里提到“主人”，输出不能改成别的称呼
  if (cfg.checkPronoun !== false && draftPlain.includes('主人') && !outPlain.includes('主人')) {
    return { ok: false, reason: '丢失“主人”称呼' };
  }

  const fixed = enforceBubbles(out, { inGroup, maxBubbles: cfg.maxBubbles });
  if (!fixed) return { ok: false, reason: '合并气泡后为空' };
  return { ok: true, text: fixed };
}

export default {
  id: 'reply-polisher',
  name: '回复润色器（Ollama）',
  version: '0.1.0-local',
  api: 1,
  description: '把主模型产出的聊天草稿交给本机 Ollama 润色模型（如 aurabot-v5-ep2），去 AI 味、套人设语气、拆多气泡并保留协议标签与数字事实。',

  defaults: {
    enabled: false,
    baseUrl: 'http://127.0.0.1:11434',
    model: 'aurabot-v5-ep2',
    keepAlive: '15m',
    timeoutMs: 8000,
    maxDraftChars: 150,
    maxBubbles: 3,
    recentLines: 4,
    skipTechnical: true,
    checkNumbers: true,
    checkPronoun: true,
    styleCard: '',
  },

  settings: [
    { key: 'enabled', label: '启用润色器', type: 'switch' },
    { key: 'baseUrl', label: 'Ollama 地址', type: 'text', placeholder: 'http://127.0.0.1:11434' },
    { key: 'model', label: 'Ollama 模型名', type: 'text', placeholder: 'aurabot-v5-ep2' },
    { key: 'keepAlive', label: '模型常驻时间（keep_alive）', type: 'text', placeholder: '15m', hint: '避免每次冷启动重新加载模型，如 15m、30m、1h' },
    { key: 'timeoutMs', label: '超时时间（毫秒）', type: 'number', min: 1500, max: 30000, step: 500 },
    { key: 'maxDraftChars', label: '草稿最大字数（超出跳过润色，0=不限）', type: 'number', min: 0, max: 1000, step: 10 },
    { key: 'maxBubbles', label: '最大气泡数（超出自动合并）', type: 'number', min: 1, max: 5, step: 1 },
    { key: 'recentLines', label: '附带最近对话条数（2~5）', type: 'number', min: 1, max: 8, step: 1 },
    { key: 'skipTechnical', label: '自动跳过含代码/命令/链接的技术草稿', type: 'switch' },
    { key: 'checkNumbers', label: '校验数字忠实度（缺数字或多出数字时退回原草稿）', type: 'switch' },
    { key: 'checkPronoun', label: '校验“主人”人称不丢失（丢失时退回原草稿）', type: 'switch' },
    {
      key: 'styleCard',
      label: '风格卡（需与润色模型训练时一致）',
      type: 'textarea',
      hint: '直接贴训练时使用的完整风格卡文本（姿态 / 习惯 / 禁忌）。',
    },
  ],

  setup(api) {
    const cfg = () => ({ ...this.defaults, ...(api.settings() || {}) });
    const stats = { total: 0, polished: 0, skipped: 0, fallback: 0, lastMs: 0, lastReason: '' };

    function recentContext(chatId, userText, c) {
      const inGroup = String(chatId || '').startsWith('group:');
      const limit = Math.max(1, Math.min(8, Math.round(Number(c.recentLines) || 4)));
      const maxTake = inGroup ? limit : Math.min(limit, 2);
      const ownerId = String(api.config()?.ownerId || '');
      const lines = [];

      try {
        const hub = api.core?.hub;
        if (hub && typeof hub.chatLogOf === 'function') {
          const cutoff = Date.now() - 30 * 60 * 1000;
          const keep = (e) => e && e.chatId === chatId && e.who !== 'bot' && e.who !== '系统' && e.text && (!e.t || Number(e.t) >= cutoff);
          let entries = (hub.chatLogOf(localDay(0)) || []).filter(keep);
          if (entries.length < maxTake) {
            const prev = (hub.chatLogOf(localDay(-1)) || []).filter(keep);
            entries = [...prev, ...entries];
          }
          for (const e of entries.slice(-maxTake)) {
            const text = String(e.text).replace(/\s+/g, ' ').trim().slice(0, 120);
            if (!text) continue;
            if (inGroup) {
              const label = ownerId && String(e.uid || '') === ownerId ? '主人' : (e.who || '群友');
              lines.push(`${label}：${text}`);
            } else {
              lines.push(`用户：${text}`);
            }
          }
        }
      } catch (error) {
        api.log.debug('读取最近对话失败，回退 userText：', error.message);
      }

      const ut = String(userText || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      if (ut) {
        const last = lines[lines.length - 1] || '';
        if (!last.includes(ut)) {
          lines.push(`${inGroup ? '群友' : '用户'}：${ut}`);
          if (lines.length > maxTake) lines.splice(0, lines.length - maxTake);
        }
      }

      return lines.length ? lines.join('\n') : '（无）';
    }

    async function polish({ chatId, draft, userText = '', history = '' }) {
      const c = cfg();
      if (!c.enabled) return { used: false, reason: '未启用', text: draft };
      if (!String(chatId || '').startsWith('private:') && !String(chatId || '').startsWith('group:')) {
        return { used: false, reason: '非聊天会话', text: draft };
      }
      const styleCard = String(c.styleCard || '').trim();
      const model = String(c.model || '').trim();
      if (!styleCard || !model) return { used: false, reason: '缺少模型名或风格卡', text: draft };

      const skipReason = shouldSkip(draft, c);
      if (skipReason) {
        stats.total++;
        stats.skipped++;
        stats.lastReason = `跳过:${skipReason}`;
        api.log.debug(`${chatId} 润色跳过（${skipReason}）`);
        return { used: false, reason: `跳过:${skipReason}`, text: draft };
      }

      stats.total++;
      const inGroup = String(chatId).startsWith('group:');
      const scene = inGroup ? SCENE_GROUP : SCENE_PRIVATE;
      const recent = String(history || '').trim() || recentContext(chatId, userText, c);
      const cleanDraft = normalizeDraftForModel(draft);
      const userPrompt = `【场景】\n${scene}\n【风格卡】\n${styleCard}\n【最近对话】\n${recent}\n【待润色草稿】\n${cleanDraft}`;

      const baseUrl = String(c.baseUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');
      const timeoutMs = Math.max(1500, Math.min(30000, Number(c.timeoutMs) || 8000));
      const t0 = Date.now();

      try {
        const res = await fetch(`${baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            stream: false,
            ...(c.keepAlive ? { keep_alive: String(c.keepAlive) } : {}),
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: userPrompt },
            ],
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const rawOut = data?.message?.content ?? '';
        const ms = Date.now() - t0;
        stats.lastMs = ms;

        const checked = validateOutput(draft, rawOut, { inGroup, cfg: c });
        if (!checked.ok) {
          stats.fallback++;
          stats.lastReason = `兜底退回:${checked.reason}`;
          api.log.warn(`${chatId} 润色未通过校验（${checked.reason}，${ms}ms），退回原草稿`);
          return { used: false, reason: `兜底退回:${checked.reason}`, ms, rawOut, text: draft };
        }

        stats.polished++;
        stats.lastReason = 'ok';
        api.log.info(`${chatId} 已润色（${model}，${ms}ms）：${checked.text.slice(0, 60)}`);
        return { used: true, reason: 'ok', ms, text: checked.text };
      } catch (error) {
        const ms = Date.now() - t0;
        stats.lastMs = ms;
        stats.fallback++;
        stats.lastReason = `调用失败:${error.message}`;
        api.log.warn(`${chatId} Ollama 润色调用失败（${ms}ms）：${error.message}，退回原草稿`);
        return { used: false, reason: `调用失败:${error.message}`, ms, text: draft };
      }
    }

    api.on('reply', async (text, { chatId, userText } = {}) => {
      const r = await polish({ chatId, draft: text, userText });
      return r.used ? r.text : undefined;
    });

    api.route('/stats', () => ({ ...stats, model: cfg().model, enabled: cfg().enabled }));

    api.route('/test', async (req) => {
      const body = (await api.core.http.body(req)) || {};
      const chatId = String(body.chatId || (body.group ? 'group:test' : 'private:test'));
      const draft = String(body.draft || '');
      const userText = String(body.userText || '');
      const history = String(body.history || '');
      if (!draft) return { ok: false, error: 'missing draft' };
      const r = await polish({ chatId, draft, userText, history });
      return { ok: true, ...r };
    });

    return { polish, stats: () => ({ ...stats }) };
  },
};
