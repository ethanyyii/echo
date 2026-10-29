// ════════════════════════════════════════════════════════
//  src/perception.js — TARS 環境感知系統
//  接收 (bot, state, mcData) 並回傳感知字串
// ════════════════════════════════════════════════════════
'use strict';
const fs   = require('fs');
const path = require('path');
const ROOT_DIR = path.join(__dirname, '..');

module.exports = function getCurrentPerception(bot, state, mcData) {
    if (!bot.entity) return "[感知失敗]";

    const pos = bot.entity.position;

    const timeOfDay = bot.time.timeOfDay;
    const isNight = timeOfDay >= 13000 && timeOfDay < 23000;
    const timeStr = isNight ? "夜晚 (危險，隨時有怪)" : "白天 (安全)";
    const weatherStr = bot.isRaining ? "下雨" : "晴天";

    let dimStr = "主世界";
    if (bot.game.dimension === 'minecraft:the_nether') dimStr = "地獄/下界 (極度危險)";
    if (bot.game.dimension === 'minecraft:the_end')    dimStr = "終界 (極度危險)";

    let biomeName = "未知區域";
    try {
        const biomeId = bot.world.getBiome(pos);
        biomeName = mcData.biomes[biomeId]?.name || "未知";
    } catch(e) {}

    let closeWallCount = 0, doorCount = 0;
    const closeOffsets = [[1,0,0],[-1,0,0],[0,0,1],[0,0,-1]];
    for (const offset of closeOffsets) {
        const block = bot.blockAt(pos.offset(offset[0], 1, offset[2]));
        if (block && block.boundingBox === 'block') closeWallCount++;
        const legBlock = bot.blockAt(pos.offset(offset[0], 0, offset[2]));
        if (legBlock && legBlock.name.includes('door')) doorCount++;
    }

    let envType = "開闊地帶";
    if (doorCount > 0) envType = "建築物/房子內";
    else if (closeWallCount >= 3) envType = "卡在狹窄的死坑底";
    else {
        const headCheck = bot.blockAt(pos.offset(0, 2, 0));
        if (headCheck && headCheck.boundingBox === 'block') envType = "洞窟內部 (危險)";
    }
    const headBlock2 = bot.blockAt(pos.offset(0, 2, 0));
    if (headBlock2 && headBlock2.boundingBox === 'block') {
        envType += " | 🚫【物理警告：頭頂被擋住，無法跳躍】";
    }

    const isAlert = isNight || dimStr.includes("危險") || envType.includes("洞窟") || envType.includes("死坑");
    const alertLevel = isAlert
        ? "🚨【高度警戒狀態】(必須緊跟哥哥，隨時準備戰鬥)"
        : "🟢【放鬆模式】(安全，可自由活動)";

    const blockAtLegs = bot.blockAt(pos);
    const blockAtHead = bot.blockAt(pos.offset(0, 1, 0));
    const waterStatus = ((blockAtLegs && blockAtLegs.name.includes('water')) ||
                         (blockAtHead && blockAtHead.name.includes('water'))) ? "【游泳中】" : "";

    const allEntities = Object.values(bot.entities)
        .filter(e => e.type !== 'player' && e.position.distanceTo(pos) < 20);
    const animalNames = ['cow','sheep','pig','chicken','cat','wolf','villager','iron_golem',
        'horse','donkey','mule','rabbit','fox','panda','bee','goat','axolotl','frog','camel'];
    const animals = allEntities.filter(e => e.name && animalNames.some(a => e.name.includes(a)));
    const others  = allEntities.filter(e => !animals.includes(e));
    const animalStr = animals.length > 0 ? animals.map(e => {
        const dist = Math.round(e.position.distanceTo(pos));
        const label = e.name === 'iron_golem' ? '鐵巨人' : e.name === 'villager' ? '村民' :
            e.name === 'cow' ? '牛' : e.name === 'sheep' ? '羊' : e.name === 'pig' ? '豬' :
            e.name === 'chicken' ? '雞' : e.name === 'cat' ? '貓' : e.name === 'wolf' ? '狼' : e.name;
        return `${label}(距${dist}格)`;
    }).join(', ') : '';
    const othersStr = others.length > 0 ? others.map(e => {
        const dist = Math.round(e.position.distanceTo(pos));
        let tag = "";
        if (e.name === 'iron_golem') tag = "(友善保鑣/不要打)";
        else if (['enderman','wither_skeleton','warden','ravager'].includes(e.name)) tag = "(極度危險)";
        return e.type === 'object' ? `掉落的${e.name}(距${dist}格)` : `${e.name}${tag}(距${dist}格)`;
    }).join(', ') : '';

    const EXPLORE_VERTICAL_LIMIT = 16;
    let exploreList = [];
    try {
        const botY = bot.entity.position.y;
        const interestingBlocks = bot.findBlocks({
            matching: (b) => {
                if (!b || !b.name || !b.position) return false;
                if (Math.abs(b.position.y - botY) > EXPLORE_VERTICAL_LIMIT) return false;
                const n = b.name.toLowerCase();
                return n.includes('chest') || n.includes('ender_chest') || n.includes('trapped_chest') ||
                       n.includes('ruined_portal') || n.includes('spawner') || n.includes('enchanting_table') ||
                       n.includes('anvil') || n.includes('bell') || n.includes('barrel');
            },
            maxDistance: 28, count: 24
        });
        const byLabel = {};
        const labels = { chest:'寶箱', ender_chest:'終界箱', trapped_chest:'陷阱箱',
            ruined_portal:'廢棄傳送門', spawner:'生怪磚', enchanting_table:'附魔台',
            anvil:'鐵砧', bell:'鐘', barrel:'木桶' };
        const now = Date.now();
        for (const p of interestingBlocks) {
            const block = bot.blockAt(p);
            if (!block || !block.name) continue;
            const blockKey = block.name.toLowerCase();
            const matchedCooldownKey = Object.keys(state.failedApproachCooldowns)
                .find(k => blockKey.includes(k));
            if (matchedCooldownKey && state.failedApproachCooldowns[matchedCooldownKey] > now) continue;
            const dist = Math.round(pos.distanceTo(p));
            let label = labels[block.name] || block.name;
            for (const [k, v] of Object.entries(labels)) { if (block.name.includes(k)) { label = v; break; } }
            if (!byLabel[label] || byLabel[label] > dist) byLabel[label] = dist;
        }
        exploreList = Object.entries(byLabel).map(([l, d]) => `${l}(距${d}格)`);
    } catch (e) {}

    const blockUnder = bot.blockAt(pos.offset(0, -1, 0))?.name || 'air';
    const posX = Math.round(pos.x);
    const posY = Math.round(pos.y);
    const posZ = Math.round(pos.z);
    const foodLevel = Math.round(bot.food || 20);

    let depthZone;
    if (posY > 60)       depthZone = "地表附近";
    else if (posY > 20)  depthZone = "地下石頭層";
    else if (posY > 0)   depthZone = "礦物層(鐵礦/金礦/銅礦密集區)";
    else if (posY > -20) depthZone = "深板岩層(Y=0以下)";
    else if (posY > -50) depthZone = "深礦層(鑽石礦在 Y=-58附近)";
    else                 depthZone = "鑽石礦區(Y≤-50，岩漿湖風險高)";

    const hazardWarnings = [];
    let caveDepth = 0;
    for (let dy = -2; dy >= -6; dy--) {
        const bChk = bot.blockAt(pos.offset(0, dy, 0));
        if (!bChk) break;
        if (bChk.name === 'lava' || bChk.name === 'flowing_lava') {
            hazardWarnings.push(`⚠️正下方${Math.abs(dy)}格有岩漿`); break;
        }
        if (bChk.name === 'air') { caveDepth = Math.abs(dy); } else { break; }
    }
    if (caveDepth >= 3) hazardWarnings.push(`⚠️正下方${caveDepth}格空洞(洞窟入口?)`);
    for (const [dx, dz, dir] of [[0,-1,'北'],[0,1,'南'],[1,0,'東'],[-1,0,'西']]) {
        const bSide = bot.blockAt(pos.offset(dx, 0, dz));
        if (bSide && (bSide.name === 'lava' || bSide.name === 'flowing_lava')) {
            hazardWarnings.push(`⚠️${dir}側有岩漿`);
        }
    }

    const oreNameList = ['coal_ore','iron_ore','copper_ore','gold_ore','redstone_ore',
        'lapis_ore','emerald_ore','diamond_ore','deepslate_coal_ore','deepslate_iron_ore',
        'deepslate_copper_ore','deepslate_gold_ore','deepslate_redstone_ore',
        'deepslate_lapis_ore','deepslate_emerald_ore','deepslate_diamond_ore',
        'ancient_debris','nether_gold_ore','nether_quartz_ore'];
    const nearbyOreMap = {};
    try {
        const oreIds = oreNameList.map(n => mcData.blocksByName[n]?.id).filter(Boolean);
        if (oreIds.length > 0) {
            const orePositions = bot.findBlocks({ matching: oreIds, maxDistance: 8, count: 12 });
            for (const op of orePositions) {
                const ob = bot.blockAt(op);
                if (ob) nearbyOreMap[ob.name] = (nearbyOreMap[ob.name] || 0) + 1;
            }
        }
    } catch(_) {}
    const nearbyOreStr = Object.entries(nearbyOreMap).map(([n,c]) => `${n}×${c}`).join(', ');

    const status    = `HP:${Math.round(bot.health || 20)} 食物:${foodLevel} ${waterStatus}`;
    const inventory = bot.inventory.items().map(item => `${item.count}x ${item.name}`).join(', ') || '空的';

    // ── 手持工具耐久度 ──
    const heldItemSlot = bot.inventory.slots[bot.getEquipmentDestSlot('hand')];
    let heldItem = '空手';
    let durabilityPainSignal = '';
    if (heldItemSlot) {
        const maxDur  = heldItemSlot.maxDurability;
        const usedDur = heldItemSlot.durabilityUsed;
        if (maxDur != null && usedDur != null) {
            const remainingDur = maxDur - usedDur;
            heldItem = `${heldItemSlot.name} (耐久: ${remainingDur}/${maxDur})`;
            if (remainingDur < 20) {
                durabilityPainSignal =
                    `🚨【痛覺神經警告】：手上的 ${heldItemSlot.name} 即將損壞 (只剩 ${remainingDur} 次)！` +
                    `請大腦立即停止當前採集任務，並使用 craft 指令合成新工具！`;
                try {
                    fs.writeFileSync(
                        path.join(ROOT_DIR, '.durability_signal'),
                        `WARN:${heldItemSlot.name}:remaining=${remainingDur}:${Date.now()}`
                    );
                } catch(_) {}
                console.log(`⚠️ [耐久警告] ${heldItemSlot.name} 只剩 ${remainingDur}/${maxDur} 耐久！`);
            }
        } else {
            heldItem = heldItemSlot.name;
        }
    }

    const busyState = state.currentMovementMode !== 'idle'
        ? `[執行中: ${state.currentMovementMode}]` : "[待機中]";
    const feedbackStr = state.systemFeedback ? ` | ⚡神經信號: ${state.systemFeedback}` : "";
    state.systemFeedback = "";

    let out = `[位置] X=${posX} Y=${posY} Z=${posZ} | 深度: ${depthZone}`;
    out += ` | [時空] ${timeStr}, ${weatherStr}, ${dimStr}, 生態系:${biomeName}`;
    out += ` | [狀態] ${status} | 🔄 ${busyState}`;
    out += ` | 警戒: ${alertLevel} | 空間: ${envType} | 腳下: ${blockUnder} | 手上: ${heldItem}`;
    out += ` | 背包: ${inventory}`;
    if (hazardWarnings.length > 0) out += ` | 🔥危險警示: ${hazardWarnings.join(', ')}`;
    if (nearbyOreStr) out += ` | 附近礦石: ${nearbyOreStr}`;
    if (animalStr) out += ` | 附近動物: ${animalStr}`;
    if (exploreList.length > 0) out += ` | 附近可探索: ${exploreList.join(', ')}`;
    out += ` | 周圍其他: ${othersStr || '無'}`;
    out += feedbackStr;
    if (durabilityPainSignal) out = durabilityPainSignal + '\n' + out;
    return out;
};
