param(
    [ValidateSet('Install', 'Test')]
    [string]$Mode = 'Install'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-BuildToolsEvent {
    param([string]$Stage, [hashtable]$Details = @{})

    $record = [ordered]@{
        event = 'windows.build_tools'
        stage = $Stage
        timestamp = [DateTime]::UtcNow.ToString('o')
    }
    foreach ($key in $Details.Keys) {
        $record[$key] = $Details[$key]
    }
    Write-Host ($record | ConvertTo-Json -Compress)
}

function Assert-InstallerExitCode {
    param([int]$ExitCode)

    if ($ExitCode -notin @(0, 3010)) {
        throw "MSVC library installation failed (exit code $ExitCode)."
    }
}

# Wait for setup.exe itself, not ServiceHub or other long-lived descendants.
# Timeout cleanup is scoped to this installer tree and has its own bounded wait.
function Wait-BuildToolsInstaller {
    param([System.Diagnostics.Process]$Installer, [int]$TimeoutMs)

    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    Write-BuildToolsEvent 'installer.started' @{
        processId = $Installer.Id
        timeoutMs = $TimeoutMs
    }
    if (-not $Installer.WaitForExit($TimeoutMs)) {
        Write-BuildToolsEvent 'installer.timed_out' @{
            processId = $Installer.Id
            elapsedMs = $timer.ElapsedMilliseconds
        }
        try {
            $Installer.Kill($true)
            $exited = $Installer.WaitForExit(5000)
            Write-BuildToolsEvent 'installer.cleanup' @{ exited = $exited }
        } catch {
            # Do not replace the timeout with a cleanup error or print raw OS diagnostics.
            Write-BuildToolsEvent 'installer.cleanup_failed'
        }
        throw "MSVC library installation exceeded its $TimeoutMs ms timeout."
    }
    $exitCode = $Installer.ExitCode
    Write-BuildToolsEvent 'installer.exited' @{
        processId = $Installer.Id
        elapsedMs = $timer.ElapsedMilliseconds
        exitCode = $exitCode
        rebootRequired = $exitCode -eq 3010
    }
    Assert-InstallerExitCode $exitCode
}

if ($Mode -eq 'Test') {
    Assert-InstallerExitCode 0
    Assert-InstallerExitCode 3010
    $rejected = $false
    try {
        Assert-InstallerExitCode 1603
    } catch {
        $rejected = $_.Exception.Message -eq 'MSVC library installation failed (exit code 1603).'
    }
    if (-not $rejected) {
        throw 'Unexpected installer exit codes must fail.'
    }

    # Real child processes exercise completion, failure, timeout, cleanup and safe logs.
    foreach ($scenario in @(
        @{ command = 'exit 0'; timeoutMs = 10000; failure = ''; stage = 'installer.exited' },
        @{ command = 'exit 7'; timeoutMs = 10000; failure = 'exit code 7'; stage = 'installer.exited' },
        @{ command = 'Start-Sleep -Seconds 60'; timeoutMs = 100; failure = 'timeout'; stage = 'installer.timed_out' }
    )) {
        $startInfo = [System.Diagnostics.ProcessStartInfo]::new((Get-Process -Id $PID).Path)
        $startInfo.UseShellExecute = $false
        foreach ($argument in @('-NoProfile', '-NonInteractive', '-Command', $scenario.command)) {
            $startInfo.ArgumentList.Add($argument)
        }
        $child = [System.Diagnostics.Process]::Start($startInfo)
        $failure = ''
        $records = @()
        try {
            $records = @(& {
                try {
                    Wait-BuildToolsInstaller $child $scenario.timeoutMs
                } catch {
                    # Keep the emitted information stream even when the wait throws.
                    Write-Output $_.Exception.Message
                }
            } 6>&1)
            $failure = ($records | Where-Object { $_ -is [string] }) -join ''
            $events = @($records | Where-Object { $_ -is [System.Management.Automation.InformationRecord] } |
                ForEach-Object { $_.MessageData.ToString() | ConvertFrom-Json })
            if ($scenario.failure -eq '' -and $failure -ne '') {
                throw "Successful installer was rejected: $failure"
            }
            if ($scenario.failure -ne '' -and -not $failure.Contains($scenario.failure)) {
                throw 'Installer failure was not reported.'
            }
            if (-not $child.HasExited -or $scenario.stage -notin $events.stage) {
                throw 'Installer termination or stage diagnostics were missing.'
            }
            if ('installer.started' -notin $events.stage) {
                throw 'Installer start diagnostics were missing.'
            }
            $started = $events | Where-Object { $_.stage -eq 'installer.started' }
            $finished = $events | Where-Object { $_.stage -eq $scenario.stage }
            if ($started.processId -ne $child.Id -or $started.timeoutMs -ne $scenario.timeoutMs -or
                $finished.elapsedMs -lt 0) {
                throw 'Installer diagnostic fields were incorrect.'
            }
            if ($scenario.stage -eq 'installer.timed_out') {
                $cleanup = $events | Where-Object { $_.stage -eq 'installer.cleanup' }
                if ($null -eq $cleanup -or -not $cleanup.exited) {
                    throw 'Timeout cleanup did not confirm installer termination.'
                }
            } elseif ($finished.exitCode -ne $child.ExitCode) {
                throw 'Installer exit-code diagnostics were incorrect.'
            }
        } finally {
            if (-not $child.HasExited) {
                $child.Kill($true)
            }
            $child.Dispose()
        }
    }
    Write-Host 'Windows build tools timeout and diagnostic tests passed.'
    exit 0
}

$stage = 'discovery'
$installer = $null
try {
    Write-BuildToolsEvent $stage
    $installerDirectory = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer'
    $vswhere = Join-Path $installerDirectory 'vswhere.exe'
    $toolsComponent = 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64'
    $spectreComponent = 'Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre'
    $installation = & $vswhere -latest -products '*' -requires $toolsComponent -property installationPath
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($installation)) {
        throw 'MSVC build tools could not be located.'
    }
    $stage = 'component.check'
    Write-BuildToolsEvent $stage
    $readyInstallation = & $vswhere -latest -products '*' -requires $toolsComponent $spectreComponent -property installationPath
    if ($LASTEXITCODE -ne 0) {
        throw 'MSVC component discovery failed.'
    }
    if ($readyInstallation -eq $installation) {
        Write-BuildToolsEvent 'component.already_installed'
        exit 0
    }

    $stage = 'installer'
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new((Join-Path $installerDirectory 'setup.exe'))
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    foreach ($argument in @('modify', '--installPath', $installation, '--add', $spectreComponent, '--quiet', '--norestart')) {
        $startInfo.ArgumentList.Add($argument)
    }
    $installer = [System.Diagnostics.Process]::Start($startInfo)
    Wait-BuildToolsInstaller $installer 600000

    $stage = 'component.verify'
    Write-BuildToolsEvent $stage
    $readyInstallation = & $vswhere -latest -products '*' -requires $toolsComponent $spectreComponent -property installationPath
    if ($LASTEXITCODE -ne 0 -or $readyInstallation -ne $installation) {
        throw 'Installer exited without the required MSVC libraries being available.'
    }
    Write-BuildToolsEvent 'component.verified'
} catch {
    Write-BuildToolsEvent 'failed' @{ failedStage = $stage }
    throw
} finally {
    if ($null -ne $installer) {
        $installer.Dispose()
    }
}
