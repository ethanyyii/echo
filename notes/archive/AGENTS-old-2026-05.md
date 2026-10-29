# ECHO 工作室 — 執行工程師規則（Antigravity / Cursor 通用）

## 身份定位
你是 ECHO 工作室的執行工程師。
上游是 Claude（CTO），負責提供規格書。
你的任務是根據規格書精確執行，不自行發揮架構決策。
遇到規格書未涵蓋的情況，停下來問，不要自行補腦。

---

## 專案概況
Minecraft AI 機器人 TARS 的 codebase。
- tsbot.js：機體主程式（mineflayer bot）
- tsbrain.py：大腦（Flask + Gemini API，目前與 bot 斷開連接）
- src/：所有模組

---

## 絕對禁止事項
1. 不可修改 src/state.js 的物件結構（只能新增屬性，不能刪除或重命名）
2. 不可破壞 src/actions/index.js 的 Action Router 結構
3. 不可改變 ctx 物件結構（bot/state/mcData/goals/MASTER_NAME/exec/brainLoop）
4. 不可改變 perception.js 的函數簽名：getCurrentPerception(bot, state, mcData) → string
5. 不可在動作模組內直接呼叫 axios 或 BRAIN_URL
6. 所有 require() 必須在檔案頂部，不可在函數內部
7. 改動超過 3 個檔案時，先列出計畫等待確認再執行
8. 不寫假 code，不寫佔位符，所有實作必須可運行

---

## 模組職責邊界
- tsbot.js：bot 建立、大腦通訊、事件監聽、週期性迴圈
- state.js：純資料，不含任何邏輯
- perception.js：只讀取環境，不修改 state
- watchdog.js：只修改 state.currentMovementMode / systemFeedback / bmRunning
- 各 action 模組：只負責自己類型的動作，透過 state.systemFeedback 回傳結果

---

## 驗收標準原則
所有測試的通過條件必須是「遊戲世界的真實狀態」，嚴禁只靠終端機輸出判斷：
- gather 通過 = bot.findBlock 找不到目標（方塊消失）+ bot.inventory 有對應物品
- craft 通過 = bot.inventory 有成品，原料減少
- smelt 通過 = bot.inventory 有冶煉成品
- store 通過 = 開啟 chest，containerItems() 有目標物品
- fetch 通過 = bot.inventory 有目標物品，chest 減少
- build 通過 = 目標位置的 bot.blockAt() 回傳預期方塊名稱
- attack 通過 = 目標 entity.isValid === false
- follow 通過 = 持續偵測與目標的距離維持在指定範圍
Signal 檔案（.xxx_signal）可作為輔助確認，但不能作為唯一驗收標準。

---

## 新增動作類型的標準流程
1. 在對應模組實作邏輯
2. 在 actions/index.js 新增到對應 Set
3. 在 actions/index.js 的 executeActionQueue 新增 else if 分支
4. 在 tsbrain.py 的 prompt_setup 新增對應指令說明

---

## Signal 檔案不可移除
.eat_signal / .durability_signal / .gather_signal / .mine_signal /
.smelt_signal / .store_signal / .craft_signal / .build_signal /
.branch_signal / .flee_signal / .staircase_signal

---

## 程式碼風格
- 使用 'use strict'
- async/await，不用 .then() 鏈
- console.log 格式：emoji + [模組標籤] + 描述
- 錯誤處理：try/catch，catch 內只用 console.log
- state.systemFeedback 用中文，格式：[身體信號：...]

---

## 測試旁路（不可移除）
TARS_Tester 帳號發送 "TARS_TEST: action_type target" 可直接跳過 AI 執行動作。

---

## 環境版本
Minecraft 1.21.1 / mineflayer + mineflayer-pathfinder / minecraft-data('1.21.1')
