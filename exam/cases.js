// ════════════════════════════════════════════════════════
//  exam/cases.js — 題庫
//
//  每題：
//    setup(X)    布置場景（考場已由 run.js 重整過，這裡只擺這題需要的東西）
//    act         要送給 ECHO 的動作；需要多步驟時改用 run(X)，回傳最後一次 ActionResult
//    judge(X, r) 以伺服器端真相回傳檢查項 [{name, pass, detail}]；全部通過 = 目標達成
//    expectAchieved  預期目標是否應該達成（預設 true；負面題填 false）
//
//  座標用 X.at(dx, dz) 取絕對 x/z，站立高度是 X.standY（草地頂面 + 1）。
// ════════════════════════════════════════════════════════
'use strict';

const chk = (name, pass, detail) => ({ name, pass: !!pass, detail: detail === undefined ? '' : String(detail) });
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

async function buildOakTree(X, dx, dz) {
    const F = X.floorY;
    const a = X.at(dx, dz);
    await X.fill(a.x - 2, F + 4, a.z - 2, a.x + 2, F + 5, a.z + 2, 'oak_leaves[persistent=true] keep');
    await X.fill(a.x - 1, F + 6, a.z - 1, a.x + 1, F + 6, a.z + 1, 'oak_leaves[persistent=true] keep');
    await X.fill(a.x, F + 1, a.z, a.x, F + 5, a.z, 'oak_log');
    return a;
}

// attack 現在是「下令後身體自己打、立刻回報 started」：要等 attack_ended 事件才算打完
async function attackAndWait(X, target, maxMs = 80000) {
    const since = (await X.echo.health()).latestEventId;
    const r = await X.echo.act({ type: 'attack', target }, 20000);
    const t0 = Date.now();
    let ended = null;
    while (Date.now() - t0 < maxMs && !ended) {
        await X.sleep(1000);
        ended = (await X.echo.events(since)).events.find(e => e.type === 'attack_ended') || null;
    }
    return { ...r, ended, ok: r.ok && !!ended && ended.outcome === 'killed' };
}
const cases = [
    // ───────────── 第 1 階段：採集與合成 ─────────────
    {
        id: 'gather_log', phase: 1, title: '伐木：一棵 5 格高的橡樹',
        timeoutMs: 120000,
        async setup(X) {
            this.tree = await buildOakTree(X, 4, 0);
            await X.tpEcho(0, 0, 4, 0);
        },
        act: { type: 'gather', target: 'oak_log' },
        async judge(X) {
            const logs = await X.ex.count('oak_log');
            const base = await X.ex.blockIs(this.tree.x, X.floorY + 1, this.tree.z, 'oak_log');
            return [
                chk('背包有橡木原木 ≥ 4（樹共 5 格）', logs >= 4, `實際 ${logs}`),
                chk('樹根方塊已消失', !base),
                chk('地上沒有遺留的掉落物（撿乾淨）', (await X.ex.entCount('@e[type=item,distance=..40]')) === 0),
            ];
        },
    },
    {
        id: 'gather_coal_ore', phase: 1, title: '挖礦：2x2x2 煤礦堆（木鎬）',
        timeoutMs: 120000,
        async setup(X) {
            const a = X.at(5, 0);
            this.pile = a;
            await X.fill(a.x, X.floorY + 1, a.z, a.x + 1, X.floorY + 2, a.z + 1, 'coal_ore');
            await X.give('wooden_pickaxe', 1);
            await X.tpEcho(0, 0, 5, 0);
        },
        act: { type: 'gather', target: 'coal_ore' },
        async judge(X) {
            const coal = await X.ex.count('coal');
            const scan = await X.ex.scan(this.pile.x, X.floorY + 1, this.pile.z, this.pile.x + 1, X.floorY + 2, this.pile.z + 1);
            const left = scan.counts.coal_ore || 0;
            return [
                chk('背包煤炭 = 8（每塊礦的掉落物都撿到）', coal === 8, `實際 ${coal}`),
                chk('煤礦堆方塊減少', left < 8, `剩 ${left}/8`),
                chk('地上沒有遺留的掉落物（撿乾淨）', (await X.ex.entCount('@e[type=item,distance=..40]')) === 0),
            ];
        },
    },
    {
        id: 'gather_iron_picks_best_tool', phase: 1, title: '挖鐵礦：背包有木鎬（排前面）和石鎬，必須用石鎬',
        timeoutMs: 120000,
        async setup(X) {
            const a = X.at(5, 0);
            this.pile = a;
            await X.fill(a.x, X.floorY + 1, a.z, a.x + 1, X.floorY + 1, a.z + 1, 'iron_ore');
            await X.give('wooden_pickaxe', 1);   // 先給木鎬，讓它排在背包前面（這是當初的 bug 條件）
            await X.give('stone_pickaxe', 1);
            await X.tpEcho(0, 0, 5, 0);
        },
        act: { type: 'gather', target: 'iron_ore' },
        async judge(X) {
            const raw = await X.ex.count('raw_iron');
            return [
                chk('背包有粗鐵 = 4（4 塊鐵礦都有掉落且撿到）', raw === 4, `實際 ${raw}`),
                chk('地上沒有遺留的掉落物（撿乾淨）', (await X.ex.entCount('@e[type=item,distance=..40]')) === 0),
            ];
        },
    },
    {
        id: 'gather_iron_wrong_tier_refused', phase: 1, title: '負面題：只有木鎬時挖鐵礦必須拒絕，不可以白白挖掉礦',
        expectAchieved: false, timeoutMs: 60000,
        async setup(X) {
            const a = X.at(5, 0);
            this.pile = a;
            await X.fill(a.x, X.floorY + 1, a.z, a.x + 1, X.floorY + 1, a.z + 1, 'iron_ore');
            await X.give('wooden_pickaxe', 1);
            await X.tpEcho(0, 0, 5, 0);
        },
        act: { type: 'gather', target: 'iron_ore' },
        async judge(X) {
            const raw = await X.ex.count('raw_iron');
            return [chk('背包有粗鐵（不應該有）', raw >= 1, `實際 ${raw}`)];
        },
        async invariants(X, r) {
            const scan = await X.ex.scan(this.pile.x, X.floorY + 1, this.pile.z, this.pile.x + 1, X.floorY + 1, this.pile.z + 1);
            const left = scan.counts.iron_ore || 0;
            return [
                chk('鐵礦一塊都沒被浪費', left === 4, `剩 ${left}/4`),
                chk('訊息說明需要什麼工具', /stone_pickaxe|iron_pickaxe|石鎬/.test(r.message || ''), r.message),
            ];
        },
    },
    {
        id: 'pickup_items', phase: 1, title: '撿東西：地上 3 個粗鐵、2 個煤炭',
        timeoutMs: 60000,
        async setup(X) {
            const a = X.at(6, 2), b = X.at(-5, -4);
            await X.cmd(`summon minecraft:item ${a.x + 0.5} ${X.floorY + 1} ${a.z + 0.5} {Item:{id:"minecraft:raw_iron",count:3}}`);
            await X.cmd(`summon minecraft:item ${b.x + 0.5} ${X.floorY + 1} ${b.z + 0.5} {Item:{id:"minecraft:coal",count:2}}`);
            await X.sleep(500);
        },
        act: { type: 'pickup_items', radius: 12 },
        async judge(X) {
            const raw = await X.ex.count('raw_iron');
            const coal = await X.ex.count('coal');
            return [
                chk('粗鐵 = 3', raw === 3, `實際 ${raw}`),
                chk('煤炭 = 2', coal === 2, `實際 ${coal}`),
            ];
        },
    },
    {
        id: 'pickup_nothing_nearby', phase: 1, title: '負面題：附近沒有掉落物，必須誠實回報',
        expectAchieved: false, timeoutMs: 30000,
        async setup() {},
        act: { type: 'pickup_items', radius: 12 },
        async judge(X) {
            const total = Object.values(await X.ex.inventory()).reduce((s, n) => s + n, 0);
            return [chk('背包出現東西（不應該有）', total > 0, `共 ${total} 個`)];
        },
    },
    {
        id: 'craft_planks', phase: 1, title: '合成：1 原木 → 木板',
        timeoutMs: 30000,
        async setup(X) { await X.give('oak_log', 1); },
        act: { type: 'craft', name: 'oak_planks' },
        async judge(X) {
            const planks = await X.ex.count('oak_planks');
            const logs = await X.ex.count('oak_log');
            return [
                chk('背包有木板 ≥ 4', planks >= 4, `實際 ${planks}`),
                chk('原木減少為 0', logs === 0, `實際 ${logs}`),
            ];
        },
    },
    {
        id: 'craft_pickaxe_auto_table', phase: 1, title: '合成：木鎬（需自動做工作台並回收）',
        timeoutMs: 60000,
        async setup(X) {
            await X.give('oak_planks', 8);
            await X.give('stick', 2);
        },
        act: { type: 'craft', name: 'wooden_pickaxe' },
        async judge(X, r) {
            const pick = await X.ex.count('wooden_pickaxe');
            const planks = await X.ex.count('oak_planks');
            const around = await X.ex.scan(X.arena.cx - 8, X.floorY + 1, X.arena.cz - 8, X.arena.cx + 8, X.floorY + 3, X.arena.cz + 8);
            return [
                chk('背包有木鎬 = 1', pick === 1, `實際 ${pick}`),
                chk('木板減少', planks < 8, `剩 ${planks}/8`),
                chk('場上沒有遺留的工作台', !(around.counts.crafting_table > 0), `場上 ${around.counts.crafting_table || 0} 個`),
                chk('工作台真的回到背包（掉在地上不算回收）', (await X.ex.count('crafting_table')) === 1, `背包 ${await X.ex.count('crafting_table')} 個`),
                chk('訊息與實際一致：說「回收進背包」', /回收進背包/.test(r.message || ''), r.message),
            ];
        },
    },
    {
        id: 'craft_missing_materials', phase: 1, title: '負面題：材料不足不可成功',
        expectAchieved: false, timeoutMs: 30000,
        async setup(X) { await X.give('oak_planks', 1); },
        act: { type: 'craft', name: 'wooden_pickaxe' },
        async judge(X) {
            const pick = await X.ex.count('wooden_pickaxe');
            return [chk('背包有木鎬（不應該有）', pick >= 1, `實際 ${pick}`)];
        },
        async invariants(X) {
            const planks = await X.ex.count('oak_planks');
            return [chk('木板未被消耗', planks === 1, `實際 ${planks}`)];
        },
    },
    {
        id: 'reject_hallucinated_item', phase: 1, title: '負面題：不存在的物品必須被拒絕',
        expectAchieved: false, expectRejected: true, timeoutMs: 10000,
        async setup(X) { await X.give('oak_planks', 4); },
        act: { type: 'craft', name: 'copper_sword' },
        async judge(X) {
            return [chk('背包出現銅劍（不應該有）', (await X.ex.count('copper_sword')) >= 1)];
        },
        async invariants(X) {
            const planks = await X.ex.count('oak_planks');
            return [chk('木板未被消耗', planks === 4, `實際 ${planks}`)];
        },
    },
    {
        id: 'smelt_raw_iron', phase: 1, title: '冶煉：2 個粗鐵（附熔爐與燃料）',
        timeoutMs: 200000,
        async setup(X) {
            await X.give('raw_iron', 2);
            await X.give('coal', 2);
            await X.give('furnace', 1);
        },
        act: { type: 'smelt', name: 'raw_iron' },
        async judge(X) {
            const ingot = await X.ex.count('iron_ingot');
            const raw = await X.ex.count('raw_iron');
            const coal = await X.ex.count('coal');
            const furnaceInWorld = (await X.ex.scan(X.arena.cx - 8, X.floorY + 1, X.arena.cz - 8, X.arena.cx + 8, X.floorY + 3, X.arena.cz + 8)).counts.furnace || 0;
            return [
                chk('背包鐵錠 = 2（整疊燒完）', ingot === 2, `實際 ${ingot}`),
                chk('粗鐵全部用掉', raw === 0, `剩 ${raw}`),
                chk('只用了 1 個煤（2 個原料用不到 2 個）', coal === 1, `剩 ${coal}/2`),
                chk('熔爐已回收（場上沒有）', furnaceInWorld === 0, `場上 ${furnaceInWorld}`),
            ];
        },
    },
    {
        id: 'store_chest', phase: 1, title: '存入：3 鑽石 → 箱子',
        timeoutMs: 60000,
        async setup(X) {
            this.chest = X.at(2, 0);
            await X.setblock(this.chest.x, X.floorY + 1, this.chest.z, 'chest[facing=west]');
            await X.give('diamond', 3);
            await X.tpEcho(0, 0, 2, 0);
        },
        act: { type: 'store', name: 'diamond' },
        async judge(X) {
            const inChest = (await X.ex.chestItems(this.chest.x, X.floorY + 1, this.chest.z)).diamond || 0;
            const onHand = await X.ex.count('diamond');
            return [
                chk('箱子裡有鑽石 = 3', inChest === 3, `實際 ${inChest}`),
                chk('背包鑽石 = 0', onHand === 0, `實際 ${onHand}`),
            ];
        },
    },
    {
        id: 'fetch_chest', phase: 1, title: '取出：箱子 5 鐵錠，取 3',
        timeoutMs: 60000,
        async setup(X) {
            this.chest = X.at(2, 0);
            await X.setblock(this.chest.x, X.floorY + 1, this.chest.z,
                'chest[facing=west]{Items:[{Slot:0b,id:"minecraft:iron_ingot",count:5}]}');
            await X.tpEcho(0, 0, 2, 0);
        },
        act: { type: 'fetch', name: 'iron_ingot', count: 3 },
        async judge(X) {
            const onHand = await X.ex.count('iron_ingot');
            const inChest = (await X.ex.chestItems(this.chest.x, X.floorY + 1, this.chest.z)).iron_ingot || 0;
            return [
                chk('背包鐵錠 = 3', onHand === 3, `實際 ${onHand}`),
                chk('箱子鐵錠 = 2', inChest === 2, `實際 ${inChest}`),
            ];
        },
    },

    // ───────────── 第 2 階段：建造、移動、戰鬥 ─────────────
    {
        id: 'place_torch_open_ground', phase: 2, title: '插火把：空地（前方有牆、兩側沒有）',
        timeoutMs: 30000,
        async setup(X) {
            const a = X.at(1, -1);
            await X.fill(a.x, X.floorY + 1, a.z, a.x, X.floorY + 3, a.z + 2, 'stone');
            await X.give('torch', 4);
            await X.tpEcho(0, 0, 1, 0);
        },
        act: { type: 'place_torch' },
        async judge(X) {
            const a = X.arena;
            const scan = await X.ex.scan(a.cx - 4, X.floorY + 1, a.cz - 4, a.cx + 4, X.floorY + 4, a.cz + 4);
            const torches = (scan.counts.torch || 0) + (scan.counts.wall_torch || 0);
            const held = await X.ex.count('torch');
            return [
                chk('場上有火把 ≥ 1', torches >= 1, `實際 ${torches}`),
                chk('背包火把 = 3', held === 3, `實際 ${held}`),
            ];
        },
    },
    {
        id: 'place_torch_tunnel', phase: 2, title: '插火把：隧道（兩側都有牆，插壁龕）',
        timeoutMs: 30000,
        async setup(X) {
            const a = X.at(-1, -1);
            await X.fill(a.x, X.floorY + 1, a.z, a.x + 4, X.floorY + 3, a.z, 'stone');
            await X.fill(a.x, X.floorY + 1, a.z + 2, a.x + 4, X.floorY + 3, a.z + 2, 'stone');
            await X.give('torch', 4);
            await X.tpEcho(0, 0, 4, 0);
        },
        act: { type: 'place_torch' },
        async judge(X) {
            const a = X.arena;
            const scan = await X.ex.scan(a.cx - 4, X.floorY + 1, a.cz - 4, a.cx + 6, X.floorY + 4, a.cz + 4);
            const torches = (scan.counts.torch || 0) + (scan.counts.wall_torch || 0);
            const held = await X.ex.count('torch');
            return [
                chk('場上有火把 ≥ 1', torches >= 1, `實際 ${torches}`),
                chk('背包火把 = 3', held === 3, `實際 ${held}`),
            ];
        },
    },
    {
        id: 'pillar_3', phase: 2, title: '墊高：3 格',
        timeoutMs: 60000,
        async setup(X) { await X.give('dirt', 10); },
        act: { type: 'pillar', height: 3 },
        async judge(X) {
            const p = await X.ex.pos(X.echoName);
            const col = await X.ex.scan(Math.floor(p.x), X.floorY + 1, Math.floor(p.z), Math.floor(p.x), X.floorY + 3, Math.floor(p.z));
            const solid = Object.values(col.counts).reduce((s, n) => s + n, 0);
            return [
                chk('高度 ≥ 地面+3.5', p.y >= X.floorY + 3.5, `Y=${p.y}`),
                chk('腳下柱子 ≥ 2 格實心', solid >= 2, `實心 ${solid}`),
            ];
        },
    },
    {
        id: 'dig_down', phase: 2, title: '挖掘：腳下一格',
        timeoutMs: 30000,
        async setup(X) { this.spot = X.at(0, 0); },
        act: { type: 'dig', direction: 'down' },
        async judge(X) {
            const stillGrass = await X.ex.blockIs(this.spot.x, X.floorY, this.spot.z, 'grass_block');
            return [chk('腳下的草地方塊已被挖掉', !stillGrass)];
        },
    },
    {
        id: 'approach_master', phase: 2, title: '走近：指揮官（Examiner）在 12 格外',
        timeoutMs: 60000,
        async setup(X) { await X.tpExaminer(12, 0); },
        async run(X) { return X.echo.act({ type: 'approach', target: X.examinerName }, 60000); },
        async judge(X) {
            const e = await X.ex.pos(X.echoName);
            const m = await X.ex.pos(X.examinerName);
            const d = dist3(e, m);
            return [chk('與指揮官距離 ≤ 3.5', d <= 3.5, `距離 ${d.toFixed(1)}`)];
        },
    },
    {
        id: 'follow_then_stop', phase: 2, needsMaster: true, skipClaim: true, title: '跟隨：指揮官移動 15 格後仍保持距離，stop 後不再移動',
        timeoutMs: 40000,
        async run(X) {
            await X.tpExaminer(3, 0);
            const started = await X.echo.act({ type: 'follow' }, 15000);
            this.started = started;
            await X.tpExaminer(15, 0);
            await X.sleep(10000);
            this.distFollow = dist3(await X.ex.pos(X.echoName), await X.ex.pos(X.examinerName));
            const stopped = await X.echo.act({ type: 'stop' }, 15000);
            await X.tpExaminer(-15, 0);
            const before = await X.ex.pos(X.echoName);
            await X.sleep(4000);
            const after = await X.ex.pos(X.echoName);
            this.driftAfterStop = dist3(before, after);
            return started.ok ? stopped : started;
        },
        async judge(X) {
            return [
                chk('follow 啟動成功', this.started && this.started.ok, this.started && this.started.reason),
                chk('指揮官移動 15 格 10 秒後距離 ≤ 5', this.distFollow <= 5, `距離 ${this.distFollow.toFixed(1)}`),
                chk('stop 後 4 秒內位移 < 1', this.driftAfterStop < 1, `位移 ${this.driftAfterStop.toFixed(1)}`),
            ];
        },
    },
    {
        id: 'attack_cow', phase: 2, title: '攻擊：一隻牛（鐵劍）',
        timeoutMs: 60000,
        async setup(X) {
            await X.give('iron_sword', 1);
            await X.summon('cow', 6, 0);
        },
        async run(X) { return attackAndWait(X, 'cow'); },
        async judge(X) {
            const left = await X.ex.entCount('@e[type=cow,distance=..40]');
            return [chk('場上牛的數量 = 0', left === 0, `剩 ${left}`)];
        },
    },
    {
        id: 'attack_zombie', phase: 2, difficulty: 'normal', title: '攻擊：一隻殭屍（夜晚，鐵劍）',
        timeoutMs: 90000,
        async setup(X) {
            await X.cmd('time set midnight');
            await X.give('iron_sword', 1);
            await X.summon('zombie', 7, 0);
        },
        async run(X) { return attackAndWait(X, 'zombie'); },
        async judge(X) {
            const left = await X.ex.entCount('@e[type=zombie,distance=..40]');
            const hp = await X.ex.scalar(X.echoName, 'Health');
            return [
                chk('場上殭屍數量 = 0', left === 0, `剩 ${left}`),
                chk('ECHO 還活著', hp > 0, `HP ${hp}`),
            ];
        },
    },
    {
        id: 'wander_then_stop', phase: 2, skipClaim: true, title: '中斷：wander 後 stop，位置必須穩定',
        timeoutMs: 30000,
        async run(X) {
            const w = await X.echo.act({ type: 'wander' }, 10000);
            this.wander = w;
            await X.sleep(3000);
            const s = await X.echo.act({ type: 'stop' }, 10000);
            await X.sleep(500);
            const p1 = await X.ex.pos(X.echoName);
            await X.sleep(2000);
            const p2 = await X.ex.pos(X.echoName);
            this.drift = dist3(p1, p2);
            return s;
        },
        async judge(X) {
            return [
                chk('wander 已啟動', this.wander && this.wander.ok, this.wander && this.wander.reason),
                chk('stop 後 2 秒位移 < 0.5', this.drift < 0.5, `位移 ${this.drift.toFixed(2)}`),
            ];
        },
    },

    // ───────────── 第 3 階段：挖礦與反射層 ─────────────
    {
        id: 'staircase_5', phase: 3, title: '階梯下礦：向下 5 層（石鎬）',
        timeoutMs: 150000,
        async setup(X) { await X.give('stone_pickaxe', 1); },
        act: { type: 'staircase', steps: 5 },
        async judge(X) {
            const p = await X.ex.pos(X.echoName);
            const target = X.floorY + 1 - 5;
            return [chk('已下降 ≥ 4 層', p.y <= X.floorY + 1 - 4 + 0.5, `Y=${p.y}（起點 ${X.floorY + 1}，目標 ${target}）`)];
        },
    },
    {
        id: 'auto_eat', phase: 3, difficulty: 'normal', skipClaim: true, title: '反射：飽食度低於 15 自動吃麵包',
        timeoutMs: 60000,
        async run(X) {
            await X.give('bread', 5);
            const since = (await X.echo.health()).latestEventId;
            await X.cmd(`effect give ${X.echoName} minecraft:hunger 30 120 true`);
            let food = 20;
            for (let i = 0; i < 20 && food >= 15; i++) { await X.sleep(1000); food = await X.ex.scalar(X.echoName, 'foodLevel'); }
            this.minFood = food;
            await X.sleep(5000);
            await X.cmd(`effect clear ${X.echoName} minecraft:hunger`);
            this.breadLeft = await X.ex.count('bread');
            this.events = (await X.echo.events(since)).events.map(e => e.type);
            return { id: null, ok: this.events.includes('ate'), status: 'done', reason: null, message: 'reflex' };
        },
        async judge(X) {
            return [
                chk('飽食度確實降到 < 15（場景成立）', this.minFood < 15, `最低 ${this.minFood}`),
                chk('收到 ate 事件', this.events.includes('ate'), this.events.join(',')),
                chk('麵包減少', this.breadLeft < 5, `剩 ${this.breadLeft}/5`),
            ];
        },
    },
];

// ───────────── 第 4 階段：水、方向、座標導航（玩家實測發現的問題）─────────────
async function buildPool(X) {
    const a = X.at(3, -1);
    await X.fill(a.x, X.floorY - 3, a.z, a.x + 2, X.floorY, a.z + 2, 'water');   // 3x3、4 格深（含地面那層）
    await X.sleep(500);
}

cases.push(
    {
        id: 'water_can_sink', phase: 4, skipClaim: true, title: '水：掉進 4 格深的水池後必須能沉下去，不能被釘在水面',
        timeoutMs: 30000,
        async run(X) {
            await buildPool(X);
            await X.tpEcho(4, 0, 4, 5);              // 站在水池正上方，會掉進水裡
            const r = await X.echo.act({ type: 'wait', ms: 6000 }, 20000);
            this.y = (await X.ex.pos(X.echoName)).y;
            return r;
        },
        async judge(X) {
            return [chk('6 秒後已沉到池底附近（Y ≤ 地面 -1.5）', this.y <= X.floorY - 1.5, `Y=${this.y.toFixed(1)}（地面 ${X.floorY}）`)];
        },
    },
    {
        id: 'water_low_air_surfaces', phase: 4, skipClaim: true, title: '水：沉在水底氧氣快用完時，必須自己游上來換氣，不能淹死',
        timeoutMs: 60000,
        async run(X) {
            await buildPool(X);
            await X.tpEcho(4, 0, 4, 5);
            const since = (await X.echo.health()).latestEventId;
            const acting = X.echo.act({ type: 'wait', ms: 20000 }, 30000);   // 水下待 20 秒，超過氧氣上限（約 15 秒）
            // 同時每秒取樣高度：先沉下去，氧氣快用完時應該會浮到水面
            const samples = [];
            for (let i = 0; i < 21; i++) { await X.sleep(1000); samples.push((await X.ex.pos(X.echoName)).y); }
            const r = await acting;
            this.samples = samples;
            this.minY = Math.min(...samples);
            this.maxYLate = Math.max(...samples.slice(8));          // 8 秒之後的最高點
            this.hp = await X.ex.scalar(X.echoName, 'Health');
            this.events = (await X.echo.events(since)).events.map(e => e.type);
            this.warnings = r.warnings || [];
            return r;
        },
        async judge(X) {
            return [
                chk('先沉到池底附近（曾經 Y ≤ 地面 -1.5）', this.minY <= X.floorY - 1.5, `最低 Y=${this.minY.toFixed(1)}`),
                chk('氧氣快用完時浮上水面（8 秒後曾經 Y ≥ 地面 -0.7）', this.maxYLate >= X.floorY - 0.7, `8 秒後最高 Y=${this.maxYLate.toFixed(1)}`),
                chk('血量仍是滿的（沒有被淹到）', this.hp >= 19.5, `HP ${this.hp}`),
                chk('收到 low_oxygen 事件', this.events.includes('low_oxygen'), this.events.join(',')),
                chk('動作結果的 warnings 帶有 reflex:low_oxygen', this.warnings.includes('reflex:low_oxygen'), this.warnings.join(',')),
            ];
        },
    },
    {
        id: 'dig_down_in_water_explains', phase: 4, title: '負面題：腳下是水時 dig down 必須立刻說明「目標是水」，不能空轉',
        expectAchieved: false, timeoutMs: 40000,
        async setup(X) {
            await buildPool(X);
            await X.tpEcho(4, 0, 4, 5);              // 掉進水池，還浮在水面附近、腳下仍是水
        },
        act: { type: 'dig', direction: 'down' },
        async judge(X) {
            return [chk('池底的方塊被挖掉了（不應該）', await X.ex.blockIs(X.arena.cx + 4, X.floorY - 4, X.arena.cz, 'air'))];
        },
        async invariants(X, r) {
            return [
                chk('5 秒內就回報（沒有空轉到逾時）', (r.durationMs || 99999) < 5000, `${r.durationMs}ms`),
                chk('原因是 target_is_liquid', r.reason === 'target_is_liquid', r.reason),
                chk('訊息說明是水／液體', /水|液體/.test(r.message || ''), r.message),
            ];
        },
    },
    {
        id: 'surface_from_flooded_stair', phase: 4, title: '脫困：在一條被水淹滿的 6 層階梯底部，下 surface 必須能自己出來',
        timeoutMs: 100000,
        async setup(X) {
            // 階梯往南、每格往下 1：以 (0, k) 為第 k 格、地板高度 F-k，頭上留 2 格空間，全部灌水；左右與下方是原本的泥土／石頭
            const F = X.floorY;
            for (let k = 0; k <= 6; k++) {
                const a = X.at(0, k);
                await X.fill(a.x, F - k, a.z, a.x, F - k + 2, a.z, 'water');
            }
            await X.fill(X.at(0, 7).x, F - 6, X.at(0, 7).z, X.at(0, 7).x, F - 4, X.at(0, 7).z, 'stone');   // 底部封住
            await X.give('stone_pickaxe', 1);
            await X.give('dirt', 16);
            // 把 ECHO 放進最底下那格
            const b = X.at(0, 6);
            await X.cmd(`tp ${X.echoName} ${b.x + 0.5} ${F - 6} ${b.z + 0.5} 180 0`);
            await X.sleep(1500);
        },
        act: { type: 'surface' },
        async judge(X) {
            const p = await X.ex.pos(X.echoName);
            const hp = await X.ex.scalar(X.echoName, 'Health');
            return [
                chk('已回到地面附近（Y ≥ 地面 -0.5）', p.y >= X.floorY - 0.5, `Y=${p.y.toFixed(1)}`),
                chk('沒有淹死、血量仍有 ≥ 10', hp >= 10, `HP ${hp}`),
            ];
        },
    },
    {
        id: 'surface_big_lake_to_shore', phase: 4, title: '脫困：在 15x15、6 格深的大水池正中央，下 surface 必須自己找岸、游過去、爬上岸',
        timeoutMs: 100000,
        async setup(X) {
            const F = X.floorY, a = X.at(4, -7);
            await X.fill(a.x, F - 5, a.z, a.x + 14, F, a.z + 14, 'water');     // 15x15，6 格深（含地面那層），岸邊就是同高度的草地
            await X.give('stone_pickaxe', 1);
            const c = X.at(11, 0);
            await X.cmd(`tp ${X.echoName} ${c.x + 0.5} ${F - 3} ${c.z + 0.5} 0 0`);   // 直接傳到水池中間、水面下 3 格
            await X.sleep(1500);
        },
        act: { type: 'surface' },
        async judge(X, r) {
            const p = await X.ex.pos(X.echoName);
            const hp = await X.ex.scalar(X.echoName, 'Health');
            const o = await X.echo.observe();
            return [
                chk('已經站在岸上（不在水裡）', !o.self.inWater, `inWater=${o.self.inWater}`),
                chk('高度回到地面（Y ≥ 地面 +0.5）', p.y >= X.floorY + 0.5, `Y=${p.y.toFixed(1)}`),
                chk('血量仍是滿的', hp >= 19.5, `HP ${hp}`),
                chk('耗時 < 60 秒', (r.durationMs || 99999) < 60000, `${r.durationMs}ms`),
            ];
        },
    },
    {
        id: 'surface_sealed_cave_digs_up', phase: 4, title: '脫困：被石頭完全封住的水穴（頭上 5 格岩層），下 surface 必須自己往上挖出去',
        timeoutMs: 100000,
        async setup(X) {
            const F = X.floorY, a = X.at(-6, -6);
            // 4x4x3 的水穴，在地底 F-7..F-5；上面還有 F-4..F 共 5 格（石頭、泥土、草地）
            await X.fill(a.x, F - 7, a.z, a.x + 3, F - 5, a.z + 3, 'water');
            await X.give('stone_pickaxe', 1);
            await X.cmd(`tp ${X.echoName} ${a.x + 1.5} ${F - 6} ${a.z + 1.5} 0 0`);
            await X.sleep(1500);
        },
        act: { type: 'surface' },
        async judge(X, r) {
            const p = await X.ex.pos(X.echoName);
            const hp = await X.ex.scalar(X.echoName, 'Health');
            const o = await X.echo.observe();
            return [
                chk('已經回到地面（Y ≥ 地面 +0.5）', p.y >= X.floorY + 0.5, `Y=${p.y.toFixed(1)}`),
                chk('不在水裡', !o.self.inWater, `inWater=${o.self.inWater}`),
                chk('沒有淹死、血量 ≥ 15', hp >= 15, `HP ${hp}`),
            ];
        },
    },
    {
        id: 'water_auto_escape_when_idle', phase: 4, skipClaim: true, title: '自動脫困：掉進大水池後什麼指令都不下，泡水太久必須自己上岸，並發出事件',
        timeoutMs: 120000,
        async run(X) {
            const F = X.floorY, a = X.at(4, -7);
            await X.fill(a.x, F - 5, a.z, a.x + 14, F, a.z + 14, 'water');
            const since = (await X.echo.health()).latestEventId;
            const c = X.at(11, 0);
            await X.cmd(`tp ${X.echoName} ${c.x + 0.5} ${F - 3} ${c.z + 0.5} 0 0`);
            // 不下任何指令，最多等 100 秒，上岸就提前結束
            let out = false;
            for (let i = 0; i < 50 && !out; i++) { await X.sleep(2000); out = !(await X.echo.observe()).self.inWater; }
            this.out = out;
            this.events = (await X.echo.events(since)).events.map(e => e.type);
            return { ok: out, status: 'done', reason: null, message: 'auto' };
        },
        async judge(X) {
            const p = await X.ex.pos(X.echoName);
            return [
                chk('沒有任何指令，自己上岸了', this.out, this.events.join(',')),
                chk('收到 water_trapped 事件', this.events.includes('water_trapped'), this.events.join(',')),
                chk('收到 auto_escape_started 事件', this.events.includes('auto_escape_started'), this.events.join(',')),
                chk('人在地面高度', p.y >= X.floorY + 0.5, `Y=${p.y.toFixed(1)}`),
            ];
        },
    },
    {
        id: 'staircase_direction_south', phase: 4, title: '階梯下礦：direction=south 必須真的往南挖（ECHO 面向東時）',
        timeoutMs: 100000,
        async setup(X) {
            await X.give('stone_pickaxe', 1);
            await X.tpEcho(0, 0, 5, 0);              // 面向東，方向要由 direction 參數決定
        },
        act: { type: 'staircase', steps: 4, direction: 'south' },
        async judge(X) {
            const p = await X.ex.pos(X.echoName);
            const dz = p.z - (X.arena.cz + 0.5), dx = p.x - (X.arena.cx + 0.5);
            return [
                chk('往南（+Z）移動 ≥ 3 格', dz >= 3, `dz=${dz.toFixed(1)}`),
                chk('東西方向幾乎沒偏移（|dx| ≤ 1）', Math.abs(dx) <= 1, `dx=${dx.toFixed(1)}`),
                chk('已下降 ≥ 3 層', p.y <= X.floorY + 1 - 3 + 0.5, `Y=${p.y.toFixed(1)}`),
            ];
        },
    },
    {
        id: 'staircase_direction_north', phase: 4, title: '階梯下礦：direction=north 必須真的往北挖（ECHO 面向南時）',
        timeoutMs: 100000,
        async setup(X) {
            await X.give('stone_pickaxe', 1);
            await X.tpEcho(0, 0, 0, 5);              // 面向南
        },
        act: { type: 'staircase', steps: 4, direction: 'north' },
        async judge(X) {
            const p = await X.ex.pos(X.echoName);
            const dz = p.z - (X.arena.cz + 0.5);
            return [chk('往北（-Z）移動 ≥ 3 格', dz <= -3, `dz=${dz.toFixed(1)}`)];
        },
    },
    {
        id: 'staircase_stops_before_water', phase: 4, title: '階梯下礦：前方有水時必須停下來說明，不能一路挖進去被淹',
        expectAchieved: false, timeoutMs: 100000,
        async setup(X) {
            const a = X.at(-1, 3);
            await X.fill(a.x, X.floorY - 5, a.z, a.x + 2, X.floorY, a.z + 1, 'water');
            await X.give('stone_pickaxe', 1);
            await X.tpEcho(0, 0, 0, 5);
        },
        act: { type: 'staircase', steps: 6, direction: 'south' },
        async judge(X) {
            const p = await X.ex.pos(X.echoName);
            return [chk('已下降 6 層（不應該到，前方是水）', p.y <= X.floorY + 1 - 6 + 0.5, `Y=${p.y.toFixed(1)}`)];
        },
        async invariants(X, r) {
            const hp = await X.ex.scalar(X.echoName, 'Health');
            return [
                chk('回報不是成功', r.ok === false, `ok=${r.ok}`),
                chk('訊息提到水', /水/.test(r.message || ''), r.message),
                chk('沒有被淹到、血量滿', hp >= 19.5, `HP ${hp}`),
                chk('停下來沒有空轉太久', (r.durationMs || 0) < 60000, `${r.durationMs}ms`),
            ];
        },
    },
    {
        id: 'goto_coordinates', phase: 4, title: 'goto：走到 (10, 地面+1, 8)',
        timeoutMs: 100000,
        async setup() {},
        async run(X) {
            const t = X.at(10, 8);
            return X.echo.act({ type: 'goto', x: t.x, y: X.standY, z: t.z, range: 1 }, 100000);
        },
        async judge(X) {
            const p = await X.ex.pos(X.echoName);
            const t = X.at(10, 8);
            const d = Math.hypot(p.x - (t.x + 0.5), p.z - (t.z + 0.5));
            return [chk('離目標 ≤ 2 格', d <= 2, `距離 ${d.toFixed(1)}`)];
        },
    },
    {
        id: 'goto_unreachable_explains', phase: 4, title: '負面題：goto 到被石頭完全封住的位置，必須失敗並說明走不到',
        expectAchieved: false, timeoutMs: 100000,
        async setup(X) {
            const a = X.at(12, 12);
            await X.fill(a.x, X.floorY + 1, a.z, a.x + 4, X.floorY + 5, a.z + 4, 'stone');
        },
        async run(X) {
            const t = X.at(14, 14);
            return X.echo.act({ type: 'goto', x: t.x, y: X.floorY + 3, z: t.z, range: 0 }, 100000);
        },
        async judge(X) {
            const p = await X.ex.pos(X.echoName);
            const t = X.at(14, 14);
            const d = Math.hypot(p.x - (t.x + 0.5), p.z - (t.z + 0.5));
            return [chk('已到達被封住的目標（不應該）', d <= 1.5, `距離 ${d.toFixed(1)}`)];
        },
        async invariants(X, r) {
            return [
                chk('回報失敗', r.ok === false, `ok=${r.ok}`),
                chk('訊息說明走不到', /走不到|找不到可以走|路/.test(r.message || ''), r.message),
            ];
        },
    },
    {
        id: 'face_south', phase: 4, title: 'face：轉向南方',
        timeoutMs: 15000,
        async setup(X) { await X.tpEcho(0, 0, 5, 0); },     // 先面向東
        act: { type: 'face', direction: 'south' },
        async judge(X) {
            const o = await X.echo.observe();
            return [chk('obs 顯示面向 south', o.self.facing === 'south', o.self.facing)];
        },
    },
);

// ───────────── 第 5 階段：玩家觀察到的行為問題（疊方塊亂跳、隔樹葉砍樹、火把習慣）─────────────
cases.push(
    {
        id: 'pillar_one_hop_per_block', phase: 5, title: '墊高：每個方塊應該一跳就疊上去（起跳次數不超過方塊數 +1）',
        timeoutMs: 40000,
        async setup(X) { await X.give('dirt', 10); },
        act: { type: 'pillar', height: 4 },
        async judge(X, r) {
            const p = await X.ex.pos(X.echoName);
            const m = /起跳 (\d+) 次，放了 (\d+) 個/.exec(r.message || '');
            const jumps = m ? parseInt(m[1], 10) : null, placed = m ? parseInt(m[2], 10) : null;
            return [
                chk('高度 ≥ 地面+4.5', p.y >= X.floorY + 4.5, `Y=${p.y.toFixed(1)}`),
                chk('訊息有起跳與放置次數', m !== null, r.message),
                chk('放了 4 個方塊', placed === 4, `放了 ${placed}`),
                chk('起跳次數 ≤ 方塊數 +1（不亂跳）', jumps !== null && jumps <= 5, `起跳 ${jumps} 次`),
                chk('耗時 < 10 秒', (r.durationMs || 99999) < 10000, `${r.durationMs}ms`),
            ];
        },
    },
    {
        id: 'gather_log_clears_leaves_first', phase: 5, title: '伐木：樹幹被樹葉整圈包住時，必須先清掉擋住的樹葉，不能隔著樹葉砍',
        timeoutMs: 120000,
        async setup(X) {
            const F = X.floorY, a = X.at(4, 0);
            await X.fill(a.x, F + 1, a.z, a.x, F + 4, a.z, 'oak_log');                                       // 4 格樹幹
            await X.fill(a.x - 1, F + 1, a.z - 1, a.x + 1, F + 3, a.z + 1, 'oak_leaves[persistent=true] keep'); // 底下 3 層被樹葉整圈包住
            await X.fill(a.x - 2, F + 4, a.z - 2, a.x + 2, F + 5, a.z + 2, 'oak_leaves[persistent=true] keep');
            this.leavesBefore = (await X.ex.scan(a.x - 1, F + 1, a.z - 1, a.x + 1, F + 3, a.z + 1)).counts.oak_leaves || 0;
            this.a = a;
            await X.tpEcho(0, 0, 4, 0);
        },
        act: { type: 'gather', target: 'oak_log' },
        async judge(X) {
            const F = X.floorY, a = this.a;
            const logs = await X.ex.count('oak_log');
            const leavesAfter = (await X.ex.scan(a.x - 1, F + 1, a.z - 1, a.x + 1, F + 3, a.z + 1)).counts.oak_leaves || 0;
            return [
                chk('背包有原木 ≥ 3', logs >= 3, `實際 ${logs}`),
                chk('包住樹幹的樹葉有被清掉（不是隔著樹葉砍）', leavesAfter < this.leavesBefore, `樹葉 ${this.leavesBefore} → ${leavesAfter}`),
            ];
        },
    },
    {
        id: 'torch_light_level_reported', phase: 5, title: '光照與火把：obs 要回報光照與火把數量；全黑的封閉空間是 0；插了火把之後 torchNearby 要變成 true',
        timeoutMs: 30000,
        async setup(X) {
            const F = X.floorY, a = X.at(-8, -8);
            this.room = a;
            await X.fill(a.x - 1, F + 1, a.z - 1, a.x + 3, F + 4, a.z + 3, 'stone');                // 實心石頭
            await X.fill(a.x, F + 1, a.z, a.x + 2, F + 2, a.z + 2, 'air');                          // 3x3x2 的封閉小房間
            await X.give('torch', 4);
            await X.cmd(`tp ${X.echoName} ${a.x + 1.5} ${F + 1} ${a.z + 1.5} 0 0`);
            await X.sleep(2500);
        },
        async run(X) {
            const dark = (await X.echo.observe()).self;
            this.darkLight = dark.lightLevel;
            this.torches = dark.torchesInInventory;
            const r = await X.echo.act({ type: 'place_torch' }, 30000);
            await X.sleep(1500);
            const lit = (await X.echo.observe()).self;
            this.litLight = lit.lightLevel;
            this.torchNearby = lit.torchNearby;
            const around = await X.ex.scan(this.room.x - 1, X.floorY + 1, this.room.z - 1, this.room.x + 3, X.floorY + 4, this.room.z + 3);
            this.torchBlocks = (around.counts.torch || 0) + (around.counts.wall_torch || 0);
            return r;
        },
        async judge(X) {
            return [
                chk('obs 回報了光照數字', typeof this.darkLight === 'number', this.darkLight),
                chk('封閉小房間光照 = 0', this.darkLight === 0, this.darkLight),
                chk('obs 回報背包火把數量 = 4', this.torches === 4, this.torches),
                chk('插火把後場上真的有火把方塊', this.torchBlocks >= 1, `實際 ${this.torchBlocks}`),
                chk('obs 的 torchNearby 變成 true（光照數字客戶端可能還是舊的，不當依據）', this.torchNearby === true, `torchNearby=${this.torchNearby}（光照讀數 ${this.litLight}）`),
            ];
        },
    },
);

cases.push(
    {
        id: 'tool_frugality_cheap_block', phase: 5, title: '省工具：背包有鐵鎬和石鎬時，挖普通石頭必須用石鎬，鐵鎬一點耐久都不能用',
        timeoutMs: 100000,
        async setup(X) {
            await X.give('iron_pickaxe', 1);     // 鐵鎬排前面（以前就是它被拿去挖了 100 層石頭而壞掉）
            await X.give('stone_pickaxe', 1);
            await X.tpEcho(0, 0, 0, 5);
        },
        act: { type: 'staircase', steps: 3, direction: 'south' },
        async judge(X) {
            const dmg = async (item) => {
                try { return await X.ex.scalar(X.echoName, `Inventory[{id:"minecraft:${item}"}].components."minecraft:damage"`); }
                catch (_) { return 0; }                    // 沒有 damage 元件 = 完全沒用過
            };
            const iron = await dmg('iron_pickaxe'), stone = await dmg('stone_pickaxe');
            return [
                chk('鐵鎬一點耐久都沒用（省著用）', iron === 0, `鐵鎬 damage=${iron}`),
                chk('石鎬有被用到', stone > 0, `石鎬 damage=${stone}`),
            ];
        },
    },
);

// ───────────── 第 6 階段：第四輪玩家回報的問題（放置、工作台、封閉的礦、掉落物、工具控制）─────────────
cases.push(
    {
        id: 'place_block_agent_builds_wall', phase: 6, skipClaim: true,
        title: 'place_block：由 agent 自己決定 6 個座標，一個一個放出 3x2 的牆（取代寫死形狀的 build）',
        timeoutMs: 120000,
        async setup(X) {
            await X.give('cobblestone', 20);
            await X.tpEcho(4, 0, 8, 0);
        },
        async run(X) {
            const results = [];
            for (let j = 0; j < 2; j++) for (let i = 0; i < 3; i++) {
                const t = X.at(6, -1 + i);
                results.push(await X.echo.act({ type: 'place_block', block: 'cobblestone', x: t.x, y: X.floorY + 1 + j, z: t.z }, 30000));
            }
            this.results = results;
            return results[results.length - 1];
        },
        async judge(X) {
            const blocks = [];
            for (let j = 0; j < 2; j++) for (let i = 0; i < 3; i++) {
                const t = X.at(6, -1 + i);
                blocks.push(await X.ex.blockIs(t.x, X.floorY + 1 + j, t.z, 'cobblestone'));
            }
            const held = await X.ex.count('cobblestone');
            return [
                chk('6 次 place_block 都回報成功', this.results.every(r => r.ok), this.results.map(r => r.ok ? 'ok' : r.reason).join(',')),
                chk('6 個座標上都真的是鵝卵石', blocks.every(Boolean), blocks.join(',')),
                chk('背包減少 6 個', 20 - held === 6, `背包 ${held}`),
            ];
        },
    },
    {
        id: 'place_block_occupied_explains', phase: 6, title: '負面題：要放的那一格已經有方塊，必須說明是什麼方塊、該怎麼辦',
        expectAchieved: false, timeoutMs: 30000,
        async setup(X) { await X.give('cobblestone', 4); },
        async run(X) { const t = X.at(1, 0); this.t = t; return X.echo.act({ type: 'place_block', block: 'cobblestone', x: t.x, y: X.floorY, z: t.z }, 20000); },
        async judge(X) { return [chk('地面那格變成鵝卵石（不應該）', await X.ex.blockIs(this.t.x, X.floorY, this.t.z, 'cobblestone'))]; },
        async invariants(X, r) {
            return [
                chk('回報失敗', r.ok === false, `ok=${r.ok}`),
                chk('訊息說出那格是 grass_block 並提示 break_block', /grass_block/.test(r.message || '') && /break_block|挖掉/.test(r.message || ''), r.message),
                chk('背包沒有被扣', (await X.ex.count('cobblestone')) === 4),
            ];
        },
    },
    {
        id: 'place_block_floating_explains', phase: 6, title: '負面題：要放在半空中、周圍沒有任何方塊可以靠，必須說明是懸空',
        expectAchieved: false, timeoutMs: 30000,
        async setup(X) { await X.give('cobblestone', 4); },
        async run(X) { const t = X.at(6, 0); this.t = t; return X.echo.act({ type: 'place_block', block: 'cobblestone', x: t.x, y: X.floorY + 9, z: t.z }, 20000); },
        async judge(X) { return [chk('半空中出現了方塊（不應該）', await X.ex.blockIs(this.t.x, X.floorY + 9, this.t.z, 'cobblestone'))]; },
        async invariants(X, r) {
            return [
                chk('回報失敗', r.ok === false, `ok=${r.ok}`),
                chk('訊息說明是懸空／沒有可以靠的方塊', /懸空|沒有實心方塊/.test(r.message || ''), r.message),
            ];
        },
    },
    {
        id: 'craft_table_in_sealed_pocket', phase: 6, title: '合成：被關在 1 格寬的岩石小洞裡，旁邊完全沒空位，必須自己挖開牆放工作台、合成、再把工作台撿回來',
        timeoutMs: 100000,
        async setup(X) {
            const F = X.floorY, a = X.at(-12, -3);
            await X.fill(a.x, F + 1, a.z, a.x + 4, F + 5, a.z + 4, 'stone');
            await X.fill(a.x + 2, F + 1, a.z + 2, a.x + 2, F + 2, a.z + 2, 'air');           // 只有 1x1x2 的小洞
            await X.give('stone_pickaxe', 1);                                                  // 用來挖開旁邊的牆
            await X.give('oak_planks', 8);
            await X.give('stick', 2);
            await X.cmd(`tp ${X.echoName} ${a.x + 2.5} ${F + 1} ${a.z + 2.5} 0 0`);
            await X.sleep(1500);
        },
        act: { type: 'craft', name: 'wooden_pickaxe' },
        async judge(X, r) {
            const pick = await X.ex.count('wooden_pickaxe');
            const tables = await X.ex.count('crafting_table');
            return [
                chk('合成出木鎬', pick === 1, `木鎬 ${pick}`),
                chk('工作台真的回到背包', tables === 1, `背包工作台 ${tables}`),
                chk('訊息與實際一致（回收進背包）', /回收進背包/.test(r.message || ''), r.message),
            ];
        },
    },
    {
        id: 'craft_count_planks', phase: 6, title: '合成：count=16 要一次做出 16 個木板（4 次），不用每次呼叫只做 4 個',
        timeoutMs: 40000,
        async setup(X) { await X.give('oak_log', 4); },
        act: { type: 'craft', name: 'oak_planks', count: 16 },
        async judge(X) {
            const planks = await X.ex.count('oak_planks');
            const logs = await X.ex.count('oak_log');
            return [chk('木板 = 16', planks === 16, `實際 ${planks}`), chk('原木用掉 4 個', logs === 0, `剩 ${logs}`)];
        },
    },
    {
        id: 'tunnel_to_sealed_ore', phase: 6, title: 'tunnel_to：礦藏在 11 格外的岩石深處，必須自己挖通道過去、把礦挖掉並撿起掉落物',
        timeoutMs: 110000,
        async setup(X) {
            const F = X.floorY, a = X.at(2, -2);
            await X.fill(a.x, F + 1, a.z, a.x + 11, F + 4, a.z + 4, 'stone');                // 12x4x5 的石頭
            this.ore = X.at(11, 0);
            await X.setblock(this.ore.x, F + 2, this.ore.z, 'iron_ore');
            await X.give('stone_pickaxe', 1);
            await X.tpEcho(0, 0, 11, 0);
        },
        act: null,
        async run(X) {
            const o = this.ore;
            return X.echo.act({ type: 'tunnel_to', x: o.x, y: X.floorY + 2, z: o.z }, 110000);
        },
        async judge(X) {
            const p = await X.ex.pos(X.echoName);
            const d = Math.hypot(p.x - (this.ore.x + 0.5), p.z - (this.ore.z + 0.5), p.y - (X.floorY + 2));
            const raw = await X.ex.count('raw_iron');
            return [
                chk('人到了礦的位置（≤ 1.6 格）', d <= 1.6, `距離 ${d.toFixed(1)}`),
                chk('礦被挖掉並撿起（粗鐵 = 1）', raw === 1, `粗鐵 ${raw}`),
                chk('地上沒有遺留的掉落物', (await X.ex.entCount('@e[type=item,distance=..40]')) === 0),
            ];
        },
    },
    {
        id: 'gather_sealed_ore_tunnels', phase: 6, title: 'gather：礦藏在岩石裡走不過去時，必須自己挖通道過去，不能一句「沒有挖到任何礦」就放棄',
        timeoutMs: 110000,
        async setup(X) {
            const F = X.floorY, a = X.at(2, -2);
            await X.fill(a.x, F + 1, a.z, a.x + 7, F + 4, a.z + 4, 'stone');
            const o = X.at(8, 0);
            await X.setblock(o.x, F + 2, o.z, 'iron_ore');
            await X.give('stone_pickaxe', 1);
            await X.tpEcho(0, 0, 8, 0);
        },
        act: { type: 'gather', target: 'iron_ore' },
        async judge(X) {
            const raw = await X.ex.count('raw_iron');
            return [chk('背包有粗鐵 ≥ 1', raw >= 1, `粗鐵 ${raw}`)];
        },
    },
    {
        id: 'pickup_sealed_item_explains', phase: 6, title: '負面題：掉落物在被岩石完全包住的空洞裡，必須說明座標與「被岩石完全包住」，不能只說走不到',
        expectAchieved: false, timeoutMs: 60000,
        async setup(X) {
            const F = X.floorY, a = X.at(4, -2);
            await X.fill(a.x, F + 1, a.z, a.x + 4, F + 5, a.z + 4, 'stone');
            this.cell = { x: a.x + 2, y: F + 3, z: a.z + 2 };
            await X.setblock(this.cell.x, this.cell.y, this.cell.z, 'air');
            await X.cmd(`summon minecraft:item ${this.cell.x + 0.5} ${this.cell.y + 0.2} ${this.cell.z + 0.5} {Item:{id:"minecraft:raw_iron",count:3},NoGravity:1b}`);
            await X.sleep(500);
            await X.tpEcho(1, 0, 4, 0);
        },
        act: { type: 'pickup_items', radius: 8 },
        async judge(X) { return [chk('背包有粗鐵（不應該）', (await X.ex.count('raw_iron')) >= 1)]; },
        async invariants(X, r) {
            const c = this.cell;
            return [
                chk('回報失敗', r.ok === false, `ok=${r.ok}`),
                chk('訊息有掉落物座標', new RegExp(`${c.x},${c.y},${c.z}`).test(r.message || ''), r.message),
                chk('訊息說「被岩石完全包住」', /被岩石完全包住/.test(r.message || ''), r.message),
            ];
        },
    },
    {
        id: 'tool_param_respected', phase: 6, title: '指定工具：tool=iron_pickaxe 時必須真的用鐵鎬（不指定時會省著用石鎬，兩者都要能控制）',
        timeoutMs: 100000,
        async setup(X) {
            await X.give('stone_pickaxe', 1);
            await X.give('iron_pickaxe', 1);
            await X.tpEcho(0, 0, 0, 5);
        },
        act: { type: 'staircase', steps: 3, direction: 'south', tool: 'iron_pickaxe' },
        async judge(X) {
            const dmg = async (item) => {
                try { return await X.ex.scalar(X.echoName, `Inventory[{id:"minecraft:${item}"}].components."minecraft:damage"`); }
                catch (_) { return 0; }                    // 沒有 damage 元件 = 完全沒用過
            };
            const iron = await dmg('iron_pickaxe'), stone = await dmg('stone_pickaxe');
            return [
                chk('鐵鎬有耐久損耗（照指定用了鐵鎬）', iron > 0, `鐵鎬 damage=${iron}`),
                chk('石鎬沒被用到', stone === 0, `石鎬 damage=${stone}`),
            ];
        },
    },
);

// ════════════════════════════════════════════════════════
//  階段 7：staircase 在「開闊洞穴」（玩家第 5 輪記錄的故障：腳下是空的，動作卻說礫石／水）
//  地形：考場地面正下方挖出一個封閉的洞穴（草地當屋頂、四周石頭），ECHO 站在洞穴北邊的草地上往南 staircase
//  buildCave：洞穴 x∈[-2,2]、z∈[1,8]，空氣層 y∈[F-depth, F-1]，洞底是 bottomBlock（在 F-depth-1）
// ════════════════════════════════════════════════════════
async function buildCave(X, depth, bottomBlock, lavaLayer) {
    const F = X.floorY;
    const a = X.at(-2, 1), b = X.at(2, 8);
    await X.fill(a.x - 1, F - depth - 1, a.z - 1, b.x + 1, F - 1, b.z + 1, 'stone');           // 實心外殼
    await X.fill(a.x, F - depth, a.z, b.x, F - 1, b.z, 'air');                                  // 挖空洞穴
    if (bottomBlock !== 'stone') await X.fill(a.x, F - depth - 1, a.z, b.x, F - depth - 1, b.z, bottomBlock);
    if (lavaLayer) await X.fill(a.x, F - depth, a.z, b.x, F - depth, b.z, 'lava');             // 洞底再鋪一層岩漿
}

cases.push(
    {
        id: 'staircase_open_cave_shallow', phase: 7, title: '階梯下礦：腳下是淺洞穴（落差 2 格）時要走下去，不能原地打轉',
        timeoutMs: 100000,
        async setup(X) {
            await buildCave(X, 2, 'stone', false);
            await X.give('stone_pickaxe', 1);
            await X.tpEcho(0, 0, 0, 5);
        },
        async run(X) { return X.echo.act({ type: 'staircase', targetY: X.floorY - 2, direction: 'south' }, 100000); },
        async judge(X) {
            const p = await X.ex.pos(X.echoName);
            const hp = await X.ex.scalar(X.echoName, 'Health');
            return [
                // 主要判斷：真的到洞底（深度）、沒受傷（血量）；水平位移只當輔助資訊，不列入通過條件
                chk('人已經在洞穴底（Y ≤ 地面-2）', p.y <= X.floorY - 2 + 0.5, `Y=${p.y.toFixed(1)}（輔助：往南 dz=${(p.z - (X.arena.cz + 0.5)).toFixed(1)}）`),
                chk('沒有摔傷（血量 ≥ 19）', hp >= 19, `HP ${hp}`),
            ];
        },
    },
    {
        id: 'staircase_open_cave_deep_honest', phase: 7, title: '階梯下礦：腳下是深洞穴（落差 11 格）時不能亂跳，要停下來說出「空洞太深」而不是礫石／水',
        expectAchieved: false, timeoutMs: 100000,
        async setup(X) {
            await buildCave(X, 10, 'stone', false);
            await X.give('stone_pickaxe', 1);
            await X.tpEcho(0, 0, 0, 5);
        },
        async run(X) { return X.echo.act({ type: 'staircase', targetY: X.floorY - 9, direction: 'south' }, 100000); },
        async judge(X) {
            const p = await X.ex.pos(X.echoName);
            return [chk('已經下到洞穴裡（不應該到，落差太大）', p.y <= X.floorY - 9 + 0.5, `Y=${p.y.toFixed(1)}`)];
        },
        async invariants(X, r) {
            const hp = await X.ex.scalar(X.echoName, 'Health');
            return [
                chk('回報不是成功', r.ok === false, `ok=${r.ok}`),
                chk('訊息說出是空洞／落差', /空洞|落差|深/.test(r.message || ''), r.message),
                chk('訊息沒有亂猜礫石／沙子／被水淹', !/礫石|沙子|被水淹/.test(r.message || ''), r.message),
                chk('沒有摔傷（血量滿）', hp >= 19.5, `HP ${hp}`),
                chk('停下來沒有空轉太久', (r.durationMs || 0) < 60000, `${r.durationMs}ms`),
            ];
        },
    },
    {
        id: 'staircase_open_cave_lava_floor', phase: 7, title: '階梯下礦：淺洞穴的洞底是岩漿時不能走下去，要停下來說明是岩漿',
        expectAchieved: false, timeoutMs: 100000,
        async setup(X) {
            await buildCave(X, 3, 'stone', true);
            await X.give('stone_pickaxe', 1);
            await X.tpEcho(0, 0, 0, 5);
        },
        async run(X) { return X.echo.act({ type: 'staircase', targetY: X.floorY - 3, direction: 'south' }, 100000); },
        async judge(X) {
            const p = await X.ex.pos(X.echoName);
            return [chk('已經下到洞穴底（不應該到，底下是岩漿）', p.y <= X.floorY - 3 + 0.5, `Y=${p.y.toFixed(1)}`)];
        },
        async invariants(X, r) {
            const hp = await X.ex.scalar(X.echoName, 'Health');
            return [
                chk('回報不是成功', r.ok === false, `ok=${r.ok}`),
                chk('訊息提到岩漿', /岩漿/.test(r.message || ''), r.message),
                chk('沒有被燒到（血量滿）', hp >= 19.5, `HP ${hp}`),
            ];
        },
    },
);

// ════════════════════════════════════════════════════════
//  階段 8：gather（玩家第 5 輪記錄的故障：深處的鑽石，移動 49 格、鵝卵石 -40，卻只說「沒有挖到任何 deepslate_diamond_ore」）
//  地形：考場地面下方一大塊實心石頭，礦藏在又深又遠的岩石裡
// ════════════════════════════════════════════════════════
async function buildRockMass(X, ore) {
    const F = X.floorY;
    const a = X.at(-6, 4), b = X.at(14, 30);
    await X.fill(a.x, F - 20, a.z, b.x, F - 1, b.z, 'stone');            // 實心石頭（草地被它蓋掉的是 F-1 以下，地面 F 維持草地）
    const o = X.at(ore.dx, ore.dz);
    await X.setblock(o.x, F + ore.dy, o.z, ore.block);
    return { x: o.x, y: F + ore.dy, z: o.z };
}

cases.push(
    {
        id: 'gather_deep_far_ore', phase: 8, title: '採集：礦在又深又遠的岩石裡（約 30 格遠、深 14 格），要挖通道過去拿到，不能只說「沒挖到」',
        timeoutMs: 330000,
        async setup(X) {
            this.ore = await buildRockMass(X, { dx: 8, dz: 22, dy: -14, block: 'deepslate_diamond_ore' });
            await X.give('iron_pickaxe', 1);
            await X.give('torch', 8);
            await X.tpEcho(0, 0, 0, 5);
        },
        // 單次動作做不完時，訊息會說「再呼叫一次就會從目前位置繼續」，所以像玩家一樣最多呼叫 3 次
        async run(X) {
            let r = null;
            for (let i = 0; i < 3; i++) {
                r = await X.echo.act({ type: 'gather', target: 'diamond_ore', tool: 'iron_pickaxe' }, 110000);
                if (r.ok) break;
                if (!/再呼叫一次|時間到|上限/.test(r.message || '')) break;      // 不是「還沒做完」的失敗就不重試
            }
            return r;
        },
        async judge(X) {
            const dia = await X.ex.count('diamond');
            const stillThere = await X.ex.blockIs(this.ore.x, this.ore.y, this.ore.z, 'deepslate_diamond_ore');
            return [
                chk('伺服器背包有鑽石', dia >= 1, `diamond=${dia}`),
                chk('礦方塊已經消失', !stillThere, stillThere ? '還在' : '已消失'),
            ];
        },
    },
);

cases.push(
    {
        id: 'gather_count_limit', phase: 8, title: '採集：count=3 時石頭只能挖 3 個，不能一口氣挖 15 個；訊息要說已達上限',
        timeoutMs: 100000,
        async setup(X) {
            const a = X.at(2, 2);
            await X.fill(a.x, X.floorY + 1, a.z, a.x + 3, X.floorY + 3, a.z + 3, 'stone');      // 4x3x4 = 48 塊石頭，遠多於 15
            await X.give('stone_pickaxe', 1);
            await X.tpEcho(0, 0, 3, 3);
        },
        act: { type: 'gather', target: 'stone', count: 3 },
        async judge(X, r) {
            // pathfinder 可能自己放掉幾個方塊墊腳（結果的 pathfinderPlaced 會說明），那些要加回來才是「挖到的數量」
            const cobble = await X.ex.count('cobblestone');
            const placed = r.pathfinderPlaced || 0;
            return [chk('挖到的鵝卵石剛好 3 個（背包 + pathfinder 放掉的）', cobble + placed === 3, `背包 ${cobble} + pathfinder 放掉 ${placed}`)];
        },
        async invariants(X, r) {
            return [
                chk('回報成功', r.ok === true, `ok=${r.ok}`),
                chk('訊息說已達上限 3 個', /上限 3/.test(r.message || ''), r.message),
            ];
        },
    },
    {
        id: 'gather_sealed_ore_honest', phase: 8, title: '採集：礦被基岩完全封住（挖不開）時，要回報失敗並說出目標座標、人在哪、通道為什麼沒成功',
        expectAchieved: false, timeoutMs: 100000,
        async setup(X) {
            const F = X.floorY;
            const o = X.at(0, 8);
            await X.fill(o.x - 2, F - 5, o.z - 2, o.x + 2, F - 1, o.z + 2, 'bedrock');           // 基岩外殼
            await X.setblock(o.x, F - 3, o.z, 'diamond_ore');
            await X.fill(o.x, F - 4, o.z, o.x, F - 2, o.z, 'bedrock');                           // 上下都封死
            await X.setblock(o.x, F - 3, o.z, 'diamond_ore');
            this.ore = { x: o.x, y: F - 3, z: o.z };
            await X.give('iron_pickaxe', 1);
            await X.tpEcho(0, 0, 0, 5);
        },
        act: { type: 'gather', target: 'diamond_ore', tool: 'iron_pickaxe' },
        async judge(X) {
            const dia = await X.ex.count('diamond');
            return [chk('伺服器背包有鑽石（不應該有，被基岩封死）', dia >= 1, `diamond=${dia}`)];
        },
        async invariants(X, r) {
            const m = r.message || '';
            const o = this.ore;
            return [
                chk('回報不是成功', r.ok === false, `ok=${r.ok}`),
                chk('訊息有目標座標', new RegExp(`${o.x},${o.y},${o.z}`).test(m), m),
                chk('訊息有說通道／走不過去的結果', /通道|走不過去/.test(m), m),
                chk('不只是一句「沒有挖到」（訊息夠長、有過程）', m.length > 80, `長度 ${m.length}`),
            ];
        },
    },
);

// ════════════════════════════════════════════════════════
//  階段 9：craft 材料不足（玩家第 6 輪：缺 1 塊木板，花 9.7 秒放工作台才失敗，訊息只說「配方不存在或材料不足」）
// ════════════════════════════════════════════════════════
cases.push(
    {
        id: 'craft_missing_materials_explains', phase: 9, title: '合成：木板只有 2 塊就想做木鎬，必須馬上失敗、說出缺什麼，而且不能先去放工作台',
        expectAchieved: false, timeoutMs: 60000,
        async setup(X) {
            await X.give('oak_planks', 2);
            await X.give('stick', 2);
            await X.tpEcho(0, 0, 0, 5);
        },
        act: { type: 'craft', name: 'wooden_pickaxe' },
        async judge(X) {
            const pick = await X.ex.count('wooden_pickaxe');
            return [chk('背包有木鎬（不應該有，材料不夠）', pick >= 1, `wooden_pickaxe=${pick}`)];
        },
        async invariants(X, r) {
            const m = r.message || '';
            const planks = await X.ex.count('oak_planks');
            const table = await X.ex.count('crafting_table');
            return [
                chk('回報不是成功', r.ok === false, `ok=${r.ok}`),
                chk('訊息說出缺 oak_planks×1', /材料不足/.test(m) && /oak_planks×1/.test(m), m),
                chk('馬上失敗（< 5 秒，沒有先去放工作台）', (r.durationMs || 0) < 5000, `${r.durationMs}ms`),
                chk('原料沒有被扣（木板還是 2）', planks === 2, `oak_planks=${planks}`),
                chk('背包沒有多出工作台', table === 0, `crafting_table=${table}`),
            ];
        },
    },
);

cases.push(
    {
        id: 'gather_log_count_2', phase: 8, title: '伐木：count=2 時一棵 5 格高的樹只能砍 2 根，樹上要留下其餘的',
        timeoutMs: 120000,
        async setup(X) {
            this.tree = await buildOakTree(X, 4, 0);
            await X.tpEcho(0, 0, 4, 0);
        },
        act: { type: 'gather', target: 'oak_log', count: 2 },
        async judge(X) {
            const logs = await X.ex.count('oak_log');
            const base = await X.ex.blockIs(this.tree.x, X.floorY + 1, this.tree.z, 'oak_log');
            const top = await X.ex.blockIs(this.tree.x, X.floorY + 5, this.tree.z, 'oak_log');
            return [
                chk('背包剛好 2 根橡木原木', logs === 2, `實際 ${logs}`),
                chk('樹根已被砍掉', !base),
                chk('樹頂那根還在（沒有整棵砍光）', top),
            ];
        },
        async invariants(X, r) {
            return [
                chk('回報成功', r.ok === true, `ok=${r.ok}`),
                chk('訊息說明 count 上限', /count=2/.test(r.message || ''), r.message),
            ];
        },
    },
    {
        id: 'gather_log_count_1', phase: 8, title: '伐木：count=1 時只砍樹根一根，不爬樹、不能挖腳下的地',
        timeoutMs: 120000,
        async setup(X) {
            this.tree = await buildOakTree(X, 4, 0);
            await X.tpEcho(0, 0, 4, 0);
        },
        act: { type: 'gather', target: 'oak_log', count: 1 },
        async judge(X) {
            const logs = await X.ex.count('oak_log');
            const base = await X.ex.blockIs(this.tree.x, X.floorY + 1, this.tree.z, 'oak_log');
            const second = await X.ex.blockIs(this.tree.x, X.floorY + 2, this.tree.z, 'oak_log');
            const p = await X.ex.pos(X.echoName);
            const ground = await X.ex.blockIs(Math.floor(p.x), X.floorY, Math.floor(p.z), 'grass_block');
            return [
                chk('背包剛好 1 根橡木原木', logs === 1, `實際 ${logs}`),
                chk('樹根已被砍掉', !base),
                chk('第二根還在（沒有爬上去砍）', second),
                chk('人沒有挖腳下的地（還站在地面上）', p.y >= X.floorY + 0.9 && (ground || p.y > X.floorY + 0.9), `Y=${p.y.toFixed(1)}`),
            ];
        },
    },
);

// ════════════════════════════════════════════════════════
//  階段 10：第 7 輪玩家記錄的問題
//   - gather target=stone 比對到 stone_bricks；target=cobblestone 因世界裡是 stone 而找不到
//   - 鎬子耐久用到壞掉都沒有預警（staircase 往深板岩挖 55 層，三把鎬全壞）
// ════════════════════════════════════════════════════════
cases.push(
    {
        id: 'gather_stone_exact_not_bricks', phase: 10, title: '採集：target=stone 只能挖 stone，不能比對到旁邊的 stone_bricks',
        timeoutMs: 100000,
        async setup(X) {
            const near = X.at(2, 0), far = X.at(7, 0);
            await X.fill(near.x, X.floorY + 1, near.z, near.x, X.floorY + 2, near.z, 'stone_bricks');      // 離得比較近的是磚
            await X.fill(far.x, X.floorY + 1, far.z, far.x + 1, X.floorY + 2, far.z + 1, 'stone');        // 真正的 stone 在遠一點
            await X.give('stone_pickaxe', 1);
            await X.tpEcho(0, 0, 4, 0);
        },
        act: { type: 'gather', target: 'stone', count: 3 },
        async judge(X, r) {
            const cobble = await X.ex.count('cobblestone');
            const bricks = await X.ex.count('stone_bricks');
            const placed = r.pathfinderPlaced || 0;
            return [
                chk('拿到鵝卵石 3 個（挖的是 stone）', cobble + placed >= 3, `背包 ${cobble} + pathfinder 放掉 ${placed}`),
                chk('沒有挖磚頭', bricks === 0, `stone_bricks=${bricks}`),
            ];
        },
    },
    {
        id: 'gather_cobblestone_via_stone', phase: 10, title: '採集：target=cobblestone（掉落物名稱）而世界裡只有 stone 時，要改挖 stone 並說明',
        timeoutMs: 100000,
        async setup(X) {
            const a = X.at(3, 0);
            await X.fill(a.x, X.floorY + 1, a.z, a.x + 1, X.floorY + 2, a.z + 1, 'stone');
            await X.give('stone_pickaxe', 1);
            await X.tpEcho(0, 0, 3, 0);
        },
        act: { type: 'gather', target: 'cobblestone', count: 3 },
        async judge(X, r) {
            const cobble = await X.ex.count('cobblestone');
            return [chk('拿到鵝卵石（≥ 2，扣掉 pathfinder 可能墊腳的）', cobble + (r.pathfinderPlaced || 0) >= 3, `背包 ${cobble}`)];
        },
        async invariants(X, r) {
            return [
                chk('回報成功', r.ok === true, `ok=${r.ok}`),
                chk('訊息說明 cobblestone 是掉落物、改挖 stone', /掉落物/.test(r.message || '') && /stone/.test(r.message || ''), r.message),
            ];
        },
    },
    {
        id: 'staircase_stops_before_tool_breaks', phase: 10, title: '階梯下礦：鎬子只剩 2 次耐久而且沒有別的鎬子時，要在壞掉前停下並說明，鎬子還在背包',
        expectAchieved: false, timeoutMs: 100000,
        async setup(X) {
            await X.cmd(`give ${X.echoName} minecraft:iron_pickaxe[minecraft:damage=248] 1`);     // 耐久 250，已損耗 248，剩 2 次
            await X.tpEcho(0, 0, 0, 5);
        },
        act: { type: 'staircase', steps: 6, direction: 'south', tool: 'iron_pickaxe' },
        async judge(X) {
            const p = await X.ex.pos(X.echoName);
            return [chk('已下降 6 層（不應該到，鎬子快壞了）', p.y <= X.floorY + 1 - 6 + 0.5, `Y=${p.y.toFixed(1)}`)];
        },
        async invariants(X, r) {
            const pick = await X.ex.count('iron_pickaxe');
            return [
                chk('回報不是成功', r.ok === false, `ok=${r.ok}`),
                chk('訊息說明鎬子耐久快用完', /耐久只剩/.test(r.message || ''), r.message),
                chk('鎬子還在背包（沒有挖到壞掉）', pick === 1, `iron_pickaxe=${pick}`),
            ];
        },
    },
);

cases.push(
    {
        id: 'goto_scaffold_up_is_fast', phase: 10, title: 'goto：頭上 4 格的空中座標，pathfinder 自己往腳下疊方塊上去，要在 10 秒內到（以前放太早被伺服器拒絕，每次白等 5 秒，爬 4 格要 32 秒）',
        timeoutMs: 60000,
        async setup(X) {
            await X.give('cobblestone', 20);
            await X.tpEcho(0, 0, 0, 5);
        },
        async run(X) { return X.echo.act({ type: 'goto', x: X.arena.cx, y: X.floorY + 5, z: X.arena.cz, range: 0 }, 60000); },
        async judge(X) {
            const p = await X.ex.pos(X.echoName);
            return [chk('人升到 Y ≥ 地面+4（站在疊起來的方塊上）', p.y >= X.floorY + 4 - 0.1, `Y=${p.y.toFixed(1)}`)];
        },
        async invariants(X, r) {
            return [
                chk('回報成功', r.ok === true, `ok=${r.ok}`),
                chk('10 秒內完成（修之前約 32 秒）', (r.durationMs || 99999) < 10000, `${r.durationMs}ms`),
                chk('結果有說 pathfinder 放了方塊', (r.pathfinderPlaced || 0) >= 3, `pathfinderPlaced=${r.pathfinderPlaced}`),
            ];
        },
    },
);

cases.push(
    {
        id: 'staircase_precious_tool_reserve', phase: 10, title: '階梯下礦：指定鐵鎬挖便宜的泥土石頭，但鐵鎬耐久已低於 15% 時要停下來，把它留給挖礦石用',
        expectAchieved: false, timeoutMs: 100000,
        async setup(X) {
            await X.cmd(`give ${X.echoName} minecraft:iron_pickaxe[minecraft:damage=215] 1`);     // 耐久 250，已損耗 215，剩 35（14%）
            await X.give('stone_pickaxe', 1);
            await X.tpEcho(0, 0, 0, 5);
        },
        act: { type: 'staircase', steps: 6, direction: 'south', tool: 'iron_pickaxe' },
        async judge(X) {
            const p = await X.ex.pos(X.echoName);
            return [chk('已下降 6 層（不應該到，鐵鎬要留著）', p.y <= X.floorY + 1 - 6 + 0.5, `Y=${p.y.toFixed(1)}`)];
        },
        async invariants(X, r) {
            const dmg = await X.ex.scalar(X.echoName, 'Inventory[{id:"minecraft:iron_pickaxe"}].components."minecraft:damage"');
            return [
                chk('回報不是成功', r.ok === false, `ok=${r.ok}`),
                chk('訊息說鐵鎬耐久低、留給礦石', /耐久只剩/.test(r.message || '') && /礦石/.test(r.message || ''), r.message),
                chk('鐵鎬沒有被繼續消耗（損耗還是 215）', Number(dmg) === 215, `damage=${dmg}`),
            ];
        },
    },
    {
        id: 'obs_lists_each_ore_type', phase: 10, title: '觀察：附近同時有鑽石、鐵、煤時，obs 的資源列要每種礦各列一個（以前所有礦只列最近一個）',
        timeoutMs: 30000,
        async setup(X) {
            const F = X.floorY;
            for (const [dx, ore] of [[4, 'coal_ore'], [6, 'iron_ore'], [8, 'diamond_ore'], [10, 'deepslate_redstone_ore']]) {
                const a = X.at(dx, 3);
                await X.setblock(a.x, F + 1, a.z, ore);
            }
            await X.tpEcho(0, 0, 0, 5);
        },
        async run(X) {
            const o = await X.echo.observe();
            this.keys = Object.keys(o.resources || {});
            return { ok: true, status: 'done', message: '' };
        },
        async judge(X) {
            const need = ['coal_ore', 'iron_ore', 'diamond_ore', 'redstone_ore'];
            return need.map(k => chk(`資源列有 ${k}`, this.keys.includes(k), this.keys.join(',')));
        },
    },
);

cases.push(
    {
        id: 'staircase_falls_back_to_precious_tool', phase: 11, title: '階梯下礦（不指定工具）：便宜的石鎬快壞時，要改用耐久夠的鐵鎬繼續挖，不能說「沒有別的工具」就停',
        timeoutMs: 100000,
        async setup(X) {
            await X.cmd(`give ${X.echoName} minecraft:stone_pickaxe[minecraft:damage=127] 1`);    // 耐久 131，已損耗 127，剩 4（快壞）
            await X.give('iron_pickaxe', 1);                                                       // 耐久滿格
            await X.tpEcho(0, 0, 0, 5);
        },
        act: { type: 'staircase', steps: 3, direction: 'south' },
        async judge(X) {
            const p = await X.ex.pos(X.echoName);
            return [chk('已下降 3 層（改用鐵鎬繼續挖）', p.y <= X.floorY + 1 - 3 + 0.5, `Y=${p.y.toFixed(1)}`)];
        },
        async invariants(X, r) {
            const stone = await X.ex.count('stone_pickaxe');
            return [
                chk('回報成功', r.ok === true, `ok=${r.ok}`),
                chk('快壞的石鎬還在（沒有被挖到壞）', stone === 1, `stone_pickaxe=${stone}`),
            ];
        },
    },
    {
        id: 'craft_picks_up_dropped_table_first', phase: 11, title: '合成：背包沒工作台但附近地上有掉落的工作台時，要先撿起來用，不能拿木板再做一張',
        timeoutMs: 60000,
        async setup(X) {
            const a = X.at(1, 1);
            await X.cmd(`summon minecraft:item ${a.x + 0.5} ${X.floorY + 1} ${a.z + 0.5} {Item:{id:"minecraft:crafting_table",count:1}}`);
            await X.give('oak_planks', 8);
            await X.give('stick', 2);
            await X.give('cobblestone', 3);
            await X.tpEcho(0, 0, 0, 5);
        },
        act: { type: 'craft', name: 'stone_pickaxe' },
        async judge(X) {
            const pick = await X.ex.count('stone_pickaxe');
            const planks = await X.ex.count('oak_planks');
            const table = await X.ex.count('crafting_table');
            return [
                chk('做出石鎬', pick === 1, `stone_pickaxe=${pick}`),
                chk('木板沒有被拿去做新桌子（還是 8 塊）', planks === 8, `oak_planks=${planks}`),
                chk('桌子回到背包', table === 1, `crafting_table=${table}`),
            ];
        },
    },
    {
        id: 'obs_oxygen_ignores_other_entities', phase: 11, title: '觀察：附近有離水缺氧的魚時，obs 的氧氣不能被牠的氣量覆蓋（ECHO 站在地面上，氧氣必須是 20）',
        timeoutMs: 40000,
        async setup(X) {
            const a = X.at(2, 2);
            for (let i = 0; i < 3; i++) await X.cmd(`summon minecraft:cod ${a.x + 0.5} ${X.floorY + 1} ${a.z + 0.5}`);
            await X.tpEcho(0, 0, 0, 5);
        },
        async run(X) {
            await X.sleep(8000);            // 離水的魚氣量每秒下降，會一直送 air_supply 更新
            const o = await X.echo.observe();
            this.oxygen = o.self.oxygen;
            return { ok: true, status: 'done', message: '' };
        },
        async judge(X) {
            return [chk('站在地面上，氧氣是 20', this.oxygen === 20, `oxygen=${this.oxygen}`)];
        },
    },
);

cases.push(
    {
        id: 'tool_param_picks_freshest_of_same_name', phase: 11, title: '指定工具：背包有兩把同名鐵鎬（一把快壞、一把全新）時，tool=iron_pickaxe 要用全新的那把',
        timeoutMs: 100000,
        async setup(X) {
            await X.cmd(`give ${X.echoName} minecraft:iron_pickaxe[minecraft:damage=240] 1`);     // 先給：排在前面的格子，剩 10 次
            await X.give('iron_pickaxe', 1);                                                       // 後給：全新
            await X.tpEcho(0, 0, 0, 5);
        },
        act: { type: 'staircase', steps: 3, direction: 'south', tool: 'iron_pickaxe' },
        async judge(X) {
            const dmg = async (slot) => { try { return Number(await X.ex.scalar(X.echoName, `Inventory[{Slot:${slot}b}].components."minecraft:damage"`)); } catch (_) { return 0; } };
            const worn = await dmg(0), fresh = await dmg(1);
            return [
                chk('快壞的那把沒有被用（損耗還是 240）', worn === 240, `slot0 damage=${worn}`),
                chk('全新的那把有被用到', fresh > 0, `slot1 damage=${fresh}`),
            ];
        },
    },
);

// ════════════════════════════════════════════════════════
//  階段 12：第 11 輪玩家記錄的問題
//   - 鑽石掉在「頭頂是實心岩石的 1 格高小凹洞」裡：pickup_items 說走不到、goto range=0 卻回報 ok 而且人沒動，浪費 5 次動作
// ════════════════════════════════════════════════════════
async function buildLowPocket(X) {
    const F = X.floorY;
    const a = X.at(-2, 4), b = X.at(2, 12);
    await X.fill(a.x, F - 8, a.z, b.x, F - 1, b.z, 'stone');                       // 實心石頭（地面草地 F 維持不動）
    const c = X.at(0, 6);
    await X.fill(c.x, F - 5, c.z, c.x, F - 4, c.z + 1, 'air');                     // A、C：兩格高的通道（z=6、7）
    await X.setblock(c.x, F - 5, c.z + 2, 'air');                                   // B：只有 1 格高的小凹洞（z=8），頭頂是實心石頭
    return { standing: c, pocket: { x: c.x, y: F - 5, z: c.z + 2 } };
}

cases.push(
    {
        id: 'pickup_item_in_low_pocket', phase: 12, title: '撿東西：鑽石掉在頭頂是實心岩石的 1 格高小凹洞裡，pickup_items 要自己挖開頭頂走進去撿，不能只說走不到',
        timeoutMs: 60000,
        async setup(X) {
            const g = await buildLowPocket(X);
            this.g = g;
            await X.give('iron_pickaxe', 1);
            await X.cmd(`tp ${X.echoName} ${g.standing.x + 0.5} ${X.floorY - 5} ${g.standing.z + 0.5}`);
            await X.sleep(1500);
            await X.cmd(`summon minecraft:item ${g.pocket.x + 0.5} ${g.pocket.y + 0.1} ${g.pocket.z + 0.5} {Item:{id:"minecraft:diamond",count:1},PickupDelay:20,Motion:[0.0,0.0,0.0]}`);
        },
        act: { type: 'pickup_items', radius: 6, name: 'diamond' },
        async judge(X) {
            const dia = await X.ex.count('diamond');
            return [chk('伺服器背包有鑽石', dia === 1, `diamond=${dia}`)];
        },
        async invariants(X, r) {
            return [chk('回報成功', r.ok === true, `ok=${r.ok}｜${r.message}`)];
        },
    },
    {
        id: 'goto_range0_must_stand_in_cell', phase: 12, title: 'goto range=0：目標格是頭頂有岩石的小凹洞站不進去時，不能回報 ok（距離 1 格以上不算站在那一格）',
        expectAchieved: false, timeoutMs: 60000,
        async setup(X) {
            const g = await buildLowPocket(X);
            this.g = g;
            await X.cmd(`tp ${X.echoName} ${g.standing.x + 0.5} ${X.floorY - 5} ${g.standing.z + 1.5}`);
            await X.sleep(1500);
        },
        async run(X) { return X.echo.act({ type: 'goto', x: this.g.pocket.x, y: this.g.pocket.y, z: this.g.pocket.z, range: 0 }, 30000); },
        async judge(X) {
            const p = await X.ex.pos(X.echoName);
            const inCell = Math.floor(p.x) === this.g.pocket.x && Math.floor(p.z) === this.g.pocket.z;
            return [chk('人站在目標那一格（站不進去，不應該成立）', inCell, `位置 (${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)})`)];
        },
        async invariants(X, r) {
            return [chk('回報不是成功', r.ok === false, `ok=${r.ok}｜${r.message}`)];
        },
    },
);

cases.push(
    {
        id: 'gather_budget_cut_is_partial', phase: 13, title: '採集：礦太遠、單次動作被時間預算切斷但已經挖了一段通道時，要回報「進行中」(status=partial)，不能標成失敗；再呼叫要能接著挖到',
        timeoutMs: 700000,
        async setup(X) {
            // 比 gather_deep_far_ore 更遠更深（約 60 格通道），一次動作（85 秒預算）一定挖不完
            this.ore = await buildRockMass(X, { dx: 12, dz: 28, dy: -19, block: 'deepslate_diamond_ore' });
            await X.give('iron_pickaxe', 1);
            await X.give('torch', 8);
            await X.tpEcho(0, 0, 0, 5);
            // 挖通道已經很快（60 格一次動作就挖得完），所以用「挖掘疲勞」把挖掘速度降到 30%，保證一次動作做不完
            await X.cmd(`effect give ${X.echoName} minecraft:mining_fatigue 900 0 true`);
        },
        async run(X) {
            this.calls = [];
            let r = null;
            for (let i = 0; i < 6; i++) {
                r = await X.echo.act({ type: 'gather', target: 'diamond_ore', tool: 'iron_pickaxe' }, 110000);
                this.calls.push({ ok: r.ok, status: r.status, cut: /再呼叫一次|時間到|上限|進度保留/.test(r.message || ''), summary: r.summary });
                if (r.ok) break;
                if (r.status !== 'partial' && !this.calls[i].cut) break;      // 真的失敗就不重試
            }
            return r;
        },
        async judge(X) {
            await X.cmd(`effect clear ${X.echoName}`);
            const dia = await X.ex.count('diamond');
            const cutCalls = this.calls.filter(c => !c.ok && c.cut);
            return [
                chk('至少有一次被時間預算切斷（否則這題沒測到東西）', cutCalls.length >= 1, JSON.stringify(this.calls.map(c => `${c.ok ? 'ok' : c.status}`))),
                chk('被切斷的每一次，狀態都是 partial（進行中），不是失敗', cutCalls.every(c => c.status === 'partial'), JSON.stringify(cutCalls.map(c => c.summary))),
                chk('接著再呼叫最後拿到鑽石', dia >= 1, `diamond=${dia}`),
            ];
        },
    },
);

cases.push(
    {
        id: 'gather_log_other_species_counts', phase: 13, title: '伐木：要 oak_log 但附近只有樺樹時，砍樺樹也算成功（ok），並且說明砍的是 birch_log，不能判成「背包沒變化」',
        timeoutMs: 120000,
        async setup(X) {
            const F = X.floorY;
            const a = X.at(4, 0);
            this.tree = a;
            await X.fill(a.x - 2, F + 4, a.z - 2, a.x + 2, F + 5, a.z + 2, 'birch_leaves[persistent=true] keep');
            await X.fill(a.x - 1, F + 6, a.z - 1, a.x + 1, F + 6, a.z + 1, 'birch_leaves[persistent=true] keep');
            await X.fill(a.x, F + 1, a.z, a.x, F + 5, a.z, 'birch_log');
            await X.tpEcho(0, 0, 4, 0);
        },
        act: { type: 'gather', target: 'oak_log' },
        async judge(X, r) {
            const birch = await X.ex.count('birch_log');
            const oak = await X.ex.count('oak_log');
            return [
                chk('背包有樺木原木 ≥ 4（樹共 5 格）', birch >= 4, `birch_log=${birch}, oak_log=${oak}`),
                chk('回報 ok（砍到了原木，不分樹種）', r.ok === true, `ok=${r.ok} reason=${r.reason}`),
                chk('訊息說明砍的是 birch_log', /birch_log/.test(r.message || ''), (r.message || '').slice(0, 120)),
            ];
        },
    },
);

// ════════════════════════════════════════════════════════
//  階段 14：垂直井（staircase shape=shaft、tunnel_to 往正下方）與 pillar 在岩石裡往上疊
//  起因：使用者觀戰看到往下挖每兩格就停 2～4 秒；實測 tunnel_to 往正下方挖成「兩欄來回的井」，12 格深走了 21 步、71 秒；
//  pillar 在頭頂有岩石時，挖頭頂是空手挖（每塊約 8 秒），而且墊腳的方塊用完不會換下一種（手上拿著鎬子去放方塊，放不出去）
// ════════════════════════════════════════════════════════
async function solidBlockAt(X, dx, dz, up) {
    const F = X.floorY;
    const a = X.at(dx - 2, dz - 2), b = X.at(dx + 2, dz + 2);
    await X.fill(a.x, F - 20, a.z, b.x, up ? F + 14 : F - 1, b.z, 'stone');
    return X.at(dx, dz);
}

cases.push(
    {
        id: 'staircase_shaft_12_fast_one_wide', phase: 14, title: '垂直井：staircase shape=shaft 往下 12 層，要又快（≤35 秒）又只挖一格寬',
        timeoutMs: 100000,
        async setup(X) {
            this.c = await solidBlockAt(X, 4, 10, false);
            await X.give('iron_pickaxe', 1);
            await X.tpEcho(4, 10, 4, 12);
        },
        async run(X) { return X.echo.act({ type: 'staircase', targetY: X.floorY + 1 - 12, shape: 'shaft' }, 100000); },
        async judge(X, r) {
            const p = await X.ex.pos(X.echoName);
            const F = X.floorY, c = this.c;
            const wallsSolid = (await X.ex.blockIs(c.x + 1, F - 5, c.z, 'stone')) && (await X.ex.blockIs(c.x - 1, F - 5, c.z, 'stone'))
                && (await X.ex.blockIs(c.x, F - 5, c.z + 1, 'stone')) && (await X.ex.blockIs(c.x, F - 5, c.z - 1, 'stone'));
            return [
                chk('下降到目標深度', p.y <= F + 1 - 12 + 0.5, `Y=${p.y.toFixed(1)}`),
                chk('只挖了一格寬（井的四面都還是石頭）', wallsSolid),
                chk('用時 ≤ 35 秒（以前兩欄來回要 71 秒）', r.durationMs <= 35000, `${Math.round(r.durationMs / 1000)} 秒`),
            ];
        },
    },
    {
        id: 'staircase_shaft_stops_above_lava', phase: 14, title: '垂直井：底下 3 格內有岩漿時要停下來說明，不能挖下去（不被燒到）',
        expectAchieved: false, timeoutMs: 60000,
        async setup(X) {
            this.c = await solidBlockAt(X, 4, 10, false);
            this.lavaY = X.floorY - 3;
            await X.setblock(this.c.x, this.lavaY, this.c.z, 'lava');
            await X.give('iron_pickaxe', 1);
            await X.tpEcho(4, 10, 4, 12);
        },
        async run(X) { return X.echo.act({ type: 'staircase', targetY: X.floorY - 10, shape: 'shaft' }, 60000); },
        async judge(X) {
            const p = await X.ex.pos(X.echoName);
            return [chk('已經下到岩漿的深度（不應該）', p.y <= this.lavaY + 0.5, `Y=${p.y.toFixed(1)}，岩漿在 Y=${this.lavaY}`)];
        },
        async invariants(X, r) {
            const hp = await X.ex.scalar(X.echoName, 'Health');
            return [
                chk('回報不是成功', r.ok === false, `ok=${r.ok}`),
                chk('訊息提到岩漿', /岩漿/.test(r.message || ''), (r.message || '').slice(0, 120)),
                chk('沒有被燒到（血量滿）', hp >= 19.5, `HP ${hp}`),
            ];
        },
    },
    {
        id: 'staircase_shaft_stops_above_water', phase: 14, title: '垂直井：底下有水時要停下來說明，不能挖下去（不被淹）',
        expectAchieved: false, timeoutMs: 60000,
        async setup(X) {
            this.c = await solidBlockAt(X, 4, 10, false);
            this.waterY = X.floorY - 4;
            await X.setblock(this.c.x, this.waterY, this.c.z, 'water');
            await X.give('iron_pickaxe', 1);
            await X.tpEcho(4, 10, 4, 12);
        },
        async run(X) { return X.echo.act({ type: 'staircase', targetY: X.floorY - 10, shape: 'shaft' }, 60000); },
        async judge(X) {
            const p = await X.ex.pos(X.echoName);
            return [chk('已經下到水的深度（不應該）', p.y <= this.waterY + 0.5, `Y=${p.y.toFixed(1)}，水在 Y=${this.waterY}`)];
        },
        async invariants(X, r) {
            return [
                chk('回報不是成功', r.ok === false, `ok=${r.ok}`),
                chk('訊息提到水', /水/.test(r.message || ''), (r.message || '').slice(0, 120)),
            ];
        },
    },
    {
        id: 'tunnel_to_straight_down_is_shaft', phase: 14, title: 'tunnel_to：目標在正下方 10 格時要挖一格寬的垂直井，不是兩欄來回（≤25 秒、10 步內）',
        timeoutMs: 100000,
        async setup(X) {
            this.c = await solidBlockAt(X, 4, 10, false);
            await X.give('iron_pickaxe', 1);
            await X.tpEcho(4, 10, 4, 12);
        },
        async run(X) { return X.echo.act({ type: 'tunnel_to', x: this.c.x, y: X.floorY + 1 - 10, z: this.c.z }, 100000); },
        async judge(X, r) {
            const p = await X.ex.pos(X.echoName);
            const F = X.floorY, c = this.c;
            const wallsSolid = (await X.ex.blockIs(c.x + 1, F - 5, c.z, 'stone')) && (await X.ex.blockIs(c.x - 1, F - 5, c.z, 'stone'));
            return [
                chk('到達目標那一格', Math.floor(p.x) === c.x && Math.floor(p.z) === c.z && p.y <= F + 1 - 10 + 0.5, `(${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)})`),
                chk('只挖了一格寬（左右還是石頭）', wallsSolid),
                chk('用時 ≤ 25 秒（以前 12 格要 71 秒）', r.durationMs <= 25000, `${Math.round(r.durationMs / 1000)} 秒`),
            ];
        },
    },
    {
        id: 'pillar_sealed_rock_uses_tool_and_switches_blocks', phase: 14, title: '墊高：被封在岩石裡往上疊 8 格，挖頭頂要用鎬子（不是空手），墊腳的方塊用完要換下一種（原木 2 個 + 鵝卵石）',
        timeoutMs: 100000,
        async setup(X) {
            const F = X.floorY;
            this.c = await solidBlockAt(X, 4, 10, true);
            await X.fill(this.c.x, F + 1, this.c.z, this.c.x, F + 2, this.c.z, 'air');
            await X.give('iron_pickaxe', 1);
            await X.give('oak_log', 2);
            await X.give('cobblestone', 64);
            await X.tpEcho(4, 10, 4, 12);
        },
        act: { type: 'pillar', height: 8 },
        async judge(X, r) {
            const p = await X.ex.pos(X.echoName);
            return [
                chk('升高 8 格', p.y >= X.floorY + 1 + 7.5, `Y=${p.y.toFixed(1)}`),
                chk('用時 ≤ 40 秒（以前空手挖頭頂，每塊約 8 秒，還會在放不出方塊上空等）', r.durationMs <= 40000, `${Math.round(r.durationMs / 1000)} 秒`),
            ];
        },
        async invariants(X, r) {
            return [chk('回報成功', r.ok === true, `ok=${r.ok}｜${r.message}`)];
        },
    },
);

// ════════════════════════════════════════════════════════
//  階段 15：蓋房子玩家（第 15 輪，Haiku low）回報的缺口
//  門：關著的門 ECHO 走不進去、也沒有開門的動作 → 新增 use_block，並開啟 pathfinder 自動開門
//  place_block 放在「地面那一層」失敗只說「已經是 grass_block」→ 訊息告訴它這一欄往上第一個空格
//  同一原因連續失敗 → 提醒；tunnel_to 往正上方 → 用 pillar
// ════════════════════════════════════════════════════════
// 7x7 的石頭小屋（內部 5x5、高 2），南牆正中間是一扇關著的橡木門
async function buildRoomWithDoor(X, dx0, dz0) {
    const F = X.floorY;
    const a = X.at(dx0, dz0);
    await X.fill(a.x, F, a.z, a.x + 6, F + 3, a.z + 6, 'stone hollow');
    const door = { x: a.x + 3, y: F + 1, z: a.z + 6 };
    await X.setblock(door.x, door.y, door.z, 'oak_door[facing=south,half=lower,hinge=left,open=false]');
    await X.setblock(door.x, door.y + 1, door.z, 'oak_door[facing=south,half=upper,hinge=left,open=false]');
    return { a, door, inside: { x: a.x + 3, y: F + 1, z: a.z + 3 } };
}

cases.push(
    {
        id: 'use_block_opens_and_closes_door', phase: 15, title: 'use_block：對關著的門按右鍵會打開，再按一次會關上，結果要說明狀態變化（以伺服器上的門狀態為準）',
        timeoutMs: 60000,
        async setup(X) {
            this.room = await buildRoomWithDoor(X, 2, 6);
            await X.tpEcho(5, 14, 5, 12);
        },
        async run(X) {
            const d = this.room.door;
            this.first = await X.echo.act({ type: 'use_block', x: d.x, y: d.y, z: d.z }, 30000);
            this.openedAfterFirst = await X.ex.blockIs(d.x, d.y, d.z, 'oak_door[open=true]');
            return X.echo.act({ type: 'use_block', x: d.x, y: d.y + 1, z: d.z }, 30000);      // 按上半也一樣會關
        },
        async judge(X, r) {
            const d = this.room.door;
            const closed = await X.ex.blockIs(d.x, d.y, d.z, 'oak_door[open=false]');
            return [
                chk('第一次回報成功', this.first.ok === true, `ok=${this.first.ok}｜${this.first.message}`),
                chk('第一次之後伺服器上的門是開的', this.openedAfterFirst),
                chk('訊息說明從關著變成開著', /關著.*開著/.test(this.first.message || ''), (this.first.message || '').slice(0, 100)),
                chk('第二次回報成功', r.ok === true, `ok=${r.ok}｜${r.message}`),
                chk('第二次之後伺服器上的門是關的', closed),
            ];
        },
    },
    {
        id: 'use_block_unsupported_explains', phase: 15, title: '負面題：use_block 對石頭按右鍵，必須失敗並說明目前只支援門／拉桿／按鈕這類',
        expectAchieved: false, timeoutMs: 30000,
        async setup(X) {
            const a = X.at(3, 5);
            await X.setblock(a.x, X.floorY + 1, a.z, 'stone');
            this.s = { x: a.x, y: X.floorY + 1, z: a.z };
            await X.tpEcho(0, 0, 3, 5);
        },
        async run(X) { return X.echo.act({ type: 'use_block', x: this.s.x, y: this.s.y, z: this.s.z }, 20000); },
        async judge() { return [chk('不應該成功（石頭不能按右鍵）', false, '')]; },
        async invariants(X, r) {
            return [
                chk('回報失敗', r.ok === false, `ok=${r.ok}`),
                chk('訊息說明只支援門、拉桿、按鈕這類', /只支援/.test(r.message || ''), (r.message || '').slice(0, 120)),
            ];
        },
    },
    {
        id: 'goto_blocked_by_door_hints_use_block', phase: 15, title: 'goto：目標在關著的木門後面的小屋裡，pathfinder 不會開門，第一次要失敗並說出門的座標、建議用 use_block；use_block 開門之後再 goto 要走得進去',
        timeoutMs: 120000,
        async setup(X) {
            this.room = await buildRoomWithDoor(X, 2, 6);
            await X.tpEcho(5, 14, 5, 12);
        },
        async run(X) {
            const t = this.room.inside, d = this.room.door;
            this.first = await X.echo.act({ type: 'goto', x: t.x, y: t.y, z: t.z, range: 1 }, 60000);
            this.use = await X.echo.act({ type: 'use_block', x: d.x, y: d.y, z: d.z }, 30000);
            this.inGoto = await X.echo.act({ type: 'goto', x: t.x, y: t.y, z: t.z, range: 1 }, 60000);
            this.inPos = await X.ex.pos(X.echoName);
            // 再從屋裡走出去（門還開著）
            return X.echo.act({ type: 'goto', x: t.x, y: t.y, z: this.room.a.z + 9, range: 1 }, 60000);
        },
        async judge(X, r) {
            const p = await X.ex.pos(X.echoName);
            const a = this.room.a, d = this.room.door, ip = this.inPos;
            const inside = ip.x > a.x + 1 && ip.x < a.x + 6 && ip.z > a.z + 1 && ip.z < a.z + 6;
            return [
                chk('第一次 goto 失敗（門關著）', this.first.ok === false, `ok=${this.first.ok}`),
                chk('第一次的訊息說出門的座標並建議 use_block', /use_block/.test(this.first.message || '') && (this.first.message || '').includes(`(${d.x},${d.y},${d.z})`), (this.first.message || '').slice(-120)),
                chk('use_block 開門成功', this.use.ok === true, `ok=${this.use.ok}｜${this.use.message}`),
                chk('開門之後 goto 成功', this.inGoto.ok === true, `ok=${this.inGoto.ok}｜${(this.inGoto.message || '').slice(0, 100)}`),
                chk('人在小屋裡面', inside, `(${ip.x.toFixed(1)},${ip.y.toFixed(1)},${ip.z.toFixed(1)})`),
                chk('從屋裡 goto 走出去成功，人在屋外', r.ok === true && p.z > a.z + 7, `ok=${r.ok}｜(${p.x.toFixed(1)},${p.z.toFixed(1)})`),
            ];
        },
    },
    {
        id: 'place_block_occupied_hint_and_repeat_warning', phase: 15, title: 'place_block：放在草地那一層會失敗，訊息要說「這一欄往上第一個放得下的格子是 y=…」；同一原因連續失敗 3 次，第 3 次要提醒問題不在座標',
        expectAchieved: false, timeoutMs: 60000,
        async setup(X) {
            await X.give('cobblestone', 8);
            await X.tpEcho(0, 0, 3, 5);
        },
        async run(X) {
            const F = X.floorY;
            this.msgs = [];
            let r = null;
            for (let i = 0; i < 3; i++) {
                const a = X.at(4 + i, 4);
                r = await X.echo.act({ type: 'place_block', block: 'cobblestone', x: a.x, y: F, z: a.z }, 30000);   // y=F 是草地方塊本身
                this.msgs.push(r.message || '');
            }
            return r;
        },
        async judge() { return [chk('不應該放成功（那一格是草地方塊）', false, '')]; },
        async invariants(X) {
            const F = X.floorY;
            return [
                chk('第一次的訊息說出這一欄往上第一個空格 y=F+1', this.msgs[0].includes(`y=${F + 1}`), this.msgs[0].slice(0, 160)),
                chk('第二次還沒有連續失敗提醒', !/連續第/.test(this.msgs[1])),
                chk('第三次有「連續第 3 次」提醒', /連續第 3 次/.test(this.msgs[2]), this.msgs[2].slice(-120)),
            ];
        },
    },
    {
        id: 'tunnel_to_straight_up_uses_pillar', phase: 15, title: 'tunnel_to：目標在正上方 6 格（在一口 1 格寬的井底）時，改用墊高上去，不是橫著挖階梯繞',
        timeoutMs: 100000,
        async setup(X) {
            const F = X.floorY;
            this.c = await solidBlockAt(X, 4, 10, true);
            await X.fill(this.c.x, F - 8, this.c.z, this.c.x, F + 14, this.c.z, 'air');
            await X.give('iron_pickaxe', 1);
            await X.give('cobblestone', 32);
            await X.cmd(`tp ${X.echoName} ${this.c.x + 0.5} ${F - 8} ${this.c.z + 0.5}`);
            await X.sleep(2500);
        },
        async run(X) { return X.echo.act({ type: 'tunnel_to', x: this.c.x, y: X.floorY - 8 + 6, z: this.c.z }, 100000); },
        async judge(X, r) {
            const p = await X.ex.pos(X.echoName);
            const F = X.floorY, c = this.c;
            const wallsSolid = (await X.ex.blockIs(c.x + 1, F - 4, c.z, 'stone')) && (await X.ex.blockIs(c.x - 1, F - 4, c.z, 'stone'));
            return [
                chk('升到目標高度', p.y >= F - 8 + 5.5, `Y=${p.y.toFixed(1)}`),
                chk('還在井裡（沒有橫著往旁邊挖）', wallsSolid && Math.floor(p.x) === c.x && Math.floor(p.z) === c.z, `(${p.x.toFixed(1)},${p.z.toFixed(1)})`),
                chk('用時 ≤ 20 秒', r.durationMs <= 20000, `${Math.round(r.durationMs / 1000)} 秒`),
            ];
        },
        async invariants(X, r) { return [chk('回報成功', r.ok === true, `ok=${r.ok}｜${(r.message || '').slice(0, 150)}`)]; },
    },
);

cases.push(
    {
        id: 'flee_runs_away_from_zombie_at_low_hp', phase: 16, difficulty: 'normal', skipClaim: true, title: '反射：血量降到 7 且身邊有殭屍時，要中斷動作、跑離殭屍（不是找指揮官、也不是原地待命被打死）；事件要說明威脅是誰',
        timeoutMs: 60000,
        async setup(X) {
            await X.cmd('time set midnight');
            await X.tpEcho(0, 0, 0, 5);
        },
        async run(X) {
            const a = X.at(0, 4);
            // 戴頭盔的殭屍不會被太陽燒掉
            // NoAI：殭屍站著不動，這樣「有沒有往反方向跑」才是確定的（會追人的殭屍拉開多少距離看運氣）
            await X.cmd(`summon minecraft:zombie ${a.x + 0.5} ${X.floorY + 1} ${a.z + 0.5} {NoAI:1b,PersistenceRequired:1b,ArmorItems:[{},{},{},{id:"minecraft:iron_helmet",count:1}]}`);
            await X.sleep(500);
            const since = (await X.echo.health()).latestEventId;
            this.dist0 = dist3(await X.ex.pos(X.echoName), await X.ex.pos('@e[type=zombie,limit=1,sort=nearest]'));
            await X.cmd(`damage ${X.echoName} 13 minecraft:generic`);     // 20 → 7
            await X.sleep(6000);
            this.dist1 = dist3(await X.ex.pos(X.echoName), await X.ex.pos('@e[type=zombie,limit=1,sort=nearest]'));
            this.hp = await X.ex.scalar(X.echoName, 'Health');
            const ev = (await X.echo.events(since)).events;
            this.started = ev.find(e => e.type === 'flee_started');
            return { id: null, ok: !!this.started, status: 'done', reason: null, message: 'reflex' };
        },
        async judge(X) {
            return [
                chk('收到 flee_started 事件', !!this.started, JSON.stringify(this.started || {}).slice(0, 150)),
                chk('事件說明威脅是殭屍', !!this.started && JSON.stringify(this.started).includes('zombie'), ''),
                chk('往反方向跑開，拉開到 ≥ 8 格', this.dist1 >= 8, `前 ${this.dist0.toFixed(1)} 後 ${this.dist1.toFixed(1)}`),
                chk('還活著而且血量沒有繼續掉到危險', this.hp >= 8, `HP ${this.hp}`),
            ];
        },
    },
    {
        id: 'flee_from_close_creeper_before_damage', phase: 16, difficulty: 'normal', skipClaim: true, title: '反射：苦力怕靠近到 5 格內，不等受傷就先中斷動作、遠離（用不會動也不會爆的苦力怕）',
        timeoutMs: 60000,
        async setup(X) {
            await X.cmd('time set midnight');
            await X.tpEcho(0, 0, 0, 5);
        },
        async run(X) {
            const a = X.at(0, 3);
            const since = (await X.echo.health()).latestEventId;      // 反射 1 秒內就會發事件，起點要在召喚之前
            await X.cmd(`summon minecraft:creeper ${a.x + 0.5} ${X.floorY + 1} ${a.z + 0.5} {NoAI:1b,Silent:1b,PersistenceRequired:1b}`);
            await X.sleep(6500);
            this.dist = dist3(await X.ex.pos(X.echoName), await X.ex.pos('@e[type=creeper,limit=1,sort=nearest]'));
            this.hp = await X.ex.scalar(X.echoName, 'Health');
            const ev = (await X.echo.events(since)).events;
            this.started = ev.find(e => e.type === 'flee_started');
            return { id: null, ok: !!this.started, status: 'done', reason: null, message: 'reflex' };
        },
        async judge(X) {
            return [
                chk('血量是滿的時候就收到 flee_started', !!this.started && this.hp >= 19.5, `HP ${this.hp}｜${JSON.stringify(this.started || {}).slice(0, 120)}`),
                chk('事件說明威脅是苦力怕', !!this.started && JSON.stringify(this.started).includes('creeper'), ''),
                chk('遠離到 ≥ 8 格', this.dist >= 8, `${this.dist.toFixed(1)} 格`),
            ];
        },
    },
);

cases.push(
    {
        id: 'gather_dirt_does_not_dig_under_feet', phase: 16, title: 'gather：挖一批泥土時不能挖腳下站的那一欄（以前挖最近的方塊，結果一路往下挖成洞，玩家從 Y108 挖到 Y101）',
        timeoutMs: 90000,
        async setup(X) {
            const F = X.floorY;
            const a = X.at(0, 6);
            await X.fill(a.x - 3, F - 4, a.z - 3, a.x + 3, F - 1, a.z + 3, 'dirt');      // 草地下面是一大塊泥土
            await X.give('stone_pickaxe', 1);
            await X.tpEcho(0, 6, 0, 10);
            this.c = a;
        },
        act: { type: 'gather', target: 'dirt', count: 6 },
        async judge(X) {
            const p = await X.ex.pos(X.echoName);
            const F = X.floorY, c = this.c;
            const dirt = await X.ex.count('dirt');
            const colIntact = await X.ex.blockIs(c.x, F - 1, c.z, 'dirt') && await X.ex.blockIs(c.x, F - 2, c.z, 'dirt');
            return [
                chk('人沒有往下挖成深洞（旁邊挖出的坑最多 2 格深）', p.y >= F + 1 - 2.5, `Y=${p.y.toFixed(1)}`),
                chk('腳下正下方那一欄的泥土還在', colIntact),
                chk('挖到泥土 ≥ 5', dirt >= 5, `dirt=${dirt}`),
            ];
        },
    },
    {
        id: 'place_block_replaceable_grass_vs_flower', phase: 16, title: 'place_block：目標格是草（可取代）要能直接蓋過去；是花（不可取代）要馬上說清楚要先挖掉，不能白等 5 秒逾時',
        expectAchieved: false, timeoutMs: 90000,
        async setup(X) {
            const g = X.at(3, 4), f = X.at(4, 4);
            this.g = { x: g.x, y: X.floorY + 1, z: g.z };
            this.f = { x: f.x, y: X.floorY + 1, z: f.z };
            await X.setblock(this.g.x, this.g.y, this.g.z, 'short_grass');
            await X.setblock(this.f.x, this.f.y, this.f.z, 'azure_bluet');
            await X.give('cobblestone', 4);
            await X.tpEcho(0, 0, 3, 4);
        },
        async run(X) {
            this.onGrass = await X.echo.act({ type: 'place_block', block: 'cobblestone', x: this.g.x, y: this.g.y, z: this.g.z }, 40000);
            this.onFlower = await X.echo.act({ type: 'place_block', block: 'cobblestone', x: this.f.x, y: this.f.y, z: this.f.z }, 40000);
            return this.onFlower;
        },
        async judge() { return [chk('不應該放成功（花不能被蓋過去）', false, '')]; },
        async invariants(X) {
            const grassDone = await X.ex.blockIs(this.g.x, this.g.y, this.g.z, 'cobblestone');
            const flowerStill = await X.ex.blockIs(this.f.x, this.f.y, this.f.z, 'azure_bluet');
            return [
                chk('草那一格直接蓋成圓石，回報成功', this.onGrass.ok === true && grassDone, `ok=${this.onGrass.ok}`),
                chk('花那一格還是花、回報失敗', this.onFlower.ok === false && flowerStill, `ok=${this.onFlower.ok}`),
                chk('花的失敗訊息馬上說明是植物、要先挖掉（≤8 秒，不是等逾時）', /植物/.test(this.onFlower.message || '') && /挖/.test(this.onFlower.message || '') && this.onFlower.durationMs <= 8000, `${Math.round(this.onFlower.durationMs / 1000)} 秒｜${(this.onFlower.message || '').slice(0, 100)}`),
            ];
        },
    },
);

cases.push(
    {
        id: 'water_low_air_interrupts_running_action', phase: 16, skipClaim: true, title: '自動脫困：泡在水裡、動作還在跑，氧氣見底時要強制中斷動作並上岸（不是等泡滿 45 秒；以前被「動作還在進行中」擋住，結果淹死）',
        timeoutMs: 120000,
        async run(X) {
            const F = X.floorY, a = X.at(4, -7);
            await X.fill(a.x, F - 5, a.z, a.x + 14, F, a.z + 14, 'water');
            const since = (await X.echo.health()).latestEventId;
            const c = X.at(11, 0);
            await X.cmd(`tp ${X.echoName} ${c.x + 0.5} ${F - 3} ${c.z + 0.5} 0 0`);
            // 下一個長動作（wait 20 秒）讓執行器忙著；反射應該在氧氣 ≤8（約 10 秒）時中斷它
            const t0 = Date.now();
            this.waitRes = await X.echo.act({ type: 'wait', ms: 20000 }, 40000);
            this.waitSec = (Date.now() - t0) / 1000;
            let out = false;
            for (let i = 0; i < 20 && !out; i++) { await X.sleep(1500); out = !(await X.echo.observe()).self.inWater; }
            this.out = out;
            this.hp = await X.ex.scalar(X.echoName, 'Health');
            this.events = (await X.echo.events(since)).events;
            return { ok: out, status: 'done', reason: null, message: 'auto' };
        },
        async judge(X) {
            const started = this.events.find(e => e.type === 'auto_escape_started');
            return [
                chk('wait 被中斷（沒有跑滿 20 秒）', this.waitSec < 17, `${this.waitSec.toFixed(1)} 秒｜${this.waitRes.reason}`),
                chk('收到 auto_escape_started，並說明中斷了 wait', !!started && started.interrupted === 'wait', JSON.stringify(started || {})),
                chk('自己上岸了', this.out, ''),
                chk('沒有溺水（血量 ≥ 14）', this.hp >= 14, `HP ${this.hp}`),
            ];
        },
    },
);

cases.push(
    {
        id: 'attack_returns_started_immediately', phase: 17, title: 'attack：下令後立刻回報「開始攻擊」（status=started、不擋住模型），之後身體自己打到那隻死掉，並發 attack_ended 事件',
        timeoutMs: 100000,
        async setup(X) {
            await X.give('iron_sword', 1);
            await X.summon('cow', 6, 0);
        },
        async run(X) {
            const since = (await X.echo.health()).latestEventId;
            const t0 = Date.now();
            this.r = await X.echo.act({ type: 'attack', target: 'cow' }, 20000);
            this.returnSec = (Date.now() - t0) / 1000;
            let ended = null;
            for (let i = 0; i < 60 && !ended; i++) { await X.sleep(1000); ended = (await X.echo.events(since)).events.find(e => e.type === 'attack_ended') || null; }
            this.ended = ended;
            return { ...this.r };
        },
        async judge(X) {
            const left = await X.ex.entCount('@e[type=cow,distance=..40]');
            return [
                chk('立刻回報（≤ 5 秒）且 status=started', this.returnSec <= 5 && this.r.status === 'started', `${this.returnSec.toFixed(1)} 秒｜${this.r.status}`),
                chk('回報訊息說明「開始攻擊」並提醒可以 stop', /開始攻擊/.test(this.r.message || '') && /stop/.test(this.r.message || ''), (this.r.message || '').slice(0, 100)),
                chk('收到 attack_ended，結果是擊殺', !!this.ended && this.ended.outcome === 'killed', JSON.stringify(this.ended || {})),
                chk('牛死了', left === 0, `剩 ${left}`),
            ];
        },
    },
    {
        id: 'attack_not_interrupted_by_normal_flee', phase: 17, difficulty: 'normal', skipClaim: true, title: '攻擊：模型下令打殭屍後，血量 7（低於一般撤退門檻 8）也不能被撤退反射中斷，要打到牠死',
        timeoutMs: 100000,
        async setup(X) {
            await X.cmd('time set midnight');
            await X.give('iron_sword', 1);
            await X.tpEcho(0, 0, 0, 5);
        },
        async run(X) {
            const a = X.at(0, 3);
            await X.cmd(`summon minecraft:zombie ${a.x + 0.5} ${X.floorY + 1} ${a.z + 0.5} {PersistenceRequired:1b,ArmorItems:[{},{},{},{id:"minecraft:iron_helmet",count:1}]}`);
            await X.cmd(`damage ${X.echoName} 13 minecraft:generic`);     // 20 → 7
            const since = (await X.echo.health()).latestEventId;
            await X.echo.act({ type: 'attack', target: 'zombie' }, 20000);
            let ended = null;
            for (let i = 0; i < 40 && !ended; i++) { await X.sleep(1000); ended = (await X.echo.events(since)).events.find(e => e.type === 'attack_ended') || null; }
            this.ended = ended;
            this.flee = (await X.echo.events(since)).events.find(e => e.type === 'flee_started') || null;
            this.hp = await X.ex.scalar(X.echoName, 'Health');
            return { ok: !!ended, status: 'done', reason: null, message: 'attack' };
        },
        async judge(X) {
            const left = await X.ex.entCount('@e[type=zombie,distance=..40]');
            return [
                chk('打鬥中沒有被一般撤退中斷（沒有 flee_started）', !this.flee, JSON.stringify(this.flee || {})),
                chk('殭屍被打死、attack_ended 結果是擊殺', !!this.ended && this.ended.outcome === 'killed' && left === 0, `${JSON.stringify(this.ended || {})}｜剩 ${left}`),
                chk('ECHO 還活著', this.hp > 0, `HP ${this.hp}`),
            ];
        },
    },
    {
        id: 'attack_stop_ends_fight_with_event', phase: 17, difficulty: 'normal', skipClaim: true, title: '攻擊：打到一半模型下 stop，要立刻停手並發 attack_ended（outcome=stopped）',
        timeoutMs: 60000,
        async setup(X) {
            await X.cmd('time set midnight');
            await X.give('iron_sword', 1);
            await X.tpEcho(0, 0, 0, 5);
        },
        async run(X) {
            const a = X.at(0, 3);
            await X.cmd(`summon minecraft:zombie ${a.x + 0.5} ${X.floorY + 1} ${a.z + 0.5} {PersistenceRequired:1b,NoAI:1b,Health:200f,attributes:[{id:"minecraft:generic.max_health",base:200d}],ArmorItems:[{},{},{},{id:"minecraft:iron_helmet",count:1}]}`);
            const since = (await X.echo.health()).latestEventId;
            await X.echo.act({ type: 'attack', target: 'zombie' }, 20000);
            await X.sleep(2500);
            this.stopRes = await X.echo.act({ type: 'stop' }, 10000);
            await X.sleep(1500);
            this.ended = (await X.echo.events(since)).events.find(e => e.type === 'attack_ended') || null;
            this.alive = (await X.ex.entCount('@e[type=zombie,distance=..40]')) === 1;
            return { ok: true, status: 'done', reason: null, message: 'attack' };
        },
        async judge() {
            return [
                chk('收到 attack_ended，結果是 stopped', !!this.ended && this.ended.outcome === 'stopped', JSON.stringify(this.ended || {})),
                chk('殭屍還活著（只是停手）', this.alive, ''),
            ];
        },
    },
    {
        id: 'flee_ends_when_model_acts', phase: 17, difficulty: 'normal', skipClaim: true, title: '撤退：身體撤退中，模型下新動作就是接手，撤退要立刻結束、新動作要能正常執行（不能整個被標成 interrupted 而鎖死）',
        timeoutMs: 60000,
        async setup(X) {
            await X.cmd('time set midnight');
            await X.tpEcho(0, 0, 0, 5);
        },
        async run(X) {
            const a = X.at(0, 4);
            await X.cmd(`summon minecraft:zombie ${a.x + 0.5} ${X.floorY + 1} ${a.z + 0.5} {PersistenceRequired:1b,NoAI:1b,ArmorItems:[{},{},{},{id:"minecraft:iron_helmet",count:1}]}`);
            const since = (await X.echo.health()).latestEventId;
            await X.cmd(`damage ${X.echoName} 13 minecraft:generic`);     // 20 → 7，觸發撤退
            await X.sleep(3000);
            this.mode = (await X.echo.observe()).self.mode;
            this.act = await X.echo.act({ type: 'wait', ms: 1000 }, 20000);       // 模型接手
            const ev = (await X.echo.events(since)).events;
            this.started = ev.find(e => e.type === 'flee_started') || null;
            this.ended = ev.find(e => e.type === 'flee_ended' && e.reason === 'model_took_over') || null;
            return { ok: this.act.ok, status: 'done', reason: null, message: 'flee' };
        },
        async judge() {
            return [
                chk('先撤退了（flee_started）', !!this.started, JSON.stringify(this.started || {}).slice(0, 100)),
                chk('模型下動作時身體還在撤退模式', this.mode === 'flee', `mode=${this.mode}`),
                chk('新動作正常執行成功（沒有被標成 interrupted）', this.act.ok === true && this.act.reason == null, `ok=${this.act.ok} reason=${this.act.reason}`),
                chk('收到 flee_ended（原因 model_took_over）', !!this.ended, JSON.stringify(this.ended || {})),
            ];
        },
    },
    {
        id: 'attack_last_floor_retreats_at_hp3', phase: 17, difficulty: 'normal', skipClaim: true, title: '攻擊：打鬥中血量掉到 3 以下，最後底線要強制撤退並發 attack_ended（outcome=interrupted），訊息說明是底線',
        timeoutMs: 100000,
        async setup(X) {
            await X.cmd('time set midnight');
            await X.give('iron_sword', 1);
            await X.tpEcho(0, 0, 0, 5);
        },
        async run(X) {
            const a = X.at(0, 3);
            // 200 血的殭屍：打不死，才有時間讓我們把血量壓到 3 以下
            await X.cmd(`summon minecraft:zombie ${a.x + 0.5} ${X.floorY + 1} ${a.z + 0.5} {PersistenceRequired:1b,NoAI:1b,Health:200f,attributes:[{id:"minecraft:generic.max_health",base:200d}],ArmorItems:[{},{},{},{id:"minecraft:iron_helmet",count:1}]}`);
            const since = (await X.echo.health()).latestEventId;
            await X.echo.act({ type: 'attack', target: 'zombie' }, 20000);
            await X.sleep(2500);
            await X.cmd(`damage ${X.echoName} 17.5 minecraft:generic`);     // 20 → 2.5
            await X.sleep(4000);
            const ev = (await X.echo.events(since)).events;
            this.flee = ev.find(e => e.type === 'flee_started') || null;
            this.ended = ev.find(e => e.type === 'attack_ended') || null;
            return { ok: !!this.flee, status: 'done', reason: null, message: 'attack' };
        },
        async judge() {
            return [
                chk('收到 flee_started，原因說明是打鬥中的最後底線', !!this.flee && /底線/.test(this.flee.reason || ''), JSON.stringify(this.flee || {}).slice(0, 160)),
                chk('收到 attack_ended，結果是被中斷', !!this.ended && this.ended.outcome === 'interrupted', JSON.stringify(this.ended || {})),
            ];
        },
    },
);

cases.push(
    {
        id: 'place_block_entity_in_cell_explains', phase: 18, skipClaim: true, title: 'place_block：目標格裡站著一隻生物時，要馬上說明是有生物站著（≤8 秒），不能等 5 秒的 blockUpdate 逾時、也不能顯示套件的原始英文錯誤',
        expectAchieved: false, timeoutMs: 60000,
        async setup(X) {
            const a = X.at(3, 4);
            this.t = { x: a.x, y: X.floorY + 1, z: a.z };
            await X.give('cobblestone', 4);
            await X.cmd(`summon minecraft:cow ${this.t.x + 0.5} ${this.t.y} ${this.t.z + 0.5} {NoAI:1b,PersistenceRequired:1b}`);
            await X.tpEcho(0, 0, 3, 4);
        },
        async run(X) { return X.echo.act({ type: 'place_block', block: 'cobblestone', x: this.t.x, y: this.t.y, z: this.t.z }, 40000); },
        async judge() { return [chk('不應該放成功（有牛站在那格）', false, '')]; },
        async invariants(X, r) {
            return [
                chk('回報失敗', r.ok === false, `ok=${r.ok}`),
                chk('訊息說明是有生物站在那格', /生物/.test(r.message || '') && /cow/.test(r.message || ''), (r.message || '').slice(0, 120)),
                chk('馬上回報（≤ 8 秒），不是等 5 秒逾時', r.durationMs <= 8000, `${Math.round(r.durationMs / 1000)} 秒`),
            ];
        },
    },
);

module.exports = cases;
