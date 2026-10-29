// ════════════════════════════════════════════════════════
//  exam/examiner.js — 考官 bot
//
//  第二個 mineflayer 帳號（預設 Examiner，創造模式、需要 OP），負責：
//    1. 布置與重整考場（空中平台，每題前完整重建）
//    2. 從「伺服器端」取得真相：/data get、/execute if、/clear，不依賴受試者 ECHO 的回報
//    3. 用本機 HTTP API（預設 127.0.0.1:5051）讓 run.js 或人工呼叫
//
//  執行：node exam/examiner.js
//  需要在遊戲內先執行 /op Examiner，且遊戲語言為英文（要解析指令回傳文字）。
// ════════════════════════════════════════════════════════
'use strict';

const http = require('http');
const mineflayer = require('mineflayer');
const Vec3 = require('vec3');
const config = require('../src/config');

const EXAMINER_NAME = process.env.EXAMINER_NAME || 'Examiner';
const EXAM_PORT     = parseInt(process.env.EXAM_PORT || '5051', 10);
const ARENA = {
    cx: parseInt(process.env.EXAM_ARENA_X || '20000', 10),
    cz: parseInt(process.env.EXAM_ARENA_Z || '20000', 10),
    floorY: parseInt(process.env.EXAM_ARENA_Y || '200', 10),   // 草地頂面的 Y
    radius: 20,
};

const CMD_GAP_MS  = 300;    // 兩個指令之間的最小間隔（避免洗頻）
const QUIET_MS    = 350;    // 最後一行回應之後等多久視為回應結束
const MAX_WAIT_MS = 3000;   // 沒有任何回應時最多等多久

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ════════════════════════════════════════════════════════
//  純解析函式（不依賴 bot，可離線測試）
// ════════════════════════════════════════════════════════

// "Test passed" / "Test passed, count: 2" / "Test failed"
function parseTest(text) {
    const m = text.match(/Test passed(?:, count: (\d+))?/i);
    if (m) return { passed: true, count: m[1] !== undefined ? parseInt(m[1], 10) : 1 };
    return { passed: false, count: 0 };
}

// "... has the following entity data: [1.5d, 64.0d, -2.3d]" → [1.5, 64, -2.3]
function parseNumbers(text) {
    const idx = text.indexOf('data:');
    const body = idx >= 0 ? text.slice(idx + 5) : text;
    return [...body.matchAll(/(-?\d+(?:\.\d+)?)[dfbsL]?(?=[,\]\s]|$)/g)].map(m => parseFloat(m[1]));
}

// 解析物品清單 NBT → { item_name: totalCount }
// 欄位順序不固定（實測是 {count, Slot, id}），所以先切出每個最外層 {...}，再各自取 id 與 count。
function parseItemList(text) {
    const out = {};
    const listStart = text.indexOf('[');
    if (listStart < 0) return out;
    let depth = 0, elemStart = -1;
    for (let i = listStart + 1; i < text.length; i++) {
        const ch = text[i];
        if (ch === '{') { if (depth === 0) elemStart = i; depth++; }
        else if (ch === '}') {
            depth--;
            if (depth === 0 && elemStart >= 0) {
                const elem = text.slice(elemStart, i + 1);
                const id = elem.match(/\bid:\s*"(?:minecraft:)?([a-z0-9_]+)"/i);
                const count = elem.match(/\bcount:\s*(\d+)/i);
                if (id) out[id[1]] = (out[id[1]] || 0) + (count ? parseInt(count[1], 10) : 1);
                elemStart = -1;
            }
        }
    }
    return out;
}

// ════════════════════════════════════════════════════════
//  指令通道
// ════════════════════════════════════════════════════════

let bot = null;
let collector = null;
let chain = Promise.resolve();
let ready = false;
let isOp = false;

function cmd(text) {
    const job = chain.then(async () => {
        const lines = [];
        let last = Date.now();
        collector = (m) => { lines.push(m); last = Date.now(); };
        bot.chat('/' + text.replace(/^\//, ''));
        const start = Date.now();
        while (true) {
            await sleep(50);
            const now = Date.now();
            if (lines.length > 0 && now - last >= QUIET_MS) break;
            if (now - start >= MAX_WAIT_MS) break;
        }
        collector = null;
        await sleep(CMD_GAP_MS);
        return lines;
    });
    chain = job.catch(() => {});
    return job;
}

const joined = lines => lines.join(' | ');

// ════════════════════════════════════════════════════════
//  真相查詢
// ════════════════════════════════════════════════════════

async function entityData(target, nbtPath) {
    // 偶爾會收不到回應（空字串），重試最多 3 次
    let text = '';
    for (let attempt = 0; attempt < 3 && !text; attempt++) {
        text = joined(await cmd(`data get entity ${target} ${nbtPath}`));
    }
    return text;
}

async function inventoryOf(target) {
    const text = await entityData(target, 'Inventory');
    return parseItemList(text);
}

async function countOf(target, item) {
    const inv = await inventoryOf(target);
    return inv[item.replace(/^minecraft:/, '')] || 0;
}

async function posOf(target) {
    const text = await entityData(target, 'Pos');
    const n = parseNumbers(text);
    if (n.length < 3) throw new Error(`無法解析 ${target} 的座標: ${text}`);
    return { x: n[0], y: n[1], z: n[2] };
}

async function scalarOf(target, nbtPath) {
    const text = await entityData(target, nbtPath);
    const n = parseNumbers(text);
    if (n.length < 1) throw new Error(`無法解析 ${target}.${nbtPath}: ${text}`);
    return n[0];
}

async function blockIs(x, y, z, block) {
    const name = block.includes(':') ? block : `minecraft:${block}`;
    const lines = await cmd(`execute if block ${x} ${y} ${z} ${name}`);
    return parseTest(joined(lines)).passed;
}

async function chestItems(x, y, z) {
    const lines = await cmd(`data get block ${x} ${y} ${z} Items`);
    return parseItemList(joined(lines));
}

async function entityCount(selector, nearX, nearY, nearZ) {
    const lines = await cmd(`execute positioned ${nearX} ${nearY} ${nearZ} if entity ${selector}`);
    return parseTest(joined(lines)).count;
}

// 以考官自己的客戶端視角掃描方塊（與 ECHO 的視角彼此獨立）
function scanRegion(x1, y1, z1, x2, y2, z2) {
    const [xa, xb] = [Math.min(x1, x2), Math.max(x1, x2)];
    const [ya, yb] = [Math.min(y1, y2), Math.max(y1, y2)];
    const [za, zb] = [Math.min(z1, z2), Math.max(z1, z2)];
    if ((xb - xa + 1) * (yb - ya + 1) * (zb - za + 1) > 40000) throw new Error('scan 範圍過大（上限 40000 格）');
    const counts = {};
    let unloaded = 0;
    for (let x = xa; x <= xb; x++) for (let y = ya; y <= yb; y++) for (let z = za; z <= zb; z++) {
        const b = bot.blockAt(new Vec3(x, y, z));
        if (!b) { unloaded++; continue; }
        if (b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air') continue;
        counts[b.name] = (counts[b.name] || 0) + 1;
    }
    return { counts, unloaded };
}

// ════════════════════════════════════════════════════════
//  考場
// ════════════════════════════════════════════════════════

async function fill(x1, y1, z1, x2, y2, z2, block) {
    for (let attempt = 0; attempt < 8; attempt++) {
        const text = joined(await cmd(`fill ${x1} ${y1} ${z1} ${x2} ${y2} ${z2} ${block}`));
        if (/not loaded/i.test(text)) { await sleep(1500); continue; }
        if (/Unknown or incomplete|permission/i.test(text)) throw new Error(`fill 被拒絕（Examiner 需要 OP）: ${text}`);
        return text;   // "Successfully filled N block(s)" 或 "Could not set the block"（區域本來就一樣）
    }
    throw new Error('fill: 區塊一直沒載入');
}

async function initServerRules() {
    const probe = joined(await cmd('gamerule keepInventory true'));
    if (!/keepInventory/i.test(probe)) {
        isOp = false;
        throw new Error(`Examiner 沒有 OP 權限或遊戲語言不是英文，回應: ${probe || '(無回應)'}。請在遊戲內執行 /op ${EXAMINER_NAME}`);
    }
    isOp = true;
    if (process.env.EXAM_MODE === 'play') {
        // 玩遊戲模式：不動日夜、天氣、怪物生成與難度，只確保考官的指令不洗版、回饋可讀
        for (const rule of ['logAdminCommands false', 'sendCommandFeedback true']) await cmd(`gamerule ${rule}`);
        return;
    }
    for (const rule of ['doMobSpawning false', 'doDaylightCycle false', 'doWeatherCycle false',
        'mobGriefing false', 'logAdminCommands false', 'sendCommandFeedback true', 'doTileDrops true']) {
        await cmd(`gamerule ${rule}`);
    }
    await cmd('difficulty peaceful');   // 預設和平；需要怪物的題目由 run.js 臨時切普通
    await cmd('time set noon');
    await cmd('weather clear');
}

// ── 附身：旁觀者模式 + /spectate ECHO，位置永遠跟著 ECHO，伺服器只需載入一組區塊 ──
let autoAttach = process.env.EXAM_MODE === 'play';
let attachTimer = null;

async function attachToEcho() {
    const lines = await cmd(`gamemode spectator ${EXAMINER_NAME}`);
    const out = joined(await cmd(`spectate ${config.MC_USERNAME} ${EXAMINER_NAME}`));
    return { ok: /spectating|Now spectating/i.test(out), response: out || joined(lines) };
}

function startAutoAttach() {
    if (attachTimer) return;
    attachTimer = setInterval(async () => {
        if (!autoAttach || !ready) return;
        try { await attachToEcho(); } catch (e) { console.log('⚠️ [Examiner] 附身失敗:', e.message); }
    }, 20000);
}

// ── 讓「人類旁觀者」一直附在 ECHO 身上 ──
// ECHO 重連或重生後，人類玩家會掉出附身、留在原地；離 ECHO 太遠，伺服器就得同時載入兩塊區域而卡頓。
// 只在使用者「已經是旁觀者」且離 ECHO 超過半徑時才重新附身；不會把一般模式的玩家硬切成旁觀者。
const FOLLOW_USER = process.env.FOLLOW_USER || config.MASTER_NAME;
const FOLLOW_RADIUS = 4;   // 附身中的使用者座標會和 ECHO 同步（兩次查詢之間 ECHO 最多走一兩格），所以 4 格以內視為還在附身或剛好在旁邊
const FOLLOW_EVERY_MS = 8000;
let followTimer = null;

// ECHO 被 /tp 到很遠的地方（考場重建、spreadplayers）或重連之後，使用者的「遊戲畫面」會追丟 ECHO，
// 但伺服器還以為他附著著（座標也還是同步的），所以只看距離抓不到。這時要先切一下模式清掉伺服器端的附身狀態再附身，
// 畫面才會重新綁上 ECHO。實測：只下一次 /spectate 沒有效果。
const FOLLOW_JUMP = 60;
let lastEchoAt = null;      // 上一輪 ECHO 的座標；null 代表上一輪 ECHO 不在線（或剛啟動）
let echoWasOffline = false;

async function keepUserAttached() {
    if (!ready || !FOLLOW_USER || FOLLOW_USER === EXAMINER_NAME) return;
    let echoAt, userAt;
    try { echoAt = await posOf(config.MC_USERNAME); } catch (_) { lastEchoAt = null; echoWasOffline = true; return; }   // ECHO 不在線
    try { userAt = await posOf(FOLLOW_USER); } catch (_) { return; }   // 使用者不在線
    const jumped = lastEchoAt && Math.hypot(echoAt.x - lastEchoAt.x, echoAt.z - lastEchoAt.z) > FOLLOW_JUMP;
    const reconnected = echoWasOffline;
    lastEchoAt = echoAt;
    echoWasOffline = false;
    const far = Math.hypot(userAt.x - echoAt.x, userAt.z - echoAt.z) > FOLLOW_RADIUS;
    if (!far && !jumped && !reconnected) return;
    let mode;
    try { mode = await scalarOf(FOLLOW_USER, 'playerGameType'); } catch (_) { return; }
    if (mode !== 3) return;   // 3 = 旁觀者；其他模式代表使用者想自己玩，不動他
    if (jumped || reconnected) {
        await cmd(`gamemode creative ${FOLLOW_USER}`);
        await cmd(`gamemode spectator ${FOLLOW_USER}`);
    }
    const out = joined(await cmd(`spectate ${config.MC_USERNAME} ${FOLLOW_USER}`));
    const why = jumped ? 'ECHO 被傳到很遠的地方' : reconnected ? 'ECHO 重連' : '離 ECHO 太遠';
    console.log(`🎓 [Examiner] 使用者 ${FOLLOW_USER} 重新附身（${why}）: ${out}`);
}

function startFollowUser() {
    if (followTimer || !FOLLOW_USER) return;
    followTimer = setInterval(() => { keepUserAttached().catch(e => console.log('⚠️ [Examiner] 使用者附身檢查失敗:', e.message)); }, FOLLOW_EVERY_MS);
}

async function resetArena() {
    const { cx, cz, floorY: F, radius: R } = ARENA;
    const echo = config.MC_USERNAME;
    const steps = [];

    await cmd(`gamemode creative ${EXAMINER_NAME}`);   // 旁觀者不會被傳送給一般玩家，ECHO 看不到，所以用創造模式
    await cmd(`tp ${EXAMINER_NAME} ${cx + 0.5} ${F + 12} ${cz + 0.5}`);
    try { await Promise.race([bot.waitForChunksToLoad(), sleep(8000)]); } catch (_) {}
    await sleep(1500);

    // 重建期間 ECHO 進創造模式（不會摔死、不會被活埋），停在平台中心上方
    await cmd(`gamemode creative ${echo}`);
    await cmd(`tp ${echo} ${cx + 0.5} ${F + 6} ${cz + 0.5}`);
    await cmd(`effect clear ${echo}`);
    await cmd(`clear ${echo}`);

    steps.push(await fill(cx - R, F + 1, cz - R, cx + R, F + 14, cz + R, 'air'));
    steps.push(await fill(cx - R, F - 8, cz - R, cx + R, F - 2, cz + R, 'stone'));
    steps.push(await fill(cx - R, F - 1, cz - R, cx + R, F - 1, cz + R, 'dirt'));
    steps.push(await fill(cx - R, F, cz - R, cx + R, F, cz + R, 'grass_block'));

    const W = R + 1;
    steps.push(await fill(cx - W, F + 1, cz - W, cx + W, F + 4, cz - W, 'stone_bricks'));
    steps.push(await fill(cx - W, F + 1, cz + W, cx + W, F + 4, cz + W, 'stone_bricks'));
    steps.push(await fill(cx - W, F + 1, cz - W, cx - W, F + 4, cz + W, 'stone_bricks'));
    steps.push(await fill(cx + W, F + 1, cz - W, cx + W, F + 4, cz + W, 'stone_bricks'));

    await cmd(`kill @e[type=!player,x=${cx},y=${F},z=${cz},distance=..80]`);
    await cmd(`time set noon`);
    await cmd(`spawnpoint ${echo} ${cx} ${F + 1} ${cz}`);
    await cmd(`tp ${echo} ${cx + 0.5} ${F + 1} ${cz + 0.5}`);
    await cmd(`gamemode survival ${echo}`);
    await cmd(`effect give ${echo} minecraft:instant_health 1 20 true`);
    await cmd(`effect give ${echo} minecraft:saturation 1 20 true`);
    await cmd(`tp ${EXAMINER_NAME} ${cx + 0.5} ${F + 4} ${cz + R - 3}`);
    await sleep(500);
    return { ok: true, arena: ARENA, fills: steps.length };
}

// ════════════════════════════════════════════════════════
//  HTTP 控制 API
// ════════════════════════════════════════════════════════

function sendJson(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) });
    res.end(payload);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
            if (chunks.length === 0) return resolve({});
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (_) { reject(new Error('invalid_json')); }
        });
        req.on('error', reject);
    });
}

function startServer() {
    const server = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url, 'http://localhost');
            const q = url.searchParams;
            const num = k => parseInt(q.get(k), 10);
            const route = `${req.method} ${url.pathname}`;

            if (route === 'GET /health') return sendJson(res, 200, { ready, isOp, name: EXAMINER_NAME, arena: ARENA });
            if (!ready) return sendJson(res, 503, { error: 'examiner_not_ready' });

            switch (route) {
                case 'POST /cmd': {
                    const body = await readBody(req);
                    return sendJson(res, 200, { lines: await cmd(String(body.command || '')) });
                }
                case 'POST /attach': {
                    const body = await readBody(req);
                    autoAttach = body.on !== false;
                    return sendJson(res, 200, autoAttach ? { autoAttach, ...(await attachToEcho()) } : { autoAttach });
                }
                case 'POST /arena/reset':
                    return sendJson(res, 200, await resetArena());
                case 'GET /inventory':
                    return sendJson(res, 200, { items: await inventoryOf(q.get('target')) });
                case 'GET /count':
                    return sendJson(res, 200, { count: await countOf(q.get('target'), q.get('item')) });
                case 'GET /pos':
                    return sendJson(res, 200, await posOf(q.get('target')));
                case 'GET /scalar':
                    return sendJson(res, 200, { value: await scalarOf(q.get('target'), q.get('path')) });
                case 'GET /blockis':
                    return sendJson(res, 200, { is: await blockIs(num('x'), num('y'), num('z'), q.get('block')) });
                case 'GET /chest':
                    return sendJson(res, 200, { items: await chestItems(num('x'), num('y'), num('z')) });
                case 'GET /entcount':
                    return sendJson(res, 200, { count: await entityCount(q.get('selector'), num('x'), num('y'), num('z')) });
                case 'GET /scan':
                    return sendJson(res, 200, scanRegion(num('x1'), num('y1'), num('z1'), num('x2'), num('y2'), num('z2')));
                default:
                    return sendJson(res, 404, { error: 'not_found', route });
            }
        } catch (e) {
            if (e.message === 'invalid_json') return sendJson(res, 400, { error: 'invalid_json' });
            console.log('⚠️ [Examiner API]', e.message);
            sendJson(res, 500, { error: 'examiner_error', message: e.message });
        }
    });
    server.listen(EXAM_PORT, '127.0.0.1', () => console.log(`🎓 [Examiner] 控制 API http://127.0.0.1:${EXAM_PORT}`));
    return server;
}

function main() {
    bot = mineflayer.createBot({
        host: config.MC_HOST,
        port: config.MC_PORT,
        username: EXAMINER_NAME,
        version: config.MC_VERSION,
        auth: config.MC_AUTH,
        family: 4,
        checkTimeoutInterval: 90000,
    });

    bot.on('messagestr', (msg) => {
        if (collector && !msg.startsWith('<')) collector(msg);
    });

    bot.once('spawn', async () => {
        console.log(`🎓 [Examiner] ${EXAMINER_NAME} 已進入遊戲`);
        startServer();
        try {
            await initServerRules();
            ready = true;
            console.log('🎓 [Examiner] OP 權限確認，準備就緒');
            startFollowUser();
            if (process.env.EXAM_MODE === 'play') {
                const r = await attachToEcho();
                console.log(`🎓 [Examiner] 旁觀者模式，附身 ${config.MC_USERNAME}: ${r.ok ? '成功' : '未成功（' + r.response + '）'}`);
                startAutoAttach();
            }
        } catch (e) {
            console.log('🚫 [Examiner]', e.message);
        }
    });

    bot.on('kicked', r => console.log('🔌 [Examiner] 被踢出:', String(r)));
    bot.on('end', r => { console.log('🔌 [Examiner] 連線結束:', String(r)); ready = false; });
    bot.on('error', e => console.log('🔥 [Examiner] 錯誤:', e.message));
}

if (require.main === module) main();

module.exports = { parseTest, parseNumbers, parseItemList };
