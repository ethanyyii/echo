# ════════════════════════════════════════════════════════
#  exam/new_round.ps1 — 開新的一輪玩家回合（在專案根目錄執行）
#
#  做的事：封存上一輪回饋 → 重啟 ECHO（狀態乾淨、載入最新程式）→ 考官切「玩家模式」（附身 ECHO）
#          → 世界規則還原、清怪、清背包 → 傳到新的乾地點並設重生點 → 確認你（使用者）、考官、ECHO 三個座標一致。
#  用法：  powershell -File exam/new_round.ps1 [-Time 4000] [-Difficulty easy] [-Round 24]
#  不會做的事：不派玩家、不開監看器（那兩個用 Agent / Monitor 工具）。
# ════════════════════════════════════════════════════════
param(
    [int]$Time = 4000,
    [string]$Difficulty = 'easy',
    [string]$Round = 'x',
    [string]$User = 'ethan0915'
)
$ErrorActionPreference = 'Continue'
Set-Location (Split-Path -Parent $PSScriptRoot)

function C($c) { try { (Invoke-RestMethod -Method Post -Uri http://127.0.0.1:5051/cmd -ContentType 'application/json' -Body (@{command=$c}|ConvertTo-Json -Compress) -TimeoutSec 60) | ConvertTo-Json -Compress -Depth 5 } catch { "ERR: $($_.Exception.Message)" } }
function Pos { $t = C 'data get entity ECHO Pos'; $m = [regex]::Matches($t,'-?\d+\.?\d*d') | ForEach-Object { [math]::Floor([double]$_.Value.TrimEnd('d')) }; return $m }

# 1) 封存回饋
Copy-Item notes\feedback.md "notes\archive\feedback-round$Round.md" -Force -ErrorAction SilentlyContinue
Copy-Item notes\world.md "notes\archive\world-round$Round.md" -Force -ErrorAction SilentlyContinue
Set-Content notes\feedback.md -Value '' -NoNewline
Set-Content notes\world.md -Value '' -NoNewline

# 2) 只停本專案的程序（命令列過濾），再重啟 ECHO 與考官（玩家模式）
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'tsbot\.js|exam[\\/]examiner\.js|exam[\\/]watch\.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Seconds 3
$env:TRAJECTORY_LOG = '1'
Remove-Item Env:EXAM_MODE -ErrorAction SilentlyContinue
Start-Process -FilePath node -ArgumentList 'tsbot.js' -RedirectStandardOutput "$env:TEMP\echo_out.log" -RedirectStandardError "$env:TEMP\echo_err.log" -WindowStyle Hidden
for ($i = 0; $i -lt 20; $i++) { Start-Sleep -Seconds 2; try { if ((Invoke-RestMethod http://127.0.0.1:5070/health -TimeoutSec 3).spawned) { break } } catch {} }
$env:EXAM_MODE = 'play'
Start-Process -FilePath node -ArgumentList 'exam/examiner.js' -RedirectStandardOutput "$env:TEMP\exam_out.log" -RedirectStandardError "$env:TEMP\exam_err.log" -WindowStyle Hidden
Start-Sleep -Seconds 12

# 3) 世界與 ECHO 還原
foreach ($r in 'doDaylightCycle true','doWeatherCycle true','doMobSpawning true','mobGriefing true') { C "gamerule $r" | Out-Null }
foreach ($m in 'zombie','skeleton','creeper','spider','husk','drowned','witch','arrow') { C "kill @e[type=minecraft:$m]" | Out-Null }
C "difficulty $Difficulty" | Out-Null
C 'clear ECHO' | Out-Null; C 'effect clear ECHO' | Out-Null; C 'gamemode survival ECHO' | Out-Null
C 'effect give ECHO minecraft:instant_health 1 10 true' | Out-Null
C "time set $Time" | Out-Null
C 'weather clear' | Out-Null

# 4) 傳到新的乾地點（每輪換一個方向／距離；最多換 4 組隨機地點，都不行就留在最後一個並提醒）
$placed = $false
for ($attempt = 0; $attempt -lt 4 -and -not $placed; $attempt++) {
    $seed = Get-Random -Minimum 300 -Maximum 1500
    $spots = @(@($seed, 300), @(-$seed, -300), @(300, $seed), @(-300, -$seed), @($seed, -$seed), @(-$seed, $seed))
    foreach ($xz in $spots) {
        C "spreadplayers $($xz[0]) $($xz[1]) 0 30 false ECHO" | Out-Null
        Start-Sleep -Seconds 6
        $p = Pos
        $g = C "execute if block $($p[0]) $($p[1]-1) $($p[2]) #minecraft:dirt"
        if ($g -match 'passed') {
            "放在 ($($p -join ',')) 腳下是泥土／草地"
            C "spawnpoint ECHO $($p[0]) $($p[1]) $($p[2])" | Out-Null
            C "setworldspawn $($p[0]) $($p[1]) $($p[2])" | Out-Null
            $placed = $true
            break
        } else { "($($p -join ',')) 腳下不是泥土，換一個" }
    }
}
if (-not $placed) { "⚠️ 找不到乾地點，ECHO 留在最後一個位置（腳下不是泥土），重生點沒有設定" }

# 5) 使用者與考官附身後的座標確認
Start-Sleep -Seconds 12
"使用者:  " + (C "data get entity $User Pos")
"考官:    " + (C 'data get entity Examiner Pos')
"ECHO:    " + (C 'data get entity ECHO Pos')
node exam/ctl.js obs 2>&1 | Select-Object -First 4
