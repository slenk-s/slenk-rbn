# Slenk Notes 生产更新脚本 —— 在 ECS 服务器上以管理员 PowerShell 运行（阿里云 Workbench 粘贴执行）。
# 对应部署计划 docs/superpowers/plans/2026-11-13-ecs-cloud-deployment.md 的 Task 4 日常更新脚本。
# 幂等：已是最新则直接退出；deps 变化才 npm install；构建失败或 pull 冲突会中止且不重启服务。
$ErrorActionPreference = 'Stop'
Set-Location C:\slenk-notes

Write-Host '==> git fetch origin' -ForegroundColor Cyan
git fetch origin
if ($LASTEXITCODE) { throw 'git fetch 失败：检查服务器到 GitHub 的网络/代理' }

$local  = git rev-parse HEAD
$remote = git rev-parse origin/master
Write-Host "本地 $local"
Write-Host "远端 $remote"

if ($local -eq $remote) {
  Write-Host '已是最新，无需更新。' -ForegroundColor Green
  exit 0
}

$dirty = git status --porcelain
if ($dirty) { throw "仓库有未提交改动，先处理再更新：`n$dirty" }

# 只有 package.json 变化才重装依赖（本机到 npm 较慢，能省则省）
$depChanged = git diff --name-only $local $remote -- package.json server/package.json web/package.json
if ($depChanged) {
  Write-Host "==> 依赖变化，npm install：$depChanged" -ForegroundColor Cyan
  npm --prefix server install --no-audit --no-fund
  if ($LASTEXITCODE) { throw 'server npm install 失败' }
  npm --prefix web install --no-audit --no-fund
  if ($LASTEXITCODE) { throw 'web npm install 失败' }
}

Write-Host '==> git pull --ff-only' -ForegroundColor Cyan
git pull --ff-only
if ($LASTEXITCODE) { throw 'git pull --ff-only 失败（服务器有本地提交），中止以免重启到不一致状态' }

Write-Host '==> 构建前端 web' -ForegroundColor Cyan
npm --prefix web run build
if ($LASTEXITCODE) { throw 'web build 失败，未重启服务，线上仍是旧版本' }

Write-Host '==> 重启 slenk-api / slenk-worker' -ForegroundColor Cyan
$nssm = 'C:\slenk-tools\nssm\nssm.exe'
if (Test-Path $nssm) {
  & $nssm restart slenk-api;    if ($LASTEXITCODE) { throw 'slenk-api 重启失败' }
  & $nssm restart slenk-worker; if ($LASTEXITCODE) { throw 'slenk-worker 重启失败' }
} else {
  Restart-Service slenk-api, slenk-worker
}

Write-Host '==> 等待 API 健康检查' -ForegroundColor Cyan
$ok = $false; $deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) {
  try { $r = Invoke-RestMethod 'http://127.0.0.1:3001/api/health' -TimeoutSec 3; if ($r.ok) { $ok = $true; break } } catch { Start-Sleep -Milliseconds 500 }
}
if (-not $ok) { throw 'API 未就绪，查看 C:\slenk-notes\logs\slenk-api.err.log' }
Write-Host "`n更新完成，API 健康。浏览器验证 https://236963.xyz:8443" -ForegroundColor Green
