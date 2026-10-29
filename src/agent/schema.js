// ════════════════════════════════════════════════════════
//  src/agent/schema.js — Agent API 的動作契約（單一事實來源）
//
//  每個動作的參數、型別、說明、執行模式與逾時都定義在這裡。
//  用途：GET /actions 輸出、POST /act 的參數驗證、測試旁路的位置參數解析。
//
//  動作檔案（profile）：不是每個動作都該給模型看。動作越多、越像，弱模型越容易選錯。
//    core      預設給模型看的核心動作（挖、採、合成、走、放、撿、打、脫困…），每件事只留一個名字
//    extended  可選：箱子（store/fetch）、走到某個東西旁（approach）、探索（wander）、潛水（dive）、跳（jump）
//    commander 需要「有一個人類指揮官」的動作（look/follow/drop/say）；純遊戲代理用不到
//    internal  只給內部反射／自動行為用（place_torch：自動插火把會呼叫它），不給模型看
//  server 預設用 config.AGENT_PROFILE（預設 core）；考場送動作時可以帶 profile:'all' 取用全部。
// ════════════════════════════════════════════════════════
'use strict';

// mode:
//   blocking   — 執行到完成才回傳
//   until-mode — exec 立即返回，但動作仍在背景進行，直到 state.currentMovementMode 離開指定模式
//   continuous — 啟動後持續進行（follow/wander/dive），呼叫 stop 才結束，立即回傳 status:'started'
//
// params[*].kind:
//   item    — 物品名稱，驗證 mcData.itemsByName
//   block   — 方塊名稱，允許子字串（例如 log、iron_ore），驗證 mcData.blocksByName
//   entity  — 生物名稱，允許子字串，驗證 mcData.entitiesByName
//   free    — 不驗證
const ACTIONS = {
    gather: {
        profile: 'core',
        description: '前往並採集最近的指定方塊（伐木、挖礦、挖土）。需要對應工具時會自動裝備；沒有工具會失敗。',
        mode: 'blocking', timeoutMs: 100000,
        params: {
            target: { type: 'string', required: true, kind: 'block', description: '方塊英文名，例如 oak_log、log、stone、iron_ore、sand。精確比對（stone 不會挖到 stone_bricks）；iron_ore、diamond_ore 這類礦也包含深板岩變體（deepslate_iron_ore）；也可以給掉落物名稱（cobblestone、raw_iron、diamond、coal），會改挖會掉出它的方塊' },
            tool: { type: 'string', required: false, kind: 'free', description: '指定要用的工具英文名（例如 stone_pickaxe）；背包有、採得動、還有耐久才會照辦。不指定就自動選：挖便宜的方塊用低階工具，把鐵鎬、鑽石鎬留給礦石' },
            count: { type: 'number', required: false, description: '最多挖幾個（礦石、石頭、泥土等；不給就最多 15 個，上限 64）。砍樹（log）時是最多砍幾根原木，不給就整棵砍完；到上限就停（樹上可能還有剩）' },
        },
        positional: ['target'],
    },
    craft: {
        profile: 'core',
        description: '合成物品。背包有原料才會成功，需要工作台時會自動放置並回收；不會自動合成中間材料（例如要先有木板才能做木鎬）。',
        mode: 'blocking', timeoutMs: 60000,
        params: {
            name: { type: 'string', required: true, kind: 'item', description: '成品英文名，例如 oak_planks、stick、wooden_pickaxe' },
            count: { type: 'number', required: false, description: '想要的成品數量（例如 oak_planks count=16 會合成 4 次）；材料不夠會做到做得出來為止。不給就合成 1 次' },
        },
        positional: ['name', 'count'],
    },
    smelt: {
        profile: 'core',
        description: '用熔爐冶煉背包裡的物品（附近沒有熔爐時會放置背包裡的熔爐並在事後回收），需要燃料。預設燒完整疊（單次最多 10 個），會等到燒完才回傳。',
        mode: 'blocking', timeoutMs: 115000,
        params: {
            name:  { type: 'string', required: true, kind: 'item', description: '要冶煉的原料英文名，例如 raw_iron、sand' },
            count: { type: 'number', required: false, description: '要燒幾個，預設背包裡該物品的全部（上限 10）' },
        },
        positional: ['name', 'count'],
    },
    store: {
        profile: 'extended',
        description: '把背包物品存入附近的箱子（附近沒有箱子且背包有箱子時會自己放置）。',
        mode: 'blocking', timeoutMs: 60000,
        params: {
            name: { type: 'string', required: true, kind: 'free', description: '物品英文名' },
        },
        positional: ['name'],
    },
    fetch: {
        profile: 'extended',
        description: '從附近的箱子取出物品。',
        mode: 'blocking', timeoutMs: 60000,
        params: {
            name:  { type: 'string', required: true, kind: 'free', description: '物品英文名' },
            count: { type: 'number', required: false, description: '取出數量，預設 1' },
        },
        positional: ['name', 'count'],
    },
    place_block: {
        profile: 'core',
        description: '在指定座標放一個方塊（座標由你決定，一次只放一個）。背包要有那個方塊；那一格必須是空的（或水、雪這類可取代的），而且周圍至少有一面實心方塊可以靠。離太遠會自己走近。蓋牆、搭橋、擋水、放工作台／熔爐／箱子／火把都用這個。',
        mode: 'blocking', timeoutMs: 40000,
        params: {
            block: { type: 'string', required: true, kind: 'item', description: '要放的方塊英文名（背包裡的物品），例如 cobblestone、dirt、torch、crafting_table、furnace' },
            x: { type: 'number', required: true, description: '目標 X 座標' },
            y: { type: 'number', required: true, description: '目標 Y 座標' },
            z: { type: 'number', required: true, description: '目標 Z 座標' },
        },
        positional: ['block', 'x', 'y', 'z'],
    },
    place_torch: {
        profile: 'internal',
        description: '在附近牆面插一支火把（背包需有火把）。',
        mode: 'blocking', timeoutMs: 30000,
        params: {},
        positional: [],
    },
    pillar: {
        profile: 'core',
        description: '腳下往上墊方塊抬高自己（背包需有可放置的方塊）。',
        mode: 'blocking', timeoutMs: 60000,
        params: {
            height: { type: 'number', required: false, description: '要抬高的格數，預設 2' },
            target: { type: 'string', required: false, kind: 'free', description: '填 player 會至少抬高到指揮官的高度' },
        },
        positional: ['target', 'height'],
        bypassDefaults: { target: 'player' },
    },
    dig: {
        profile: 'core',
        description: '挖掉面前、頭上或腳下的一個方塊。',
        mode: 'blocking', timeoutMs: 20000,
        params: {
            direction: { type: 'string', required: false, enum: ['forward', 'up', 'down'], description: '預設 down' },
            tool: { type: 'string', required: false, kind: 'free', description: '指定要用的工具英文名（例如 stone_pickaxe）；背包有、採得動、還有耐久才會照辦。不指定就自動選：挖便宜的方塊用低階工具，把鐵鎬、鑽石鎬留給礦石' },
        },
        positional: ['direction'],
    },
    staircase: {
        profile: 'core',
        description: '往下挖到指定深度。shape=stairs（預設）挖成斜的階梯，可以原路走回來，會處理洞穴落差、水、岩漿，適合要回來、帶東西、不熟的地形；shape=shaft 挖成一格寬的垂直井，每層只挖腳下一格所以最快，但沒有台階、上不來（要用 surface 或 pillar），適合單程下礦，每落一層前都會檢查底下 3 格內有沒有水、岩漿、虛空或太深的落差，有就停下並說明。需要鎬子；每個方塊自動選最適合的工具。單次動作最多約 100 秒，超過會被切斷但進度保留，用同一個 targetY 再呼叫一次就會從目前位置繼續。',
        mode: 'blocking', timeoutMs: 100000,
        params: {
            targetY: { type: 'number', required: false, description: '目標 Y 座標（最低 -60）' },
            steps:   { type: 'number', required: false, description: '向下挖幾層（未給 targetY 時使用，預設 10）' },
            shape: { type: 'string', required: false, enum: ['stairs', 'shaft'], description: 'stairs＝階梯（預設，走得回來）；shaft＝一格寬的垂直井（最快，上不來）' },
            direction: { type: 'string', required: false, enum: ['north', 'south', 'east', 'west'], description: '階梯往哪個方向挖；不給就沿著目前面向（shape=shaft 不用）' },
            tool: { type: 'string', required: false, kind: 'free', description: '指定要用的工具英文名（例如 stone_pickaxe）；背包有、採得動、還有耐久才會照辦。不指定就自動選：挖便宜的方塊用低階工具，把鐵鎬、鑽石鎬留給礦石' },
        },
        positional: ['_direction', 'steps'],
    },
    tunnel_to: {
        profile: 'core',
        description: '挖一條通道走到指定座標，需要鎬子：朝目標一格一格挖出 1x2 的通道，需要升降時挖成階梯（目標在正下方時改挖一格寬的垂直井，上不來要用 surface 或 pillar；目標在正上方時改用 pillar 邊挖頭頂邊墊高，要有可以放的方塊），沿路掉落物會撿起來；前方有水或岩漿會停下並說明；在黑暗的地底有火把會自己插。range=0（預設）表示一路挖到站在那一格（目標是礦就把它挖掉）；range>0 表示走到距離 range 格以內就停。單次最多約 95 秒，進度保留，用同樣的目標再呼叫一次就會繼續。藏在岩石裡、走不過去的礦就用這個。',
        mode: 'blocking', timeoutMs: 105000,
        params: {
            x: { type: 'number', required: true, description: '目標 X 座標' },
            y: { type: 'number', required: true, description: '目標 Y 座標' },
            z: { type: 'number', required: true, description: '目標 Z 座標' },
            range: { type: 'number', required: false, description: '走到距離目標幾格以內就停，預設 0（一路挖到那一格）' },
        },
        positional: ['x', 'y', 'z', 'range'],
    },
    attack: {
        profile: 'core',
        description: '攻擊最近的指定生物，身體會自己一直打到那一隻死掉為止（不會攻擊玩家，一次只打一隻）。下令後立刻回報「開始攻擊」，不會等到打完——你可以用 obs 看血量與戰況、用 events 等 attack_ended（擊殺／被中斷）；想停就下 stop（任何新動作也會停止戰鬥）。戰鬥中血量掉到 5 以下會強制撤退。被偷襲時身體會先自動撤退，讓你有時間看一下有幾隻、是什麼，再決定要不要打、打哪一隻。',
        mode: 'continuous', timeoutMs: 15000,
        params: {
            target: { type: 'string', required: true, kind: 'entity', description: '生物英文名，例如 zombie、cow、spider' },
        },
        positional: ['target'],
    },
    approach: {
        profile: 'extended',
        description: '走到指定的玩家、生物或方塊旁邊（3 格內）。',
        mode: 'blocking', timeoutMs: 90000,
        params: {
            target: { type: 'string', required: true, kind: 'free', description: '玩家名、生物名或方塊名，例如 chest、crafting_table、cow' },
        },
        positional: ['target'],
    },
    goto: {
        profile: 'core',
        description: '走到指定座標。range=0 表示要站在那一格，預設 1（走到 1 格內）。只會走、不會挖路：目標被封住或在封閉空間就會失敗，並說明原因。',
        mode: 'blocking', timeoutMs: 100000,
        params: {
            x: { type: 'number', required: true, description: 'X 座標（往東增加）' },
            y: { type: 'number', required: true, description: 'Y 座標（往上增加）' },
            z: { type: 'number', required: true, description: 'Z 座標（往南增加）' },
            range: { type: 'number', required: false, description: '到達判定半徑，預設 1；0 = 站在該格' },
        },
        positional: ['x', 'y', 'z', 'range'],
    },
    face: {
        profile: 'core',
        description: '轉向指定方位。north = -Z、south = +Z、east = +X、west = -X。staircase 預設沿著目前面向，所以挖之前可以先轉向（或直接給它 direction 參數）；dig forward 也是挖面前那一格。',
        mode: 'blocking', timeoutMs: 10000,
        params: {
            direction: { type: 'string', required: true, enum: ['north', 'south', 'east', 'west', 'up', 'down'], description: '要面向的方位' },
        },
        positional: ['direction'],
    },
    follow: {
        profile: 'commander',
        description: '持續跟隨玩家，直到下達 stop。',
        mode: 'continuous', timeoutMs: 10000,
        params: {
            target: { type: 'string', required: false, kind: 'free', description: '玩家名，預設指揮官' },
        },
        positional: ['target'],
    },
    wander: {
        profile: 'extended',
        description: '朝隨機方向探索 10~20 格。',
        mode: 'continuous', timeoutMs: 10000,
        params: {},
        positional: [],
    },
    dive: {
        profile: 'extended',
        description: '開啟潛水模式（允許待在水裡）。',
        mode: 'continuous', timeoutMs: 10000,
        params: {},
        positional: [],
    },
    surface: {
        profile: 'core',
        description: '回到地表／脫困：在水裡會自己算出最近的岸（和水面同高、上方開放的實心地面）游過去爬上岸；封閉的水洞或被埋在地底（洞穴、隧道、井）找不到出口時，會往上挖階梯出去（需要鎬子）。氧氣不足會先去找氣室換氣。最多約 100 秒，沒成功會說明原因。往正上方只想升高幾格請用 pillar。',
        mode: 'blocking', timeoutMs: 110000,
        params: {},
        positional: [],
    },
    stop: {
        profile: 'core',
        description: '中止目前所有移動與任務，回到待機。',
        mode: 'blocking', timeoutMs: 10000,
        params: {},
        positional: [],
    },
    wait: {
        profile: 'core',
        description: '原地等待。',
        mode: 'blocking', timeoutMs: 30000,
        params: {
            ms: { type: 'number', required: false, description: '毫秒，預設 1000，上限 20000' },
        },
        positional: ['ms'],
    },
    look: {
        profile: 'commander',
        description: '轉頭看向指揮官。',
        mode: 'blocking', timeoutMs: 10000,
        params: {},
        positional: [],
    },
    jump: {
        profile: 'extended',
        description: '跳一下。',
        mode: 'blocking', timeoutMs: 10000,
        params: {},
        positional: [],
    },
    use_block: {
        profile: 'core',
        description: '對指定座標的方塊按右鍵：開關門、活板門、柵欄門，扳拉桿、按按鈕。結果會說明它從開著變成關著（或相反）。木門可以徒手開，鐵門不行。離太遠會自己走近。蓋房子時用它開門進出、晚上關門擋怪物。門本身用 place_block 放（oak_door 之類，放下面那一格，會自己長出上半）。',
        mode: 'blocking', timeoutMs: 20000,
        params: {
            x: { type: 'number', required: true, description: '方塊 X 座標' },
            y: { type: 'number', required: true, description: '方塊 Y 座標（門的上下兩格任選一格）' },
            z: { type: 'number', required: true, description: '方塊 Z 座標' },
        },
        positional: ['x', 'y', 'z'],
    },
    equip: {
        profile: 'core',
        description: '把背包裡的物品拿到手上。',
        mode: 'blocking', timeoutMs: 15000,
        params: {
            name: { type: 'string', required: true, kind: 'free', description: '物品英文名' },
        },
        positional: ['name'],
    },
    eat: {
        profile: 'core',
        description: '吃背包裡的食物。',
        mode: 'blocking', timeoutMs: 20000,
        params: {
            name: { type: 'string', required: true, kind: 'free', description: '食物英文名，例如 bread、cooked_beef' },
        },
        positional: ['name'],
    },
    pickup_items: {
        profile: 'core',
        description: '走過去撿起附近地上的掉落物（挖礦、殺怪、砍樹之後散落的東西）。',
        mode: 'blocking', timeoutMs: 60000,
        params: {
            radius: { type: 'number', required: false, description: '搜尋半徑，預設 12，上限 32' },
            name:   { type: 'string', required: false, kind: 'free', description: '只撿名稱包含這個字串的物品，例如 raw_iron；不填就全撿' },
        },
        positional: ['name', 'radius'],
    },
    drop: {
        profile: 'commander',
        description: '走向指揮官並把物品丟給他。',
        mode: 'blocking', timeoutMs: 60000,
        params: {
            name: { type: 'string', required: true, kind: 'free', description: '物品英文名，或 all 丟出全部' },
        },
        positional: ['name'],
    },
    // 由 executor 直接處理，不經 Action Router
    say: {
        profile: 'commander',
        description: '在遊戲聊天欄說一句話。',
        mode: 'blocking', timeoutMs: 5000, local: true,
        params: {
            message: { type: 'string', required: true, kind: 'free', description: '要說的話' },
        },
        positional: ['message'],
    },
};

// 檔案 → 包含哪些群組
const PROFILE_GROUPS = {
    core: ['core'],
    extended: ['core', 'extended'],
    commander: ['core', 'commander'],
    all: ['core', 'extended', 'commander', 'internal'],
};
const DEFAULT_PROFILE = 'core';

function actionsInProfile(profile) {
    const groups = PROFILE_GROUPS[profile] || PROFILE_GROUPS[DEFAULT_PROFILE];
    return Object.entries(ACTIONS).filter(([, def]) => groups.includes(def.profile || 'core')).map(([name]) => name);
}

// 名稱標準化：小寫、空白與連字號轉底線
function normalizeName(value) {
    return String(value).trim().toLowerCase().replace(/[\s\-]+/g, '_');
}

function editDistance(a, b) {
    const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        let diag = prev[0];
        prev[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const tmp = prev[j];
            prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
            diag = tmp;
        }
    }
    return prev[b.length];
}

// 回傳最像 name 的候選（子字串與詞彙重疊優先，其次編輯距離 ≤ 2），最多 limit 個
function suggestNames(name, candidates, limit = 3) {
    const tokens = name.split('_').filter(t => t.length >= 3);
    const scored = [];
    for (const c of candidates) {
        let score = 0;
        if (c.includes(name) || name.includes(c)) score += 3;
        for (const t of tokens) if (c.includes(t)) score += 1;
        if (score > 0) scored.push([score, c]);
    }
    if (scored.length === 0) {
        for (const c of candidates) {
            const d = editDistance(name, c);
            if (d <= 2) scored.push([3 - d, c]);
        }
    }
    scored.sort((a, b) => b[0] - a[0] || a[1].length - b[1].length);
    return scored.slice(0, limit).map(s => s[1]);
}

function checkKnownName(kind, value, mcData) {
    if (!mcData) return null;
    if (kind === 'item') {
        if (mcData.itemsByName[value]) return null;
        const hint = suggestNames(value, Object.keys(mcData.itemsByName));
        return `不存在的物品 '${value}'` + (hint.length ? `，你是不是要找：${hint.join(', ')}` : '');
    }
    if (kind === 'block') {
        if (mcData.blocksByName[value]) return null;
        const names = Object.keys(mcData.blocksByName);
        if (names.some(n => n.includes(value))) return null;
        const hint = suggestNames(value, names);
        return `不存在的方塊 '${value}'` + (hint.length ? `，你是不是要找：${hint.join(', ')}` : '');
    }
    if (kind === 'entity') {
        if (mcData.entitiesByName[value]) return null;
        const names = Object.keys(mcData.entitiesByName);
        if (names.some(n => n.includes(value))) return null;
        const hint = suggestNames(value, names);
        return `不存在的生物 '${value}'` + (hint.length ? `，你是不是要找：${hint.join(', ')}` : '');
    }
    return null;
}

/**
 * 驗證並標準化一個動作。
 * @returns {{ok:true, action:object} | {ok:false, error:string}}
 */
function validateAction(raw, mcData, profile = DEFAULT_PROFILE) {
    if (!raw || typeof raw !== 'object' || typeof raw.type !== 'string') {
        return { ok: false, error: "動作必須是含有 'type' 欄位的物件" };
    }
    const type = raw.type.trim().toLowerCase();
    const def = ACTIONS[type];
    const visible = actionsInProfile(profile);
    if (!def || !visible.includes(type)) {
        const hint = suggestNames(type, visible);
        const hidden = def ? `動作 '${raw.type}' 不在目前的動作集（${profile}）裡` : `未知動作 '${raw.type}'`;
        return { ok: false, error: hidden + (hint.length ? `，你是不是要用：${hint.join(', ')}` : '，可用動作請查 GET /actions') };
    }

    const action = { type };
    for (const [field, spec] of Object.entries(def.params)) {
        let value = raw[field];
        if (value === undefined || value === null || value === '') {
            if (spec.required) return { ok: false, error: `${type} 缺少必要參數 '${field}'` };
            continue;
        }
        if (spec.type === 'number') {
            const n = typeof value === 'number' ? value : Number(value);
            if (!Number.isFinite(n)) return { ok: false, error: `${type}.${field} 必須是數字，收到 ${JSON.stringify(value)}` };
            value = n;
        } else {
            if (typeof value !== 'string') value = String(value);
            if (spec.kind && spec.kind !== 'free') value = normalizeName(value);
            else if (spec.enum) value = value.trim().toLowerCase();
            else value = value.trim();
        }
        if (spec.enum && !spec.enum.includes(value)) {
            return { ok: false, error: `${type}.${field} 必須是 ${spec.enum.join(' / ')} 其中之一，收到 '${value}'` };
        }
        if (spec.kind && spec.kind !== 'free') {
            const err = checkKnownName(spec.kind, value, mcData);
            if (err) return { ok: false, error: `${type}.${field}：${err}` };
        }
        action[field] = value;
    }

    if (type === 'wait' && typeof action.ms === 'number') action.ms = Math.min(Math.max(action.ms, 0), 20000);
    return { ok: true, action };
}

/**
 * 把位置參數轉成動作物件（測試旁路用）。以 '_' 開頭的位置會被忽略。
 * 回傳 null 表示不是已知動作。
 */
function buildFromPositional(typeRaw, args) {
    const type = String(typeRaw).toLowerCase();
    const def = ACTIONS[type];
    if (!def || def.local) return null;
    const action = { type, ...(def.bypassDefaults || {}) };
    def.positional.forEach((field, i) => {
        const value = args[i];
        if (field.startsWith('_') || value === undefined) return;
        const spec = def.params[field];
        if (spec && spec.type === 'number') {
            const n = parseInt(value, 10);
            if (Number.isFinite(n)) action[field] = n;
        } else {
            action[field] = value;
        }
    });
    return action;
}

function listActions(profile = DEFAULT_PROFILE) {
    const visible = new Set(actionsInProfile(profile));
    return Object.entries(ACTIONS).filter(([name]) => visible.has(name)).map(([name, def]) => ({
        name,
        description: def.description,
        mode: def.mode,
        timeoutMs: def.timeoutMs,
        params: Object.fromEntries(Object.entries(def.params).map(([field, spec]) => [field, {
            type: spec.type,
            required: !!spec.required,
            ...(spec.enum ? { enum: spec.enum } : {}),
            description: spec.description,
        }])),
    }));
}

module.exports = { ACTIONS, PROFILE_GROUPS, DEFAULT_PROFILE, actionsInProfile, validateAction, buildFromPositional, listActions, normalizeName, suggestNames };
