// ════════════════════════════════════════════════════════
//  exam/run.js — 跑題器
//
//  每題流程：重整考場 → 場地檢查 → 布置 → 送動作給 ECHO → 考官取真相判分 → 比對 ECHO 自己的回報
//
//  用法：
//    node exam/run.js                    跑第 1 階段
//    node exam/run.js --phase 2          跑第 2 階段（可用 1,2,3 或 all）
//    node exam/run.js --only gather_log,craft_planks
//    node exam/run.js --list             列出所有題目
//    node exam/run.js --spectator ethan0915   開考時把旁觀者傳送到考場邊緣
//  前置：node exam/examiner.js 與 npm start（MASTER_NAME=Examiner）都已就緒
//
//  結論分類：
//    PASS          世界狀態符合預期，且 ECHO 的回報與世界一致
//    ACTION_BUG    動作本身沒做到（世界狀態不符預期），但 ECHO 回報誠實
//    VERIFIER_BUG  世界狀態符合預期，但 ECHO 回報與世界不一致（驗證器誤判）
//    BOTH          動作沒做到，而且 ECHO 的回報也與世界不一致
//    SETUP_FAILED  考場或前置條件有問題，這題不計分
// ════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const cases = require('./cases');

// ── 參數 ──
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const ECHO_URL = arg('--echo', `http://127.0.0.1:${config.AGENT_PORT}`);
const EXAM_URL = arg('--exam', `http://127.0.0.1:${process.env.EXAM_PORT || 5051}`);
const EXAMINER_NAME = process.env.EXAMINER_NAME || 'Examiner';
const ECHO_NAME = config.MC_USERNAME;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function call(base, method, route, body, timeoutMs = 60000) {
    const headers = { 'Content-Type': 'application/json' };
    if (base === ECHO_URL && config.AGENT_TOKEN) headers.Authorization = `Bearer ${config.AGENT_TOKEN}`;
    const res = await fetch(base + route, {
        method, headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch (_) { json = { raw: text }; }
    return { status: res.status, body: json };
}

async function must(promise, what) {
    const r = await promise;
    if (r.status !== 200) throw new Error(`${what} 失敗 (HTTP ${r.status}): ${JSON.stringify(r.body)}`);
    return r.body;
}

// ════════════════════════════════════════════════════════
//  X：交給題目使用的工具箱
// ════════════════════════════════════════════════════════
async function buildX() {
    const health = await must(call(EXAM_URL, 'GET', '/health'), 'Examiner /health');
    const arena = health.arena;
    const F = arena.floorY;
    const q = (o) => new URLSearchParams(o).toString();

    const ex = {
        cmd: async (command) => (await must(call(EXAM_URL, 'POST', '/cmd', { command }), `指令 ${command}`)).lines,
        count: async (item) => (await must(call(EXAM_URL, 'GET', '/count?' + q({ target: ECHO_NAME, item })), 'count')).count,
        inventory: async (target = ECHO_NAME) => (await must(call(EXAM_URL, 'GET', '/inventory?' + q({ target })), 'inventory')).items,
        pos: async (target) => must(call(EXAM_URL, 'GET', '/pos?' + q({ target })), `pos ${target}`),
        scalar: async (target, p) => (await must(call(EXAM_URL, 'GET', '/scalar?' + q({ target, path: p })), `scalar ${p}`)).value,
        blockIs: async (x, y, z, block) => (await must(call(EXAM_URL, 'GET', '/blockis?' + q({ x, y, z, block })), 'blockis')).is,
        chestItems: async (x, y, z) => (await must(call(EXAM_URL, 'GET', '/chest?' + q({ x, y, z })), 'chest')).items,
        entCount: async (selector) => (await must(call(EXAM_URL, 'GET', '/entcount?' + q({ selector, x: arena.cx, y: F, z: arena.cz })), 'entcount')).count,
        scan: async (x1, y1, z1, x2, y2, z2) => must(call(EXAM_URL, 'GET', '/scan?' + q({ x1, y1, z1, x2, y2, z2 })), 'scan'),
        reset: async () => must(call(EXAM_URL, 'POST', '/arena/reset', undefined, 180000), 'arena reset'),
    };

    const echo = {
        act: async (action, timeoutMs) => (await call(ECHO_URL, 'POST', '/act', { action, profile: 'all', ...(timeoutMs ? { timeoutMs } : {}) }, (timeoutMs || 120000) + 30000)).body,
        observe: async () => must(call(ECHO_URL, 'GET', '/observe'), 'observe'),
        status: async () => must(call(ECHO_URL, 'GET', '/status'), 'status'),
        health: async () => must(call(ECHO_URL, 'GET', '/health'), 'ECHO /health'),
        cancel: async () => must(call(ECHO_URL, 'POST', '/cancel'), 'cancel'),
        events: async (since) => must(call(ECHO_URL, 'GET', `/events?since=${since}&limit=200`), 'events'),
    };

    const X = {
        arena, floorY: F, standY: F + 1,
        echoName: ECHO_NAME, examinerName: EXAMINER_NAME,
        ex, echo, sleep,
        at: (dx, dz) => ({ x: arena.cx + dx, z: arena.cz + dz }),
        cmd: ex.cmd,

        async give(item, count) {
            const lines = (await ex.cmd(`give ${ECHO_NAME} minecraft:${item} ${count}`)).join(' | ');
            if (!/Gave/i.test(lines)) throw new Error(`give ${item} 失敗: ${lines}`);
        },
        async fill(x1, y1, z1, x2, y2, z2, block) {
            const lines = (await ex.cmd(`fill ${x1} ${y1} ${z1} ${x2} ${y2} ${z2} ${block}`)).join(' | ');
            if (!/filled|Could not set/i.test(lines)) throw new Error(`fill ${block} 失敗: ${lines}`);
        },
        async setblock(x, y, z, block) {
            const lines = (await ex.cmd(`setblock ${x} ${y} ${z} ${block}`)).join(' | ');
            if (!/Changed|Could not set/i.test(lines)) throw new Error(`setblock ${block} 失敗: ${lines}`);
        },
        async summon(entity, dx, dz) {
            const a = X.at(dx, dz);
            const lines = (await ex.cmd(`summon minecraft:${entity} ${a.x + 0.5} ${F + 1} ${a.z + 0.5}`)).join(' | ');
            if (!/Summoned/i.test(lines)) throw new Error(`summon ${entity} 失敗: ${lines}`);
        },
        // ECHO 站到 (dx,dz)，面向 (fdx,fdz)；tp 之後確認 ECHO 自己的視角真的轉過去，沒轉到就重 tp
        async tpEcho(dx, dz, fdx, fdz) {
            const a = X.at(dx, dz);
            const wantYaw = Math.atan2(-(fdx - dx), -(fdz - dz));   // mineflayer 的 yaw 定義
            for (let attempt = 1; attempt <= 5; attempt++) {
                // 不用 `facing`：它只送「看向某點」封包，mineflayer 不處理。改用明確的旋轉角度（Notchian yaw：南 0、西 90、北 180、東 -90）
                const notchianYaw = Math.round(Math.atan2(-(fdx - dx), (fdz - dz)) * 180 / Math.PI);
                await ex.cmd(`tp ${ECHO_NAME} ${a.x + 0.5} ${F + 1} ${a.z + 0.5} ${notchianYaw} 0`);
                await sleep(1000);
                const yaw = (await echo.observe()).self.yaw;
                let diff = Math.abs(yaw - wantYaw) % (Math.PI * 2);
                if (diff > Math.PI) diff = Math.PI * 2 - diff;
                if (diff < 0.3) return;
                console.log(`   ⚠️ ECHO 視角未轉到位（yaw=${yaw}，應為 ${wantYaw.toFixed(2)}），重新 tp（第 ${attempt} 次）`);
            }
            throw new Error(`ECHO 的視角一直沒有轉向 (${fdx},${fdz})`);
        },
        async tpExaminer(dx, dz) {
            const a = X.at(dx, dz);
            await ex.cmd(`tp ${EXAMINER_NAME} ${a.x + 0.5} ${F + 1} ${a.z + 0.5}`);
            await sleep(700);
        },
    };
    return X;
}

// ════════════════════════════════════════════════════════
//  考場檢查
// ════════════════════════════════════════════════════════
async function checkArena(X) {
    const problems = [];
    const { cx, cz } = X.arena;
    const inv = await X.ex.inventory();
    if (Object.keys(inv).length > 0) problems.push(`ECHO 背包不是空的: ${JSON.stringify(inv)}`);
    const p = await X.ex.pos(X.echoName);
    if (Math.abs(p.x - (cx + 0.5)) > 1.5 || Math.abs(p.z - (cz + 0.5)) > 1.5 || Math.abs(p.y - X.standY) > 0.7) {
        problems.push(`ECHO 不在出生點: (${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})`);
    }
    if (!(await X.ex.blockIs(cx, X.floorY, cz, 'grass_block'))) problems.push('出生點腳下不是草地方塊');
    if (!(await X.ex.blockIs(cx, X.floorY + 2, cz, 'air'))) problems.push('出生點上方不是空氣');
    const hp = await X.ex.scalar(X.echoName, 'Health');
    if (hp < 19.5) problems.push(`ECHO 血量 ${hp} 未回滿`);

    const status = await X.echo.status();
    if (status.busy) { await X.echo.cancel(); problems.push('ECHO 還在執行上一個動作（已取消）'); }

    // ECHO 自己的視角也要看到腳下是草地（等區塊載入）
    let seen = null;
    for (let i = 0; i < 8; i++) {
        const o = await X.echo.observe();
        seen = o.self && o.self.blockBelow;
        if (seen === 'grass_block') break;
        await sleep(1000);
    }
    if (seen !== 'grass_block') problems.push(`ECHO 視角腳下是 ${seen}，不是 grass_block`);
    return problems;
}

async function prepareArena(X) {
    let problems = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
        await X.ex.reset();
        problems = await checkArena(X);
        if (problems.length === 0) return [];
        console.log(`   ⚠️ 場地檢查未過（第 ${attempt} 次）: ${problems.join('；')}`);
    }
    return problems;
}

// ════════════════════════════════════════════════════════
//  跑一題
// ════════════════════════════════════════════════════════
async function runCase(X, c, masterOk) {
    const out = { id: c.id, title: c.title, phase: c.phase, verdict: null, echo: null, achieved: null, checks: [], invariants: [], events: [], notes: [] };
    const started = Date.now();
    let difficultyChanged = false;
    let spawnRuleBefore = null;

    try {
        if (c.needsMaster && !masterOk) {
            out.verdict = 'SETUP_FAILED';
            out.notes.push(`ECHO 的 MASTER_NAME 不是 ${EXAMINER_NAME}，這題需要。請用 MASTER_NAME=${EXAMINER_NAME} 啟動 ECHO`);
            return out;
        }

        const problems = await prepareArena(X);
        if (problems.length > 0) {
            out.verdict = 'SETUP_FAILED';
            out.notes.push(...problems);
            return out;
        }

        if (c.difficulty) {
            // 切到有怪的難度時，先關掉自然生怪（只讓題目自己 summon 的怪存在），結束後還原
            const cur = (await X.cmd('gamerule doMobSpawning')).join(' ');
            spawnRuleBefore = /true/i.test(cur) ? 'true' : 'false';
            await X.cmd('gamerule doMobSpawning false');
            await X.cmd(`difficulty ${c.difficulty}`);
            difficultyChanged = true;
        }
        if (c.setup) await c.setup(X);
        const since = (await X.echo.health()).latestEventId;

        const r = c.run ? await c.run.call(c, X) : await X.echo.act(c.act, c.timeoutMs);
        out.echo = {
            ok: r.ok, status: r.status, reason: r.reason, message: r.message,
            durationMs: r.durationMs, evidence: r.evidence, details: r.details,
            inventoryDelta: r.inventoryDelta, interruptedBy: r.interruptedBy, warnings: r.warnings,
        };
        await sleep(800);

        out.checks = await c.judge(X, r);
        out.achieved = out.checks.every(k => k.pass);
        if (c.invariants) out.invariants = await c.invariants(X, r);
        out.events = (await X.echo.events(since)).events.map(e => `${e.type}${e.ok === false ? '(fail)' : ''}`);

        const expected = c.expectAchieved !== false;
        const behaviorOK = out.achieved === expected;
        let claimOK;
        if (c.skipClaim) claimOK = true;
        else if (c.expectRejected) claimOK = r.status === 'rejected' && r.reason === 'invalid_params';
        else claimOK = (r.ok === true) === out.achieved;

        if (behaviorOK && claimOK) out.verdict = 'PASS';
        else if (!behaviorOK && claimOK) out.verdict = 'ACTION_BUG';
        else if (behaviorOK && !claimOK) out.verdict = 'VERIFIER_BUG';
        else out.verdict = 'BOTH';
        if (out.invariants.some(k => !k.pass) && out.verdict === 'PASS') out.verdict = 'ACTION_BUG';
        if (out.invariants.some(k => !k.pass)) out.notes.push('副作用檢查未過: ' + out.invariants.filter(k => !k.pass).map(k => `${k.name}(${k.detail})`).join('；'));
    } catch (e) {
        out.verdict = out.verdict || 'SETUP_FAILED';
        out.notes.push(`考試過程例外: ${e.message}`);
    } finally {
        out.durationMs = Date.now() - started;
        try { await X.echo.cancel(); } catch (_) {}
        if (difficultyChanged) {
            try { await X.cmd('difficulty peaceful'); } catch (_) {}
            if (spawnRuleBefore) { try { await X.cmd(`gamerule doMobSpawning ${spawnRuleBefore}`); } catch (_) {} }
        }
    }
    return out;
}

// ════════════════════════════════════════════════════════
//  主程式
// ════════════════════════════════════════════════════════
const ICON = { PASS: '✅', ACTION_BUG: '🛠️ ', VERIFIER_BUG: '🤥', BOTH: '💥', SETUP_FAILED: '⚙️ ' };

async function main() {
    if (argv.includes('--list')) {
        for (const c of cases) console.log(`[階段${c.phase}] ${c.id.padEnd(26)} ${c.title}`);
        return;
    }

    const phaseArg = arg('--phase', '1');
    const phases = phaseArg === 'all' ? [1, 2, 3, 4, 5, 6] : phaseArg.split(',').map(Number);
    const only = arg('--only', null);
    const selected = cases.filter(c => only ? only.split(',').includes(c.id) : phases.includes(c.phase));
    if (selected.length === 0) { console.log('沒有符合條件的題目'); return; }

    console.log(`🎓 考試開始：${selected.length} 題  ECHO=${ECHO_URL}  Examiner=${EXAM_URL}\n`);

    const exHealth = await call(EXAM_URL, 'GET', '/health').catch(e => ({ status: 0, body: { error: e.message } }));
    if (exHealth.status !== 200 || !exHealth.body.ready) {
        console.log(`🚫 考官未就緒: ${JSON.stringify(exHealth.body)}\n   請先執行 node exam/examiner.js，並在遊戲內 /op ${EXAMINER_NAME}`);
        process.exit(2);
    }
    const echoHealth = await call(ECHO_URL, 'GET', '/health').catch(e => ({ status: 0, body: { error: e.message } }));
    if (echoHealth.status !== 200 || !echoHealth.body.spawned) {
        console.log(`🚫 ECHO 未就緒: ${JSON.stringify(echoHealth.body)}\n   請先執行 npm start（並以 MASTER_NAME=${EXAMINER_NAME} 啟動）`);
        process.exit(2);
    }

    const X = await buildX();
    const obs = await X.echo.observe();
    const masterOk = !!(obs.master && obs.master.name === EXAMINER_NAME);
    if (!masterOk) console.log(`⚠️ ECHO 的 MASTER_NAME 不是 ${EXAMINER_NAME}，需要指揮官的題目會被跳過\n`);

    const spectator = arg('--spectator', null);
    if (spectator) {
        const a = X.at(0, 16);
        await X.ex.cmd(`tp ${spectator} ${a.x + 0.5} ${X.floorY + 1} ${a.z + 0.5} facing ${X.arena.cx + 0.5} ${X.floorY + 2} ${X.arena.cz + 0.5}`);
    }

    // 考試期間考官要待在考場（創造模式），暫停自動附身；結束後恢復
    await call(EXAM_URL, 'POST', '/attach', { on: false }).catch(() => {});
    const results = [];
    for (const c of selected) {
        console.log(`▶ ${c.id} — ${c.title}`);
        const r = await runCase(X, c, masterOk);
        results.push(r);
        console.log(`  ${ICON[r.verdict] || '?'} ${r.verdict}  (${(r.durationMs / 1000).toFixed(1)}s)`);
        if (r.echo) console.log(`     ECHO 回報: ok=${r.echo.ok} reason=${r.echo.reason || '-'} msg=${r.echo.message || '-'}`);
        if (cases.find(x => x.id === r.id).expectAchieved === false) console.log('     （負面題：下列目標項目預期不成立，✗ 才是正確結果）');
        for (const k of r.checks) console.log(`     ${k.pass ? '✓' : '✗'} ${k.name}${k.detail ? ' — ' + k.detail : ''}`);
        if (r.events.length) console.log(`     事件: ${r.events.join(', ')}`);
        for (const n of r.notes) console.log(`     ⚠️ ${n}`);
        console.log('');
    }

    await call(EXAM_URL, 'POST', '/attach', { on: true }).catch(() => {});

    const tally = {};
    for (const r of results) tally[r.verdict] = (tally[r.verdict] || 0) + 1;
    console.log('════ 總結 ════');
    for (const [v, n] of Object.entries(tally)) console.log(`${ICON[v] || ''} ${v}: ${n}`);
    const bad = results.filter(r => r.verdict !== 'PASS');
    if (bad.length) console.log('\n未通過: ' + bad.map(r => `${r.id}(${r.verdict})`).join(', '));

    const dir = path.join(config.ROOT_DIR, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `exam-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), tally, results }, null, 2));
    console.log(`\n報告已存: ${file}`);
    process.exit(bad.length ? 1 : 0);
}

main().catch(e => { console.log('💥 考試程式錯誤:', e.message); process.exit(2); });
