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

# The transcripts are recorded outside the checkout and copied into `performance/`
# only after both runs are done: a file this script added to the checkout part-way
# through would change the default file set the formatting task hashes, and the
# second run would no longer be a rerun of unchanged inputs.
$staging = Join-Path $env:TEMP ("harn-49-measure-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $staging | Out-Null

# `fresh` executes every task with the cache cleared; `cached` is the gate an
# operator or the harness runs, so its output shows what an unchanged rerun
# reuses and what it still executes.
$runs = if ($Mode -eq 'validation') { @('fresh', 'cached') } else { @('four-workers') }
foreach ($run in $runs) {
    $name = if ($Mode -eq 'validation') { "validation-$run" } else { 'four-workers' }
    $prefix = Join-Path $staging "harn-49-$name"
    $before = Snapshot
    $metadata = @(
        "Started UTC: $([DateTime]::UtcNow.ToString('o'))"
        "Commit: $(git rev-parse HEAD)"
        "Node: $(node --version); npm: $(npm --version)"
        "Vitest: $((Get-Content node_modules/vitest/package.json -Raw | ConvertFrom-Json).version)"
        "Turborepo: $((Get-Content node_modules/turbo/package.json -Raw | ConvertFrom-Json).version)"
        "OS: $([Environment]::OSVersion.VersionString); logical CPUs: $([Environment]::ProcessorCount)"
        "Workers: $(if ($Mode -eq 'validation') {'policy 8, then boundary 4'} else {'one pool, 4'})"
        "Cache: $(if ($run -eq 'fresh') {'cleared before the run: every task executes'} elseif ($run -eq 'cached') {'the normal gate: unchanged eligible tasks are replayed'} else {'not used — the comparison runs the tests directly'})"
        "Working changes: $(git diff --stat | Out-String)"
    )
    $metadata | Set-Content -LiteralPath "$prefix.txt" -Encoding UTF8
    $watch = [Diagnostics.Stopwatch]::StartNew()
    # Turborepo writes its run banner to stderr, and Windows PowerShell turns redirected
    # native stderr into an error record under `Stop`. The exit code read below is what
    # decides whether a run failed, so the invocation itself runs outside that preference.
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        if ($Mode -eq 'validation' -and $run -eq 'fresh') {
            & npm.cmd run validate:fresh 2>&1 | Tee-Object -FilePath "$prefix-detail.txt"
        } elseif ($Mode -eq 'validation') {
            & npm.cmd run validate 2>&1 | Tee-Object -FilePath "$prefix-detail.txt"
        } else {
            & npm.cmd run test:four-workers -- --reporter=verbose --reporter=json "--outputFile.json=$prefix-timings.txt" 2>&1 |
                Tee-Object -FilePath "$prefix-detail.txt"
        }
    } finally {
        $ErrorActionPreference = $previousPreference
    }
    $result = $LASTEXITCODE
    $watch.Stop()
    # Windows PowerShell's Tee-Object uses UTF-16. Keep the complete text in
    # UTF-8 for repository review; the JSON reporter file is left byte-for-byte.
    $verboseText = [IO.File]::ReadAllText("$prefix-detail.txt")
    [IO.File]::WriteAllText("$prefix-detail.txt", $verboseText, [Text.UTF8Encoding]::new($false))
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
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath "$prefix-cleanup.txt" -Encoding UTF8
    if ($result -ne 0 -or $newProcesses.Count -ne 0 -or $newDirectories.Count -ne 0) {
        throw "Run $run failed or left new processes/directories; its raw output is in $prefix-detail.txt."
    }
}

# Both runs are complete: publish what they recorded, once, and leave nothing staged.
Copy-Item -Path "$staging/harn-49-*" -Destination "performance/" -Force
Remove-Item -LiteralPath $staging -Recurse -Force
