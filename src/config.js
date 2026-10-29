// ════════════════════════════════════════════════════════
//  src/config.js — 集中設定（讀取 .env 與環境變數）
//  環境變數優先於 .env；.env 不存在時使用預設值
// ════════════════════════════════════════════════════════
'use strict';
const fs   = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');

function loadDotEnv(file) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { return; }
    for (const line of raw.split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (!m) continue;
        let value = m[2];
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (process.env[m[1]] === undefined) process.env[m[1]] = value;
    }
}

loadDotEnv(path.join(ROOT_DIR, '.env'));

const env = (key, fallback) => {
    const v = process.env[key];
    return (v === undefined || v === '') ? fallback : v;
};

const config = {
    ROOT_DIR,
    MC_HOST:     env('MC_HOST', '127.0.0.1'),
    MC_PORT:     parseInt(env('MC_PORT', '25565'), 10),
    MC_USERNAME: env('MC_USERNAME', 'ECHO'),
    MC_VERSION:  env('MC_VERSION', '1.21.1'),
    MC_AUTH:     env('MC_AUTH', 'offline'),

    MASTER_NAME: env('MASTER_NAME', ''),
    TESTER_NAMES: env('TESTER_NAMES', 'ECHO_Tester,TARS_Tester')
        .split(',').map(s => s.trim()).filter(Boolean),

    AGENT_HOST:  env('AGENT_HOST', '127.0.0.1'),
    AGENT_PROFILE: env('AGENT_PROFILE', 'core'),   // 給模型看的動作集：core（預設）/extended/commander/all，見 src/agent/schema.js
    AGENT_PORT:  parseInt(env('AGENT_PORT', '5070'), 10),
    AGENT_TOKEN: env('AGENT_TOKEN', ''),

    // 設為 1 時，每個動作與結果會追加到 logs/trajectory-YYYY-MM-DD.jsonl（可作為微調資料）
    TRAJECTORY_LOG: env('TRAJECTORY_LOG', '0') === '1',

    LLM_BASE_URL: env('LLM_BASE_URL', ''),
    LLM_API_KEY:  env('LLM_API_KEY', ''),
    LLM_MODEL:    env('LLM_MODEL', ''),
};

module.exports = config;
