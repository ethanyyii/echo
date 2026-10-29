// ════════════════════════════════════════════════════════
//  src/agent/executor.js — 動作執行器
//  包住 Action Router（ctx.exec），為每個動作產出結構化的 ActionResult：
//    驗證參數 → 擷取動作前快照 → 執行（含逾時）→ 擷取動作後快照 → 以世界狀態判定成敗
//  同一時間只允許一個動作在執行；stop 與 cancel 可以隨時中斷。
// ════════════════════════════════════════════════════════
'use strict';

const fs   = require('fs');
const path = require('path');
const { ACTIONS, validateAction } = require('./schema');
const { takeSnapshot, surroundings } = require('./observation');
const verifier = require('./verifier');
const { isTool } = require('../actions/tools');
const { pushEvent, getEventsSince, latestEventId } = require('./events');

const STOP_SETTLE_MS = 5000;
const POLL_MS        = 250;

function delay(ms) {
    let timer;
    const promise = new Promise(resolve => { timer = setTimeout(resolve, ms); });
    return { promise, cancel: () => clearTimeout(timer) };
}

function cleanFeedback(text) {
    return String(text || '').replace(/^\[身體信號：/, '').replace(/\]$/, '').trim();
}

function round1(n) { return Math.round(n * 10) / 10; }

const REASON_TEXT = {
    no_inventory_change: '背包沒有出現預期的變化',
    partial: '只完成了一部分',
    target_not_found: '找不到目標',
    target_not_reached: '沒有走到目標旁邊',
    timeout: '逾時',
    interrupted: '被打斷',
    nothing_placed: '沒有放下任何方塊',
    nothing_to_dig: '那個位置沒有可以挖的方塊',
    block_still_there: '方塊還在原地',
    no_items_nearby: '附近沒有掉落物',
    nothing_picked_up: '什麼都沒撿到',
    exception: '執行時發生錯誤',
    cancelled: '被取消',
    target_is_liquid: '目標是水或岩漿，不能直接挖',
    did_not_turn: '沒有轉到指定方向',
    still_in_water: '還在水裡',
    still_underground: '雖然離開水了，但還被埋在地底',
    no_state_change: '那個方塊的開關狀態沒有改變',
};

const TOOL_USING_ACTIONS = new Set(['gather', 'tunnel_to', 'staircase', 'dig', 'attack', 'pillar', 'place_torch']);

// 動作失敗時，把「驗證結果」放在最前面，動作模組自己的說法放後面，避免模組罐頭文字蓋過事實
// 一行摘要（≤100 字）：給小模型只讀這一行就能判斷「成功／進行中／失敗」與主要變化；需要細節再看 message／details
function composeSummary(action, ok, madeProgress, reason, inventoryDelta, dist, toolDurability) {
    const mark = ok ? '✓' : (madeProgress ? '◐' : '✗');
    const word = ok ? '成功' : (madeProgress ? '進行中（已有進展，同樣參數再呼叫會繼續）' : `失敗：${REASON_TEXT[reason] || reason}`);
    const bits = [];
    if (dist >= 1) bits.push(`位移 ${Math.round(dist)} 格`);
    const gained = Object.entries(inventoryDelta).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}+${v}`);
    const lost = Object.entries(inventoryDelta).filter(([, v]) => v < 0).sort((a, b) => a[1] - b[1]).slice(0, 2).map(([k, v]) => `${k}${v}`);
    if (gained.length) bits.push(`得到 ${gained.join(' ')}`);
    if (lost.length) bits.push(`用掉 ${lost.join(' ')}`);
    const tools = Object.entries(toolDurability || {}).slice(0, 1).map(([k, v]) => `${k} ${v}`);
    if (tools.length) bits.push(`工具 ${tools[0]}`);
    const line = `${mark} ${action.type} ${word}${bits.length ? '｜' + bits.join('｜') : ''}`;
    return line.length > 140 ? line.slice(0, 137) + '…' : line;
}

function composeMessage(ok, reason, details, moduleText, error, timeoutSec, partial) {
    const text = error ? `${moduleText} [exception: ${error}]`.trim() : moduleText;
    if (ok) return text;
    const detail = details ? ' ' + JSON.stringify(details) : '';
    const limitNote = reason === 'timeout' && timeoutSec ? `（單次動作的時間上限是 ${timeoutSec} 秒，已完成的進度保留，可以再呼叫一次繼續）` : '';
    // 有進展但還沒到目標：不是失敗，開頭就寫明「進行中」，避免小模型把它當成失敗而放棄或亂換做法
    const fleeNote = reason === 'interrupted' ? '（身體的撤退反射在這個動作進行中觸發了：被怪物逼退，附近的敵人用 obs 看；你可以用 attack 反擊、或再下一次動作接手）' : '';
    const partialWhy = (reason === 'partial' || reason === 'timeout') ? `：${REASON_TEXT[reason] || reason}` : '';
    // 動作模組已經給了具體原因（例如「材料不足…還缺 stick×2」）時，不再並列一句籠統的「背包沒有出現預期的變化」，兩句話意思不同會讓模型搞不清楚是哪個問題
    const genericOnly = reason === 'no_inventory_change' && moduleText;
    const head = genericOnly ? '未達成' : partial
        ? `進行中（已有進展、還沒到目標，用同樣的參數再呼叫一次會從目前位置繼續）${partialWhy}${limitNote}${detail}`
        : `未達成：${REASON_TEXT[reason] || reason}${fleeNote}${limitNote}${detail}`;
    return text ? `${head}｜動作模組回報：${text}` : head;
}

// 動作回傳時身體常常還在落下或滑行，位置還沒更新；先等它停穩（落地、在水裡漂穩、或最多 1.5 秒）
async function settleBody(bot) {
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline && bot.entity) {
        const v = bot.entity.velocity;
        const still = Math.abs(v.x) < 0.01 && Math.abs(v.y) < 0.1 && Math.abs(v.z) < 0.01;   // 站在地上時 vy 是重力的 -0.0784，不是 0（以前條件 <0.02 永遠不成立，每個動作都白等 1.5 秒）
        const pp = bot.entity.position;
        const underB = bot.blockAt(pp.offset(0, -0.1, 0));
        if (bot.entity.onGround && still && underB && underB.boundingBox === 'block') return;   // 腳下沒有實心方塊就還沒站穩（剛挖掉腳下的方塊時 onGround 還是 true）
        if (!bot.entity.onGround && still && bot.entity.isInWater) return;
        await delay(100).promise;
    }
}

function createExecutor(ctx, config) {
    const { bot, state } = ctx;
    let current = null;
    let seq = 0;
    let lastResult = null;
    let lastExec = null;     // 上一個被逾時或取消切斷、但還沒真正結束的動作
    let failStreak = { key: '', count: 0 };   // 同一種動作因為同一個原因連續失敗幾次（換座標重試也算）（它還會在背景寫回饋、動身體）

    function appendTrajectory(entry) {
        if (!config.TRAJECTORY_LOG) return;
        try {
            const dir = path.join(config.ROOT_DIR, 'logs');
            fs.mkdirSync(dir, { recursive: true });
            const day = new Date().toISOString().slice(0, 10);
            fs.appendFileSync(path.join(dir, `trajectory-${day}.jsonl`), JSON.stringify(entry) + '\n');
        } catch (e) {
            console.log('⚠️ [軌跡記錄] 寫入失敗:', e.message);
        }
    }

    function rejected(reason, message, extra = {}) {
        return { id: null, ok: false, status: 'rejected', reason, message, ...extra };
    }

    // 強制停止：走 Router 的 stop，並補上 stop 沒有清掉的 bmRunning
    async function hardStop() {
        try { await ctx.exec([{ type: 'stop' }]); } catch (e) { console.log('⚠️ [Executor] stop 例外:', e.message); }
        state.bmRunning = false;
        state.currentMovementMode = 'idle';
    }

    async function cancel() {
        if (!current) {
            await hardStop();
            return { cancelled: false, wasBusy: false };
        }
        const id = current.id;
        current.cancelled = true;
        current.signalCancel();
        await hardStop();
        return { cancelled: true, wasBusy: true, id };
    }

    function status() {
        return {
            busy: !!current,
            current: current ? {
                id: current.id,
                type: current.action.type,
                elapsedMs: Date.now() - current.startedAt,
            } : null,
            mode: state.currentMovementMode,
            last: lastResult,
        };
    }

    async function run(raw, opts = {}) {
        if (!bot.entity) return rejected('not_spawned', '機器人尚未進入遊戲世界');

        const checked = validateAction(raw, ctx.mcData, opts.profile || config.AGENT_PROFILE || 'core');
        if (!checked.ok) return rejected('invalid_params', checked.error);
        const action = checked.action;
        const def = ACTIONS[action.type];

        // say 不經 Router，也不佔用執行槽
        if (def.local) {
            try { bot.chat(action.message); }
            catch (e) { return rejected('exception', e.message, { action }); }
            return { id: null, ok: true, status: 'done', action, message: '已發送聊天訊息' };
        }

        // stop 隨時可以中斷目前的動作
        if (action.type === 'stop') {
            const cancelled = await cancel();
            return {
                id: cancelled.id ?? null, ok: state.currentMovementMode === 'idle', status: 'done', action,
                message: cancelled.wasBusy ? `已中止進行中的動作 #${cancelled.id}` : '已回到待機',
            };
        }

        if (current) {
            return rejected('busy', `動作 #${current.id}(${current.action.type}) 還在進行中，請等它結束或先 stop`, {
                current: { id: current.id, type: current.action.type, elapsedMs: Date.now() - current.startedAt },
            });
        }

        // 上一個被切斷的動作如果還在背景收尾，等它結束（最多 8 秒）再開始，否則它結束時寫的訊息會蓋掉這個動作的
        if (lastExec) {
            const wait = delay(8000);
            await Promise.race([lastExec, wait.promise]);
            wait.cancel();
            lastExec = null;
        }

        const id = ++seq;
        const record = { id, action, startedAt: Date.now(), cancelled: false, interruptedBy: null, signalCancel: null };
        const cancelPromise = new Promise(resolve => { record.signalCancel = () => resolve('CANCELLED'); });
        current = record;

        const warnings = [];
        // 身體撤退是「先逃，爭取時間讓模型判斷」；模型下了新動作就是它做完決定、接手了，撤退立刻結束
        // （以前撤退模式存在期間，模型下的每個動作都被標成 interrupted，被怪物追著就永遠動不了）
        if (state.currentMovementMode === 'flee') {
            warnings.push('model_took_over_from_flee');
            state.currentMovementMode = 'idle';
            try { bot.pathfinder.setGoal(null); bot.clearControlStates(); } catch (_) {}
            pushEvent('flee_ended', { health: Math.round(bot.health * 10) / 10, reason: 'model_took_over' });
        }

        const watcher = setInterval(() => {
            if (record.interruptedBy) return;
            if (state.currentMovementMode === 'flee') record.interruptedBy = 'flee';
            else if ((state.systemFeedback || '').includes('卡在地形')) record.interruptedBy = 'watchdog';
        }, 200);

        try {
            const startEventId = latestEventId();
            const before = takeSnapshot(bot, state);
            const beforeSurround = surroundings(bot);
            const pathfinderPlacedBefore = bot.pathfinderPlaced || 0;
            bot.actionPartial = false;      // 動作模組在「有進展但被時間／距離上限切斷」時會把它設成 true
            const extra = verifier.capture(action, ctx);
            state.systemFeedback = '';

            const timeoutMs = Math.min(Math.max(Number(opts.timeoutMs) || def.timeoutMs, 1000), 600000);
            const deadline = Date.now() + timeoutMs;
            console.log(`🤖 [Executor] #${id} ${JSON.stringify(action)} (timeout ${timeoutMs}ms)`);

            bot.preferredToolName = action.tool ? String(action.tool).toLowerCase() : null;   // 玩家指定的工具（selectTool 會優先用）
            const execPromise = ctx.exec([action]);
            const timeoutTimer = delay(timeoutMs);
            const raced = await Promise.race([
                execPromise,
                timeoutTimer.promise.then(() => 'TIMEOUT'),
                cancelPromise,
            ]);
            timeoutTimer.cancel();

            let timedOut = raced === 'TIMEOUT';
            const wasCancelled = raced === 'CANCELLED';
            const outcome = (timedOut || wasCancelled) ? null : (raced && raced[0]) || null;

            // 被取消：hardStop 已由 cancel() 執行，給動作一點時間自己收尾
            if (wasCancelled) {
                const settle = delay(STOP_SETTLE_MS);
                const settled = await Promise.race([execPromise.then(() => 'SETTLED'), settle.promise.then(() => 'PENDING')]);
                settle.cancel();
                if (settled === 'PENDING') { warnings.push('action_did_not_settle_after_cancel'); lastExec = execPromise; }
            }

            // 背景型動作（attack）：exec 立即返回，等 mode 離開
            if (!timedOut && def.mode === 'until-mode') {
                while (state.currentMovementMode === def.waitMode && !record.cancelled) {
                    if (Date.now() >= deadline) { timedOut = true; break; }
                    await delay(POLL_MS).promise;
                }
            }

            if (timedOut) {
                await hardStop();
                const settle = delay(STOP_SETTLE_MS);
                const settled = await Promise.race([execPromise.then(() => 'SETTLED'), settle.promise.then(() => 'PENDING')]);
                settle.cancel();
                if (settled === 'PENDING') { warnings.push('action_did_not_settle_after_timeout'); lastExec = execPromise; }
            }

            await settleBody(bot);
            // craft：背包更新封包可能比動作回傳晚，扣材料了成品卻還沒出現；等成品真的增加（最多 3 秒）再取快照
            if (action.type === 'craft' && !timedOut && !record.cancelled && /成功合成/.test(state.systemFeedback || '')) {
                const craftWaitEnd = Date.now() + 3000;
                while (Date.now() < craftWaitEnd) {
                    const now = takeSnapshot(bot, state);
                    if ((now.inventory[action.name] || 0) > (before.inventory[action.name] || 0)) break;
                    await delay(100).promise;
                }
            }
            const after = takeSnapshot(bot, state);
            const verdict = verifier.verify(action, before, after, extra, ctx);
            const feedback = state.systemFeedback || '';
            state.systemFeedback = '';

            let ok = verdict.ok;
            let reason = verdict.reason;
            if (timedOut) {
                if (ok) warnings.push('timed_out_but_goal_met');
                else reason = 'timeout';
            }
            if (!ok && outcome && outcome.error) reason = 'exception';
            if (!ok && outcome && outcome.skipped) reason = outcome.skipped;
            if (!ok && record.interruptedBy) reason = 'interrupted';
            if (record.cancelled) { ok = false; reason = 'cancelled'; }

            // 動作進行期間身體發生的反射事件（缺氧上浮、受傷、逃跑、敵人靠近），讓大腦知道這個動作不是在安靜的環境下做的
            const reflexTypes = new Set();
            for (const ev of getEventsSince(startEventId, 100)) {
                if (['low_oxygen', 'damaged', 'flee_started', 'hostile_nearby'].includes(ev.type)) reflexTypes.add(ev.type);
            }
            for (const t of reflexTypes) warnings.push(`reflex:${t}`);

            const inventoryDelta = verifier.gains(before, after);

            // 工具警告：用壞了／不見了，或手上的工具耐久快見底
            if (TOOL_USING_ACTIONS.has(action.type)) {
                for (const [name, d] of Object.entries(inventoryDelta)) {
                    if (d < 0 && isTool({ name })) warnings.push(`tool_lost:${name}`);
                }
                const held = bot.heldItem;
                if (held && held.maxDurability != null && held.durabilityUsed != null) {
                    const left = held.maxDurability - held.durabilityUsed;
                    if (left / held.maxDurability < 0.15) warnings.push(`tool_durability_low:${held.name}:${left}/${held.maxDurability}`);
                }
            }
            // pathfinder 自己放的方塊（墊腳／搭橋）會悄悄消耗背包裡的方塊，要讓大腦知道
            const pathfinderPlaced = (bot.pathfinderPlaced || 0) - pathfinderPlacedBefore;
            if (pathfinderPlaced > 0) warnings.push(`pathfinder_placed_blocks:${pathfinderPlaced}`);
            // 這個動作用掉耐久的工具：回報剩多少，快見底（< 15%）就警告
            const toolDurability = {};
            for (const [name, a] of Object.entries(after.tools || {})) {
                const b = (before.tools || {})[name];
                if (b && a.left < b.left) {
                    toolDurability[name] = `${b.left}→${a.left}/${a.max}`;
                    if (a.left / a.max < 0.15) warnings.push(`tool_durability_low:${name}:${a.left}/${a.max}`);
                }
            }
            const dx = after.pos.x - before.pos.x, dy = after.pos.y - before.pos.y, dz = after.pos.z - before.pos.z;

            // 「有進展但沒做完」：reason 是 partial，或逾時但人實際移動了／背包有變化。ok 仍然是 false（目標沒達成），
            // 但 status 是 'partial'，讓呼叫端分得出「做了一半」和「真的失敗」。
            const progressed = Math.hypot(dx, dy, dz) >= 2 || Object.keys(inventoryDelta).length > 0;
            // 模組自己最清楚「是不是做到一半被時間上限切斷」（例如 gather 挖通道挖了 33 步但礦還差 5 格，驗證器只看到背包沒變化）
            const moduleSaysPartial = !!bot.actionPartial;
            bot.actionPartial = false;
            const madeProgress = !ok && !record.cancelled && !record.interruptedBy && (reason === 'partial' || moduleSaysPartial || (reason === 'timeout' && progressed));
            const result = {
                id,
                ok,
                status: ok && def.mode === 'continuous' ? 'started' : (madeProgress ? 'partial' : 'done'),
                action,
                reason,
                message: composeMessage(ok, reason, verdict.details, cleanFeedback(feedback), outcome && outcome.error, Math.round(timeoutMs / 1000), madeProgress)
                    + (pathfinderPlaced > 0 ? `（路上 pathfinder 自己放了 ${pathfinderPlaced} 個方塊墊腳或搭橋，背包的方塊因此減少）` : '')
                    + (warnings.some(w => w.startsWith('action_did_not_settle')) ? '（動作被強制停止後身體還沒完全停下來，可能還在動；下一個動作前先 wait 2 秒或下 stop）' : ''),
                summary: composeSummary(action, ok, madeProgress, reason, inventoryDelta, Math.hypot(dx, dy, dz), toolDurability),
                evidence: verdict.evidence,
                ...(verdict.details ? { details: verdict.details } : {}),
                durationMs: Date.now() - record.startedAt,
                inventoryDelta,
                positionDelta: { dx: round1(dx), dy: round1(dy), dz: round1(dz), distance: round1(Math.hypot(dx, dy, dz)) },
                healthDelta: round1((after.health ?? 0) - (before.health ?? 0)),
                interruptedBy: record.interruptedBy,
                ...(pathfinderPlaced > 0 ? { pathfinderPlaced } : {}),
                ...(Object.keys(toolDurability).length ? { toolDurability } : {}),
                warnings,
            };
            // 「同樣參數失敗兩次就別再試」只擋得住完全相同的呼叫；弱模型常常只換座標、原因其實一樣，一直重試到預算用完
            {
                const key = `${action.type}|${reason}`;
                if (!ok && !madeProgress && !record.cancelled) failStreak = failStreak.key === key ? { key, count: failStreak.count + 1 } : { key, count: 1 };
                else failStreak = { key: '', count: 0 };
                if (failStreak.count >= 3) {
                    result.message += `（⚠️ 這是連續第 ${failStreak.count} 次「${action.type}」因為同樣的原因失敗：問題不在座標或參數，請先處理原因再試，或換一個做法）`;
                    result.summary += `｜連續第 ${failStreak.count} 次同因失敗`;
                }
            }
            // 動作期間身體遇到了怪物：動作結果可能還是 ok（例如砍到樹了），但模型要知道剛剛發生過什麼
            {
                const bits = [];
                if (warnings.includes('reflex:flee_started')) bits.push('途中進入撤退（被怪物逼退）');
                else if (warnings.includes('reflex:damaged')) bits.push('途中受傷');
                else if (warnings.includes('reflex:hostile_nearby')) bits.push('途中附近出現敵人');
                if (bits.length) { result.summary += `｜⚠️ ${bits.join('、')}，用 obs 看血量與附近的敵人`; }
            }

            lastResult = result;
            const { type: _t, ...argsOnly } = action;
            pushEvent('action_done', { actionId: id, action: action.type, args: JSON.stringify(argsOnly), ok, reason, status: result.status });
            appendTrajectory({
                t: Date.now(),
                action,
                result,
                before: { pos: before.pos, health: before.health, food: before.food, mode: before.mode, inventory: before.inventory, surround: beforeSurround },
                after: { pos: after.pos, health: after.health, mode: after.mode, surround: surroundings(bot) },
            });
            console.log(`🤖 [Executor] #${id} ${action.type} → ${ok ? '✅ ok' : '❌ ' + reason} (${result.durationMs}ms)`);
            return result;
        } catch (e) {
            console.log('⚠️ [Executor] 未預期例外:', e.message);
            const result = { id, ok: false, status: 'done', action, reason: 'exception', message: e.message, warnings };
            lastResult = result;
            return result;
        } finally {
            clearInterval(watcher);
            bot.preferredToolName = null;
            current = null;
        }
    }

    return { run, cancel, status };
}

module.exports = { createExecutor };
