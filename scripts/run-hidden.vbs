' Launches the claude-stats-daemon node process with no visible console window.
' Used by the Task Scheduler entry registered by install-task-scheduler.ps1.
Set fso = CreateObject("Scripting.FileSystemObject")
Set ws  = CreateObject("Wscript.Shell")

' This script lives in <daemon>/scripts/. The daemon entrypoint is <daemon>/src/index.js.
scriptDir  = fso.GetParentFolderName(WScript.ScriptFullName)
daemonRoot = fso.GetParentFolderName(scriptDir)
indexJs    = daemonRoot & "\src\index.js"

' Find node.exe on PATH via cmd to avoid hardcoding nvm paths.
' wWindowStyle = 0 means hidden; bWaitOnReturn = False so wscript exits immediately,
' but the spawned node.exe keeps running detached.
ws.CurrentDirectory = daemonRoot
' Redirect stdout/stderr to a rotating log file so the daemon can write freely
' even when no console is attached (otherwise a hidden console can stall on
' large flushes). The log gets truncated on every launch to keep it bounded.
logPath = daemonRoot & "\daemon.log"
ws.Run "cmd.exe /c node """ & indexJs & """ > """ & logPath & """ 2>&1", 0, False
