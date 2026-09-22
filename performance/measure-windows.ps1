param([ValidateSet('validation', 'four-workers')][string]$Mode = 'validation')

# Read-only host inventory; this script never terminates a process or deletes a fixture.
$ErrorActionPreference = 'Stop'
function Snapshot {
    $processes = @(Get-CimInstance Win32_Process | Where-Object {
        $_.Name -in @('node.exe', 'git.exe', 'cmd.exe', 'taskkill.exe')
    } | ForEach-Object {
        [pscustomobject]@{
            Identity = "$($_.ProcessId)/$($_.CreationDate.ToUniversalTime().ToString('o'))"
            Parent = $_.ParentProcessId
            Name = $_.Name
            CommandLine = $_.CommandLine
        }
    })
    $directories = @(Get-ChildItem -LiteralPath $env:TEMP -Directory |
        Where-Object { $_.Name -like 'nexus-harness-*' -or $_.Name -like 'nexus-live-check-*' } |
        ForEach-Object FullName)
    return @{ Processes = $processes; Directories = $directories }
}

$runs = if ($Mode -eq 'validation') { @(1, 2) } else { @('four-workers') }
foreach ($run in $runs) {
    $name = if ($Mode -eq 'validation') { "validation-$run" } else { 'four-workers' }
    $prefix = "performance/harn-48-$name"
    $before = Snapshot
    $metadata = @(
        "Started UTC: $([DateTime]::UtcNow.ToString('o'))"
        "Commit: $(git rev-parse HEAD)"
        "Node: $(node --version); npm: $(npm --version)"
        "Vitest: $((Get-Content node_modules/vitest/package.json -Raw | ConvertFrom-Json).version)"
        "OS: $([Environment]::OSVersion.VersionString); logical CPUs: $([Environment]::ProcessorCount)"
        "Workers: $(if ($Mode -eq 'validation') {'policy 8, then boundary 4'} else {'one pool, 4'})"
        "Working changes: $(git diff --stat | Out-String)"
    )
    $metadata | Set-Content -LiteralPath "$prefix.txt" -Encoding UTF8
    $watch = [Diagnostics.Stopwatch]::StartNew()
    if ($Mode -eq 'validation') {
        & npm.cmd run validate -- -- --reporter=verbose --reporter=json "--outputFile.json=$prefix-timings.txt" 2>&1 |
            Tee-Object -FilePath "$prefix-detail.txt"
    } else {
        & npm.cmd run test:four-workers -- --reporter=verbose --reporter=json "--outputFile.json=$prefix-timings.txt" 2>&1 |
            Tee-Object -FilePath "$prefix-detail.txt"
    }
    $result = $LASTEXITCODE
    $watch.Stop()
    # Windows PowerShell's Tee-Object uses UTF-16. Keep the complete text in
    # UTF-8 for repository review; the JSON reporter file is left byte-for-byte.
    $verboseText = [IO.File]::ReadAllText((Join-Path (Get-Location) "$prefix-detail.txt"))
    [IO.File]::WriteAllText((Join-Path (Get-Location) "$prefix-detail.txt"), $verboseText, [Text.UTF8Encoding]::new($false))
    $after = Snapshot
    $newProcesses = @($after.Processes | Where-Object { $_.Identity -notin $before.Processes.Identity })
    $newDirectories = @($after.Directories | Where-Object { $_ -notin $before.Directories })
    @(
        "Ended UTC: $([DateTime]::UtcNow.ToString('o'))"
        "Exit code: $result"
        "Total command wall seconds: $($watch.Elapsed.TotalSeconds.ToString('F3', [Globalization.CultureInfo]::InvariantCulture))"
    ) | Add-Content -LiteralPath "$prefix.txt" -Encoding UTF8
    @{
        BeforeProcesses = $before.Processes
        AfterProcesses = $after.Processes
        NewProcesses = $newProcesses
        BeforeDirectoryCount = $before.Directories.Count
        AfterDirectoryCount = $after.Directories.Count
        NewDirectories = $newDirectories
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath "performance/harn-48-fixture-cleanup-$run.txt" -Encoding UTF8
    if ($result -ne 0 -or $newProcesses.Count -ne 0 -or $newDirectories.Count -ne 0) {
        throw "Run $run failed or left new processes/directories; inspect its raw output and cleanup inventory."
    }
}
