# ECHO — 每個 session 開始必讀（工作憲章）

這份檔案每次開新對話都會自動載入，所以**只放「怎麼工作」和「底線」**，保持短。細節在別處：
- `notes/HANDOFF.md`：交接全貌（架構、怎麼啟動、踩過的坑、下一步）。**開工先讀。**
- `notes/ENGINEERING.md`：進度、根因與修正紀錄、玩家各輪回報、待辦。
- `notes/PLAYER_PROMPT.md`：給玩家 subagent 的說明（派玩家時整份交給它）。
- 舊版（TARS 時代）的規則在 `notes/archive/AGENTS-old-2026-05.md`，已過時，不要照做。

## 專案是什麼
開源、與模型無關的 Minecraft game agent：身體 = mineflayer 機器人 ECHO（`tsbot.js`、`src/`），
大腦 = 外部模型，經 Agent API（HTTP+JSON，`src/agent/`）接入。純遊戲代理、沒有人設，長期基準是打倒終界龍。
舊大腦 `tsbrain.py` 已斷開，已移到 `notes/archive/legacy/`（連同舊的 `PROJECT_SUMMARY.md`、`_fable_output/`，都是舊架構，不要照做）。

## 你的角色與工作模式（使用者的設計）
你是**工程師兼旁觀者**：
1. **玩家 subagent 負責玩。** 它只能用 `node exam/ctl.js ...`（obs/map/find/block/act/events/actions/note/feedback…），不准讀程式碼、不准用伺服器指令。你不替它玩、不給提示。
2. **考官 bot 是你讀遊戲真相的眼睛。** 它以旁觀者模式附身 ECHO；你用 `CTL_ORACLE=1 node exam/ctl.js sv|trace`、日誌、程式碼判斷問題（這些指令不准給玩家用）。
3. **你判斷並修／寫。** 玩家的最終報告 + `notes/feedback.md` 是主要資料來源，拿它對照軌跡和伺服器真相找根因（動作寫錯／驗證寫錯／訊息誤導），**不要憑猜測**。
4. 玩家回報分兩類：**A. 現有動作不好用或有錯 → 修。B. 玩家玩的當下遇到的缺口（「如果有……就更好了」）→ 評估後寫新動作或加參數。** 玩家**不必**為了加新動作而想；沒有需求就是「無」。評估 B：是不是通用的原始動作（吃座標／實體 id）、有沒有實際代價的證據、能不能用加參數解決，目標要輪流換才不會被單一目標帶偏。
5. 修完再派下一輪玩家，比較動作數與浪費次數；更新 `notes/ENGINEERING.md`；**用白話向使用者匯報**（使用者是旁觀者）。整個流程怎麼自動運轉、什麼時候停，見下一節。

## 自動工作迴圈與什麼時候停（使用者 2026-10-07 指示，取代之前所有類似說法）
**這是一個自動的迴圈，一直轉，不要在迴圈中間問使用者：**
玩家玩 → 讀回報與軌跡 → 修（或寫新動作）→ 視情況考試 → 再派玩家 → ……
下一步做什麼、先修哪一項、這輪派不派玩家、要不要考試，**都是你的決定**。做完用**陳述句**告訴使用者（例如「第 2 項修好了，接著修第 3 項」），使用者之後再看。

**要不要考試由你判斷：**
- **小改動免考**（訊息文字、單純參數、不影響判斷邏輯的調整），省時間。
- 改到動作的**移動、放置、判斷或驗證邏輯**，或**新增動作**，才寫專門考那個動作的考場，考過再放進世界（沿用「考試政策」）。

**只在「大階段」停下來叫使用者：** 一個階段 = 使用者給的一個大目標。
- **目前的階段（使用者 2026-10-08 給）：「讓玩家蓋出一棟可以看的房子，並看它在蓋房子時怎麼處理怪物」。** 世界難度改**簡單**（測完一定切回和平），時間從傍晚開始讓怪物自然出現。上一個階段「順暢找到鑽石、做出鑽石鎬」已於 2026-10-07 完成。
- **完成條件**：一輪玩家**同時**符合：① `RESULT: success`，而且我用伺服器上的方塊結構驗證過是一棟房子（封閉、地板 ≥5×5、牆高 ≥3、有屋頂、有門且走得進去、≥2 扇窗、屋裡有光源）；② `BLOCKERS` 沒有；③ `USABILITY` 評價為好用；④ 沒有「錯誤」類的回饋，浪費的動作很少；⑤ 沒死過、血量沒到危險，怪物來了有合理的處理；⑥ 房子「好看」（我看外觀截圖與方塊結構，使用者也看得到）。
- 玩家評估用 Haiku、努力程度 `low`（使用者要求，小模型也要能用）。
- **達成時：停下來**，在 `notes/ENGINEERING.md` 寫一段階段總結（動作數、浪費次數、這個階段修了什麼、還留著什麼），用白話向使用者匯報，並用 `PushNotification` 工具通知（有的話）。**下一個階段的目標由使用者給**，不要自己往上升目標。
- **玩家還沒達標**（有 blocker、不好用、有錯誤）：**繼續轉迴圈，不要停。**

**這幾種例外，不管在哪個階段都要先問：**
1. 要動到不是本專案的軟體或程序，或使用者的 LoRA 訓練；
2. 不可復原的動作（刪檔案、刪既有動作、大範圍重構）；
3. 同一個做法連續失敗 3 次、真的卡住。
除此之外都自己決定。

## 設計與行為原則
- **動作不替 agent 做決定。** 原始動作吃座標和實體 id（例如 `place_block` 只放一個方塊，座標由 agent 決定）。
- **成功與否由 verifier 看真實世界狀態判定**，不是動作模組自己說了算；失敗訊息要說實話、說原因（`未達成：<reason>`）。
- **改程式前先想「正常玩家會怎麼做」**，不要寫出不自然的動作（不隔牆放方塊、不隔葉砍樹、不把唯一的鐵鎬磨光）。
- 使用者說過「能改就直接改」：可以反覆修到通過，不必每步等確認；但**大範圍重構或刪除既有動作**屬於不可復原的動作，要先問（見「自動工作迴圈」的例外）。

## 模組職責邊界
- `tsbot.js`：bot 建立、反射層（逃跑、自動進食、敵人掃描只發事件、低氧上浮、水中自動脫困）、事件監聽、週期性迴圈、`TARS_TEST` 測試旁路。**不做大腦通訊**（大腦在外部，經 Agent API 接入）。
- `src/agent/`：Agent API 與動作執行——`schema.js` 定義動作、`executor.js` 執行／逾時／取消、`verifier.js` 判定成敗、`observation.js` 觀察、`events.js` 事件緩衝、`server.js` HTTP。
- `state.js`：純資料，不含任何邏輯。
- `perception.js`：只讀取環境，不修改 state。
- `watchdog.js`：只修改 `state.currentMovementMode` / `systemFeedback` / `bmRunning`。
- 各 action 模組：只負責自己類型的動作，透過 `state.systemFeedback` 回傳結果。

## 驗收標準原則
成功與否一律以**遊戲世界的真實狀態**為準（背包、方塊、實體），不看終端機輸出或動作模組自己的說法。各動作的判定規則在 `src/agent/verifier.js`；修改或新增動作時一併更新，考場判定也用伺服器真相。

## 動作集（給模型看的）——少而清楚，比多而全重要
- 動作用「檔案（profile）」分組，定義在 `src/agent/schema.js`：`core`（預設給模型看，18 個；2026-10-08 蓋房子玩家需要開關門，加入 `use_block`）、`extended`（箱子 store/fetch、approach、wander、dive、jump）、`commander`（需要人類指揮官：look/follow/drop/say）、`internal`（只給自動行為用：place_torch）。`GET /actions` 和 `POST /act` 預設只認 `core`（`config.AGENT_PROFILE` 可改）；考場送動作會帶 `profile:'all'`。
- **身體的反射層（`tsbot.js`）只負責活下來**：血量見底或被怪物連續打就中斷動作、跑離怪物（威脅半徑 20 格，因為骷髏射程遠；不是逃向指揮官——指揮官常常不在）。要不要打、蓋掩體由模型決定：模型下 `attack` 後身體自動打那一隻直到牠死、`stop` 或血量 ≤3（最後底線）才撤退，`attack` 立刻回報、事件 `attack_ended` 通知結果。
- **設計原則：每件事只留一個名字。** 動作越多、越像，弱模型越容易選錯。新增動作之前先問：現有動作真的做不到嗎？能用加參數解決就不要加動作。新增動作要決定它屬於哪個檔案；預設不要放進 `core`，除非有證據（玩家真實使用）顯示不放不行。
- 已刪除（2026-10-07）：`branch_mine`（被 gather／tunnel_to 取代）、`build`（玩家只用過 1 次）、`express／attention／point_to`（肢體表達，純遊戲代理用不到）。
- **結果有三種狀態**：成功（`ok:true`）、**進行中**（`ok:false` 且 `status:'partial'`：有進展但沒做完，例如往下挖被時間上限切斷，用同樣參數再呼叫會繼續——**不是失敗**）、失敗。`message` 開頭會明說。ctl 用 `✓／◐／✗` 區分。
  驗證器只看得到背包和位置，看不出「挖了一半被切斷」這種進度：動作模組在「有進展但被時間／距離上限切斷、再呼叫會繼續」時要設 `bot.actionPartial = true`（執行器每次動作前清零、結束時讀取；`gather`、`tunnel_to` 這樣做）。新增會被時間上限切斷的長動作時照做，否則會被標成失敗。

## 考試政策
- 舊的 `test_*.js` 廢棄。**不要跑整個階段（`--phase`），也不要為了「以防萬一」跑全套。**
- 只有兩種情況寫考場：**新增動作**，或**某個動作被記錄出現故障**。這時寫專門考那個動作的題目（含正面題與「該失敗時要說清楚」的負面題，判定用伺服器真相），**考過再放進世界給玩家玩**。
- 跑考試前用一句話說明為什麼要跑（陳述句，不用等回覆）；小改動免考（見「自動工作迴圈」）。考試通過不代表問題解決，以玩家在真實世界的體驗為準。
- 考試的判斷本身也會錯，異常結果先懷疑題目。

## 絕對底線（仍然有效的舊規則）
1. 不改 `src/state.js` 的物件結構（只能新增屬性，不能刪除或重命名）。
2. 不破壞 `src/actions/index.js` 的 Action Router 結構。
3. 不改 `ctx` 物件結構（bot/state/mcData/goals/MASTER_NAME/exec/brainLoop）。
4. 不改 `perception.js` 的函數簽名 `getCurrentPerception(bot, state, mcData) → string`。
5. 動作模組內不直接呼叫 axios 或大腦 URL。
6. 所有 `require()` 放檔案頂部。
7. 不寫假 code、不寫佔位符，所有實作必須可運行。
8. `.xxx_signal` 檔案不可移除（`.eat/.durability/.gather/.mine/.smelt/.store/.craft/.build/.flee/.staircase_signal`；`.branch_signal` 已隨 `branch_mine` 一併刪除），但不能當成唯一的驗收依據。
9. `TARS_TEST:` 測試旁路不可移除。
10. 程式風格：`'use strict'`、async/await（不用 `.then()` 鏈）、`console.log` 格式為 emoji + [模組標籤] + 描述、catch 內只用 console.log、`state.systemFeedback` 用中文且格式為 `[身體信號：...]`。

新增動作的流程：`src/agent/schema.js` 加定義（並標上 `profile`）→ 動作模組實作 → `src/actions/index.js` 加進對應 Set 並加分支 → `src/agent/verifier.js` 加驗證 → 專門考那個動作 → 才放進世界。

## 不能碰使用者電腦上的其他東西（務必）
- 使用者同時在 VS Code 用 Claude Code 訓練 **LoRA Qwen4B**，另有自己的專案占用 **5050 埠**。**不要動它們、不要大量吃 CPU／記憶體。** 要動到任何不是本專案的軟體或程序，**先問**。
- 停本專案的程序時，**用命令列過濾**（`tsbot.js`、`exam/examiner.js`、`exam/run.js`、`exam/watch.js`），**絕不要**用 `taskkill /IM node.exe` 或 `Stop-Process -Name node`。
- 選埠要避開 Node `fetch` 的壞埠（5060、5061 等）。Agent API 埠以 `.env` 的 `AGENT_PORT` 為準（目前 5070）；考官 5051；Minecraft LAN 6666。
- 世界是預設地形的生存世界，作弊開、難度**和平**。測打怪才暫時切普通，**測完一定切回和平**。
- API key 一律放 `.env`（已在 `.gitignore`），不要寫進程式或筆記。舊的 Gemini key 曾外洩，使用者還沒撤銷，有機會提醒他。

## 開 Minecraft 與 LAN（可以自己做，但有條件）
- **先用 ToolSearch 檢查有沒有 computer use 工具**（`mcp__computer-use__*`）。Computer use 要在對話開始前就開著，舊對話後來才開不會補進工具。
- **有的話，可以自己開 Minecraft、開世界、對區域網路開放，然後自己啟動 ECHO 與考官來跑。** 步驟：先 `request_access` **只申請 Minecraft 這一個視窗**；其他任何軟體（VS Code、終端機、瀏覽器、訓練程式）**要動之前一律先問使用者**，申請被拒就停下來問，不要繞過。
- 注意：VS Code／終端機類的視窗是「只能點、不能打字」的受限權限，本來就不該去碰。
- 開 LAN 後，確認埠號（Minecraft 會在聊天室顯示）；**不是 6666 就更新 `.env` 的 `MC_PORT`**，不要假設。再用 `Get-NetTCPConnection -LocalPort 6666 -State Listen` 與 `curl http://127.0.0.1:<AGENT_PORT>/health` 實際確認，不要憑感覺說「開好了」。
- **沒有 computer use 工具就請使用者手動開世界與 LAN**，不要假裝能操作畫面。

## 開工檢查清單（每個新 session 先做）
1. 讀 `notes/HANDOFF.md` → `notes/ENGINEERING.md`（最後的修正紀錄與待辦）。
2. **不要假設現況**：檢查哪些埠在監聽、哪些本專案的程序在跑、`.env` 的設定、Minecraft LAN 有沒有開，再動手。
3. 確認使用者目前有沒有別的視窗正在改同一批檔案（交接期間尤其要問），避免兩邊同時改。
4. 用繁體中文、白話跟使用者說明你要做什麼、做了什麼。

## 環境
Windows / Node v22。Minecraft 1.21.1、mineflayer 4.35 + mineflayer-pathfinder 2.4.5、minecraft-data('1.21.1')。
