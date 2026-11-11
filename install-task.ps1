$ErrorActionPreference = 'Stop'
$root   = 'D:\Code\skills\bilibili-daily-comment'
$node   = 'C:\Users\35238\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$script = Join-Path $root 'scripts\daily.mjs'
$name   = 'BilibiliDailyComment'

Import-Module ScheduledTasks -ErrorAction Stop
$action   = New-ScheduledTaskAction -Execute $node -Argument ('"' + $script + '"') -WorkingDirectory $root
$trigger  = New-ScheduledTaskTrigger -Daily -At '19:00'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Description 'B站当天置顶评论热度榜' -Force | Out-Null

$t = Get-ScheduledTask -TaskName $name
Write-Output ('TASK=' + $t.TaskName + ' STATE=' + $t.State)
Write-Output ('EXEC=' + $t.Actions[0].Execute + ' ARGS=' + $t.Actions[0].Arguments)
Write-Output ('NEXT=' + (Get-ScheduledTaskInfo -TaskName $name).NextRunTime)
