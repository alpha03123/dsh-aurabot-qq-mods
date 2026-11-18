/**
 * 机器人同伴（本地模块，2026-11-17）
 *
 * 同一个群里有好几个 Aurabot 时用：认出对方机器人，让她们可以互相接话、斗嘴，但不会没完没了。
 *   · 对方机器人说话：被点名 / @ / 引用 → 照常回；
 *   · 对方紧跟在人后面说的（多半是在回那个人）→ 不插嘴；她们已经互相聊起来了 → 按「接话概率」接；
 *   · 机器人之间连续来回超过 maxRounds 轮（中间没有人说话）就停，有人一开口就重新计；
 *   · 人说话完全不管，原来的兴趣话题插话规则照旧（主人和对方聊到她感兴趣的，她也可能插一句）；
 *   · 群聊上下文里告诉她对方是谁。
 * 两个 Aurabot 各自装这个模块，各自在设置里填对方。
 *
 * @type {import('../aurabot').AurabotModule}
 */
export default {
  id: 'bot-peers',
  name: '机器人同伴',
  version: '0.2.0-local',
  api: 1,
  description: '同一个群里有好几个 Aurabot 时：认出对方，允许互相接话斗嘴，但机器人之间最多来回几轮就停。',

  defaults: {
    enabled: false,
    peers: '',
    maxRounds: 3,
    replyChance: 0.8,
  },
  settings: [
    { key: 'enabled', label: '启用', type: 'switch' },
    {
      key: 'peers',
      label: '同群的其他机器人（每行：数字ID 名字 一句话简介）',
      type: 'textarea',
      hint: '数字 ID 是对方在桥接映射表里的 ID（onebots-discord 的 endpoints.json 里 peerOf… 那一项）。例如：12345678901 小橘 话多的橘猫，爱抢零食',
    },
    { key: 'maxRounds', label: '机器人之间最多来回几轮（中间没人说话）', type: 'number' },
    { key: 'replyChance', label: '对方没点名时接话的概率（0~1）', type: 'number' },
  ],

  setup(api) {
    const cfg = () => ({ ...this.defaults, ...(api.settings() || {}) });
    const chain = new Map(); // 群号 → 上次有人说话之后，机器人之间（含她自己）连续说了几条

    function peers() {
      const out = [];
      for (const line of String(cfg().peers || '').split(/\r?\n/)) {
        const m = line.trim().match(/^(\d{4,22})\s+(\S+)\s*(.*)$/);
        if (m) out.push({ id: m[1], name: m[2].slice(0, 20), desc: m[3].trim().slice(0, 80) });
      }
      return out;
    }
    const peerOf = (uid) => peers().find((p) => p.id === String(uid || ''));
    const cap = () => Math.max(1, Math.min(20, Math.round(Number(cfg().maxRounds) || 3))) * 2;

    api.on('group/decide', (decision, { msg } = {}) => {
      const c = cfg();
      if (!c.enabled || !msg || !msg.groupId) return undefined;
      const g = String(msg.groupId);
      const peer = peerOf(msg.userId);
      if (!peer) {
        chain.set(g, 0); // 有人说话：重新计
        return undefined;
      }
      const n = (chain.get(g) || 0) + 1;
      chain.set(g, n);
      // 她睡着了：同伴机器人说话不接（自主生活模块管作息）
      try {
        const au = api.use && api.use('autonomy');
        if (au && typeof au.asleep === 'function' && au.asleep()) return { reply: false, reason: `睡着了，${peer.name}说话不接` };
      } catch (error) {}
      if (n >= cap()) return { reply: false, reason: `和${peer.name}已经来回 ${Math.floor(n / 2)} 轮了，先停` };
      if (decision && decision.reply && decision.mode === 'must') return undefined; // 被点名 / @ / 引用：照常回
      // 对方明确 @ 或引用了别人（且没提到她）：单独在回那个人，不插嘴
      if (n === 1 && (msg.atOthers || msg.replyId)) return { reply: false, reason: `${peer.name}在单独回别人的话，不插嘴` };
      if (decision && decision.reply) return undefined;
      const chance = Math.max(0, Math.min(1, Number(c.replyChance)));
      if (Math.random() < chance) return { reply: true, mode: 'engaged', reason: `接${peer.name}的话` };
      return { reply: false, reason: `${peer.name}这句先不接` };
    });

    // 她自己在群里说话也算一条
    api.on('activity', (a) => {
      if (!a || a.kind !== 'out' || !String(a.chatId || '').startsWith('group:')) return;
      const g = String(a.chatId).slice(6);
      chain.set(g, (chain.get(g) || 0) + 1);
    });

    // 群聊上下文：对方是谁
    api.context(({ chat } = {}) => {
      if (!cfg().enabled || !chat || chat.kind !== 'group') return '';
      const ps = peers();
      if (!ps.length) return '';
      return ps
        .map((p) => `群里的「${p.name}」（${p.id}）是和你一起住在群里的另一个角色${p.desc ? '：' + p.desc : ''}。你们可以聊天、斗嘴、互相吐槽；但有人（尤其主人）说话时先顾人，别跟她没完没了地聊下去。`)
        .join('\n');
    });

    return { peers, chainOf: (g) => chain.get(String(g)) || 0 };
  },
};
