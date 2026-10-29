# 交接檔（給接手的新視窗）

寫於 2026-10-07。上一個視窗的對話被壓縮過好幾次，**這份檔案加上 `notes/ENGINEERING.md` 就是完整的記憶**，不要指望對話歷史。

## 0. 先照這個順序讀

1. 這份檔案（全部）。
2. `notes/ENGINEERING.md`：根因與修正表、第 1～5 輪玩家回報、**第 5 輪之後的 10 項待辦（依優先序）**。
3. `notes/PLAYER_PROMPT.md`：派玩家 subagent 時要整份交給它。
4. 要改哪個模組，再讀那個檔：`src/agent/schema.js`（動作定義的唯一來源）、`executor.js`、`verifier.js`、`observation.js`，動作在 `src/actions/`。
5. 先讀 `CLAUDE.md`（工作憲章，每次開新對話會自動載入，通常已經在你的 context 裡）。不要先讀 `notes/archive/legacy/` 裡的東西（舊的 tsbrain.py、PROJECT_SUMMARY.md、_fable_output/）：它們是舊架構，已經過時（見 §7）。

## 1. 專案是什麼、要去哪

資料夾：專案根目錄。Minecraft 機器人 ECHO（mineflayer，MC 1.21.1）。

使用者要把它變成**開源、與模型無關的 Minecraft game agent**：純遊戲代理、沒有人設，之後接自己訓練的本地模型，長期基準是**打倒終界龍**。

已經談定的分工：**身體（bot、動作、反射、感知）保留並加強，大腦換成外部模型，經由 Agent API（HTTP+JSON）接入。**
舊大腦 `tsbrain.py`（Gemini）已經與 bot 斷開，已移到 `notes/archive/legacy/`，不再使用。之後要做一個 Node 的參考大腦（OpenAI 相容），還沒開始。

**動作設計原則（使用者明確要求）：動作不能替 agent 做決定。** 原始動作吃座標和實體 id，例如 `build` 應只放一個方塊、座標由 agent 決定（`place_block` 已做出來）。動作的成功與否由 verifier 看**真實世界狀態**判定，不是看動作模組自己說了什麼。

## 2. 使用者偏好與限制（務必遵守）

- 用**繁體中文**，白話說明。使用者是旁觀者，不一定想看技術細節；他睡前／離開前會要求「白話匯報你做了什麼」。
- **改程式前先想「正常玩家會怎麼做」**，不要寫出不自然的動作（這次就抓到「隔著岩壁放工作台」）。
- **不要每改一次就跑一大堆考試。** 玩家的回報才是主要資料來源。考場只在「新增動作」或「某個動作被記錄出問題」時，才寫專門考那個動作的題目，考過再放進世界玩（見 §5.1）；小改動免考；跑之前用一句話說明為什麼要跑（陳述句，不用等回覆）。
- 玩家可以提「如果有……就更好了」，我評估後寫新動作；但**玩家不必為了加新動作而想**，沒有需求就寫「無」（見 §5）。
- 使用者說過「能改就直接改」，可以反覆修到通過；但 `CLAUDE.md` 的「絕對底線」仍然有效。
- **絕對不要動使用者電腦上其他的東西。** 使用者正在 VS Code 裡用 Claude Code 訓練 **LoRA Qwen4B**，另外 **5050 埠被他的另一個專案占用**（所以本專案的 Agent API 已改成 **5070**）。要動到任何不是本專案的軟體或程序，一律先問。
  - 停掉本專案的程序時，**一定要用命令列過濾**（`tsbot.js`、`exam/examiner.js`、`exam/run.js`、`exam/watch.js`），**不要**用 `taskkill /IM node.exe` 或 `Stop-Process -Name node`，那可能殺到他別的 Node 程式。
  - 不要大量吃 CPU／記憶體，訓練在跑。
- 世界是**預設地形的生存世界，LAN 埠 6666，主機 127.0.0.1**，作弊開啟，難度預設**和平**。測打怪時才暫時切普通，**測完一定要切回和平**。
- 舊的 Gemini API key 曾經外洩，已從程式移除，**使用者還沒去撤銷**，有機會提醒他。`.env` 的 LLM 欄位刻意留空，使用者自己填。
- 使用者說過他想讓我用 computer use 自己開 Minecraft 和 LAN。**舊視窗沒有 computer use 工具**（Computer use 是在那個對話開始之後才打開的）。新視窗先用 `ToolSearch` 查有沒有 `mcp__computer-use__*`；有的話只申請 Minecraft 這一個視窗，其他軟體要動之前先問使用者。沒有的話，請使用者手動開世界並「對區域網路開放」，埠號要是 6666。

## 3. 架構一頁

```
tsbot.js            bot 建立、反射層（逃跑、自動進食、敵人掃描只發事件、低氧上浮、水中自動脫困）、TARS_TEST 測試旁路
src/config.js       讀 .env：MC_HOST/PORT/USERNAME, MASTER_NAME, AGENT_HOST/PORT/TOKEN, TRAJECTORY_LOG, LLM_*
src/state.js        純資料（只能新增屬性）
src/actions/*       動作實作；index.js 是 Action Router；tools.js 是共用工具（selectTool、collectDrops、placeUnderFeet、torchHabit…）
src/agent/
  schema.js         所有動作的定義（參數、型別、逾時、模式、profile 檔案），也產生 /actions（預設只列 core 18 個；其餘動作分在 extended／commander／internal，見 CLAUDE.md「動作集」）
  executor.js       執行動作：驗證參數→忙碌鎖→逾時→取消→等身體停穩→交給 verifier→組訊息→寫軌跡
  verifier.js       用真實世界狀態判定 ok/reason（失敗訊息開頭是「未達成：原因」，後面接動作模組自己的說法）
  observation.js    /observe、/map、/find、/block
  events.js         事件環形緩衝（500 筆），長輪詢
  server.js         HTTP：GET /health /actions /observe /map /find /block /status /events；POST /act /cancel；預設只綁 127.0.0.1
exam/
  ctl.js            玩家用的命令列（obs map find block act events actions note notes feedback status cancel）；
                    `CTL_ORACLE=1` 才開放 sv（伺服器指令）、trace（軌跡），玩家不准用
  examiner.js       考官 bot + 控制 API（5051）：伺服器真相查詢、/cmd、/attach、/arena/reset
  run.js            考試執行器：--phase 1..6|all、--only a,b、--list
  cases.js          考題（第 1～6 階段）
  watch.js          監看器：ECHO 卡水、溺水、血量低、動作太久、位置不動、連續失敗／同一失敗迴圈、閒置太久、死亡、斷線
notes/              ENGINEERING.md（進度）、PLAYER_PROMPT.md、feedback.md（玩家邊玩邊記）、world.md（玩家筆記）、archive/（舊輪次）
logs/               軌跡 JSONL（TRAJECTORY_LOG=1）、考試報告 JSON（被 .gitignore 忽略）
```

ActionResult 欄位：`{id, ok, status, action, reason, message, evidence, details, durationMs, inventoryDelta, positionDelta, healthDelta, interruptedBy, warnings}`。

## 4. 怎麼啟動／停止（Windows，這台機器）

先確認埠：Agent API = **5070**，考官 = **5051**，Minecraft LAN = **6666**。

啟動 ECHO（背景、隱藏視窗，在專案根目錄）：
```powershell
$env:TRAJECTORY_LOG='1'
Start-Process -FilePath node -ArgumentList 'tsbot.js' -RedirectStandardOutput "$env:TEMP\echo_out.log" -RedirectStandardError "$env:TEMP\echo_err.log" -WindowStyle Hidden
```
健康檢查：`curl http://127.0.0.1:5070/health` 應回 `{"ok":true,"spawned":true,"username":"ECHO",...}`。

啟動考官（玩家模式＝旁觀者附身 ECHO，伺服器只多載入一個區域）：
```powershell
$env:EXAM_MODE='play'
Start-Process -FilePath node -ArgumentList 'exam/examiner.js' -WindowStyle Hidden
```
**跑 `exam/run.js` 考試時，ECHO 的 `MASTER_NAME` 要設成 Examiner**，否則需要「指揮官」的題目會被跳過。

停止：用 `Get-CimInstance Win32_Process -Filter "Name='node.exe'"` 列出命令列，**只停命令列含 `tsbot.js` 或 `exam/` 的那幾個**。

**使用者（人類）附身 ECHO：**使用者要在旁觀者模式附身 ECHO，否則兩人離太遠伺服器要同時載入兩塊區域而卡頓。
- 考官（`exam/examiner.js`）每 8 秒檢查一次：使用者（`FOLLOW_USER`，預設 `.env` 的 `MASTER_NAME`）**已經是旁觀者**、而且離 ECHO 超過 4 格，就自動下 `/spectate ECHO <使用者>`。ECHO 重連／重生後使用者會掉出附身，現在不用手動點滑鼠。不會把非旁觀者模式的玩家硬切成旁觀者。
- 第一次要手動做：`POST /cmd` 送 `gamemode spectator <使用者>`，再 `spectate ECHO <使用者>`（`tp` 不會讓旁觀者脫離附身）。
- 區網開「允許命令：開」時，**所有玩家都有 OP**，所以考官不需要另外 `/op Examiner`。

**開遊戲的實務（computer use）：**Minecraft 遊戲視窗裡**滑鼠點按鈕常常沒反應**（點世界清單的項目有效，點底下的按鈕無效）。改用鍵盤：`Tab` 移焦點、`Return` 按下。注意在「建立新世界」畫面，焦點在世界名稱欄時按 `Return` 會直接建立（用預設值：普通難度、命令關）。LAN 畫面：Tab 到「允許命令」按 Return 切成開 → Tab 到連接埠欄位輸入 6666 → Tab 到「開始 LAN 世界」按 Return。啟動器的「Play」按鈕要先把視窗最大化才看得到。

**開新的一輪玩家回合：直接用 `powershell -File exam/new_round.ps1 -Time 4000 -Difficulty easy -Round <編號>`**（封存回饋、重啟 ECHO、考官切玩家模式、清怪、換新乾地點並設重生點、確認三人同座標）。之後用 Monitor 跑 `node exam/watch.js`、用 Agent 派玩家。**玩家回合開始前一定要重啟 ECHO**（否則上一個考試殘留的回饋會出現在 obs，且載入不到最新程式）。蓋房子這類階段：**早上起跑**（`-Time 2000～4000`），夜晚自然降臨在蓋的途中；從夜晚空手起跑沒有人能活。
動作與反射的現況：`attack` 立刻回報、身體自動打到那隻死或 stop；撤退反射先逃、模型下新動作就接手；ATTACK_FLOOR_HP=5。考官在考試模式時留在考場，**手動測試把 ECHO 開到別處時要讓考官也附身**（`gamemode spectator Examiner`＋`spectate ECHO Examiner`），否則伺服器要同時載入兩塊區域而卡頓。

把 ECHO 從考場送回真實世界、準備玩家回合（透過考官 5051 的 `POST /cmd`，body `{"command":"..."}`）：
`clear ECHO`、`effect clear ECHO`、`spreadplayers 0 0 0 300 false ECHO`、`gamemode survival ECHO`、`time set day`，再 `POST /attach`。
玩家回合前把 `notes/feedback.md`、`notes/world.md` 先複製到 `notes/archive/` 再清空。

派玩家：用 Agent 工具開 general-purpose subagent、背景執行，prompt 要它先讀 `notes/PLAYER_PROMPT.md`，並說明 `{MILESTONE}`、`{BUDGET}`（前幾輪：鑽石鎬、200 次）。指令在專案根目錄用 `node exam/ctl.js ...`。同時用 Monitor 工具跑 `node exam/watch.js`（上限 30 分鐘，要重新武裝）。
監看器的 `REPEATED_FAILURES` 常常只是玩家在試錯，**先看 `CTL_ORACLE=1 node exam/ctl.js obs` 和最新 `logs/trajectory-*.jsonl` 再決定要不要介入**，不要一報警就動手。

## 5. 工作迴圈

角色分工：**玩家 subagent 負責玩；考官 bot 是我讀遊戲真相的眼睛；我是旁觀者兼工程師，負責判斷與修／寫。**

**這是一個自動的迴圈，一直轉，不要在迴圈中間問使用者**（玩家玩 → 讀回報與軌跡 → 修／寫新動作 → 視情況考試 → 再派玩家 → ……）。下一步做什麼、先修哪一項、這輪派不派玩家、要不要考試，都是我的決定，做完用陳述句告訴使用者。**只在「大階段」完成、或碰到例外時才停**，完整規則見 `CLAUDE.md` 的「自動工作迴圈與什麼時候停」。

1. 玩家玩一輪（我不介入，除非真的卡死／危險）。**不需要準備考場**，直接在真實世界玩。
2. 讀玩家最終報告 + `notes/feedback.md` + 軌跡，找根因，**用軌跡與伺服器真相驗證，不要憑猜測**（上次我追了一個假線索；craft 那題我猜是驗證太早，真相是 mineflayer 連續合成會丟成品）。
3. 玩家的回報分兩類，各自處理：
   - **A. 現有動作不好用／有錯**（動作寫錯、驗證寫錯、訊息誤導）：修。
   - **B. 玩家在玩的當下遇到的缺口（「如果有……就更好了」）**：評估後寫新動作或加參數。**不是每個願望都要做，我來過濾：**
     1. 是不是通用的原始動作（吃座標／實體 id），而不是替 agent 做決定的大動作？
     2. 有沒有證據（玩家多花幾次 act、軌跡裡的浪費、做不到）？
     3. 能不能用現有動作加參數解決？能就先加參數。
     4. 不要只被單一目標帶偏：目標要輪流換（鑽石鎬只會暴露挖礦的缺口，打龍還要下界、戰鬥、遠程、搭橋）。
   - 玩家**不需要**為了加新動作而去想，沒有需求就寫「無」。
4. 修／寫程式。新動作的流程見 §7（schema → 動作模組 → router → verifier）。
5. **考試政策（見 §5.1）**：**小改動免考**（訊息文字、單純參數、不影響判斷邏輯的調整）；改到動作的移動、放置、判斷或驗證邏輯，或新增動作，才寫專門考那個動作的考場，考過再放進世界讓玩家玩。
6. 重啟 ECHO，**直接派下一輪玩家**，比較動作數與浪費次數：第 1 輪 27（鐵鎬）、第 2 輪 99、第 4 輪 78、第 5 輪 46（鑽石鎬）、第 6 輪 25（鐵劍＋桶＋打火鐮）。
7. 更新 `notes/ENGINEERING.md`，用陳述句向使用者白話匯報（不是提問）。
8. **階段完成才停**：一輪玩家同時 `RESULT: success`、`BLOCKERS` 沒有、`USABILITY` 好用、沒有「錯誤」類回饋且浪費很少，就停下來寫階段總結、匯報並 `PushNotification`；下一個階段的目標由使用者給。沒達標就繼續轉。

### 5.1 考試政策（使用者 2026-10-07 明確指示）

- **原本專案裡的舊考試（根目錄 `test_*.js`）基本廢棄**：太弱，不要花時間在它上面。
- **不要再跑整個階段（`--phase`）、也不要為了「以防萬一」跑全套。** 現在玩家可以直接進真實世界玩，不需要準備考場。
- **考場只在兩種情況寫：**
  1. 新增了動作；
  2. 某個動作被玩家／軌跡記錄出現故障或有問題。
  這時寫一組**專門考那個動作的考場**（只考它，含正面題與「該失敗時要說清楚原因」的負面題，判定用伺服器真相），**考過再放進世界給玩家玩**。
- `exam/cases.js` 的第 1～6 階段保留當成**可重用的題目範本與基礎設施**（`exam/examiner.js`、`exam/run.js --only ...` 仍可用），不是例行回歸；需要時用 `--only` 挑相關的幾題，跑之前用一句話說明為什麼要跑（陳述句，不用等回覆）。階段 7～9 是新寫的專門考場（staircase 洞穴、gather、craft 缺材料）。
- 考試通過只代表「動作在受控環境做得對」，**不代表問題解決**，最後仍以玩家在真實世界的體驗為準。

## 6. 現況（交接當下）

- 第 6 階段考題 9 題全過；`tool_frugality_cheap_block`、`craft_pickaxe_auto_table` 也過。第五輪玩家成功（約 46 次動作）。
- Agent API 埠：**以 `.env` 的 `AGENT_PORT` 為準（目前 5070）**。曾經改成 5060，但那是 Node `fetch` 的壞埠、`ctl.js` 連不上，所以換成 5070；選埠要避開 fetch 的壞埠清單。考官的 5051 沒改。
- **程序是否在跑、修到哪一項，以 `notes/ENGINEERING.md` 最後的「2026-10-07 修正紀錄」與實際檢查為準**（先 `curl` 健康檢查、看哪些埠在監聽，不要假設）。
- 交接當下沒有半成品；上一輪最後改的是 `placement.js`（放置要有視線）、`gather.js`（挖通道到礦旁邊 range:1）、`exam/cases.js`（兩題判斷修正）。

## 7. 已過時、不要照做的東西

- `notes/archive/legacy/PROJECT_SUMMARY.md` 與 `notes/archive/AGENTS-old-2026-05.md` 描述的是舊的「TARS + 大腦」架構。**現行底線一律以 `CLAUDE.md` 的「絕對底線」為準**（不改 `src/state.js` 的結構、不破壞 Action Router、不改 `ctx` 與 `perception.js` 簽名、動作模組不用 axios、`require()` 放檔案頂部等；舊的「改超過 3 個檔案要先列計畫」已取消）。**已經不適用**：「大腦通訊」「prompt_setup」「新增動作要改 tsbrain.py」（tsbrain.py 已移到 notes/archive/legacy/）。新增動作的現行流程是：`schema.js` 加定義 → 動作模組實作 → `actions/index.js` 加進對應 Set 並加分支 → `verifier.js` 加驗證。
- 各種 `.xxx_signal` 檔案仍保留（不可移除），但**不能當成唯一的驗收依據**。
- 舊的 `tsbrain.py`、`PROJECT_SUMMARY.md`、`_fable_output/` 已在 2026-10-07 移到 `notes/archive/legacy/`（根目錄的舊 `test_*.js` 早就不在了）：舊的，別理它。

## 8. 下一步（依優先序，細節在 ENGINEERING.md）

**目前的階段：讓玩家順暢地找到鑽石、做出鑽石鎬，而且體驗好**（完成條件見 `CLAUDE.md`）。迴圈自動轉，下一步由我自己決定。進度以 `notes/ENGINEERING.md` 最後的「待辦現況」為準：
1. ~~craft 驗證競態~~ ✅　2. ~~staircase 開闊洞穴~~ ✅　3. ~~gather 逾時不說做了什麼~~ ✅（根因是 tunnel.js 往下挖階梯沒挖開頭頂）　~~obs 假的 low_oxygen／地底~~ ✅　~~tunnel_to 停滯~~ ✅。
4. 未做：gather 的 `count` 對樹木（log）；goto 失敗訊息別一律猜「在水裡」；`events` 過濾考官的 setup 聊天；純走到任意座標（必要時挖／搭橋）的動作。
5. 長期：原始動作重構（`break_block`、`use_item`、`use_block`、`equip` 加 slot、`sleep`、容器依座標操作、`shoot`、`bridge`、傳送門、打龍巨集）、配方依賴圖 `/plan`、去指揮官化（flee/follow/drop 現在假設有人類主人）、Node 參考大腦、開源準備（README、授權、清掉 TARS/ECHO/Kamie 命名）。

## 9. 踩過的坑（省你重蹈覆轍）

- mineflayer yaw 0 = 朝北，`dx = -sin(yaw)`、`dz = -cos(yaw)`。`/tp ... facing` **不會**更新 mineflayer 的 yaw，要用明確的旋轉角度。
- `bot.findBlock` 的 `matching` 若讀 `b.position` 必須加 `useExtraInfo: true`。
- 客戶端光照資料對載入後被改過的方塊是**過期**的（石頭下面天光還是 15）；判斷地底要用頭上實心格數，不是光照。
- `bot.oxygenLevel` 是 0～20。`bot.controlState` 是 proxy，印出來是 `{}` 是正常的，別被騙。
- 在腳下放方塊必須先升到比新方塊高 1 格以上；放方塊不要信伺服器（它不檢查視線），要自己射線檢查。
- 在水裡長按跳會卡在窄洞頂；水中移動只在下一個路點比較高時才跳，並對齊格子中心（hitbox 在整數邊界會卡）。
- 事件的 `id` 曾被動作 id 蓋掉（`{id, ...data}` 順序），現在動作 id 叫 `actionId`。
- 用 Python 批次改檔時，`s.index()` 找到的是**第一個**符合的位置，可能改到別的題目／函式；改完要確認改對地方。長的 heredoc 與反斜線換行在 Bash 工具裡容易出事，長腳本先寫成檔案再執行。
- 考試的判斷本身也會錯：查背包耐久用 `/scalar` 查 `Inventory[{id:"minecraft:iron_pickaxe"}].components."minecraft:damage"`，沒有該元件代表沒用過。
- 伺服器的 NBT 欄位順序不固定（`{count, Slot, id}`），解析要不依賴順序。
- 考官如果是旁觀者，ECHO 看不到它；考試需要實體互動時考官要用創造模式（run.js 已處理）。

## 10. 給新視窗的第一則訊息（使用者可直接貼）

> 請先讀 `CLAUDE.md`（工作憲章），再讀 `notes/HANDOFF.md` 和 `notes/ENGINEERING.md`，然後照 HANDOFF 的 §2 規則接手。先用 ToolSearch 檢查有沒有 computer use 工具；有就只申請 Minecraft 視窗幫我開 LAN 6666，沒有就我自己開。世界開好後用 5070 埠啟動 ECHO 與考官，從「下一步」第 1～3 項開始修。
