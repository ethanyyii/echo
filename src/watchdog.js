// ════════════════════════════════════════════════════════
//  src/watchdog.js — TARS 全域卡死看門狗
//  每 2 秒檢查一次座標位移，偵測卡死並執行雙層脫困
// ════════════════════════════════════════════════════════
'use strict';

// 需要移動的狀態才做卡死判定
const MOVING_MODES = new Set([
    'gather', 'staircase',
    'approach', 'goto', 'follow',     // attack 不在這裡：站著揮劍位置本來就不動
    'flee', 'pillar', 'wander',
]);

module.exports = function startWatchdog(bot, state) {
    let stuckCount  = 0;
    let lastPos     = null;

    // 站著挖礦、砍樹、放方塊、等伺服器時座標不會動，但那是在做事，不算卡死：
    // 最近 10 秒內有挖掉方塊、挖到一半被中斷、撿起東西，或此刻正在挖，都視為有活動（玩家：砍樹時被連續「強制跳躍脫困」好幾次，看起來就是原地一直跳）
    let lastActivityAt = Date.now();
    const markActive = () => { lastActivityAt = Date.now(); stuckCount = 0; };
    bot.on('diggingCompleted', markActive);
    bot.on('diggingAborted', markActive);
    bot.on('playerCollect', (collector) => { if (bot.entity && collector === bot.entity) markActive(); });

    setInterval(async () => {
        if (!bot.entity) return;

        // 白名單：非移動狀態直接歸零並略過
        if (!MOVING_MODES.has(state.currentMovementMode)) {
            stuckCount = 0;
            lastPos    = bot.entity.position.clone();
            return;
        }

        const curPos = bot.entity.position;

        if (lastPos === null) {
            lastPos = curPos.clone();
            return;
        }

        const dist = curPos.distanceTo(lastPos);
        lastPos = curPos.clone();

        if (bot.targetDigBlock || Date.now() - lastActivityAt < 10000) {
            stuckCount = 0;
            return;
        }

        if (dist >= 0.2) {
            // 移動正常，重置計數
            stuckCount = 0;
            return;
        }

        stuckCount++;

        // ── 一級脫困：卡住 12 秒 (stuckCount >= 6) ──
        if (stuckCount >= 6 && stuckCount < 12) {
            console.log(`⚠️ [看門狗] 偵測到卡死 (mode=${state.currentMovementMode}, count=${stuckCount})，執行強制跳躍脫困！`);
            try {
                bot.pathfinder.setGoal(null);
                bot.clearControlStates();
                bot.setControlState('jump', true);
                bot.setControlState('forward', true);
                await new Promise(r => setTimeout(r, 500));
                bot.setControlState('jump', false);
                bot.setControlState('forward', false);
            } catch (e) {
                console.log(`⚠️ [看門狗] 一級脫困例外: ${e.message}`);
            }
            return;
        }

        // ── 二級求救：卡住 24 秒 (stuckCount >= 12) ──
        if (stuckCount >= 12) {
            console.log(`🚨 [看門狗] 脫困失敗，已中斷任務並準備呼叫大腦！(mode=${state.currentMovementMode})`);
            try {
                bot.pathfinder.setGoal(null);
                bot.clearControlStates();
            } catch (e) {}
            state.currentMovementMode = 'idle';
            state.bmRunning           = false;
            state.systemFeedback      =
                '[身體信號：我卡在地形裡動彈不得了，任務已被迫中斷！請哥哥來救我或重新下達指令！]';
            stuckCount = 0;
        }
    }, 2000);

    console.log('🐕 [看門狗] 已啟動，每 2 秒偵測一次卡死狀態');
};
