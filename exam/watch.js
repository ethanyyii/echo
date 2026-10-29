// ════════════════════════════════════════════════════════
//  exam/watch.js — ECHO 監視員
//
//  持續偵測「ECHO 不對勁」的情況，偵測到就印一行警報（每個類型有冷卻，不洗版）。
//  設計給 Claude Code 的 Monitor 工具使用：stdout 的每一行會變成一則通知，叫醒正在等待的工程師。
//  所以這支腳本「只印需要處理的事」，不印例行狀態。
//
//    node exam/watch.js
//
//  偵測項目：
//    WATER_TRAPPED     連續泡在水裡太久（含是否在地底、頭上幾格實心、氧氣、正在做什麼）
//    DROWNING          氧氣見底、或泡水時血量持續下降
//    HP_LOW / HP_CRITICAL
//    ACTION_LONG       同一個動作跑太久
//    NO_MOVEMENT       動作進行中，位置很久都沒變
//    REPEATED_FAILURES 最近連續失敗、或同一個動作用同樣原因一直失敗
//    IDLE_LONG         很久沒有任何新動作（玩家可能卡住或已結束）
//    DEATH / DISCONNECTED / AUTO_ESCAPE（反射層事件）
//    ECHO_API_DOWN / ECHO_API_UP
// ════════════════════════════════════════════════════════
'use strict';

const config = require('../src/config');

const ECHO = `http://127.0.0.1:${config.AGENT_PORT}`;
const EXAM = `http://127.0.0.1:${process.env.EXAM_PORT || 5051}`;
const ECHO_NAME = config.MC_USERNAME;

const POLL_MS          = 3000;
const WATER_ALERT_SEC  = 25;
const ACTION_LONG_MS   = 110000;
const NO_MOVE_MS       = 60000;
const IDLE_LONG_MS     = 6 * 60 * 1000;
const COOLDOWN_MS      = 90000;

const headers = config.AGENT_TOKEN ? { Authorization: `Bearer ${config.AGENT_TOKEN}` } : {};

async function getJson(base, route) {
    try {
        const res = await fetch(base + route, { headers: base === ECHO ? headers : {}, signal: AbortSignal.timeout(4000) });
        return await res.json();
    } catch (_) { return null; }
}

const stamp = () => new Date().toLocaleTimeString('zh-TW', { hour12: false });
const lastAlertAt = {};

function alert(type, message, cooldown = COOLDOWN_MS) {
    const now = Date.now();
    if (lastAlertAt[type] && now - lastAlertAt[type] < cooldown) return;
    lastAlertAt[type] = now;
    console.log(`[${stamp()}] ALERT ${type}: ${message}`);
}

function info(type, message) { console.log(`[${stamp()}] INFO ${type}: ${message}`); }

const fmtPos = p => `(${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)})`;

let apiDown = false;
let lastEventId = null;
let waterAlerted = false;
let hpHistory = [];                // [{t, hp}]
let lastPos = null, lastMoveAt = Date.now();
let lastActionDoneAt = Date.now();
const recentResults = [];          // 最近的動作結果 {action, ok, reason}

// 向考官查伺服器端真相（失敗就略過，不影響監視）
async function serverTruth() {
    const air = await getJson(EXAM, `/scalar?target=${ECHO_NAME}&path=Air`);
    const hp = await getJson(EXAM, `/scalar?target=${ECHO_NAME}&path=Health`);
    const parts = [];
    if (air && typeof air.value === 'number') parts.push(`伺服器端空氣=${air.value}`);
    if (hp && typeof hp.value === 'number') parts.push(`伺服器端HP=${hp.value}`);
    return parts.join(' ');
}

async function tick() {
    const obs = await getJson(ECHO, '/observe');
    if (!obs || !obs.ready) {
        if (!apiDown) { apiDown = true; alert('ECHO_API_DOWN', 'ECHO 的 Agent API 沒有回應（程式停了、斷線，或還沒進入遊戲）', 30000); }
        return;
    }
    if (apiDown) { apiDown = false; lastEventId = null; info('ECHO_API_UP', 'ECHO 的 Agent API 恢復了'); }

    const s = obs.self;
    const status = await getJson(ECHO, '/status');
    const now = Date.now();

    // ── 事件（反射層）──
    if (lastEventId === null) {
        const h = await getJson(ECHO, '/health');
        lastEventId = h && typeof h.latestEventId === 'number' ? h.latestEventId : 0;
    } else {
        const ev = await getJson(ECHO, `/events?since=${lastEventId}&limit=200`);
        if (ev && ev.events) {
            for (const e of ev.events) {
                lastEventId = Math.max(lastEventId, e.id);
                if (e.type === 'death') alert('DEATH', `ECHO 死亡了（位置 ${fmtPos(s.position)}）`, 10000);
                else if (e.type === 'disconnected') alert('DISCONNECTED', `ECHO 與伺服器斷線：${e.reason || ''}`, 10000);
                else if (e.type === 'auto_escape_started') info('AUTO_ESCAPE', `ECHO 泡水 ${e.seconds} 秒，自動脫困啟動${e.interrupted ? `（中斷了 ${e.interrupted}）` : ''}`);
                else if (e.type === 'auto_escape_done') info('AUTO_ESCAPE', `自動脫困結束：${e.ok ? '成功' : '未成功'} ${e.message || ''}`);
                else if (e.type === 'action_done') {
                    lastActionDoneAt = now;
                    recentResults.push({ action: e.action, args: e.args || '', ok: e.ok || e.status === 'partial', reason: e.reason, partial: e.status === 'partial' });   // partial = 有進展但沒做完，不算失敗
                    if (recentResults.length > 8) recentResults.shift();
                }
            }
        }
    }

    // ── 泡水 ──
    if (s.inWater && s.waterSeconds >= WATER_ALERT_SEC) {
        waterAlerted = true;
        const truth = await serverTruth();
        alert('WATER_TRAPPED',
            `ECHO 已連續泡在水裡 ${s.waterSeconds} 秒，位置 ${fmtPos(s.position)}，氧氣 ${s.oxygen}/20，HP ${s.health}，` +
            `${s.enclosure.underground ? `在地底（頭上實心 ${s.enclosure.solidAbove} 格）` : '在地表附近'}，` +
            `${s.inBubbleColumn ? '在氣泡柱裡，' : ''}${status && status.busy ? `正在做 ${status.current.type}（${Math.round(status.current.elapsedMs / 1000)} 秒）` : '目前沒有動作'}。${truth}`);
    } else if (waterAlerted && !s.inWater) {
        waterAlerted = false;
        info('RECOVERED', `ECHO 已離開水中，位置 ${fmtPos(s.position)}`);
    }

    // ── 溺水 / 血量 ──
    hpHistory.push({ t: now, hp: s.health });
    hpHistory = hpHistory.filter(h => now - h.t <= 30000);
    const oldest = hpHistory[0];
    if (s.inWater && ((typeof s.oxygen === 'number' && s.oxygen <= 2) || (oldest && oldest.hp - s.health >= 3))) {
        alert('DROWNING', `ECHO 可能正在溺水：氧氣 ${s.oxygen}/20，HP ${s.health}（30 秒前 ${oldest ? oldest.hp : '?'}），位置 ${fmtPos(s.position)}`, 30000);
    }
    if (s.health <= 4) alert('HP_CRITICAL', `ECHO 血量只剩 ${s.health}，位置 ${fmtPos(s.position)}，模式 ${s.mode}`, 30000);
    else if (s.health <= 8) alert('HP_LOW', `ECHO 血量 ${s.health}，位置 ${fmtPos(s.position)}，模式 ${s.mode}`, 60000);

    // ── 動作太久 / 位置不動 ──
    if (status && status.busy && status.current) {
        if (status.current.elapsedMs > ACTION_LONG_MS) {
            alert('ACTION_LONG', `動作 ${status.current.type} 已經跑了 ${Math.round(status.current.elapsedMs / 1000)} 秒還沒結束（位置 ${fmtPos(s.position)}）`);
        }
        const p = s.position;
        if (!lastPos || Math.hypot(p.x - lastPos.x, p.y - lastPos.y, p.z - lastPos.z) > 1.0) { lastPos = { ...p }; lastMoveAt = now; }
        const NO_MOVE_OK = new Set(['wait', 'smelt', 'craft', 'follow', 'attack']);
        if (now - lastMoveAt > NO_MOVE_MS && !NO_MOVE_OK.has(status.current.type)) {
            alert('NO_MOVEMENT', `動作 ${status.current.type} 進行中，但位置 ${Math.round((now - lastMoveAt) / 1000)} 秒都沒變：${fmtPos(s.position)}（HP ${s.health}${s.inWater ? '，在水中' : ''}）`);
        }
    } else {
        lastPos = { ...s.position }; lastMoveAt = now;
    }

    // ── 連續失敗 ──
    const last5 = recentResults.slice(-5);
    if (last5.length === 5 && last5.every(r => !r.ok)) {
        alert('REPEATED_FAILURES', `最近 5 個動作全部失敗：${last5.map(r => `${r.action}[${r.reason}]`).join('、')}`);
    }
    // 同樣的動作、同樣的參數、同樣的原因連續失敗 3 次才算空轉（換了目標不算）
    const last3 = recentResults.slice(-3);
    if (last3.length === 3 && last3.every(r => !r.ok && r.action === last3[0].action && r.args === last3[0].args && r.reason === last3[0].reason)) {
        alert('SAME_FAILURE_LOOP', `同一個動作用完全相同的參數連續 3 次失敗：${last3[0].action} ${last3[0].args} [${last3[0].reason}]（玩家可能在空轉）`);
    }

    // ── 很久沒有新動作 ──
    if (!(status && status.busy) && now - lastActionDoneAt > IDLE_LONG_MS) {
        alert('IDLE_LONG', `已經 ${Math.round((now - lastActionDoneAt) / 60000)} 分鐘沒有新動作了（玩家可能卡住、已結束，或在等待）`, 5 * 60 * 1000);
    }
}

async function main() {
    info('WATCH_STARTED', `開始監視 ECHO（每 ${POLL_MS / 1000} 秒一次）`);
    while (true) {
        try { await tick(); } catch (e) { /* 單次失敗不要讓監視員停掉 */ }
        await new Promise(r => setTimeout(r, POLL_MS));
    }
}

main();
