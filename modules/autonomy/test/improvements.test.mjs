import assert from 'node:assert/strict'
import { test } from 'node:test'

import { statusLine, weatherNotable } from '../lib/agenda.mjs'
import botPeers from '../../bot-peers/index.mjs'

test('statusLine 不包含「接下来想」，只保留当前/刚才在做什么', () => {
  const agenda = {
    items: [{ id: 'a1', slot: 'night', what: '找主人聊天', state: 'todo' }],
  }
  const s1 = statusLine(agenda, { at: Date.now() - 10 * 60_000, brief: '在看番' }, { hour: 19 })
  assert.ok(s1.includes('在看番'))
  assert.equal(s1.includes('接下来想'), false)

  const s2 = statusLine(agenda, null, { hour: 19, busy: { until: Date.now() + 60_000, what: '做蛋糕' } })
  assert.ok(s2.includes('正在做蛋糕'))
  assert.equal(s2.includes('接下来想'), false)
})

test('weatherNotable 能识别大幅降温与明天高降水概率', () => {
  const normal = {
    now: { temp: 18, code: 1 },
    today: { min: 14, max: 21, pop: 10, code: 1 },
    tomorrow: { min: 13, max: 20, pop: 10, code: 1 },
  }
  assert.equal(weatherNotable(normal), false)

  const cooling = {
    now: { temp: 16, code: 0 },
    today: { min: 10, max: 18, pop: 0, code: 0 },
    tomorrow: { min: 5, max: 11, pop: 10, code: 2 },
  }
  assert.equal(weatherNotable(cooling), true)

  const tomorrowRain = {
    now: { temp: 18, code: 2 },
    today: { min: 14, max: 20, pop: 20, code: 2 },
    tomorrow: { min: 13, max: 18, pop: 75, code: 61 },
  }
  assert.equal(weatherNotable(tomorrowRain), true)
})

test('bot-peers：n === 1 仅在单独回别人时拦截，公共发言按意愿/概率放行', () => {
  const handlers = new Map()
  let ctxFn = null
  botPeers.setup({
    settings: () => ({ enabled: true, peers: '20001 小汐 鲸鱼娘', maxRounds: 3, replyChance: 1 }),
    on: (ev, fn) => handlers.set(ev, fn),
    context: (fn) => { ctxFn = fn },
    use: () => null,
  })
  assert.ok(typeof ctxFn === 'function')
  const decide = handlers.get('group/decide')
  // 先有真人说话，重置 chain=0
  assert.equal(decide({ reply: true, mode: 'must' }, { msg: { groupId: 'g1', userId: '999' } }), undefined)
  // 对方机器人紧接着单独 @ 别人回话：不插嘴
  const r1 = decide({ reply: false, mode: 'none' }, { msg: { groupId: 'g1', userId: '20001', atOthers: true } })
  assert.equal(r1.reply, false)

  // 重置 chain=0；对方机器人发公开吐槽（没 @/引用别人）：不再被 n===1 死板拦死
  decide({ reply: true, mode: 'must' }, { msg: { groupId: 'g1', userId: '999' } })
  const r2 = decide({ reply: false, mode: 'none' }, { msg: { groupId: 'g1', userId: '20001', atOthers: false, replyId: '' } })
  assert.equal(r2.reply, true)
})
