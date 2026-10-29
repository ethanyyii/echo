// ════════════════════════════════════════════════════════
//  src/actions/index.js — Action Router (統一入口)
//  接收 action.type 並派發給對應的模組
// ════════════════════════════════════════════════════════
'use strict';

const executeMovement    = require('./movement');
const executeCombat      = require('./combat');
const executeInteraction = require('./interaction');
const executeGather      = require('./gather');
const executeMining      = require('./mining');
const executeLogistics   = require('./logistics');
const executeBuilder     = require('./builder');

// 動作類型 → 模組的路由表
const MOVEMENT_TYPES    = new Set(['dive','surface','stop','wait','look','follow','wander','approach','jump','face','goto']);
const COMBAT_TYPES      = new Set(['attack']);
const INTERACTION_TYPES = new Set(['drop','eat','equip','pickup_items','use_block']);
const GATHER_TYPES      = new Set(['gather']);
const MINING_TYPES      = new Set(['staircase','tunnel_to']);
const LOGISTICS_TYPES   = new Set(['craft','smelt','store','fetch']);
const BUILDER_TYPES     = new Set(['place_torch','dig','pillar','place_block']);

/**
 * 建立 executeActionQueue 函數
 * @param {object} ctx - 共用 context（包含 bot, state, mcData, goals, MASTER_NAME）
 * @returns {function} executeActionQueue(actArray)
 */
function createActionQueue(ctx) {
    // 後期綁定：把 exec 函數本身注入 ctx（供自動插火把呼叫 place_torch 用）
    // 回傳每個動作的執行結果 [{ type, skipped, error }]，舊呼叫端可忽略回傳值
    async function executeActionQueue(actArray) {
        const outcomes = [];
        if (!Array.isArray(actArray) || actArray.length === 0) return outcomes;

        for (const action of actArray) {
            const outcome = { type: action.type, skipped: null, error: null };
            outcomes.push(outcome);

            // ── 採集保護鎖 ──
            if (ctx.state.currentMovementMode === 'gather') {
                // place_torch 放行：挖礦動作在黑暗的隧道裡會自己插火把（以前被這個鎖擋掉，從來沒成功過）
                if (action.type !== 'stop' && action.type !== 'gather' &&
                    action.type !== 'staircase' &&
                    action.type !== 'tunnel_to' && action.type !== 'place_torch') {
                    console.log(`🔒 [採集保護鎖] 採集進行中，略過動作: ${action.type}`);
                    outcome.skipped = 'gather_lock';
                    continue;
                }
            }

            console.log(`[執行動作] -> ${action.type}`);
            try {
                if (MOVEMENT_TYPES.has(action.type)) {
                    await executeMovement(action, ctx);
                } else if (COMBAT_TYPES.has(action.type)) {
                    await executeCombat(action, ctx);
                } else if (INTERACTION_TYPES.has(action.type)) {
                    await executeInteraction(action, ctx);
                } else if (GATHER_TYPES.has(action.type)) {
                    await executeGather(action, ctx);
                } else if (MINING_TYPES.has(action.type)) {
                    await executeMining(action, ctx);
                } else if (LOGISTICS_TYPES.has(action.type)) {
                    await executeLogistics(action, ctx);
                } else if (BUILDER_TYPES.has(action.type)) {
                    await executeBuilder(action, ctx);
                } else {
                    console.log(`⚠️ [Action Router] 未知動作類型: ${action.type}`);
                    outcome.skipped = 'unknown_action';
                }
            } catch (err) {
                console.log(`⚠️ [動作中斷/超時] ${action.type}:`, err.message);
                outcome.error = err.message;
            }
        }
        return outcomes;
    }

    // 注入 exec 供遞迴呼叫（e.g. 挖礦動作 → place_torch）
    ctx.exec = executeActionQueue;
    return executeActionQueue;
}

module.exports = { createActionQueue };
