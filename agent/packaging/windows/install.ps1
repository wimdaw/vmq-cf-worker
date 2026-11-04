<#
.SYNOPSIS
    安装 V免签 桌面监控端（Windows）。

.DESCRIPTION
    不做成 Windows 服务，而是注册一个「开机启动 + 失败自动重启」的计划任务。
    原因：真正的 Windows 服务需要程序实现 SCM 协议，要么引入 WinSW/NSSM 这类
    外部包装器（多一个二进制、多一条供应链），要么把 agent 改成服务形态。
    计划任务在功能上等价（开机即跑、SYSTEM 身份、失败重启、不需要登录），
    且零外部依赖。

    需要管理员权限。

.EXAMPLE
    .\install.ps1
    .\install.ps1 -InstallDir "D:\tools\vmq-agent"
#>
#Requires -RunAsAdministrator
[CmdletBinding()]
param(
    [string]$InstallDir = "$env:ProgramFiles\vmq-agent",
    [string]$ConfigPath = "$env:ProgramData\vmq-agent\config.json",
    [string]$Arch = "amd64"
)

$ErrorActionPreference = "Stop"

$src = Join-Path $PSScriptRoot "..\..\dist\vmq-agent-windows-$Arch.exe"
if (-not (Test-Path $src)) {
    throw "找不到 $src，请先执行 agent\scripts\build.sh"
}

# ---------- 1. 二进制 ----------
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$exe = Join-Path $InstallDir "vmq-agent.exe"
Copy-Item $src $exe -Force
Write-Host "已安装 $exe"

# ---------- 2. 配置（已存在则不覆盖，避免冲掉线上令牌） ----------
$cfgDir = Split-Path $ConfigPath -Parent
New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null
if (Test-Path $ConfigPath) {
    Write-Host "配置已存在，保留原文件：$ConfigPath"
} else {
    & $exe -init -config $ConfigPath | Out-Null
    Write-Host "已生成示例配置：$ConfigPath（请填写 server.base_url 与 server.token）"
}

# 配置里有令牌，只允许 SYSTEM 与管理员读取
& icacls $ConfigPath /inheritance:r /grant:r "SYSTEM:(F)" "Administrators:(F)" | Out-Null

# ---------- 3. 计划任务 ----------
$taskName = "vmq-agent"
$action = New-ScheduledTaskAction -Execute $exe -Argument "-config `"$ConfigPath`""
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Force | Out-Null

Start-ScheduledTask -TaskName $taskName

Write-Host ""
Write-Host "已注册计划任务 $taskName 并启动。常用命令："
Write-Host "  Get-ScheduledTask -TaskName $taskName | Get-ScheduledTaskInfo"
Write-Host "  & '$exe' -check -config '$ConfigPath'"
Write-Host "  Get-Content '$cfgDir\logs\vmq-agent.log' -Tail 50 -Wait   # 若配置了 alerts.log_file"
Write-Host ""
Write-Host "改了配置后：Restart-ScheduledTask -TaskName $taskName"
Write-Host ""
Write-Host "注意：计划任务以 SYSTEM 运行，没有桌面会话，alerts.desktop 弹窗不会出现。"
Write-Host "      生产环境请配置 alerts.webhook（企业微信/钉钉/飞书机器人）。"
