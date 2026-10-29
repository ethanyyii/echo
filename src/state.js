// ════════════════════════════════════════════════════════
//  src/state.js — TARS 全域可變狀態單例
//  所有模組透過 require('../state') 存取同一個物件
// ════════════════════════════════════════════════════════

const state = {
    currentMovementMode: 'idle',
    attackInterval: null,
    systemFeedback: '',
    isEating: false,
    bmRunning: false,
    isThinking: false,
    brainTimer: null,
    isDiving: false,
    failedApproachCooldowns: {},
    watchdogStarted: false,
    waterSince: null,        // 連續泡在水裡的起點（毫秒時間戳）；不在水裡或刻意潛水時是 null

    // 常見食物優先清單 (越前越優先)
    FOOD_PRIORITY: [
        'golden_apple', 'enchanted_golden_apple', 'cooked_beef', 'cooked_porkchop',
        'cooked_mutton', 'cooked_chicken', 'cooked_salmon', 'cooked_cod',
        'cooked_rabbit', 'bread', 'baked_potato', 'carrot', 'apple',
        'melon_slice', 'sweet_berries', 'dried_kelp', 'cookie', 'pumpkin_pie',
        'mushroom_stew', 'rabbit_stew', 'suspicious_stew',
    ],

    // 遠程型敵對生物清單 (距離 > 3 格應舉盾)
    RANGED_MOBS: new Set(['skeleton', 'stray', 'pillager', 'witch', 'ghast', 'blaze', 'drowned', 'bogged']),
};

module.exports = state;
