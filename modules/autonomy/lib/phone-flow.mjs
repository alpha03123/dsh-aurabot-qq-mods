// [未启用/备用 · ADB 控安卓手机链路，线上未开启 phone 扩展时仅保留作备用]
// 手机 ADB 唤醒、安全执行与自建模块扫描（从 autonomy/index.mjs 拆出）。
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { assertNoModelText, checkExec } from './exec-guard.mjs';
import { scanModuleCode } from './mod-scan.mjs';
import { isGranted } from './grants.mjs';
import { readJson, writeJson } from './helpers.mjs';

export function createPhoneFlow({ api, aurabotDir, dshHome, dayKey }) {
    function looksBroken(cmd) {
      const s = String(cmd || '').trim();
      if (!s) return '空命令';
      const sq = (s.match(/'/g) || []).length;
      const dq = (s.match(/"/g) || []).length;
      if (sq % 2 === 1) return '单引号没闭合（命令写到一半断了）';
      if (dq % 2 === 1) return '双引号没闭合（命令写到一半断了）';
      if (/(\|\||&&|\||>|>>|=|\\)$/.test(s)) return '命令结尾停在 ' + s.slice(-2) + '（没写完）';
      const hd = s.match(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/);
      if (hd) {
        const tag = hd[1];
        const lines = s.split('\n').map((x) => x.trim());
        if (!lines.includes(tag)) return `heredoc ${tag} 没有闭合`;
      }
      if (/[\u4e00-\u9fa5]/.test(s) && !/[;&|><=$`]/.test(s)) {
        return '这写的是一句描述，不是能执行的命令';
      }
      if (/printf\s+%s\s+[A-Za-z0-9+/=]{20,}/.test(s)) {
        return '不用自己套 base64，直接写要跑的命令就行';
      }
      return '';
    }


    function phoneAdbPath() {
      try {
        const cfg = readJson(path.join(aurabotDir, 'config.json'), {});
        const p = cfg && cfg.ext && cfg.ext.phone && cfg.ext.phone.adbPath;
        if (p && fs.existsSync(String(p))) return String(p);
      } catch (error) {}
      // 读不到配置就按常见位置找，最后交给 PATH
      const exe = process.platform === 'win32' ? 'adb.exe' : 'adb';
      const guess = path.join(dshHome, 'plugins-data', 'aurabot', 'modules-data', 'phone', 'platform-tools', exe);
      return fs.existsSync(guess) ? guess : exe;
    }

    const wait = (ms) => new Promise((z) => setTimeout(z, ms));

    /**
     * 跑一条 adb 命令，返回 { ok, out }。
     * 必须先过 exec-guard：白名单外的子命令、危险命令、含 shell 元字符的参数一律不跑。
     */
    function runAdb(args, modelText) {
      // 默认没给手机权限：没授权就当这条命令不存在
      if (!isGranted(api.settings(), 'phone')) {
        return Promise.resolve({ ok: false, message: '手机权限还没授权（面板 → 自主生活 → 权限）' });
      }
      const exe = phoneAdbPath();
      // 防御性断言：模型给的文本不该出现在任何命令参数里。
      // 现在的调用参数全是字面量，但把这条钉在入口处，将来谁想拼 detail 进来会当场炸。
      if (modelText) {
        try {
          assertNoModelText(args, modelText);
        } catch (error) {
          api.log.warn('adb 调用被拦下：' + error.message);
          return Promise.resolve({ ok: false, message: '被安全断言拦下：' + error.message });
        }
      }
      const verdict = checkExec(exe, args);
      if (!verdict.ok) {
        api.log.warn('adb 调用被拦下：' + verdict.reason);
        return Promise.resolve({ ok: false, message: '被安全白名单拦下：' + verdict.reason });
      }
      return new Promise((resolve) => {
        execFile(
          exe,
          args,
          { timeout: 60_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
          (error, stdout, stderr) => {
            const out = String(stdout || '').trim();
            const err = String(stderr || '').trim();
            if (error) return resolve({ ok: false, message: (err || error.message).slice(0, 300) });
            resolve({ ok: true, out: out.slice(0, 1500) });
          },
        );
      });
    }

    /**
     * 今天在手机上花了几次。
     * 用 dayCounts（全量累计）而不是 done（只留最近 50 条，会把额度算小）。
     */
    function todayCounts(s) {
      const c = (s && s.dayCounts) || {};
      let phone = Number(c.phone) || 0;
      // 老状态还没有 dayCounts：退回 done 估算，别让额度恒为 0 而彻底失守
      if (!phone) {
        const list = Array.isArray(s && s.done) ? s.done : [];
        for (const r of list) {
          if (String((r && r.action) || '') === 'phone') phone += 1;
        }
      }
      return { phone };
    }

    /** 玩手机前：确认连着、叫醒屏幕、锁着就输密码 */
    async function ensurePhoneAwake(lock) {
      const dev = await runAdb(['devices']);
      const attached = String(dev.out || '')
        .split(/\r?\n/)
        .filter((l) => /\tdevice$/.test(l));
      if (!attached.length) return { ok: false, message: '手机没连上（USB 线没插？）' };

      const pw = await runAdb(['shell', 'dumpsys', 'power']);
      if (!/mWakefulness=Awake/.test(String(pw.out || ''))) {
        await runAdb(['shell', 'input', 'keyevent', '224']);
        await wait(900);
        await runAdb(['shell', 'input', 'swipe', '612', '2200', '612', '700', '250']);
        await wait(900);
      }

      const sk = await runAdb(['shell', 'dumpsys', 'deviceidle']);
      if (/mScreenLocked=true/i.test(String(sk.out || ''))) {
        if (!lock) return { ok: false, message: '手机锁着，但没配锁屏密码' };
        await runAdb(['shell', 'input', 'text', lock]);
        await wait(400);
        await runAdb(['shell', 'input', 'keyevent', '66']);
        await wait(1500);
      }
      // 回桌面再交给她：白名单只认内容应用，停在设置/别的系统页会直接被拦
      await runAdb(['shell', 'input', 'keyevent', '3']);
      await wait(600);
      return { ok: true };
    }

    /**
     * 她给自己造一个新模块：写进 plugins-data/aurabot/modules/<id>/index.mjs。
     * 模块系统每 3 秒 sync 一次，写完自动生效，不需要重启。
     * 只许新建，不许覆盖已有模块；语法不过就整个目录删掉。
     */
    async function createModule(id, code) {
      const mid = String(id || '').trim().toLowerCase();
      if (!/^[a-z][a-z0-9-]{1,30}$/.test(mid)) {
        return { ok: false, message: '模块 id 只能小写字母开头、字母/数字/短横线，2-31 字符' };
      }
      const src = String(code || '').trim();
      if (!src) return { ok: false, message: '没有代码' };
      // 静态闸门：禁用起进程、直连网络、动态求值、插件内部对象、越界文件操作
      const scan = scanModuleCode(src);
      if (!scan.ok) return { ok: false, message: scan.reason };
      const base = path.join(aurabotDir, 'modules', mid);
      if (fs.existsSync(base)) return { ok: false, message: `模块 ${mid} 已经存在了，不能覆盖` };
      const file = path.join(base, 'index.mjs');
      try {
        fs.mkdirSync(base, { recursive: true });
        fs.writeFileSync(file, src, 'utf8');
        const nodeArgs = ['--check', file];
        const verdict = checkExec('node', nodeArgs);
        if (!verdict.ok) {
          fs.rmSync(base, { recursive: true, force: true });
          return { ok: false, message: '被安全白名单拦下：' + verdict.reason };
        }
        const bad = await new Promise((resolve) => {
          execFile('node', nodeArgs, { timeout: 20000, windowsHide: true }, (error, stdout, stderr) => {
            resolve(error ? String(stderr || error.message).slice(0, 300) : '');
          });
        });
        if (bad) {
          fs.rmSync(base, { recursive: true, force: true });
          return { ok: false, message: '语法没过，已丢弃：' + bad };
        }
        return { ok: true, message: `新模块 ${mid} 写好了，三秒内自动加载`, dir: base };
      } catch (error) {
        try {
          fs.rmSync(base, { recursive: true, force: true });
        } catch (e) {}
        return { ok: false, message: error.message };
      }
    }

    /**
     * 挑一条手机流程：探索类优先；刷内容类（B站 / 知乎）**一天合计最多 4 次**。
     * 同一批里按「今天跑过几次」升序，跑得最少的先上。
     * 淘宝已经整个禁掉了（主人 2026-11-08 要卸载它），这里不再单独提权，
     * 它的 flow 也在 flows.json 里 enabled=false，不会再被挑中。
     */
    function pickPhoneFlow(flows) {
      const file = path.join(api.dataDir(), 'phone-flow-counts.json');
      const day = dayKey();
      let st = readJson(file, null);
      if (!st || st.day !== day) st = { day, counts: {} };
      const counts = st.counts || {};
      const CONTENT_CAP = 4;
      const countOf = (f) => Number(counts[String(f.id)]) || 0;
      // 刷内容类：B站刷推荐/搜索、知乎热榜 —— 都算「刷」
      const isContent = (f) => /^(bili-|zhihu-|xhs-)/.test(String(f.id));

      const contentUsed = flows.filter(isContent).reduce((sum, f) => sum + countOf(f), 0);
      const exploreOnly = flows.filter((f) => !isContent(f));
      // 额度没用完时给 35% 的入场机会，其余时候只从探索类里挑
      let pool = contentUsed < CONTENT_CAP && Math.random() < 0.35 ? flows : exploreOnly;
      if (!pool.length) pool = flows;

      const min = Math.min(...pool.map(countOf));
      const least = pool.filter((f) => countOf(f) === min);
      const pick = least[Math.floor(Math.random() * least.length)];
      counts[String(pick.id)] = countOf(pick) + 1;
      st.counts = counts;
      writeJson(file, st);
      return pick;
    }

    /**
     * 自己上网：搜一下 → 自己挑一条点开 → 读完用自己的口气记下看到了什么。
     * 浏览器用 browser-ops（专用浏览器，窗口在屏幕外），看过的写进记忆（seen，不算人物事实）。
     */

  return { looksBroken, phoneAdbPath, runAdb, todayCounts, ensurePhoneAwake, createModule, pickPhoneFlow };
}
