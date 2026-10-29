// ════════════════════════════════════════════════════════
//  exam/ctl.js — 互動用命令列工具（一行一個指令，輸出精簡）
//
//    node exam/ctl.js obs                    精簡觀察
//    node exam/ctl.js act gather target=oak_log   執行動作（key=value，數字自動轉型，也可直接給 JSON）
//    node exam/ctl.js map [radius] [layer|top] [dy]   文字地圖
//    node exam/ctl.js events [since]         事件
//    node exam/ctl.js status | cancel
//    node exam/ctl.js actions                列出所有動作與參數
//    node exam/ctl.js note <文字> | notes    寫入／讀取筆記（玩家的長期記憶，存在 notes/world.md）
//  工程師專用（需要環境變數 CTL_ORACLE=1）：
//    node exam/ctl.js sv <伺服器指令>        透過考官執行伺服器指令（設定場景、核對真相）
//    node exam/ctl.js trace [n]              最近 n 筆動作軌跡
// ════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../src/config');

const NOTES_FILE = path.join(config.ROOT_DIR, 'notes', 'world.md');

// 會洩漏伺服器端真相或可以作弊的指令，只給旁觀的工程師用
function oracle() {
    if (process.env.CTL_ORACLE === '1') return true;
    console.log('這個指令不開放給玩家使用（它會作弊或洩漏伺服器真相）。請只用 obs / map / act / events / actions / note / notes。');
    return false;
}

const ECHO =`http://127.0.0.1:${config.AGENT_PORT}`;
const EXAM = `http://127.0.0.1:${process.env.EXAM_PORT || 5051}`;

async function call(base, method, route, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (base === ECHO && config.AGENT_TOKEN) headers.Authorization = `Bearer ${config.AGENT_TOKEN}`;
    const res = await fetch(base + route, {
        method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(600000),
    });
    const text = await res.text();
    try { return JSON.parse(text); } catch (_) { return { raw: text }; }
}

const fmtPos = p => `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`;

function printObs(o) {
    if (!o.ready) { console.log('未就緒'); return; }
    const s = o.self;
    console.log(`位置 ${fmtPos(s.position)}（所在方塊 ${s.blockPos.x},${s.blockPos.y},${s.blockPos.z}）面向${s.facing} | ${s.dimension} ${s.biome || ''} | ${o.world.isNight ? '夜' : '晝'}${o.world.raining ? ' 雨' : ''}`);
    console.log(`方塊光 ${s.lightLevel === null ? '?' : s.lightLevel}（火把等人造光，白天地表也是 0）${s.enclosure && s.enclosure.skyLight != null ? ` 天光 ${s.enclosure.skyLight}（白天地表約 15，地底 0）` : ''} 背包火把 ${s.torchesInInventory}`);
    console.log(`HP ${s.health} 食物 ${s.food}${s.oxygen != null && s.oxygen < 20 ? ' 氧氣 ' + s.oxygen : ''}${s.inWater ? ` [水中 ${s.waterSeconds}秒${s.headInWater ? '' : '，頭在水面上'}]` : ''}${s.inBubbleColumn ? ' [氣泡柱]' : ''} ${s.enclosure.underground ? '[地底，頭上實心' + s.enclosure.solidAbove + '格]' : ''} | 模式 ${s.mode} | 腳下 ${s.blockBelow}@${s.blockPos.x},${s.blockPos.y - 1},${s.blockPos.z} 頭上 ${s.blockAbove} 前方 ${s.blockAhead}/${s.blockAheadHead} | 手持 ${s.held ? s.held.name + (s.held.durabilityLeft != null ? `(耐久剩 ${s.held.durabilityLeft}/${s.held.durabilityMax})` : '') : '空手'}`);
    if (Object.keys(s.equipment).length) console.log('裝備', JSON.stringify(s.equipment));
    if (o.tools && o.tools.length) console.log('工具', o.tools.map(t => `${t.name}${t.durabilityLeft != null ? ` 剩${t.durabilityLeft}/${t.durabilityMax}` : ''}${t.held ? '(手持)' : ''}`).join(' | '));
    console.log('背包', Object.keys(o.inventory).length ? Object.entries(o.inventory).map(([k, v]) => `${k}x${v}`).join(' ') : '(空)');
    const res = Object.entries(o.resources).map(([k, v]) => `${k}:${v.block}@${fmtPos(v.position)}(${v.distance})`);
    if (res.length) console.log('資源', res.join(' | '));
    const near = Object.entries(o.nearbyBlocks).sort((a, b) => b[1].count - a[1].count).slice(0, 8).map(([k, v]) => `${k}x${v.count}`);
    if (near.length) console.log('周圍方塊', near.join(' '));
    if (o.entities.length) console.log('生物', o.entities.slice(0, 10).map(e => `${e.item ? 'item:' + e.item.name + 'x' + e.item.count : e.name}#${e.id}${e.hostile ? '!' : ''}(${e.distance})@${fmtPos(e.position)}`).join(' '));
    if (o.master) console.log(`指揮官 ${o.master.name} ${o.master.online ? (o.master.nearby ? '距' + o.master.distance : '在線但不在附近') : '不在線'}`);
    if (o.hazards.length) console.log('危險', o.hazards.join(','));
    if (o.feedback) console.log('回饋', o.feedback);
}

function printResult(r) {
    if (r.status === 'rejected') { console.log(`✗ 被拒絕 [${r.reason}] ${r.message}`); return; }
    const head = `${r.ok ? '✓' : (r.status === 'partial' ? '◐' : '✗')} #${r.id} ${r.action ? r.action.type : ''} ${r.status}${r.reason ? ' [' + r.reason + ']' : ''} (${r.durationMs}ms)`;
    console.log(head);
    if (r.summary) console.log('  摘要:', r.summary);
    if (r.message) console.log('  訊息:', r.message);
    if (r.inventoryDelta && Object.keys(r.inventoryDelta).length) console.log('  背包變化:', Object.entries(r.inventoryDelta).map(([k, v]) => `${k}${v > 0 ? '+' : ''}${v}`).join(' '));
    if (r.positionDelta && r.positionDelta.distance > 0.5) console.log(`  位移: (${r.positionDelta.dx},${r.positionDelta.dy},${r.positionDelta.dz})`);
    if (r.details) console.log('  細節:', JSON.stringify(r.details));
    if (r.toolDurability && Object.keys(r.toolDurability).length) console.log('  工具耐久（這個動作用掉的）:', Object.entries(r.toolDurability).map(([k, v]) => `${k} ${v}`).join('、'));
    if (r.interruptedBy) console.log('  被打斷:', r.interruptedBy);
    if (r.warnings && r.warnings.length) console.log('  警告:', r.warnings.join(','));
}

function parseAct(args) {
    const joined = args.join(' ');
    if (joined.trim().startsWith('{')) return JSON.parse(joined);
    const action = { type: args[0] };
    for (const kv of args.slice(1)) {
        const i = kv.indexOf('=');
        if (i < 0) continue;
        const k = kv.slice(0, i), v = kv.slice(i + 1);
        action[k] = v !== '' && !isNaN(Number(v)) ? Number(v) : v;
    }
    return action;
}

async function main() {
    const [cmd, ...rest] = process.argv.slice(2);
    switch (cmd) {
        case 'obs': {
            const o = await call(ECHO, 'GET', '/observe');
            if (rest[0] === 'json') console.log(JSON.stringify(o, null, 1)); else printObs(o);
            break;
        }
        case 'act': {
            const action = parseAct(rest);
            printResult(await call(ECHO, 'POST', '/act', { action }));
            break;
        }
        case 'map': {
            const radius = rest[0] || 8, mode = rest[1] || 'layer', dy = rest[2] || 0;
            const axisArg = mode === 'slice' ? (rest[2] || 'x') : 'x';
            const m = await call(ECHO, 'GET', `/map?radius=${radius}&mode=${mode}&dy=${dy}&axis=${axisArg}&heights=${mode === 'top' ? 1 : 0}`);
            if (m.mode === 'slice') {
                console.log(`${m.note}（中心 ${fmtPos(m.origin)}，橫軸範圍 ${m.hRange[0]}..${m.hRange[1]}，Y ${m.yRange[0]}..${m.yRange[1]}）`);
                m.rows.forEach((row, i) => console.log(String(m.yRange[0] - i).padStart(4) + ' ' + row));
                console.log('圖例:', Object.entries(m.legend).map(([k, v]) => `${k}=${v}`).join(' '));
                break;
            }
            console.log(`中心 ${fmtPos(m.origin)}  x:${m.xRange[0]}..${m.xRange[1]} (西→東)  z:${m.zRange[0]}..${m.zRange[1]} (北→南)  模式=${m.mode}${m.mode === 'layer' ? ' dy=' + m.dy : ''}`);
            if (m.note && m.note.includes('地底')) console.log('⚠️ ' + m.note);
            m.rows.forEach((row, i) => console.log(row + (m.heightRows ? '   ' + m.heightRows[i] : '')));
            console.log('圖例:', Object.entries(m.legend).map(([k, v]) => `${k}=${v}`).join(' '));
            if (m.heightNote) console.log(m.heightNote);
            break;
        }
        case 'find': {
            const f = await call(ECHO, 'GET', `/find?block=${encodeURIComponent(rest[0] || '')}&radius=${rest[1] || 32}&count=${rest[2] || 20}`);
            if (f.error) { console.log(f.error); break; }
            console.log(`找「${f.query}」半徑 ${f.radius}：${f.found} 個`);
            for (const b of f.blocks) console.log(`  ${b.name} @ ${b.x},${b.y},${b.z}  距離 ${b.distance}`);
            break;
        }
        case 'block': {
            const b = await call(ECHO, 'GET', `/block?x=${rest[0]}&y=${rest[1]}&z=${rest[2]}`);
            console.log(b.loaded === false ? `(${b.x},${b.y},${b.z}) 區塊尚未載入` : `(${b.x},${b.y},${b.z}) ${b.name}${b.solid ? ' 實心' : ''}${b.diggable ? ' 可挖' : ''}`);
            break;
        }
        case 'events': {
            const e = await call(ECHO, 'GET', `/events?since=${rest[0] || 0}&limit=50`);
            for (const ev of e.events) {
                const { id, t, type, ...r } = ev;
                console.log(`#${id} ${type} ${JSON.stringify(r)}`);
            }
            console.log(`(latestEventId=${e.latestEventId})`);
            break;
        }
        case 'status': console.log(JSON.stringify(await call(ECHO, 'GET', '/status'))); break;
        case 'cancel': console.log(JSON.stringify(await call(ECHO, 'POST', '/cancel'))); break;
        case 'actions': {
            const a = await call(ECHO, 'GET', '/actions');
            for (const act of a.actions) {
                const params = Object.entries(act.params).map(([k, p]) =>
                    `${k}${p.required ? '*' : ''}:${p.enum ? p.enum.join('|') : p.type}`).join(' ');
                console.log(`${act.name}${params ? '  ' + params : ''}  — ${act.description} [${act.mode}]`);
            }
            console.log('（* = 必填）');
            break;
        }
        case 'note': {
            if (!rest.length) { console.log('用法: note <要記住的事>'); break; }
            fs.mkdirSync(path.dirname(NOTES_FILE), { recursive: true });
            fs.appendFileSync(NOTES_FILE, `- [${new Date().toLocaleString('zh-TW', { hour12: false })}] ${rest.join(' ')}\n`);
            console.log('已記下');
            break;
        }
        case 'notes': {
            let text = '';
            try { text = fs.readFileSync(NOTES_FILE, 'utf8'); } catch (_) {}
            console.log(text.trim() ? text.trim().split('\n').slice(-80).join('\n') : '(還沒有筆記)');
            break;
        }
        case 'feedback': {
            // 玩家邊玩邊記下「這個 API 哪裡難用／驚訝／缺什麼」，不用等到最後才回報
            const kind = rest[0];
            const kinds = ['驚訝', '缺少', '難用', '錯誤', '建議'];
            if (!kinds.includes(kind) || rest.length < 2) { console.log(`用法: feedback <${kinds.join('|')}> <說明>`); break; }
            let lastId = '-';
            try { const st = await call(ECHO, 'GET', '/status'); lastId = st.last ? `#${st.last.id} ${st.last.action ? st.last.action.type : ''}` : '-'; } catch (_) {}
            const file = path.join(config.ROOT_DIR, 'notes', 'feedback.md');
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.appendFileSync(file, `- [${new Date().toLocaleTimeString('zh-TW', { hour12: false })}] (${kind}｜上一個動作 ${lastId}) ${rest.slice(1).join(' ')}\n`);
            console.log('已記錄');
            break;
        }
        // ── 以下是工程師（旁觀者）專用：會洩漏真相或作弊，需要 CTL_ORACLE=1 ──
        case 'sv': {
            if (!oracle()) break;
            const r = await call(EXAM, 'POST', '/cmd', { command: rest.join(' ') });
            console.log((r.lines || [JSON.stringify(r)]).join('\n'));
            break;
        }
        case 'trace': {
            if (!oracle()) break;
            const n = parseInt(rest[0] || '15', 10);
            const dir = path.join(config.ROOT_DIR, 'logs');
            const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.startsWith('trajectory-')).sort() : [];
            if (!files.length) { console.log('沒有軌跡檔（ECHO 需以 TRAJECTORY_LOG=1 啟動）'); break; }
            const lines = fs.readFileSync(path.join(dir, files[files.length - 1]), 'utf8').trim().split('\n').slice(-n);
            for (const line of lines) {
                const e = JSON.parse(line);
                const r = e.result || {};
                const time = new Date(e.t).toLocaleTimeString('zh-TW', { hour12: false });
                const inv = r.inventoryDelta && Object.keys(r.inventoryDelta).length
                    ? ' Δ' + Object.entries(r.inventoryDelta).map(([k, v]) => `${k}${v > 0 ? '+' : ''}${v}`).join(',') : '';
                console.log(`${time} #${r.id} ${JSON.stringify(e.action)} → ${r.ok ? 'ok' : 'FAIL[' + r.reason + ']'} ${r.durationMs}ms${inv}${r.message ? ' | ' + r.message : ''}`);
            }
            break;
        }
        default:
            console.log('用法: obs [json] | act <type> k=v... | map [radius] [layer|top] [dy] | find <方塊名> [半徑] [數量] | block x y z | events [since] | actions | note <文字> | notes | status | cancel');
    }
}

main().catch(e => {
    if (/fetch failed|ECONNREFUSED|ECONNRESET/i.test(e.message)) console.log('ctl 錯誤：連不上 ECHO 的 Agent API（ECHO 可能和遊戲斷線了、程式停了或正在重新啟動）。等 10～20 秒再試一次；一直不行就先回報這個狀況。原始訊息:', e.message);
    else console.log('ctl 錯誤:', e.message);
    process.exit(1);
});
