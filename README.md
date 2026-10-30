# ECHO：與模型無關的 Minecraft Agent

ECHO 讓任何語言模型都能玩 Minecraft。
用 mineflayer 寫的機器人負責「身體」，外部的模型透過 HTTP + JSON 的 Agent API 當「大腦」：大腦看感知、下動作，身體去做，再由驗證器用**真實的世界狀態**判斷這個動作到底成功了沒有。

長期目標是讓 agent 從空背包一路打倒終界龍。目前還沒做到（見[目前進度](#目前進度)）。

> 程式碼由 AI 撰寫；我做的是設計讓 AI 分工、驗收、交接的工作流程，見文末「我在這個專案裡做的事」。

## 架構

```
外部大腦（任何模型、人或 subagent）
   │  HTTP + JSON
   ▼
src/agent/server.js ── Agent API（GET /observe /map /find /events…、POST /act /cancel）
   ▼
src/agent/executor.js ── 驗證參數 → 忙碌鎖 → 逾時 → 取消 → 等身體停穩
   ▼
src/actions/* ── 身體實際做事（挖、砍、合成、放置、移動、戰鬥…）
   ▼
src/agent/verifier.js ── 比較動作前後的真實世界狀態，判定成敗
   ▼
ActionResult 回傳給大腦
```

- **身體**（`tsbot.js`）：連線、反射動作（逃跑、自動進食、低氧上浮、水中脫困、斷線重連）。
- **動作**（`src/actions/`）：原始動作吃座標或實體 id，**不替 agent 做決定**。例如 `place_block` 只放一個方塊，放哪裡由大腦決定。
- **動作定義**（`src/agent/schema.js`）：參數、型別、逾時的唯一來源。預設只給模型 18 個核心動作，因為動作越多，小模型越容易選錯。
- **驗證器**（`src/agent/verifier.js`）：成敗只看真實狀態，例如背包實際增加了什麼、方塊實際放在哪裡，不相信動作自己的回報。

### 為什麼用真實狀態驗證

早期版本的測試只讀終端機輸出，結果「通過」的結論後來全部不可信。所以現在的設計是：動作自己回報的 `ok`，要和世界的真實狀態比對。

## 考場評測（`exam/`）

`exam/run.js` 用另一個「考官」機器人向伺服器查真相，每一題同時判斷兩件事：

| | 動作宣稱成功 | 動作宣稱失敗 |
|---|---|---|
| **世界真的做到了** | PASS | VERIFIER_BUG（驗證器判錯） |
| **世界沒有做到** | ACTION_BUG（動作有問題） | BOTH |

有副作用（例如把不該拆的方塊拆了）也算 ACTION_BUG。這樣可以分清楚是動作壞了、還是驗證器本身壞了。

除了考場，也用 Claude subagent 當「玩家」實際玩，每輪寫回饋（`notes/archive/feedback-round*.md`）。

## 目前進度

- 能做到：砍樹、挖礦（階梯下挖、挖通道、垂直井）、合成（自動做工作台）、熔煉、存取箱子、放置方塊、開關門、攻擊與撤退、蓋簡單的房子。
- 「從空背包做出鑽石鎬」需要的動作數：第 2 輪 99 次 → 第 12 輪 32 次；換成較小的模型（Haiku）24 次也能完成。
- **還沒做到**：下界與終界傳送門、遠程攻擊、搭橋、穿護甲、睡覺、打龍。內建的參考大腦也還沒實作，目前的大腦是人或 subagent 透過 `exam/ctl.js` 操作。

詳細紀錄在 `notes/ENGINEERING.md`。

## 安裝與執行

需要：Node.js 18 以上、Minecraft Java 版 1.21.1。

1. 在 Minecraft 開一個世界，選「對區域網路開放」並允許作弊。
2. 安裝與設定：
   ```bash
   npm install
   cp .env.example .env   # 填入 MC_HOST、MC_PORT、MC_USERNAME 等
   ```
3. 啟動：
   ```bash
   npm start
   ```
   Agent API 預設在 `127.0.0.1:5070`。如果把 `AGENT_HOST` 設成非本機位址，必須同時設定 `AGENT_TOKEN`，否則不會啟動。

呼叫範例：

```bash
curl -X POST http://127.0.0.1:5070/act -H "Content-Type: application/json" -d '{"type":"gather","target":"oak_log"}'
```

回應會包含 `ok`、`status`、`reason`、`evidence`、`inventoryDelta`、`positionDelta` 等欄位。失敗時 `message` 開頭固定是「未達成：<原因>」。

## 開發歷程

| 版本 | 時間 | 變化 |
|---|---|---|
| 初代 | 2026-03 | 單一大檔案的機器人，加上 Python 寫的 Gemini 大腦 |
| 模組化 | 2026-05 | 拆成 `src/actions/`、感知、看門狗 |
| 現行版 | 2026-10 | 重做成與模型無關的 Agent API，加入驗證器與考場評測 |

## 我在這個專案裡做的事：設計讓 AI 把事做好的工作流程

我不寫程式。這個專案的程式碼由 AI 寫，但「AI 要怎麼分工、怎麼知道自己做對了、做錯了誰來抓」是我設計的。我的工作流程會隨專案改變，也一直在進化：

| 階段 | 工作流程 | 為什麼改 |
|---|---|---|
| 初代（2026-03） | Gemini 寫程式，我自己複製、執行 | 每次改碼都整份重生、結果不一致，很耗 context |
| 雙端（2026-05） | Gemini 負責「診斷」問題、說明症狀，Cursor（Sonnet）負責「下藥」改碼並回報給 Gemini；用 system prompt 劃清兩邊的職責 | 兩邊各做擅長的事；但 Cursor 自己改了碼、Gemini 看不到，所以要先劃清界線 |
| 現行（2026-10） | Claude Code 當工程師，加上我設計的「考官」和「玩家」 | 改成與模型無關的 Agent API 後，需要一套能自己驗收的流程 |

現行流程裡我設計的部分：

- **考官替身**：Claude Code 說它讀不到遊戲裡的狀態，我就提議讓它自己接一個替身進遊戲，直接向伺服器查真實狀態、讀數據。這就是 `exam/examiner.js`，也是上面四象限判定的基礎。
- **AI 玩家**：讓 Claude 的 subagent（Haiku，刻意用小模型、低努力程度）當玩家實際玩，每輪玩完寫回饋，Claude Code 再依回饋修。目前做了 23 輪（`notes/archive/feedback-round*.md`）。用小模型是因為我要求「小模型也要能用」。
- **規則**：「動作不能替 agent 做決定」「改程式前先想正常玩家會怎麼做」「階段目標由我給，AI 不自己升級目標」。
- **我的位置**：像客戶一樣看成果。例如我在畫面上看到「疊方塊時地板一直跳」，回報後才追出墊腳放置的時機差一格。

`CLAUDE.md` 與 `notes/` 保留了這套流程實際運作的紀錄。

— 簡翊森（GitHub：ethanyyii）
