import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addItem,
  agendaBlock,
  applyOps,
  carryCandidates,
  ensureTimes,
  mergeOwnerEdits,
  newAgenda,
} from '../lib/agenda.mjs';

test('carryCandidates preserves unfinished promises and auto-timed items, drops fixed-clock self routines', () => {
  const now = new Date('2026-11-26T10:00:00+08:00').getTime();
  const agenda = newAgenda('2026-11-26');
  // 1) fixed-clock meal (explicit at, autoAt not set) -> should NOT carry over
  addItem(agenda, { slot: 'afternoon', what: '吃午饭', from: 'self', at: new Date('2026-11-26T12:00:00+08:00').getTime() }, { hour: 10, now });
  // 2) flexible self item (no at initially) -> ensureTimes sets autoAt=true -> SHOULD carry over
  addItem(agenda, { slot: 'afternoon', what: '整理桌面素材', from: 'self' }, { hour: 10, now });
  // 3) timed promise (explicit at) -> SHOULD carry over
  addItem(agenda, { slot: 'evening', what: '帮主人查天文馆', from: 'promise', at: new Date('2026-11-26T20:00:00+08:00').getTime() }, { hour: 10, now });
  ensureTimes(agenda, { now });

  const carries = carryCandidates(agenda);
  const whats = carries.map((x) => x.what);
  assert.equal(whats.includes('吃午饭'), false, 'fixed-clock self item should not carry over');
  assert.equal(whats.includes('整理桌面素材'), true, 'auto-timed self item should carry over');
  assert.equal(whats.includes('帮主人查天文馆'), true, 'unfinished promise should carry over even with explicit at');
  for (const c of carries) {
    assert.equal(c.at, undefined, 'carried item should clear stale previous-day at');
    assert.equal(c.age, 1);
  }
});

test('mergeOwnerEdits preserves dropped/deferred timers, non-promise owner edits, and top-level fields', () => {
  const now = Date.now();
  const mine = {
    agenda: newAgenda('2026-11-26'),
    timers: [
      { id: 't1', at: now + 3600_000, what: '周六出门', fired: false, updatedAt: now - 5000 },
      { id: 't2', at: now + 7200_000, what: '晚上提醒喝水', fired: false, updatedAt: now - 5000 },
    ],
    customStatus: { text: '旧状态', at: now - 5000 },
    sleepSchedule: { sleepAt: now + 10_000, wakeAt: now + 20_000, at: now - 5000 },
    sessionRolloverDay: '2026-11-25',
    held: { 'private:1': { since: now - 60_000, until: now - 10_000 } },
  };
  addItem(mine.agenda, { slot: 'afternoon', what: '画一张小插画', from: 'self' }, { hour: 14, now });

  const disk = structuredClone(mine);
  // Owner deferred t1, dropped t2, dropped self item a1, changed customStatus, rolled over session, cleared held
  disk.timers[0].at = now + 9999_000;
  disk.timers[0].updatedAt = now;
  disk.timers[1].fired = true;
  disk.timers[1].dropped = true;
  disk.timers[1].updatedAt = now;
  applyOps(disk.agenda, [{ op: 'drop', id: 'a1', why: '主人说改天画' }], { by: 'owner', now });
  disk.customStatus = { text: '新状态', at: now };
  disk.sessionRolloverDay = '2026-11-26';
  disk.lastRolledSessionId = 'sess-99';
  disk.held = {};

  mergeOwnerEdits(mine, disk);

  assert.equal(mine.timers.find((t) => t.id === 't1').at, now + 9999_000, 'deferred timer time preserved');
  assert.equal(mine.timers.find((t) => t.id === 't2').dropped, true, 'dropped timer tombstone preserved');
  assert.equal(mine.timers.find((t) => t.id === 't2').fired, true);
  assert.equal(mine.agenda.items.find((x) => x.id === 'a1').state, 'dropped', 'owner drop on self item preserved');
  assert.equal(mine.customStatus.text, '新状态');
  assert.equal(mine.sessionRolloverDay, '2026-11-26');
  assert.equal(mine.lastRolledSessionId, 'sess-99');
  assert.deepEqual(mine.held, {});

  const block = agendaBlock(mine.agenda, { timers: mine.timers, now });
  assert.ok(block.includes('[t1]'), 'agendaBlock should include timer ID for my_agenda');
  assert.equal(block.includes('[t2]'), false, 'agendaBlock should hide dropped timers');
});

test('my_agenda supports add dedup, defer (preserving future day), drop, and done on timers + time param on agenda defer', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { default: autonomy } = await import('../index.mjs');

  const dir = mkdtempSync(join(tmpdir(), 'autonomy-myagenda-'));
  const toolFactories = [];
  const api = {
    settings: () => ({ ...autonomy.defaults, enabled: true }),
    saveSettings: () => {},
    config: () => ({ enabled: true, ownerId: '10001' }),
    dataDir: () => dir,
    log: { info() {}, warn() {}, error() {}, debug() {} },
    later: () => {},
    every: () => {},
    on: () => {},
    route: () => {},
    command: () => {},
    tool: (fn) => { toolFactories.push(fn); },
    rule: () => () => {},
    context: () => () => {},
    lib: () => ({}),
    has: () => false,
    open: () => {},
    sendImage: async () => ({ ok: false }),
    setConfig: () => {},
    defineTool: (t) => t,
    use: () => null,
    isOwner: () => true,
    dsh: null,
    core: {},
  };

  try {
    autonomy.setup(api);
    const tools = toolFactories.flatMap((fn) => fn({ level: 'full', chat: { kind: 'private', userId: '10001' } }) || []);
    const myAgenda = tools.find((t) => t && t.name === 'my_agenda');
    assert.ok(myAgenda, 'my_agenda tool registered for owner private chat');

    // 1) Add future timer (day=2, slot=morning -> 09:00 two days later)
    const rAdd = await myAgenda.execute({ action: 'add', what: '周六去北京天文馆', day: 2, slot: 'morning' });
    assert.equal(rAdd.ok, true);
    const idMatch = rAdd.message.match(/\[(t[a-z0-9]+)\]/);
    assert.ok(idMatch, `expected timer id in message: ${rAdd.message}`);
    const tid = idMatch[1];

    // 2) Fuzzy duplicate add must be rejected/guided instead of creating a second timer
    const rDup = await myAgenda.execute({ action: 'add', what: '周六去北京天文馆玩', day: 2, time: '10:00' });
    assert.equal(rDup.ok, true);
    assert.ok(rDup.message.includes(tid), 'duplicate add should reference existing timer id');

    // 3) Defer timer by id with only time="10:30" (must preserve day=+2!)
    const rDefer = await myAgenda.execute({ action: 'defer', id: tid, time: '10:30' });
    assert.equal(rDefer.ok, true, rDefer.message);
    assert.ok(rDefer.message.includes('10:30'), `defer should update time to 10:30: ${rDefer.message}`);
    assert.ok(rDefer.今天的安排.includes(`[${tid}]`), 'agendaBlock should list deferred timer with id');

    // 4) Drop timer by id
    const rDrop = await myAgenda.execute({ action: 'drop', id: tid });
    assert.equal(rDrop.ok, true, rDrop.message);
    assert.equal(rDrop.今天的安排.includes(`[${tid}]`), false, 'dropped timer must vanish from agendaBlock');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
