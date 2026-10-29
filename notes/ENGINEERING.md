# 工程進度與玩家回饋整理

最後更新：2026-10-07（交接檔：notes/HANDOFF.md；Agent API 埠已改 5070（5060 會被 Node fetch 擋掉））

## 工作方式（已與使用者確認）

- 玩家 subagent 只用 `node exam/ctl.js` 玩遊戲（obs/map/find/block/act/events/actions/note/feedback），我（主 Claude）旁觀，
  用 `CTL_ORACLE=1` 的 `sv`（伺服器指令）、`trace`（軌跡）、日誌與程式碼判斷問題。
- 玩家的回報（最終報告 + `notes/feedback.md`）是主要依據。**考試政策（2026-10-07 使用者指示）：** 舊的 `test_*.js` 廢棄；不再跑整個階段；考場只在「新增動作」或「某個動作被記錄出問題」時寫專門考那個動作的題目，考過再放進世界玩（詳見 HANDOFF.md §5.1）。
- 玩家可以提「如果有……就更好了」，由我評估後寫新動作或加參數；玩家不必為了加新動作而想（見 HANDOFF.md §5、PLAYER_PROMPT.md）。
- 考官 Examiner 在「玩遊戲模式」（`EXAM_MODE=play`）以旁觀者模式附身 ECHO，避免伺服器多載入一組區塊；跑 `exam/run.js` 時暫停附身。
- 啟動：`EXAM_MODE=play node exam/examiner.js`、`MASTER_NAME=ethan0915 TRAJECTORY_LOG=1 node tsbot.js`。
  跑考試時 ECHO 的 MASTER_NAME 要設成 Examiner。LAN 世界埠號 6666、主機 127.0.0.1（.env）。

## 玩家回報歷史

### 第 1 輪：目標鐵鎬（27 次動作，成功）
修掉：gather 選工具不分等級（木鎬挖鐵白挖）、gather 迴圈無限空轉、branch_mine 步數自己記不看真實位置、watchdog 把站著挖礦當卡死。
新增：pickup_items、/find、/block、掉落物名稱、地圖礦石分類、失敗訊息以驗證結果為準、工具損壞警告。

### 第 2 輪：目標鑽石鎬（99 次動作，成功；55 次失敗、約 25 次浪費；總耗時 38.5 分鐘）
玩家評價：做得到但不好用，勉強可用，需要很多繞路。最拖累它的 3 件事：
1. 沒有轉向／goto，動作方向全看面向；obs 座標四捨五入，方塊位置難判斷。
2. gather／staircase／pickup_items 長時間阻塞、沒有進度、完成後不結束，訊息與實際結果不一致。
3. 遇到水、礫石、不連通空洞沒有處理手段，失敗訊息又不具體。
好用的部分：find 與 block 查詢、craft／smelt 自動處理工作台與熔爐、branch_mine 最可靠。

## 找到的根因與修正（本輪）

| 現象 | 根因 | 修正 |
|---|---|---|
| 遇水卡死、一直浮在水面、dig down 逾時 | tsbot.js 防溺水反射「只要碰水就一直按住跳」，且在 gather 模式離開水後不會放開（staircase/branch_mine 的模式就是 gather，所以碰過一次水後整個動作都在原地跳，挖掘被中斷）；另 oxygenLevel 是 0–20 卻比 `<60`，潛水永遠被取消 | 只在「頭泡水且氧氣 ≤ 6」或「在岩漿」才強制上浮，且只放開自己按的跳 |
| staircase 往反方向挖 | `fdz = +cos(yaw)`，與 branch_mine/build 的 `-cos(yaw)` 相反（mineflayer yaw 0 = 朝北），Z 軸鏡像 | 改成 `-cos`，並加 `direction` 參數 |
| staircase 用壞工具、不偵測水、礫石空轉、訊息說謊 | 用背包第一把鎬；只偵測岩漿；沒有進度判斷；罐頭訊息 | 每個方塊用 selectTool；偵測前方與周圍的水／岩漿；35 秒或 5 輪深度沒變就停；訊息寫實際原因 |
| dig down 對著水挖逾時 25 秒 | 液體被當成可挖目標 | 立刻回報 target_is_liquid |
| act 回傳時位置還沒更新 | 動作結束時身體還在落下／滑行 | executor 先等身體停穩（最多 1.5 秒）再取快照 |
| obs 座標混亂 | 位置四捨五入，/block /map 用 floor | self 加 blockPos（整數）、facing、blockAbove/blockAhead |
| act 阻塞超過 2 分鐘 | 各動作逾時 300 秒 | 全部動作預設逾時 ≤ 115 秒，逾時回傳部分結果；smelt 單次上限 10 |

新增動作：`goto`（x,y,z,range）、`face`（north/south/east/west/up/down）、staircase／branch_mine 的 `direction`。

### 第 3 輪：被封閉的水洞卡住（blocked）
水中脫困沒有手段，玩家只能靠 dig 往上猜。修正：新增 `surface`（BFS 找水面／靠岸格、卡住就往上挖階梯）、水下氧氣反射（遲滯）、水中 10/20/45 秒的 water_trapped／自動脫困事件。真實淹水洞穴 3/3 脫困。

### 第 4 輪：目標鑽石鎬（78 次動作，成功；27 次失敗）
玩家最大的抱怨：(1) 工具與耐久不受控（staircase 把唯一的鐵鎬挖壞）；(2) 失敗訊息不透明或自相矛盾（隧道裡 craft 放不下工作台、gather／pickup 沒說原因、「已回收」與背包對不上）；(3) 礦被岩石封住、掉落物拿不到，沒有挖通道的動作。
另外使用者在旁觀察到：疊方塊時一直跳、隔著樹葉砍原木、不插火把。

## 第 4 輪之後的修正（2026-10，已在遊戲內驗證：第 6 階段 9 題 + 省工具題全過）

| 現象 | 根因 | 修正 |
|---|---|---|
| 工作台放不下、隧道裡 craft 失敗 | 只試四個鄰格，沒空位就放棄 | `placement.js`：`placeBlockNear` 看所有附近空位，沒有就挖開旁邊的牆；`placeBlockAt` 供 `place_block` 動作 |
| **工作台被放到岩壁外面、人撿不到**（考試抓到） | 伺服器不檢查視線，隔牆放得進去；候選格只看距離 | 放置前用射線檢查，眼睛到參考面第一個打到的必須是參考方塊（`canSeeFace`）；新增 reason `blocked_view` |
| 礦在岩石裡，gather 說「沒挖到」 | 只用 pathfinder，走不過去就跳過 | 新增 `tunnel.js`／`tunnel_to`；gather 走不到時先挖通道到「礦的旁邊」（range 1，不是 2：挖掉後掉落物要在通道裡） |
| 撿不到掉落物沒有原因 | 只回 nothing_picked_up | `pickup_items` 列出沒撿到的物品座標，並標示「被岩石完全包住」 |
| 工具／耐久不受控 | 每次都選背包第一把 | `selectTool`：便宜方塊用較不珍貴的鎬；耐久 ≤3 不用；動作可帶 `tool` 參數；obs 有 `tools[]` 與耐久 |
| 事件 id 被動作 id 蓋掉 | `pushEvent` 的 `{id, ...data}` 順序 | id 放在 spread 之後，動作 id 改叫 `actionId` |
| 上一個動作的訊息漏到下一個 | 逾時的動作仍在跑，晚寫 feedback | executor 的 `lastExec`：開始新動作前先等舊的收尾（最多 8 秒） |
| 疊方塊一直跳 | 沒等升到夠高就放 | `placeUnderFeet`：升到 y ≥ 新方塊頂 + 1.15 才放 |
| 隔葉砍原木 | 直接對目標下鎬 | `digBlockWithSight`：先清掉擋視線的方塊 |
| 沒有火把習慣 | — | `torchHabit`：地底、周圍 6 格沒火把、亮度 ≤ 7 且背包有火把就插；地表不插 |
| 水裡待太久 | — | 反射層自動執行 `surface`（20 秒閒置／45 秒強制），watch.js 會通知 |

新增動作／參數：`place_block`、`tunnel_to`、`craft count`、`tool`（gather/dig/branch_mine/staircase）。

注意：考試題的判斷本身也會錯。這次兩題的 NBT 比對寫在同一個樣式上被我批次取代到錯的題目，改用 `/scalar` 查 `Inventory[{id:...}].components."minecraft:damage"` 才可靠。

## 待辦（尚未做）

- act 長時間運行時沒有進度輸出（目前只有逾時上限）。
- 原始動作重構（使用者已認可方向）：place_block 已完成；還缺 break_block 取代 dig、use_item、use_block、equip 加 slot（盔甲／副手）、sleep、容器依座標操作、shoot、bridge、傳送門。
- 階段 A+：配方依賴圖（/plan）、失敗分類 hint、去指揮官化（單人玩時沒有指揮官，逃跑／follow／drop 會失效）。
- 通關終界龍所需動作清單見對話中的分析（goto、place/break/use、盔甲、遠程、搭橋、跨維度…）。

### 第 5 輪：目標鑽石鎬（約 46 次動作，成功；約 9 次浪費；前幾輪為 99、78 次）
路線：木頭→木鎬→石頭→熔爐→鐵鎬→階梯下到 Y≈-10→3 顆深板岩鑽石→合成。評價：「可用」，find 與 map slice 最有幫助。最拖累它的 3 件事：
1. gather 挖太多又太慢：一棵樹 15 個原木、石頭 15 個、煤 15 個，磨損工具；掉落物拿不到或目標在奇怪位置時，失敗原因不清楚。
2. 洞穴裡導航不可預測：staircase、goto 在開闊洞穴卡住，訊息卻猜「礫石／水」，實際是掉落或空地。
3. 回饋與實際狀態不符：craft torch 扣了材料但背包沒火把、地表出現 low_oxygen 假警報、gather 長距離移動後卻說「沒有挖到」。

## 第 5 輪之後的待辦（2026-10-06 夜，尚未修；使用者要求先暫停，明天開世界後繼續）

優先序（玩家回報 + 我在軌跡裡的觀察）：
1. **craft 驗證競態 / count 語意**：`craft name=torch count=8` 扣了煤與木棍卻回 `no_inventory_change`；火把後來才出現（背包更新比快照晚）。要在 verifier 對 craft 多等一下／比對最終值，並確認 count 是「成品數量」。
2. **staircase 在開闊洞穴卡住**（Y=27、Y=-10 各一次 did_not_descend／partial）：腳下是空的、不是礫石或水。要偵測「下一格是空氣」→ 往下走／搭橋，並把卡住原因講實話（現在永遠說礫石／水）。單次最多 100 秒，目標 Y 太遠要在訊息裡建議分次呼叫。
3. **gather 逾時但移動 49 格、鵝卵石 -40、火把 -3，卻說「沒有挖到任何 deepslate_diamond_ore」**：要查它在深處為什麼繞很遠、為什麼沒挖到近在眼前的鑽石；逾時訊息要說明位置、深度變化與做了什麼。
4. **gather 範圍／數量**：一棵樹 15、石頭 15、煤 15 太多；訊息要說明會挖幾個，考慮加 `count` 上限參數；撿到順手的小物（樹苗、木棍）也要說明。
5. **goto 失敗訊息永遠猜「在水裡」**；實際是洞穴落差。成功時用鵝卵石搭橋也沒說明（`inventoryDelta` 有，但訊息沒提）。
6. **obs 在地表出現 `氧氣 0 / low_oxygen`**（假警報）；obs 的 `資源` 只列幾類，深處的礦（鑽石、紅石）要多列。
7. **events 會重播考官的 setup 聊天**（傳送、給物品），對玩家是雜訊，要過濾來源為 Examiner 的聊天。
8. **tunnel_to 第一次只挖 6 格就因「連續 4 步沒更靠近」停下**：確認是不是 stall 判斷太嚴。
9. craft 放工作台後自動回收（前一輪已修，這次玩家還提出，確認訊息夠清楚即可）。
10. 玩家想要「純粹走到任意座標、必要時挖／搭橋」的動作（tunnel_to + goto 的合體，或 goto 加 `dig`/`bridge` 選項）。

已驗證有效（玩家這輪沒有再抱怨）：tool 參數（鐵鎬 213/250，沒有被亂用，但前期 staircase/gather 一開始仍忽略 tool 並磨損了石鎬與木鎬到剩 3，要確認是不是第一次呼叫時沒帶 tool 的緣故）、tunnel_to 撿起封閉空洞的掉落物、熔爐／工作台回收。

## 待辦（尚未做）

- act 長時間運行時沒有進度輸出（目前只有逾時上限）。
- 原始動作重構（使用者已認可方向）：place_block 已完成；還缺 break_block 取代 dig、use_item、use_block、equip 加 slot（盔甲／副手）、sleep、容器依座標操作、shoot、bridge、傳送門。
- 階段 A+：配方依賴圖（/plan）、失敗分類 hint、去指揮官化（單人玩時沒有指揮官，逃跑／follow／drop 會失效）。
- 通關終界龍所需動作清單見對話中的分析（goto、place/break/use、盔甲、遠程、搭橋、跨維度…）。

## 第 5 輪進行中觀察到的待查問題（2026-10-06 夜，玩家還在跑，尚未修）

1. **craft 驗證競態**：`craft name=torch count=8` 回 `ok=false reason=no_inventory_change`，但動作模組說成功、煤與木棍也扣了，之後火把確實在背包（gather 還用掉 3 支）。疑似 verifier 取快照時火把的背包更新還沒到（inventoryDelta 只有 coal -2、stick -2，沒有 torch +8）。要在 verifier 對 craft 多等一下，或改比對成品數量的最終值。
2. **staircase 在 Y=27 連續 did_not_descend**（west 一次、south 一次，各只撐 10～17 秒就判卡住）：原因不明，要看軌跡的 before/after 與周圍方塊（可能是下面是水、礫石，或我的 5 輪深度沒變判斷太敏感）。第一次 staircase 在 100 秒逾時時只下了 23 層（Y=-54 的目標太遠，單次動作做不完，玩家得分次呼叫）。
3. **gather diamond_ore 逾時 100 秒**：位移 49 格、背包鵝卵石 -40、火把 -3，結果「沒有挖到任何 deepslate_diamond_ore」。鵝卵石少 40 個代表它在鋪路或擋水，要查 gather 在深處為什麼走這麼遠卻沒挖到目標（可能 findBlock 的目標被 skipped、或一直在繞路）。
4. `tunnel_to` 第一次 remaining=23 但只挖 6 格就因「連續 4 步沒更靠近」停下；需要確認是被礫石／水擋住還是 stall 判斷太嚴。

## 2026-10-07 修正紀錄（接手後）

1. **Agent API 埠 5060 → 5070**：Node 的 `fetch` 把 5060／5061 列為「壞埠」（SIP），一律回 `bad port`，`exam/ctl.js` 和之後的 Node 參考大腦都連不上（curl 不受影響所以上輪沒發現）。改了 `.env`、`.env.example`、`src/config.js`。**以後選埠要避開 fetch 的壞埠清單**（5060、5061、6666、6667 等；6666 只給 Minecraft 的 net 連線用，沒問題）。
2. **待辦第 1 項 craft（已修，伺服器端驗證 8/8）**：根因不是驗證太早，而是 **mineflayer 連續合成會丟成品**——第 1 次合成的伺服器確認封包若在第 2 次點擊途中才到，客戶端背包錯亂，伺服器扣了材料卻沒給成品（約 50% 機率；客戶端還會樂觀地顯示有成品，所以不能用客戶端數量判斷）。`logistics.js` 的 craft 改成一次合成一次、每次之後 `waitForTicks(12)`；`count` 本來就是成品數量，沒問題。另在 `executor.js` 對 craft 取 `after` 快照前最多等 3 秒讓成品出現（保險）。驗收：給 3 煤 4 木棍，`craft torch count=8`，用 `data get entity ECHO Inventory` 看伺服器真相，8 次全有 8 支火把。

3. **待辦第 2 項 staircase 在開闊洞穴卡住（已修，專門考場 5/5）**：
   - 軌跡（trajectory-2026-10-06）只記了位置與背包，沒記周圍方塊，所以先用考場重現：在地面正下方挖封閉洞穴（`exam/cases.js` 階段 7 的 `buildCave`），舊程式 3/3 都回 `did_not_descend` 並一律猜「礫石／沙子／被水淹」，連洞底是岩漿也不提。
   - 根因（在 `src/actions/mining.js` 的 staircase 主迴圈）：(a) 完全不看「新位置腳下有沒有地」，下一格是空洞就硬走；(b) goto 失敗的備援用 `GoalNear(range 1)`，站在目標正上方一格就算到達，所以水平前進、深度不變也算成功；(c) 又因 pathfinder 沒關 `canPlace`，開闊處會自己鋪方塊（#43 鵝卵石 -5 卻沒下降）；(d) 卡住訊息是罐頭。
   - 修法：前進前先 `scanGround`（往下最多 12 格找地面）。落差 ≤3 格（摔不會受傷）且落點旁沒有液體 → 走下去，目標落點用真實地面高度；落差 >3、底下是水／岩漿、或深不見底 → 停下來說出實況（落差幾格、地面在哪、底下是什麼，並建議 place_block 搭台階或換方向）。移除 `GoalNear` 備援，改成只用「直接往前走」；卡住訊息改用 `describeColumn` 如實列出前方 頭上／腳高／下一格／腳下 的方塊與 pathfinder 的錯誤，有礫石／沙子才提。
   - 考場（階段 7，只用 `--only` 跑）：`staircase_open_cave_shallow`（淺洞要走下去）、`staircase_open_cave_deep_honest`（深洞要誠實說空洞太深）、`staircase_open_cave_lava_floor`（洞底岩漿要說岩漿）。連同既有的 `staircase_direction_south`、`staircase_stops_before_water` 都過。第一次跑時淺洞題的判斷太嚴（dz ≥ 1，實際 0.9），是題目錯，已改成 ≥ 0.5。
   - 尚未解決／留意：玩家真實記錄的 Y=27、Y=-10 當時周圍方塊不得而知，我們只能推測是開闊洞穴；下次若再卡住，訊息會直接列出當時的方塊，到時再看。深洞（>3 格）目前是停下來回報，不會自己搭台階（動作不替 agent 做決定，搭台階交給 `place_block`）。單次 staircase 約 4 秒一層，逾時訊息已建議可分次呼叫。

4. **待辦第 3 項 gather 逾時卻不說做了什麼（已修，專門考場 + 回歸全過）**：
   - 先在考場重現（`gather_deep_far_ore`：礦在 27 格遠、深 15 格的岩石裡）：舊程式 20 秒就放棄，只說「沒有挖到任何 deepslate_diamond_ore」。加了通道逐步日誌後看到真相：**根因是 `tunnel.js` 的真 bug，不是被擋住**——往下挖階梯時只挖「新那一格」和它的頭上，但人是先水平走進去再落下一格，所以原本高度的那一格頭頂（`c.y+1`）也要挖開；沒挖開人就頭撞石頭卡在原地，連 4 步「沒更靠近」就被判停滯（待辦第 8 項「tunnel_to 停滯判斷太嚴」其實就是這個）。前 3 步剛好穿過已是空氣的地方，所以看起來沒事。修法：往下的步驟連 `c.y+1`、`c.y`、新格三格一起挖；停滯訊息改成如實列出卡住位置、想去的格子和那裡的方塊。
   - gather 本身：結束訊息現在附全程摘要（目標座標、出發距離、高度差、結束位置、離礦多遠、移動幾格、Y 變化、過程：直接走失敗的原因、通道挖了幾步到沒到、為什麼沒到）；走路加時間上限（首次 60 秒、之後 40 秒，皆不超過剩餘預算），走太久就停下報告「再呼叫一次從目前位置繼續」，不再一路走到被強制逾時；通道改用整個動作預算（約 85 秒）而不是固定 45 秒。
   - 新參數 `count`（礦石、石頭、泥土等，預設 15、上限 64）：挖到上限會說「已達本次上限」；擋路而被清掉的同種方塊也算進 count。**樹木（log）仍整棵砍完，不受 count 限制（待辦第 4 項還沒做完）**。
   - 考場（階段 8）：`gather_deep_far_ore`（像玩家一樣最多呼叫 3 次，實際 1 次就拿到鑽石）、`gather_count_limit`、`gather_sealed_ore_honest`（被基岩封死要說出座標與通道失敗原因）；回歸 `tunnel_to_sealed_ore`、`gather_sealed_ore_tunnels`、`gather_coal_ore` 全過。
5. **pathfinder 悄悄放方塊現在會說出來**：`tsbot.js` 在 spawn 時包住 `bot.placeBlock`，pathfinder 放（`isBuilding()` 為真）就計數；`executor.js` 把數量寫進結果的 `pathfinderPlaced`、`warnings` 的 `pathfinder_placed_blocks:N`，並在訊息後面附一句。能力沒砍（canPlace 仍開著）。實測 `gather_count_limit` 抓到它用掉 1 個鵝卵石。
6. **軌跡現在記周圍資料**：每筆動作的 `before.surround` 與新增的 `after`（pos、health、mode、surround）。`surround` = 方塊座標、面向、腳／腳下／腳下 2 格／頭／頭上 2 格、前方腳／頭／腳下的方塊、附近 3 格最近的液體（名稱、距離、座標）、頭上實心格數。以後動作卡住不用靠推測。
7. 淺洞題（`staircase_open_cave_shallow`）的判定改成：主要看「到洞底的深度、血量沒掉」，水平位移只當輔助說明。

### 第 6 輪玩家（進行中）
目標：做出鐵劍、桶（bucket）、打火鐮（flint_and_steel）（下界傳送門前置），預算 200 次 act。特別留意 `staircase` 在真實洞穴有沒有被新的「腳下是空的」判斷誤擋（落差 >3 會停下來，應該只在真的有大洞時才發生）。目標沒有用鑽石鎬：前 3 輪都是它，只暴露挖礦缺口；`equip` 目前不能穿護甲，所以也沒選護甲。

### 待辦現況（第 5 輪之後的 10 項）
1 craft ✅　2 staircase ✅　3 gather ✅　8 tunnel_to 停滯 ✅（同一個根因）。
4 gather 樹木整棵砍（count 對 log 無效）、5 goto 失敗訊息永遠猜「在水裡」（pathfinder 搭橋現在會說了，但失敗訊息還沒改）、6 obs 地表假 low_oxygen、7 events 過濾考官聊天、9 craft 工作台回收訊息、10 純走到任意座標（必要時挖／搭橋）：未做。

### 第 6 輪結果：目標鐵劍＋桶＋打火鐮（成功，25 次動作；第 5 輪 46、第 4 輪 78、第 2 輪 99）
路線：砍樹→木板／工作台／木鎬→石頭→石鎬→煤→鐵→熔爐→冶煉→鐵劍、桶→挖沙礫找燧石（三次才出 3 個）→打火鐮。失敗只有 2 次（木鎬缺 1 塊木板、一次 pickup_items）。玩家評價「整體好用」。**這輪 staircase 一次都沒用到**（玩家靠 gather 自己挖通道下地底），所以「新的腳下是空的判斷會不會在真實洞穴誤擋」**這輪沒有資料**，下一輪要換需要下探的目標才看得到。
玩家抱怨與處理（用軌跡核對過）：
1. gather `count` 對樹木無效（count=6 砍了整棵 15 根）→ **未修**（待辦第 4 項，樹木整棵砍的流程要另外處理）。
2. 挖沙礫 count=10 只挖 6 個不說原因；count=20 挖 20 個只撿 15 個、回報 `timed_out_but_goal_met`——**根因：挖掘迴圈沒遵守時間預算（只有走路／通道遵守），106 秒逾時剛好發生在撿掉落物途中，掉落物留在原地**。已修：挖掘迴圈也遵守 85 秒預算，時間到會先去撿；結束訊息說明為什麼停（時間預算用完／附近約 4 格內沒有更多／已達上限）。
3. gather 訊息只報目標物品，dirt+47、燧石等只有背包變化看得到 → 已修：訊息附「順手還撿到：…」，挖掉比撿到多時說明「可能有掉落物留在原地」。
4. craft 缺材料時花 9.7 秒（先去放工作台）才失敗，訊息只說「配方不存在或材料不足」→ 已修：先用 `recipesFor(…, true)` 確認材料夠不夠，不夠就**立刻**失敗並說「配方需要 oak_planks×3、stick×2；還缺 oak_planks×1」，不放工作台、不扣原料。順手修了 executor 對失敗 craft 也白等 3 秒的問題（只在動作模組說合成成功時才等成品）。
5. obs 地表假警報：`low_oxygen` 現在只有頭真的泡在水裡才算；`enclosure.underground` 改用頭上實心格數（≥2），不再把樹冠下的低天空光當地底。
6. gather 選的目標和 `find` 列的最近一個不同（find 說 (-48,87,166)，gather 去 (-24,94,173)）→ 未查（gather 用 findBlock 的方塊順序，find 是排序後的列表；沒有實際代價的證據，先記著）。
7. craft 要回收工作台的動作每次 9～10 秒（不需要工作台的只要 3 秒）→ 未處理，是設計成本（挖回工作台＋撿起）。
考場（階段 9）：`craft_missing_materials_explains`；回歸 `craft_pickaxe_auto_table`、`gather_count_limit`、`gather_coal_ore`、`gather_deep_far_ore` 全過。

### 待辦現況（更新）
已完成：1 craft、2 staircase、3 gather、6 obs 假警報、8 tunnel 停滯。
未做：4 gather 樹木整棵砍／count 對 log 無效、5 goto 失敗訊息猜「在水裡」、7 events 過濾考官聊天、10 純走到任意座標；原始動作重構（equip 加 slot 才能穿護甲、break_block、use_item…）仍在清單上。

### 自動迴圈接手（2026-10-07）：樹木 count 修好，派第 7 輪
- **樹木 `gather count`（已修，專門考場 + 回歸過）**：count=N 表示最多砍 N 根原木，不給就整棵砍完。樹根最後一定會被砍（人站在上面往下挖），所以往上砍的額度是 N-1；N=1 直接砍樹根不爬樹。實測抓到一個真 bug：N=2 時頭頂還留著第 3 根，人跳不上樹根，收尾那段「往下挖腳下的方塊」就挖到了地面、樹根沒砍——現在人不在樹上就直接砍樹根。訊息會說「count=N，到上限就停，樹上可能還有剩」或「整棵砍完；想限制數量可以加 count 參數」。考場：`gather_log_count_2`、`gather_log_count_1`；回歸 `gather_log`、`gather_log_clears_leaves_first` 全過。
- 工作方式更新：`CLAUDE.md` 新增「自動工作迴圈與什麼時候停」（迴圈一直轉、小改動免考、只在階段完成或例外才停）。目前階段 = 讓玩家順暢地找到鑽石、做出鑽石鎬而且體驗好。
- **第 7 輪玩家**：目標＝從空背包做出鑽石鎬，預算 200 次 act，ECHO 送到新的出生位置。要看的：staircase 在真實洞穴有沒有被「腳下是空的」判斷誤擋（落差 >3 才會停）；和第 5 輪（46）、第 6 輪（25）比動作數。

### 第 7 輪結果：從空背包做鑽石鎬（成功，約 50 次動作；第 5 輪 46、第 6 輪 25（不同目標））——**階段尚未完成**
路線：砍雲杉→木鎬→石頭→煤→鐵（gather 自己挖通道）→熔爐冶煉→鐵鎬→staircase 往下→遇到水與洞穴→`dig down` 掉進洞穴→深板岩層→tunnel_to 逐顆取鑽石→鑽石鎬。**階段完成條件沒達到**：BLOCKERS 有 2 條、USABILITY 只有「可用」、回饋有 3 則「錯誤」、浪費約 17 次（試錯 9 + 工鎬壞掉重做 8）。
**staircase 在真實洞穴有沒有被誤擋（這輪的觀察重點）**：沒有誤擋。下降 30＋17 層順利；在 Y=12 遇到真正的大洞穴（腳下薄薄一層滴水石、底下空 10～11 格），東／西／北三個方向都被正確拒絕（每次 2 秒、不亂跳、血量滿）；另有兩次「前方緊鄰水」也正確停下。但玩家為了找出路逐方向試了 3 次，已改成拒絕訊息一併列出其他三個方向前方腳下的情況。
玩家回報與處理（用軌跡與**伺服器真相**核對過）：
1. **gather「挖掉 3 個鑽石／鐵礦卻沒撿到」（最嚴重）**：伺服器查證 (959,-45,-981) 的 `deepslate_diamond_ore` **還在**、附近沒有任何掉落物實體——**根本沒挖成**。原因：goto 超時（`Took to long to decide path`）後，迴圈裡下一次 goto 會「假成功」（人沒動卻回傳成功）；然後沒有視線時的「直接挖」備援不檢查距離，人站在 14 格外對著礦呼叫 `bot.dig`，客戶端世界先把方塊畫成空氣、伺服器不收，gather 就數成「挖掉 N 個」。**教訓：客戶端的 `blockAt` 不能當真相，挖完要靠背包有掉落物。** 修法：goto 回傳後驗證實際距離（>5.5 格就當失敗，改走通道）；直接挖前必須在 4.8 格內；沒撿到任何掉落物時訊息改成「嘗試挖了 N 個，但背包沒有出現掉落物，很可能根本沒挖成，不要當成已經挖到」。**這個失敗情境（goto 超時後假成功）沒有在考場重現成功**，修法是預防性的；之後若再出現，看軌跡的 surround 與訊息。
2. **gather `target=stone` 比對到 `stone_bricks`／`mossy_stone_bricks`；`target=cobblestone` 找不到（世界裡是 stone）**：已修。目標解析改成依序：精確方塊名（含 `deepslate_` 變體，所以 iron_ore 仍包含深板岩鐵礦）→ 掉落物名稱（cobblestone←stone、raw_iron←iron_ore、diamond←diamond_ore、coal←coal_ore）→ 名稱包含。找不到時訊息列出找過哪些方塊，並說明是「隨機移動 25 格」。
3. **工具耐久沒有預警（staircase 往深板岩挖 55 層，wooden／stone／iron 三把鎬全壞，iron 還剩 150 時開始挖）**：這是真的耗損（深板岩每格 1 耐久、約 165 格）。已加：每個動作結果的 `toolDurability`（用過的工具 `150→60/250`）、低於 15% 的 `tool_durability_low` 警告；`selectTool` 回報 `nearlyBroken`（耐久 ≤4 且沒有別的工具能替代），staircase／tunnel_to／gather 遇到就**停下來說清楚**（哪把、剩幾次、再挖會壞）。不替玩家決定做新鎬，只讓它看得到、不會挖到工具消失。
4. staircase 遇洞穴／水只能一個方向一個方向試：拒絕訊息現在會列出其他三個方向前方腳下的情況（可以挖／N 格落差可走下去／N 格深空洞／底下是水或岩漿）。**不做自動繞行或自動搭台階**（動作不替 agent 做決定；搭台階交給 `place_block`、挖一格交給 `dig`）。
5. 玩家想要「指定座標的礦並確保撿到掉落物」：目前 `tunnel_to range=0` 做得到（它會撿沿路與終點掉落物），gather 修好後也更可靠；不另寫新動作。
6. 小項（未處理，無實際代價證據）：obs「光照 0／夜晝」顯示、`craft count` 是產出數量（已寫在說明）、新鎬出現沒有來源說明（玩家自己 craft 的）。
考場（階段 10）：`gather_stone_exact_not_bricks`、`gather_cobblestone_via_stone`、`staircase_stops_before_tool_breaks`；回歸 `staircase_direction_south`、`staircase_open_cave_deep_honest`、`gather_deep_far_ore`、`gather_sealed_ore_honest`、`gather_sealed_ore_tunnels`、`gather_coal_ore`、`tunnel_to_sealed_ore`、`gather_count_limit` 全過。

### 使用者從畫面觀察到：ECHO 往腳下疊方塊往上時，看著地板一直跳，跳好幾下才放好一個（已修，第 8 輪前）
- 先排除：`pillar` 動作本身正常（3 格 3 次起跳、約 3 秒，軌跡與 `pillar_one_hop_per_block` 都過）。真正的原因是 **pathfinder 自己的垫腳（goto／gather 路上遇到高處）**：用考場量測（走到頭上 +4 的空中座標），**放置失敗 9 次、每次白等 5 秒（`blockUpdate did not fire within timeout of 5000ms`），爬 4 格花 32 秒**。
- 根因：mineflayer-pathfinder 的條件是 `canPlace = 參考方塊.y + 1 < bot.y`，但新方塊佔據的是「參考方塊上面那一格」（參考方塊 y+1～y+2），腳必須升到 **參考方塊 y+2** 以上才放得進去；差一格，伺服器因身體還在那一格裡而默默拒絕，`placeBlock` 要等 5 秒逾時，pathfinder 再重跳。我自己的 `placeUnderFeet` 用「升到新方塊頂面 +1.15 才放」，所以一跳一個。使用者猜「起跳跟放方塊的時間對不上」完全正確。
- 修法（不改 node_modules，重裝會被洗掉）：`tsbot.js` 包住的 `bot.placeBlock`，pathfinder 往腳下放（面向量 y=1）時，先等身體升到參考方塊 y+2 以上再放；跳已過最高點還沒到就立刻失敗（約 0.17 秒），不白等 5 秒。同時加了 `pathfinderPlaceFailed` 計數與失敗日誌（`🧱 [pathfinder放方塊] 失敗…`，含放置時的 Y 與參考方塊）。
- 結果：同樣爬 4 格 **32 秒 → 3.2 秒**，兩次實測一致，4 個方塊都放上。考場 `goto_scaffold_up_is_fast`（10 秒內到、pathfinder 放 ≥3 個）；回歸 `pillar_one_hop_per_block`、`gather_log`、`gather_log_count_2`、`gather_count_limit`、`craft_pickaxe_auto_table` 全過。
- 順帶：之前每一輪 gather／goto 路上若遇到要垫腳的地方，都被這個 5 秒陷阱拖慢，可能是「gather 很慢」的一部分原因。

### 第 8 輪結果：從空背包做鑽石鎬（成功，約 28 次動作，只有 3 次 staircase 失敗；BLOCKERS 無、USABILITY「好用」）——**階段尚未完成**
路線：樹冠上出生→砍橡木→木鎬→石頭→石鎬→熔爐→煤→鐵（指定石鎬）→冶煉→鐵鎬→staircase（指定鐵鎬）往下→鑽石→鑽石鎬。對照：第 7 輪約 50 次（浪費約 17）、第 8 輪約 28 次（試錯 2：staircase 撞水一次、一次 craft 批次被外部擋掉）。垫腳修好後 gather／goto 路上不再白等 5 秒。
**沒達標的原因（完成條件第 ④ 條：不能有「錯誤」類回饋）**：玩家記了 1 則「錯誤」：`staircase tool=iron_pickaxe` 三次呼叫（約 69 階石頭／深板岩）把鐵鎬從 250 耗到 17，動作進行中沒有任何保護，差點挖不了鑽石（挖完 2 顆剩 11）。注意：**這是玩家自己指定了 `tool=iron_pickaxe`**（我們照辦；不指定時會自動用石鎬省著用），不是自動選了最高階，但這把鎬子是挖礦石的必要工具，應該有保護。
處理：
1. 貴重工具（鐵／鑽石）拿去挖便宜的方塊（非礦石）時，耐久低於 15% 就停下來並說明「它是留著挖礦石用的貴重工具」，建議改用 tool 指定石鎬／木鎬或先做新鎬；挖礦石不受這條影響（仍是 ≤4 次才停）。staircase／tunnel_to／gather 都套用（共用 `describeNearlyBroken`）。
2. staircase 停下時訊息一併說「現在 Y、離目標還有幾層」；回報的下降層數只算這一次呼叫（玩家覺得不是累計很困惑）。
3. obs 的資源列：礦石以前合成一類只列最近一個，現在每種礦各列最近一個（煤、鐵、銅、金、紅石、青金石、鑽石、綠寶石，含深板岩變體；其他礦與遠古殘骸另列 `other_ore`）。玩家反映要靠 find 才看得到鑽石。
4. 砍樹 count 訊息：count=6 只得 4 根時說明「這棵樹只有 4 根可砍，所以沒到上限」。
5. gather 的 target 說明補上：精確比對、礦包含深板岩變體、可給掉落物名稱（回答玩家「不確定 diamond_ore 會不會匹配 deepslate」）。
未處理（無實際代價證據或屬設計）：staircase 100 秒單次上限要重複呼叫（進度保留，訊息已說可再呼叫）；craft 工作台第一次沒回收掉在地上（之後都回收，訊息有說）；obs「光照 0」字樣（地面白天也顯示 0，意思是方塊光照而非天空光，只是標籤不清楚）。
考場（階段 10）：`staircase_precious_tool_reserve`、`obs_lists_each_ore_type`；回歸 `staircase_stops_before_tool_breaks`、`tool_frugality_cheap_block`、`tool_param_respected`、`staircase_direction_south`、`staircase_open_cave_shallow` 全過。

### 第 9 輪結果：從空背包做鑽石鎬（成功，約 31 次動作；第 8 輪 28、第 7 輪 50；試錯浪費約 3 次）——**階段尚未完成**
**沒達標原因**：回報的 BLOCKERS 欄有 1 條（玩家說沒真的卡死）、USABILITY 只有「整體可用」、回饋有 2 則「錯誤」。玩家頭號抱怨是**我上一輪加的耐久保護造成的回歸**，其餘多是真問題：
1. **selectTool 回歸（我造成）**：staircase 不指定工具，石鎬用到只剩 4/131（省著用，正確），然後說「沒有別的工具能挖 diorite」就停，背包明明有耐久 249/250 的鐵鎬。原因：「便宜方塊只用非貴重工具」的偏好，在唯一的非貴重工具快壞時沒有回退。修法：先排除所有「快壞」的工具（含貴重工具 15% 保留線），再做省著用的偏好；全都快壞才停。考場 `staircase_falls_back_to_precious_tool`。
2. **obs「氧氣 3／10」假數字（上游 bug，已修）**：伺服器查證 `Air=300` 沒有缺氧。**根因：mineflayer 處理 `air_supply` 沒有檢查是不是自己的實體**，附近任何生物（魚、鱿魚、溺屍…）更新氣量都會覆蓋 `bot.oxygenLevel`；考場用 3 條離水的魚重現，**修之前讀到 −1**。修法：`tsbot.js` 只認自己實體的 `air_supply`（`bot.oxygenLevel` 改成只被自己的封包更新）。這也影響 ECHO 自己的缺氧反射，已補跑水相關考題（水底氧氣用完會上浮、`low_oxygen` 事件、大湖上岸、自動脫困）全過。考場 `obs_oxygen_ignores_other_entities`。
3. **工作台掉在原地沒撿回，下一次 craft 又拿 4 塊木板做一張新的並放置失敗**：刚掉出來的物品有約 0.5 秒拾取延遲，`collectDrops` 第一次太快撿不到。修法：回收失敗時等一下重試最多兩次；背包沒桌子時，先檢查附近 10 格有沒有掉落的桌子，有就先撿，不拿木板做新的。考場 `craft_picks_up_dropped_table_first`。
4. gather 每次先 `Took to long to decide path`（5 秒思考超時）再改挖通道：同一個目標開頭直接走失敗後，迴圈裡不再讓 pathfinder 再思考一次，直接改挖通道（省約 5 秒）。**這個改動曾造成回歸**：通道挖通後 `knownUnreachable` 旗標沒清，下一圈又判「走不過去」放棄目標（`gather_sealed_ore_tunnels` 抓到），已改成通道之後清旗標。教訓：任何「記住上次失敗」的快取，在環境改變（挖通道）後都要失效。
5. 小項：`place_block` 失敗訊息和被封住掉落物的提示裡寫了不存在的 `break_block`，改成實際可用的 `dig`／`gather`／`tunnel_to`；ctl 的 obs 腳下加上座標（`腳下 grass_block@x,y,z`），回應玩家「place_block 以為是空氣其實是草方塊」。
未處理（無實際代價證據、屬設計）：staircase 單次 100 秒要重複呼叫；gather 副產物（挖通道順手撿到的石頭）塞滿背包（訊息已列出「順手還撿到」）；obs「光照 0」標籤。
考場（階段 11）3 題新增、全過；回歸（staircase 工具保護、省工具、指定工具、craft 自動桌、gather 全套、水／缺氧／脫困）全過。

### 第 10 輪結果：從空背包做鑽石鎬（成功，約 36 次動作，失敗約 6 次；BLOCKERS 無、API_WISHES 無、USABILITY「整體好用」）——差一則「錯誤」回饋
動作數與浪費：36 次（第 9 輪 31、第 8 輪 28、第 7 輪 50）；失敗 6 次中 3 次是 staircase 在洞穴區誠實停下（砂礫擋路一次、6～8 格深空洞兩次，訊息都列了其他方向）、1 次砍樹掉落物卡在樹葉上、1 次 pickup 走不到、1 次 gather 逾時（同參數再呼叫就好）；另外玩家自己指定 tool=iron_pickaxe 多花 3 次重做鐵鎬（玩家自述是自己的操作失誤）。
**為什麼還不算完成**：回饋裡有 1 則「錯誤」：gather 訊息說通道「到達」，但結束時人在 8 格外、站在樹葉上，訊息過程和最終位置對不上。查證：通道確實到達，之後挖了 3 個石頭，**為了撿掉落物（含清樹葉掉出的 3 棵樹苗）又走回樹上**，訊息漏了這一段。已改：挖完後為了撿東西又移動超過 3 格時，訊息會說明「所以結束位置不在挖礦的地方」。
其他處理（都用軌跡核對過）：
1. 監看器的 `REPEATED_FAILURES`（連 5 次 staircase partial/timeout）是誠實的停下，不是故障：砂礫掉落、6～8 格深空洞（訊息列出其他方向可以挖）、逾時後繼續、鐵鎬低於 15% 的保護（現在 Y=-39，離目標還差 15 層），玩家一路前進。
2. **玩家指定 tool 沒有耐久預警（「完成前才在 15% 停下」）**：結果其實有 `toolDurability`（250→38），但 **ctl 沒把它印出來**，玩家看不到。已補（`工具耐久（這個動作用掉的）: iron_pickaxe 224→110/250`）。
3. **同名工具有兩把（213/250 與 37/250）時，`tool=iron_pickaxe` 選到的是「背包排第一的」，可能是快壞那把**：已改成用耐久最多的那把；obs 的工具列標示哪把在手上（`(手持)`）。考場 `tool_param_picks_freshest_of_same_name`（快壞那把損耗仍 240、全新那把有被用）。
4. 砍樹後原木卡在樹葉上方時，gather 只報「+3」：現在會先再試一次、等一下再確認，確實還沒撿到才說「還有 N 個原木掉落物沒撿到，停在 (x,y,z)，多半卡在樹葉上方走不到」。**第一版這個提示講早了**（考場 `gather_log` 判定時地上已經沒有掉落物，它之後自己被撿起來了），補上重試後誤報消失。
未處理（設計或無代價證據）：staircase 遇洞穴／砂礫要自己換方向（拒絕訊息已列其他方向的情況，不做自動繞行或搭台階）；gather 走不過去改挖通道單次 40～95 秒（挖通道本身每步約 3 秒）；count 被單一樹／礦脈截斷時要自己再呼叫（訊息有說）。

### 第 11 輪結果：從空背包做鑽石鎬（成功，約 37 次動作，失敗 8 次；BLOCKERS 無；USABILITY「整體可用」；回饋 1 則「錯誤」）——**階段尚未完成**
動作數：37（第 10 輪 36、第 9 輪 31、第 8 輪 28、第 7 輪 50）。沒達標原因：評價只是「整體可用」（不是「好用」）、有 1 則「錯誤」回饋、約 5 次動作浪費在撿一顆鑽石。
1. **最大的浪費：鑽石掉在 1 格外，gather／pickup_items／goto／approach 都沒撿到（玩家記為「錯誤」）**。軌跡：掉落物在 (546,-51,1332)，那一格**頭頂是實心岩石**（只有 1 格高的凹洞，人站不進去），ECHO 站在隔壁格；`pickup_items` 說「走不到」；`goto range=0` 卻回報 ok「已到達，距離 1.1 格」而人根本沒動；最後 `dig forward` 把頭頂挖開、走進那一格才撿到。
   - **可確定的 bug（已修）：`goto range=0` 的驗證太寬鬆**（距離 ≤1.9 格就算到），考場 `goto_range0_must_stand_in_cell` **穩定重現**（站在目標格外 1 格回報 ok，判為 VERIFIER_BUG）。現在 `range=0` 必須人的所在方塊就是目標那一格；失敗訊息會說「那一格頭頂是 stone，只有 1 格高，人站不進去，要先把它挖掉（dig up 或 tunnel_to）」。
   - **沒能重現的部分**：我在考場做了同樣的 1 格高凹洞（`pickup_item_in_low_pocket`），ECHO 走到隔壁格就自動撿到了——沒有重現玩家「站在隔壁格卻撿不到」。不寫沒驗證過的挖頭頂邏輯，改成補診斷：`pickup_items` 撿不到時列出精確座標、離人多遠、那一格頭頂是不是實心方塊。下次再出現就有資料。
2. **staircase 自動插火把用掉 7 支只說「已插上火把」**：現在訊息會說「途中自動插了 N 支火把，背包還剩 M 支」。
3. **`craft count=2 stick` 得到 4 個**：count 是想要的成品數量，但配方一次產 4 個，所以做 1 次得 4 個；訊息現在說「要 2 個，這個配方一次產 4 個，所以做了 1 次，共 4 個」。
4. 其他：obs 的「位置」是四捨五入、「所在方塊」是 floor（差 1 格會混淆）——ctl 已有「腳下方塊座標」可對照，先不改；staircase 單次 100 秒要拆多次（進度保留、訊息有說）、gather 走不過去改挖通道每次 60～77 秒（挖通道本身每步約 3 秒）屬設計；staircase 不指定 tool 時用 wooden／stone 把它們耗到快壞（這是省鐵鎬的設計，ctl 現在會印出耐久）。
考場（階段 12）：`pickup_item_in_low_pocket`、`goto_range0_must_stand_in_cell`；回歸 goto／pickup／approach／craft／staircase 共 14 題全過。

### 第 12 輪結果：從空背包做鑽石鎬——**階段完成條件達成**
玩家回報：`RESULT: success`、BLOCKERS 無、USABILITY「Good overall」、回饋 2 則都是「驚訝」（沒有「錯誤」）。我用軌跡與伺服器真相核實：伺服器背包確有 `diamond_pickaxe`（耐久 1561/1561）；軌跡 26 次動作（玩家自計 32，含 obs 等）、失敗 3 次（一次 craft 因自動做工作台吃掉木板、兩次 staircase 100 秒逾時——長距離下挖拆成多次呼叫的正常現象）。

## 階段總結：「讓玩家順暢地找到鑽石、做出鑽石鎬，而且體驗好」（2026-10-07 完成）

**動作數與浪費（玩家自計）**
| 輪次 | 目標 | 動作數 | 浪費／試錯 | 結果 |
|---|---|---|---|---|
| 第 2 輪 | 鑽石鎬 | 99 | 約 25 | 成功（勉強可用） |
| 第 4 輪 | 鑽石鎬 | 78 | 27 次失敗 | 成功 |
| 第 5 輪 | 鑽石鎬 | 46 | 約 9 | 成功（可用） |
| 第 6 輪 | 鐵劍＋桶＋打火鐮（不同目標） | 25 | 2 | 成功（好用） |
| 第 7 輪 | 鑽石鎬 | 約 50 | 約 17 | 成功，但有 blocker／錯誤 |
| 第 8 輪 | 鑽石鎬 | 約 28 | 約 2 | 成功，仍有 1 則「錯誤」 |
| 第 9 輪 | 鑽石鎬 | 約 31 | 約 3 | 成功，仍有 2 則「錯誤」 |
| 第 10 輪 | 鑽石鎬 | 約 36 | 約 6 | 成功，仍有 1 則「錯誤」 |
| 第 11 輪 | 鑽石鎬 | 約 37 | 約 5 | 成功，仍有 1 則「錯誤」 |
| **第 12 輪** | **鑽石鎬** | **約 32** | **約 3～4** | **成功、無 blocker、好用、無「錯誤」** |

**這個階段（接手後）修了什麼**——每一項都先用考場／伺服器真相找到真正原因，不憑猜測：
- craft：連續合成會丟成品（mineflayer 第二次點擊遇上第一次的伺服器確認，約 50%）→ 一次合成一次並等確認；缺材料先說缺什麼、不先去放工作台；回收工作台失敗會等拾取延遲後重試，背包沒桌子先撿附近掉落的；`count` 說明實際做幾次。
- staircase：開闊洞穴（腳下是空的）→ 掃描地面、落差 ≤3 格走下去、否則誠實停下並列出其他方向；備援的 `GoalNear` 會讓人「站在目標正上方也算到達」已移除；卡住訊息列出實際看到的方塊；工具耐久保護（快壞就停、貴重工具 <15% 留給礦石）；說明現在 Y 與還差幾層；說出自動插了幾支火把。
- gather／tunnel_to：`tunnel.js` 往下挖階梯沒挖開頭頂（真 bug，根因是「連 4 步沒更靠近」的假停滯）；走路與挖掘都遵守時間預算；結果附全程摘要（目標座標、距離、通道結果、順手撿到什麼、為什麼停）；`count` 上限（含砍樹）；目標解析（精確方塊名、`deepslate_` 變體、掉落物名稱如 cobblestone／raw_iron）；goto 回傳後驗證實際距離；沒撿到掉落物時不再說「挖掉了」（**客戶端畫面不能當真相**：站在 14 格外 `bot.dig`，客戶端畫成空氣、伺服器不收）。
- pathfinder：**垫腳放置時機差一格**（放太早被伺服器默默拒絕、每次白等 5 秒；爬 4 格 32 秒→3.2 秒，也就是使用者從畫面看到的「看著地板一直跳」）；放了幾個方塊會寫進結果（`pathfinderPlaced`）。
- 觀察與回報：**氧氣假數字**（mineflayer 的 `air_supply` 沒檢查是不是自己的實體，附近魚的氣量會覆蓋）、地底判斷改用頭上實心格數、資源列每種礦各列一個、每個動作結果帶 `toolDurability`、軌跡記周圍方塊與 `after`、obs 腳下座標、`goto range=0` 必須站在那一格。
- 工作流程：`CLAUDE.md` 自動迴圈與階段規則；`HANDOFF.md` 同步；Agent API 埠 5060（fetch 壞埠）→ 5070。
- 考場：階段 7～12 共約 25 題專門考場（staircase 洞穴／工具耐久、gather 全套、craft、氧氣、pathfinder 垫腳、goto／pickup 等），每一題修之前都先重現或驗證會失敗。

**還留著的（下一階段或之後可以處理，不影響這個階段的完成）**
1. **craft 自動做工作台會吃木板然後失敗**：玩家有 6 塊木板想做木鎬（需要 3 塊），背包沒桌子，它先拿 4 塊做桌子，剩 2 塊不夠，最後只說「材料不足」。應該在動手前就算「桌子 4 塊＋配方」總共夠不夠，不夠就直接說（第 12 輪玩家唯一的浪費）。
2. staircase 不指定 `tool` 時，會把木鎬／石鎬磨到快壞才換（這是為了省鐵鎬、鑽石鎬的設計；現在 ctl 會印耐久、貴重工具有 15% 保留線，但玩家仍覺得不透明，建議之後考慮在動作開始前回報「將使用哪把」）。
3. 單次動作 100 秒上限：staircase 長距離下挖要拆 3～4 次呼叫（進度保留，訊息說「可再呼叫」）；gather 走不過去改挖通道每次 40～95 秒（挖通道每步約 3 秒）。
4. `pickup_items` 站在隔壁格卻撿不到掉落物（第 11 輪玩家遇到、考場沒重現）：已補診斷（精確座標、距離、頭頂是否實心），出現時再查。
5. obs 的「位置」四捨五入、「所在方塊」取 floor（差 1 格會混淆）；地表偶爾顯示 `[地底，頭上實心N格]`（頭上真的有 ≥2 格實心方塊時，例如洞口，不一定是 bug，未驗證）。
6. 長期（HANDOFF §8 第 5 點，未動）：原始動作重構（`break_block`、`use_item`、`use_block`、`equip` 加 slot 才能穿護甲、`sleep`、容器依座標操作、`shoot`、`bridge`、傳送門、打龍巨集）、配方依賴圖、去指揮官化、Node 參考大腦、開源準備。
**下一個階段的目標由使用者給**（例如「讓玩家在地表自己蒐集材料存活，並蓋一棟房子」），我不自己往上升目標。


目標不變：從空背包做出鑽石鎬，ECHO 送到另一個新出生點。階段完成條件仍是：success、無 BLOCKERS、USABILITY 好用、無「錯誤」類回饋且浪費很少。

### 收工狀態（2026-10-07 傍晚）
本專案所有程序都已停止（ECHO `tsbot.js`、考官 `exam/examiner.js`；沒有 run／watch 在跑），5070、5051 埠沒有人監聽。Minecraft 由使用者自己關閉，世界是 `ECHO_Test`（LAN 埠 6666）。**隔天開工：先查埠與程序，再從開遊戲開始**（`CLAUDE.md` 的「開 Minecraft 與 LAN」與「開工檢查清單」）；階段完成後的下一個目標由使用者給。上一個階段留著的第一項：craft 自動做工作台會先吃木板再失敗（見階段總結「還留著的」）。

## 動作集重整（2026-10-07 晚，使用者授權「放手改、放手刪」；專案已有備份）

**起因**：使用者指出動作是兩年前寫的、很陽春，擔心留著不好用的動作，之後換成比 subagent 更小的模型會錯亂。審視（用最近 8 輪玩家的真實世界動作 527 次，剔除我的考場動作 354 次）：30 個動作玩家只用過 20 個，前 5 個（craft、gather、dig、staircase、pickup_items）占 75%；`store fetch place_torch attack follow stop wait eat drop say` 一次都沒用過。限制：玩家全是強模型、目標只有挖礦，打架／下界沒測過，「沒用過」不等於「對打龍沒用」。

**已做**
1. **動作檔案（profile）**：`schema.js` 每個動作標上 `profile`：`core`（預設，17 個：gather craft smelt place_block pillar dig staircase tunnel_to attack goto face surface stop wait equip eat pickup_items）、`extended`（store fetch approach wander dive jump）、`commander`（look follow drop say，需要人類指揮官）、`internal`（place_torch，自動插火把內部用）。`GET /actions` 與 `POST /act` 預設只認 `core`（`AGENT_PROFILE` 可改）；考場 `echo.act` 與 TARS_TEST 旁路帶 `profile:'all'`。被隱藏的動作程式碼都還在，要用隨時打開。
2. **刪除**：`branch_mine`（約 250 行，被 gather／tunnel_to 取代，玩家只用 14 次）、`build`（約 140 行，玩家只用 1 次）、`express／attention／point_to`（整個 `express.js`，肢體表達）、對應的 verifier、`.branch_signal`、5 題考題（`build_wall`、4 個 `branch_mine_*`）。
3. **「進行中」狀態**：有進展但沒做完（reason 為 partial，或逾時但人移動 ≥2 格／背包有變化）→ `ok:false` 但 `status:'partial'`，`message` 開頭明說「進行中（已有進展，用同樣的參數再呼叫一次會從目前位置繼續）」；ctl 用 `✓／◐／✗`；watch.js 不把 partial 算進連續失敗；PLAYER_PROMPT 說明了三種符號。原因：`staircase` 每次下挖 30 層被 100 秒切斷也被標成失敗（成功率只有 13%），強模型看得懂、弱模型會放棄或亂試。
4. **每個結果加一行 `summary`**（≤140 字，例如「◐ staircase 進行中（…）｜位移 47 格｜得到 cobblestone+30｜工具 iron_pickaxe 249→141/250」），給小模型只讀這一行就能判斷；`message`／`details` 保留給需要細節的人。ctl 把摘要印在最前面。
5. 舊檔移到 `notes/archive/legacy/`：`tsbrain.py`、`PROJECT_SUMMARY.md`、`_fable_output/`；刪 `__pycache__`。

**刻意沒做（以及為什麼）**
- **沒有把 `staircase` 併進 `tunnel_to`**（我先前提議過）：實際看程式與玩家用法，兩者是互補不是重複——`staircase` 是「沿一個方向往下挖到某個深度」，內含洞穴／落差／水的判斷，剛修好且考場齊全；`tunnel_to` 是「挖到一個座標」。合併會動到剛驗證過的安全邏輯，風險大於好處。名字不同、用途清楚，先留。
- **沒有把 `pillar` 併進 `place_block`**：`pillar`（抬高自己 N 格）合約很清楚且有考場；併成參數反而讓 `place_block` 變複雜。只刪了 `build`、把 `place_torch` 設為內部。
- **gather 沒有重寫**：它承擔很多事（找、走、挖、挖通道、插火把、選工具、撿），是玩家 28～37 次動作能完成的關鍵，現在合約已經清楚（一行摘要＋詳細訊息），貿然拆開會退步。是否拆成「找／走／挖」由模型組合，留待 Haiku 基線跑完看小模型實際卡在哪再決定。
- **`.xxx_signal` 其他信號檔、`CLAUDE.md` 底線**：沒動（使用者沒有指示）。信號檔目前只是死重，可以之後一併清掉。

**明天開工的第一件事（遊戲開了才能做）**
這次動了 `builder／mining／verifier／executor／server／schema／router`，屬於結構改動，所以跑**一次**專門考場的回歸（`exam/run.js --only` 挑 staircase、gather、craft、tunnel_to、pickup、goto、place_block、pillar、dig、surface、attack、smelt 相關的題，目前共 72 題），確認沒壞；再派**一輪強模型玩家**確認 `core` 17 個動作＋「進行中」狀態＋一行摘要在真實遊戲裡順；最後才讓 **Haiku 當玩家跑基線**（使用者要求：先修完再跑，不單獨浪費一輪）。

## 2026-10-08：重整後的回歸、第 13 輪（強模型）、Haiku 基線

**開遊戲／附身（實務，已寫進 HANDOFF §4）**
- 這個 Minecraft 視窗**滑鼠點按鈕沒反應**（點世界清單項目有效、點底下按鈕無效），用 `Tab`／`Return` 操作。建立新世界畫面焦點在名稱欄時按 `Return` 會直接建立（用預設：普通、命令關），所以改在開 LAN 時才選「允許命令：開」並輸入 6666。
- 區網開「允許命令」時所有玩家都有 OP，考官不需要 `/op Examiner`。
- 使用者（人類旁觀者）要附身 ECHO，否則伺服器要同時載入兩塊區域而卡頓。**考官新增 `keepUserAttached()`**（`exam/examiner.js`，每 8 秒）：使用者是旁觀者，且離 ECHO 超過 4 格→`/spectate ECHO <使用者>`；ECHO 一次被傳走超過 60 格或重連→先 `gamemode creative`→`spectator` 再 `/spectate`（只下一次 `/spectate` 沒有用：伺服器以為還附著、使用者畫面卻追丟了）。`tp` 不會讓旁觀者脫離附身。不會把非旁觀者模式的玩家切成旁觀者。使用者另外要夜視：`effect give ethan0915 minecraft:night_vision infinite 0 true`。

**回歸（為什麼跑：動了 router／verifier／executor／schema／server，屬結構改動）**：`exam/run.js --only` 挑 24 題涵蓋 gather／craft／smelt／store／place_torch（隱藏動作用 `profile:'all'`）／pillar／dig／attack／staircase／surface／goto／place_block／tunnel_to／count／range0，**24/24 通過**。

**第 13 輪（強模型 Sonnet，空背包→鑽石鎬）：成功，16 次動作**（第 12 輪約 32、第 7 輪約 50），BLOCKERS 無、USABILITY「好用」，回饋 1 難用＋2 驚訝＋1 建議，沒有「錯誤」類。浪費 2 次（pickup_items 掉落物卡在樹葉上方；gather 被切斷）。最慢的是 gather（每次 57～94 秒，都是「走不過去改挖通道」，約 2.4 秒一步）。
- **找到的問題與根因**
  1. gather 被 85 秒預算切斷、已挖了 33 步通道（Y 35→16，還差 5 格），結果卻標 ✗`no_inventory_change`，內文又說「進度保留，再呼叫一次會繼續」，符號與內文矛盾。**根因**：執行器只認「reason 是 partial」或「reason 是 timeout 且有進展」，但 gather 是自己在預算到時收尾，驗證器看到「背包沒出現目標礦」就判 `no_inventory_change`，進不到 partial。**修**：模組自己宣告進度——`bot.actionPartial`（執行器每次動作前清零、結束時讀取）；`tunnelToPosition` 回傳 `timedOut`；`tunnel_to` 與 gather 在「時間到但已挖了一段」或「走路被上限切斷但比出發時近 ≥2 格」時設旗標；partial 的訊息開頭不再附互相矛盾的原因文字。
  2. gather 一個都沒挖到時，收尾仍會「走回挖礦中心撿掉落物」——那裡就是還沒到的目標，白跑還可能拖到動作逾時。**修**：只有 `blocksMined > 0` 才走回去撿。
  3. （新題暴露的真正 bug）**上一個動作被切斷後，下一次 `pathfinder.goto` 會立刻回報成功但人根本沒動**（程式裡早有註解記過）。gather 走完後用「眼睛到方塊中心的實際距離」驗證，門檻是 5.5 格，但「直接挖」的可及距離是 4.8 格：5.4 格剛好被放行又被擋下，直接放棄目標、一步沒動。**修**：驗證門檻改 4.8（正常走到最遠約 3.2 格，不誤傷）；不通過就走既有的「改挖通道」分支。
  4. pickup_items 走不到時沒有下一步建議。**修**：訊息補「用 dig 挖掉旁邊或下方擋路的方塊（樹葉也可以）再撿，或放棄它」。
- **刻意沒改**：gather 自動選 stone_pickaxe 把它磨到 7/131、手上有 iron_pickaxe——這是設計（便宜的方塊用低階工具，鐵鎬留給礦石，`tool` 參數說明已寫），只記下來；隧道順手撿的 cobblestone 一次 +28～47 讓背包被洗版（不影響目標，未處理）；craft 之後手持變成 dirt（pathfinder 搭橋時換的，不影響目標，未處理）。
- **新題**：`gather_budget_cut_is_partial`（phase 13）：礦在約 60 格外的岩石裡，一次動作一定做不完；斷言「被切斷的每一次都是 partial」「再呼叫能接著挖到鑽石」。修前第二次呼叫失敗（上面第 3 點），修後 `["partial","ok"]`、拿到鑽石。同組舊題 `gather_deep_far_ore`、`gather_sealed_ore_tunnels`、`tunnel_to_sealed_ore`、`gather_coal_ore`、`pickup_sealed_item_explains`、`gather_sealed_ore_honest` 全過。

### Haiku 基線（第 14 輪，Haiku 當玩家，空背包→鑽石鎬，同樣的 PLAYER_PROMPT、不給提示）：成功，24 次動作
BLOCKERS 無、API_WISHES 無、USABILITY「整體好用」；浪費約 2 次；回饋 1 錯誤＋1 驚訝＋1 難用＋1 建議。**最小的模型也沒有卡關，動作數比強模型前幾輪還少**（17 個 core 動作＋一行摘要＋進行中狀態確實幫得上忙）。**結論：目前不需要把 gather 拆成找／走／挖**（原本打算看 Haiku 卡在哪再決定，它沒卡）。全程約 17 分鐘（多數時間花在 gather／tunnel_to 挖通道，每次約 100 秒、tunnel_to 挖到 Y=11 要呼叫 4 次）。
- **找到的真 bug（已修）**：`gather target=oak_log count=6` 回 ✗`no_inventory_change`，背包卻多了 birch_log+5。**根因**：伐木（target 含 `log`）本來就不分樹種，驗證器卻只算名字含 `oak_log` 的物品，兩邊各自為政。**修**：verifier 對原木目標改成「任何 `_log` 增加都算」；gather 指定了樹種時優先砍那個樹種（只要不比最近的樹遠超過 24 格），砍了別的樹種就在訊息說明（「附近沒有 oak_log…砍的是 birch_log；樹種不同一樣能做木板和木棍，要指定樹種得自己走到那種樹旁邊」）。新題 `gather_log_other_species_counts`（phase 13）＋同組舊題 `gather_log`、`gather_log_count_1/2`、`gather_log_clears_leaves_first` 共 5 題全過。
- 小修：逾時後的 `action_did_not_settle_after_timeout` 警告 Haiku 看不懂 → 訊息加一句白話（「動作被強制停止後身體還沒完全停下來，可能還在動；下一個動作前先 wait 2 秒或下 stop」）。
- **沒改（原因）**：tunnel_to 自動先用木鎬、石鎬把它們磨到 3～4 點、鐵鎬只磨一點——設計如此（便宜的先用、鐵鎬留給礦石），兩個玩家都問「為什麼」，答案已寫在 schema 的 `tool` 參數說明；craft 結果出現「工具 wooden_pickaxe 38→37」是回收工作台用掉的耐久；動作編號從 #5 開始是我跑考試用掉的編號；obs 資源欄每種礦只列最近一格，要多顆用 `find`（設計）；背包塞滿 cobblestone（Haiku 163 個）沒有丟棄動作（`drop` 在 commander 檔案，需要指揮官）——沒有實際代價，**但長程任務（背包滿了）要不要有「丟棄」是之後要評估的缺口**。
- **順帶發現（未改）**：`gather.js` 找「活樹」的 `findBlock` matcher 沒開 `useExtraInfo:true`，`b.position` 永遠是空的，第一個 matcher 其實一律回傳 false，永遠落到「找原木殘幹」的備案（日誌常見「附近無活樹，找到原木殘幹」）。目前行為正確（備案就是找最近的原木），改它會改變選哪一棵樹，所以先不動。

### 2026-10-08 下午：往下挖的停頓、垂直井、往上疊（使用者從畫面觀察到的問題）
使用者看到 ECHO 往下挖時每兩格就停 2～4 秒，問是不是模型在思考；另外交代「往上疊時會不會又出現原地一直跳放不出方塊」。**不是模型**（一個 tunnel_to 是一個動作，中間不呼叫模型；模型思考約 4～7 秒，只發生在動作與動作之間）。實測 + 讀程式：
1. **tunnel_to 往正下方挖成「兩欄來回的井」**（不是階梯）：水平已對齊、只剩往下時，每步「水平走一格 + 往下一格」，水平方向每次反過來，挖出兩欄貫通的井；12 格深走了 21 步、71.6 秒；井壁直立，上不來。**修**：新增 `src/actions/shaft.js`（一格寬的垂直井：每層只挖腳下一格，落下前檢查腳下那格與四周有沒有水／岩漿、往下 12 格內第一個實心方塊之前有沒有液體／虛空、落差 >3 格、落地點旁有沒有液體，有就停下並說明）；`staircase` 加 `shape: stairs|shaft`（預設 stairs）；`tunnel_to` 往正下方改用同一套。實測 12 層：垂直井 9 秒、tunnel_to 正下方 9 秒（原 71 秒）；斜下 12 格 25 秒、12 步（原 21 步）。
2. **走進下一格後沒等落地就讀高度**：每隔一步讀到高一格的位置，用錯的高度重算，12 格走了 21 步。**修**：`settleOnGround()`（tools.js）。
3. **「等身體站穩」的條件有誤，每個動作結束都白等 1.5 秒**（executor 的 `settleBody` 也是）：站在地上時 mineflayer 的垂直速度是 -0.0784（重力），條件卻要求 <0.02，永遠不成立。**修**：門檻 0.1，並要求腳下真的有實心方塊（剛挖掉腳下那格時客戶端要過一個物理刻才發現沒地板，那一刻 onGround 還是 true）。
4. **pillar 在頭頂有岩石時極慢**（封在岩石裡疊 8 格：65 秒只升 4 格）：挖頭頂時手上拿的是墊腳的方塊，**空手挖石頭每塊約 8 秒**。**修**：挖頭頂前先 `selectTool` + `equipFor`。
5. **pillar 的墊腳方塊用完不會換下一種**：選了背包第一種可放的方塊（例如 2 根原木），用完後手上拿的是鎬子（挖頭頂換的），`placeBlock` 對空手／鎬子放不出去，伺服器不理它，每次等 5 秒的 `blockUpdate` 逾時、連 3 次後放棄——這就是使用者看到的「原地一直跳卻放不出方塊」。**修**：`findPlaceable()` 每一跳前重新挑、重新 `equip`。封在岩石裡疊 8 格（原木 2 + 鵝卵石 64）：10 秒。
6. 平地、井裡、隧道裡的 pillar（每跳放一個，8～10 格 3～5 秒）本來就沒問題；`goto` 往上搭方塊（pathfinder 自己疊）有 `goto_scaffold_up_is_fast` 考過。
- **診斷日誌**：tunnel 每步印「挖+等／走進去」毫秒數，shaft 每層印「檢查+挖／落地」，pillar 每跳印「清頭頂幾塊／起跳放置／成功與否」，單塊挖超過 1.5 秒印警告。
- **新考題（phase 14）**：`staircase_shaft_12_fast_one_wide`、`staircase_shaft_stops_above_lava`、`staircase_shaft_stops_above_water`、`tunnel_to_straight_down_is_shaft`、`pillar_sealed_rock_uses_tool_and_switches_blocks`；`gather_budget_cut_is_partial` 改成用「挖掘疲勞」把挖掘速度降到 30%（挖通道變快後 60 格一次動作就挖得完，原題前提失效）。回歸 33 題全過。
- **還沒查**：第 14 輪 Haiku 玩家的 tunnel_to 曾有 3 步各卡 4.7 秒、1 步卡 22.7 秒（看門狗曾喊「卡死、強制跳躍」），原因沒找到；修完上面幾項後的測量沒有再出現，疑似和「兩欄來回 + 位置讀錯」有關，沒有證據確認，之後再出現再查。

### 2026-10-08 傍晚：蓋房子階段第 15 輪（Haiku、努力程度 low，預算 400，簡單難度、傍晚開始）
- **結果**：約 223 次動作，全程血量 20；蓋出一棟房子：地板 5×5 樺木板、圓石牆高 3、屋頂 25 格（混橡木板／圓石／泥土，不整齊）、兩個 1 格的窗洞、屋內 1 支火把；**門只是開口**（關著的門走不進去，它就把門挖掉）；屋內只有 3×3×3。→ **沒達完成條件**（門、好看、怪物處理沒測到：這輪只出現 2 次敵人，沒掉血）。
- **玩家真實遇到的缺口與處理**（都有證據）：
  1. **沒有開關門的動作，pathfinder 也走不過關著的門**。查證：套件的 `canOpenDoors` 只處理柵欄門（名稱含 gate），一般門無論開關都被當實心方塊。**處理**：新增 `use_block`（core，開關門／活板門／柵欄門／拉桿／按鈕，驗證看 block 的 open／powered 狀態有沒有變）；`goto` 走不到時，若目標附近有關著的門，訊息說出門的座標並建議先 `use_block`；pathfinder 的 `getBlock` 包一層，把**打開的**門視為可通行；開著的門只剩約 0.2 格的容錯（門板 0.19 格 + 身體寬 0.6），pathfinder 對不準會卡在門口，所以 `goto` 加了「卡在開著的門旁邊 2.5 秒 → 停掉 pathfinder、算出門洞最寬一段的中心線、蹲走對準穿過去、再繼續」。考題 `goto_blocked_by_door_hints_use_block` 驗證進、出兩個方向。
  2. **`place_block` 放在地面那一層失敗**（Haiku 連錯 5 次，每次只換座標）：訊息改成「這一欄往上第一個放得下的格子是 y=…」。
  3. **同一原因連續失敗**（它換座標一直重試，原因都是「背包沒有 birch_planks」）：執行器記「同一動作＋同一原因」連續次數，≥3 次在訊息與摘要提醒「問題不在座標或參數」。
  4. **地底脫困沒有往上挖的動作**：`tunnel_to` 目標在正上方改用 `pillar`（邊挖頭頂邊墊高，現在不再空手挖）；`surface` 的說明改成涵蓋「從地底回到地表」。
  5. `map top` 右邊的高度圖符號（a、f、h…）沒有圖例：補 `heightNote`。
- **沒改**：`place_block` 對花草本來就能蓋（Haiku 說的「放在 dandelion 失敗」其實是 `inside_self`，自己站在那格）；屋頂材料不夠／森林太遠、整地花很多次——是玩家規劃。
- **新考題（phase 15）**：`use_block_opens_and_closes_door`、`use_block_unsupported_explains`、`goto_blocked_by_door_hints_use_block`、`place_block_occupied_hint_and_repeat_warning`、`tunnel_to_straight_up_uses_pillar`；回歸 21 題全過。

### 2026-10-08 晚：蓋房子第 16 輪（Haiku low、夜晚開始）暴露的怪物處理缺口與修正
- **結果**：ECHO 在這輪連死 7 次以上（我把玩家停掉）。第一個動作（砍樹約 60 秒）就遇到苦力怕和骷髏，血量 20 → 5.7，反射層「血量 ≤6 → 逃向指揮官」，但指揮官（使用者）是旁觀者、不在附近，於是**原地待命被打死**；重生點又被設到考場，後來設回出生點後在那裡被怪物圍著反覆死（空站著被打）。
- **修（反射層，tsbot.js）**：血量 ≤ 8，或 4 秒內連掉 ≥ 6 滴且身邊有怪物 → 中斷動作（模式 flee，executor 會標 interrupted）、**往遠離所有近處怪物的合力方向跑**（每秒重算，蹲跑），身邊安靜 3 秒才解除；苦力怕靠近 5 格不等受傷先躲。`flee_started` 事件與動作訊息說明威脅是誰、多遠（以前只說「向哥哥求救」）。要不要回頭打（`attack`）、蓋掩體（`place_block`）由模型決定。
- **玩家回饋的其他真問題**：① 事件裡混著大量考官的 gamerule／傳送系統訊息 → 過濾掉考官的聊天；② `gather target=dirt` 挖最近的方塊，結果一路往下挖成洞（從 Y108 到 Y101）→ 選目標時避開腳下正下方那一欄，並且 target=dirt 時把草方塊（挖了也掉泥土）一起算，挖表面而不是往下；③ 動作被怪物打斷時結果仍 ok、看不出剛被攻擊 → 摘要加「途中進入撤退／受傷／附近出現敵人」；④ craft 失敗時「背包沒有預期的變化」與「材料不足」兩句並列 → 有具體原因就只寫「未達成」；⑤ **`place_block` 放在花上等 5 秒才失敗**：我原先以為花可以被取代，**錯了**——Minecraft 只有草、蕨、雪層、藤蔓、枯灌木、水這類是 replaceable，花、樹苗、農作物、火把不是，伺服器拒絕是對的；`isReplaceable` 原本把所有非實心方塊都算，改成明確清單，植物擋住時訊息馬上說「花草、樹苗這類植物不能直接蓋過去，要先 dig 挖掉」。
- **新／改考題**：`flee_runs_away_from_zombie_at_low_hp`（不會動的殭屍，驗證往反方向跑到 ≥8 格、事件點名殭屍、血量沒崩）、`flee_from_close_creeper_before_damage`、`gather_dirt_does_not_dig_under_feet`、`place_block_replaceable_grass_vs_flower`；舊的 `flee_reflex`（驗證「向指揮官靠近」）已刪。相關回歸 29 題全過。
- **基礎設施教訓**：① 考官在考試模式時留在考場，ECHO 被我開到別處做量測，使用者和考官各載入一塊區域會卡頓；手動測試時要讓考官也附身（`gamemode spectator Examiner` + `spectate ECHO Examiner`）。② 考試把世界重生點設在考場，ECHO 死亡會被傳到 20000 格外；玩家回合前要 `spawnpoint ECHO <出生點>`。③ ECHO 與伺服器的連線偶爾被重置（`write ECONNRESET`），tsbot 不會自動重連（待查，可能與兩塊區域同時載入的卡頓有關）。

### 2026-10-08 晚：打怪邏輯重做（使用者提議的「先撤退 → 模型決定打哪隻 → 身體持續打到死或模型說停 → 沒下令就自動撤退」）
- **起因**：第 17～20 輪（Haiku low 蓋房子，夜晚起跑／入夜）反覆死亡。證據：① 舊反射「血量 ≤6 逃向指揮官」，指揮官（使用者）是旁觀者不在附近，原地待命被打死；② 修成「遠離怪物」後，骷髏在 10.4 格外射箭，反射看到 10 格內沒怪就解除撤退→被射死（骷髏射程遠，威脅半徑改 20 格，解除要「20 格內沒怪 4 秒、最近 5 秒沒受傷」）；③ 模型自己下的 `attack zombie` 被撤退反射中斷，既沒打贏也沒逃掉；④ `attack` 是「擋住模型直到打完」（until-mode，上限 60 秒），模型根本沒辦法在打的時候說停。
- **舊 attack 的實際邏輯**（combat.js）：挑「當下最近的那隻」→ GoalFollow 跟到 1.5 格 → 裝劍（沒有劍用斧頭，不用鎬子）→ 每 0.6 秒揮一次，距離 <3.5 才打；苦力怕每打一下往後退 0.8 秒；遠程怪（骷髏等）有盾就舉盾；牠死了或模式離開 attack 才結束。一次只打一隻。
- **新設計**：
  1. **先撤退**（tsbot.js）：血量 ≤8，或 4 秒連掉 ≥6 滴且 20 格內有怪 → 中斷動作、往遠離所有近處怪物的合力方向蹲跑（每秒重算），事件／訊息點名怪物與距離；苦力怕靠近 5 格不等受傷先躲。沒有下令就一直是這個預設。
  2. **模型下 `attack` 後**：改成 `continuous`，立刻回「開始攻擊 <名稱>#id（離你 X 格），會一直打到牠死掉；用 obs 看戰況，想停就 stop 或任何新動作。身邊還有 N 隻其他敵人」，**不擋住模型**；身體自己打那一隻直到牠死、模型 `stop`／下新動作、或超過 120 秒。
  3. **打鬥中一般撤退不再中斷戰鬥**，只有血量 ≤3（`ATTACK_FLOOR_HP`）這條最後底線才強制撤退。
  4. **事件**：`attack_ended`（outcome = killed／interrupted／stopped／timeout，附剩餘敵人數與損失血量）、`attack_progress`（打到血量又掉 ≥6）。`stop`、撤退都走同一個收尾出口（`state.endAttack`），才會發 `attack_ended`。
  5. 看門狗不再把「站著揮劍」當卡死（`attack` 從 MOVING_MODES 拿掉）。
- **考題**（phase 17 + 舊題改寫）：`attack_returns_started_immediately`、`attack_not_interrupted_by_normal_flee`（血量 7 也不被一般撤退打斷、打死殭屍）、`attack_last_floor_retreats_at_hp3`、`attack_stop_ends_fight_with_event`；`attack_cow`／`attack_zombie` 改成等 `attack_ended`；反射題 `flee_runs_away_from_zombie_at_low_hp`、`flee_from_close_creeper_before_damage` 全過。
- **刻意沒做**：自動反擊（身邊有近戰怪、有武器就自己打）——偏離「動作不替 agent 做決定」，使用者尚未同意；自動蓋掩體。

### 蓋房子階段小結（2026-10-08，第 15～24 輪；階段目標：「蓋出一棟可以看的房子，並看它處理怪物」，簡單難度）
- **第 24 輪（Sonnet，早上起跑，雪針葉林）**：玩家回報 success，約 155 次動作（浪費約 14 次）；我用伺服器方塊驗證：屋內 5×5×3（x1098～1102、z-240～-236、y70～72）、外框 7×7、屋頂 y73 全封、南面針葉木門（實際開關過，進出都走得通）、窗洞 ≥2、火把 2 支，**結構符合規格**；外觀：整齊的深色針葉木板方盒屋、有圓石基座，**樸素、沒有玻璃**。USABILITY「Good overall」、BLOCKERS 無。未達的完成條件：**⑤ 沒死過**——玩家死了 1 次（屋頂蓋好前 stray 進到屋裡，血量 20→0），重生後做了石劍把牠殺了。
- **歷程（Haiku low 的第 15～20 輪都是夜晚或入夜起跑，空手出門，幾乎無法存活；之後改成早上起跑、改用 Sonnet）修了這些真問題**（每項都有證據與考題）：
  1. 開關門：`use_block`（core 動作第 18 個）；pathfinder 不會開門、也不能穿過打開的門 → `getBlock` 包一層讓打開的門可通行、`goto` 卡在開著的門旁邊時對準門洞蹲走穿過去、走不到時訊息說出附近關著的門；`place_block` 太遠時同樣提示關著的門與目前位置。
  2. 撤退反射（tsbot.js）：舊的「血量 ≤6 逃向指揮官」會原地待命被打死；改成「血量 ≤8，或 4 秒連掉 ≥6 滴且 20 格內有怪 → 中斷動作、往遠離怪物的合力方向蹲跑；苦力怕 5 格內先躲」；威脅半徑 20 格（骷髏射程遠）；解除要「20 格內沒怪 4 秒＋最近 5 秒沒受傷」；**只在受傷當下評估**；**模型下新動作＝接手，撤退立刻結束**（以前撤退存在期間模型的每個動作都被標 interrupted，Sonnet 因此浪費 23 次動作）。
  3. `attack` 重做（照使用者的設計）：下令後立刻回「開始攻擊」（continuous，不擋住模型），身體持續打那一隻到死／`stop`／新動作／120 秒；打鬥中一般撤退不中斷，只有最後底線 `ATTACK_FLOOR_HP` 才強制撤退（原本 3，實戰兩次在 4→0 一次被打死，改 **5**）；事件 `attack_ended`（killed／interrupted／stopped／timeout）、`attack_progress`。
  4. 水中：氧氣 ≤8 就強制中斷動作上浮，不等 45 秒；取消後等動作真的結束再執行 surface、被當成 busy 就重試（原本「反射想救命卻被進行中的動作擋住」，ECHO 溺死）。
  5. 看門狗：最近 10 秒有挖／被中斷的挖／撿東西或正在挖，就不算卡死（砍樹時被連續「強制跳躍脫困」，就是使用者看到的「原地一直跳」）；站著揮劍（attack）不算卡死。
  6. ECHO 與伺服器連線偶爾被重置（`write ECONNRESET`，沒有踢人訊息，原因不明）後程式還活著卻不重連 → 斷線 3 秒後自動重新啟動自己（沿用同一份 stdout/stderr，最多 6 次）；`ctl` 連不上時明講是 ECHO 斷線／重啟中。
  7. 其他：事件過濾考官聊天；`gather dirt` 不挖腳下、草方塊一併算；動作被怪物打斷時摘要加「途中遇怪／受傷／撤退」；craft 失敗有具體原因就不重複籠統那句；`place_block`：植物（花、樹苗）不是可取代方塊（我原先以為可以，錯）、放在地面層失敗時說「這一欄往上第一個放得下的格子是 y=…」、同一原因連續失敗 3 次提醒、目標格有生物站著時馬上說明並翻譯逾時錯誤；`map` 高度圖說明、`obs` 方塊光／天光分開標示。
- **新增工具**：`exam/new_round.ps1`（重啟 ECHO、考官切玩家模式、清怪、換新乾地點、設重生點、確認使用者／考官／ECHO 三個座標一致；`-Time -Difficulty -Round`）。
- **留下的問題**：① 夜晚野外空手就是死局，小模型（Haiku low）基本活不下來，Sonnet 要靠運氣；要不要讓身體自動反擊／自動躲進掩體是設計問題（偏離「動作不替 agent 做決定」，未做）；② 房子沒有玻璃（沒測 smelt 沙子→玻璃路徑）；③ 室內光照 obs 讀數不更新（伺服器光照封包的限制，`torchNearby` 才可靠，未改）；④ `craft` 在有雪層的位置放不下工作台；⑤ 連線被重置的根因沒查到。

### 留給下一階段（待使用者給目標）的清單
1. gather／tunnel_to 單次動作太慢（挖通道約 2.4 秒一步、約 100 秒一次、60 格要 3～4 次呼叫）；`tunnelToPosition` 每步有多處等待，可以評估優化，但要小心不要退步（這段剛修過兩次）。
2. 背包滿了怎麼辦（沒有丟棄動作；隧道順手撿的 cobblestone 一次 +28～47）。
3. craft 自動做工作台會先吃木板再失敗（要先檢查「總木板數 ≥ 4 + 配方」）、staircase 沒指定工具時的選擇不透明。
4. 其他 `.xxx_signal` 信號檔（死重，沒指示就沒刪）。
5. 長期（HANDOFF §8）：原始動作重構、配方依賴圖、去指揮官化、打龍巨集等。

**階段與流程狀態**：前一階段「順暢找到鑽石、做出鑽石鎬、體驗好」已於第 12 輪達成並停下；今天的回歸、第 13 輪（強模型 16 次）、第 14 輪（Haiku 24 次）都再次符合完成條件。**下一個階段的目標由使用者給**。
