// ════════════════════════════════════════════════════════
//  src/actions/combat.js — 戰鬥類動作
//  涵蓋: attack
// ════════════════════════════════════════════════════════
'use strict';
const { goals } = require('mineflayer-pathfinder');
const fs   = require('fs');
const path = require('path');
const { pushEvent } = require('../agent/events');
const { HOSTILE_MOBS } = require('../agent/observation');
const ROOT_DIR = path.join(__dirname, '..', '..');

const ATTACK_MAX_MS = 120000;     // 單次戰鬥最長 120 秒，再久就收手讓模型重新判斷

module.exports = async function executeCombat(action, ctx) {
    const { bot, state, MASTER_NAME } = ctx;

    switch (action.type) {
        case 'attack': {
            if (!action.target) break;
            if (state.attackInterval) { clearInterval(state.attackInterval); state.attackInterval = null; }

            const enemy = bot.nearestEntity(e =>
                e.name &&
                e.name.toLowerCase().includes(action.target.toLowerCase()) &&
                e.type !== 'player'
            );

            if (enemy) {
                state.currentMovementMode = 'attack';
                bot.pathfinder.setGoal(new goals.GoalFollow(enemy, 1.5), true);

                const shieldItem = bot.inventory.items().find(i => i.name === 'shield');
                if (shieldItem) {
                    try {
                        await bot.equip(shieldItem, 'off-hand');
                        console.log(`🛡️ [舉盾] 盾牌已裝備至副手`);
                    } catch(se) {
                        console.log(`⚠️ [舉盾] 副手裝備失敗: ${se.message}`);
                    }
                }

                const sword = bot.inventory.items().find(i => i.name.includes('sword')) ||
                              bot.inventory.items().find(i => i.name.includes('axe'));
                if (sword) { try { await bot.equip(sword, 'hand'); } catch(_) {} }

                const isRanged = state.RANGED_MOBS.has(enemy.name.toLowerCase()) ||
                                 enemy.name.toLowerCase().includes('creeper');
                let shieldRaised = false;

                // 立刻回報（不擋住模型）：身體自己打到這一隻死掉為止；模型可以用 obs／events 看戰況，
                // stop 或任何新動作都會停止戰鬥；血量掉到最後底線（見 tsbot.js 的 ATTACK_FLOOR_HP）才會強制撤退
                const startedAt = Date.now();
                const hpAtStart = bot.health;
                let lastProgressHp = bot.health;
                const dist0 = bot.entity.position.distanceTo(enemy.position);
                const nearHostiles = () => Object.values(bot.entities).filter(e => e && e !== enemy && e.isValid && e.name && HOSTILE_MOBS.has(String(e.name).toLowerCase()) && e.position.distanceTo(bot.entity.position) <= 16).length;
                state.systemFeedback = `[身體信號：開始攻擊 ${enemy.name}#${enemy.id}（離你 ${dist0.toFixed(1)} 格），會一直打到牠死掉；你不用等，用 obs 看血量與戰況，想停就下 stop（或任何新動作）。身邊還有 ${nearHostiles()} 隻其他敵人]`;

                const endFight = (outcome) => {
                    clearInterval(state.attackInterval);
                    state.attackInterval = null;
                    try { bot.deactivateItem(); } catch(_) {}
                    const stillAttack = state.currentMovementMode === 'attack';
                    if (stillAttack) { state.currentMovementMode = 'idle'; bot.pathfinder.setGoal(null); }
                    const remaining = nearHostiles();
                    pushEvent('attack_ended', { target: action.target, entityId: enemy.id, outcome, health: Math.round(bot.health * 10) / 10, hpLost: Math.round((hpAtStart - bot.health) * 10) / 10, remainingHostiles: remaining });
                    if (outcome === 'killed') {
                        state.systemFeedback = `[身體信號：已擊殺 ${action.target}（血量 ${Math.round(bot.health)}/20，附近還有 ${remaining} 隻敵人）]`;
                        console.log('⚔️ [戰鬥結束] 目標已擊殺');
                        try { fs.writeFileSync(path.join(ROOT_DIR, '.attack_signal'), `SUCCESS:${action.target}:${Date.now()}`); } catch(_) {}
                    }
                };

                state.endAttack = endFight;      // 撤退、stop 也走這個出口，才會發 attack_ended 告訴模型戰鬥被中斷了
                state.attackInterval = setInterval(() => {
                    if (!enemy.isValid) { endFight('killed'); return; }
                    if (state.currentMovementMode !== 'attack') { endFight('interrupted'); return; }
                    if (Date.now() - startedAt > ATTACK_MAX_MS) { endFight('timeout'); return; }
                    if (lastProgressHp - bot.health >= 6) {      // 打到血量又掉了 6 以上：通知模型戰況，由模型決定要不要繼續
                        lastProgressHp = bot.health;
                        pushEvent('attack_progress', { target: action.target, health: Math.round(bot.health * 10) / 10, remainingHostiles: nearHostiles() });
                    }

                    const dist = bot.entity.position.distanceTo(enemy.position);

                    if (isRanged && dist > 3 && shieldItem) {
                        if (!shieldRaised) {
                            try { bot.activateItem(true); shieldRaised = true; } catch(_) {}
                        }
                    } else {
                        if (shieldRaised) {
                            try { bot.deactivateItem(); shieldRaised = false; } catch(_) {}
                        }
                        if (dist < 3.5) {
                            bot.lookAt(enemy.position.offset(0, 1.5, 0));
                            bot.attack(enemy);
                            bot.swingArm('right');
                            if (enemy.name.toLowerCase().includes('creeper')) {
                                bot.setControlState('back', true);
                                setTimeout(() => bot.setControlState('back', false), 800);
                            }
                        }
                    }
                }, 600);
            } else {
                state.systemFeedback = `[身體信號：找不到可攻擊的目標 ${action.target}]`;
            }
            break;
        }
    }
};
