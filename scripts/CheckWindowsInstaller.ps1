param(
    [ValidateSet('Install', 'Test')]
    [string]$Mode = 'Install',
    [string]$Directory = 'release',
    [string]$Version = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-NoTroRegistration {
    param([Microsoft.Win32.RegistryKey]$Registration)
    # Uninstall entries such as AddressBook legitimately omit DisplayName.
    $displayName = $Registration.GetValue('DisplayName', $null)
    if ($displayName -match '^Tro(?:\s|$)') {
        throw 'Installer probe refuses an existing Tro registration.'
    }
}

function Assert-ShortcutTarget {
    param([string]$Path, [string]$ExpectedTarget)
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -lt 76 -or [BitConverter]::ToUInt32($bytes, 0) -ne 76) {
        throw 'Shortcut has an invalid Shell Link header.'
    }
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($Path)
    if ([string]::IsNullOrWhiteSpace($shortcut.TargetPath) -or
        -not [string]::Equals([System.IO.Path]::GetFullPath($shortcut.TargetPath),
            [System.IO.Path]::GetFullPath($ExpectedTarget), [StringComparison]::OrdinalIgnoreCase) -or
        -not (Test-Path -LiteralPath $ExpectedTarget -PathType Leaf)) {
        throw 'Shortcut does not target the installed Tro executable.'
    }
}

function Assert-TemporaryInstallPath {
    param([string]$Path, [string]$TemporaryRoot)
    $root = [System.IO.Path]::GetFullPath($TemporaryRoot).TrimEnd('\') + '\'
    $target = [System.IO.Path]::GetFullPath($Path)
    if (-not $target.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Installer probe path is outside its temporary directory.'
    }
}

function Invoke-InstallerProcess {
    param([string]$Path, [string[]]$Arguments)
    $process = Start-Process -FilePath $Path -ArgumentList $Arguments -WindowStyle Hidden -PassThru
    try {
        if (-not $process.WaitForExit(120000)) {
            $process.Kill($true)
            throw 'Installer probe process timed out.'
        }
        if ($process.ExitCode -ne 0) { throw 'Installer probe process failed.' }
    } finally { $process.Dispose() }
}

if ($Mode -eq 'Test') {
    $temporaryRoot = [System.IO.Path]::GetTempPath()
    $temporaryDirectory = Join-Path $temporaryRoot ('TroInstallerTest-' + [guid]::NewGuid())
    Assert-TemporaryInstallPath $temporaryDirectory $temporaryRoot
    New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null
    $registryFixturePath = 'HKCU:\Software\TroInstallerTest-' + [guid]::NewGuid()
    try {
        New-Item -Path $registryFixturePath | Out-Null
        Assert-NoTroRegistration (Get-Item -LiteralPath $registryFixturePath)
        foreach ($displayName in @('', 'Other application', 'Trojan')) {
            New-ItemProperty -LiteralPath $registryFixturePath -Name DisplayName -Value $displayName -PropertyType String -Force | Out-Null
            Assert-NoTroRegistration (Get-Item -LiteralPath $registryFixturePath)
        }
        foreach ($displayName in @('Tro', 'Tro 0.1.0', 'tro')) {
            New-ItemProperty -LiteralPath $registryFixturePath -Name DisplayName -Value $displayName -PropertyType String -Force | Out-Null
            $rejected = $false
            try { Assert-NoTroRegistration (Get-Item -LiteralPath $registryFixturePath) }
            catch { $rejected = $_.Exception.Message -eq 'Installer probe refuses an existing Tro registration.' }
            if (-not $rejected) { throw 'Existing Tro registration was accepted.' }
        }
        Write-Output 'Windows installer registration fixtures passed.'
        $target = Join-Path $temporaryDirectory 'Tro.exe'
        $link = Join-Path $temporaryDirectory 'Tro.lnk'
        [System.IO.File]::WriteAllBytes($target, [byte[]]@(0x4d, 0x5a))
        [System.IO.File]::WriteAllBytes($link, [byte[]]::new(2190))
        $rejected = $false
        try { Assert-ShortcutTarget $link $target }
        catch { $rejected = $_.Exception.Message -eq 'Shortcut has an invalid Shell Link header.' }
        if (-not $rejected) { throw 'Zero-filled shortcut was accepted.' }
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($link)
        $shortcut.TargetPath = $target
        $shortcut.Save()
        Assert-ShortcutTarget $link $target
        $rejected = $false
        try { Assert-ShortcutTarget $link (Join-Path $temporaryDirectory 'Missing.exe') }
        catch { $rejected = $_.Exception.Message -eq 'Shortcut does not target the installed Tro executable.' }
        if (-not $rejected) { throw 'Wrong shortcut target was accepted.' }
        Write-Output 'Windows installer shortcut fixtures passed.'
    } finally {
        if (Test-Path -LiteralPath $registryFixturePath) {
            Remove-Item -LiteralPath $registryFixturePath -Force
        }
        Assert-TemporaryInstallPath $temporaryDirectory $temporaryRoot
        Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force
    }
    exit 0
}

# Real installation belongs only on a disposable GitHub-hosted Windows runner.
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or
    $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or
    [string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) {
    throw 'Installer probe requires a disposable GitHub Windows runner.'
}
if ($Version -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$') {
    throw 'Expected installer version is invalid.'
}
$startMenuLink = Join-Path ([Environment]::GetFolderPath('Programs')) 'Tro.lnk'
$desktopLink = Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'Tro.lnk'
if ((Test-Path -LiteralPath $startMenuLink) -or (Test-Path -LiteralPath $desktopLink) -or
    (Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'Programs\tro'))) {
    throw 'Installer probe refuses an existing Tro installation or shortcut.'
}
foreach ($registryRoot in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) {
    foreach ($registration in @(Get-ChildItem -LiteralPath $registryRoot -ErrorAction SilentlyContinue)) {
        Assert-NoTroRegistration $registration
    }
}
$root = (Resolve-Path -LiteralPath $Directory).Path
$installer = Join-Path $root "Tro-$Version-windows-x64-setup.exe"
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { throw 'Versioned installer is missing.' }
$temporaryDirectory = Join-Path $env:RUNNER_TEMP ('TroInstallerSmoke-' + [guid]::NewGuid())
$installDirectory = Join-Path $temporaryDirectory 'App'
Assert-TemporaryInstallPath $installDirectory $env:RUNNER_TEMP
New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null
$stage = 'install'
try {
    # Silent one-click NSIS installation does not launch Tro. /D must be last.
    Invoke-InstallerProcess $installer @('/S', "/D=$installDirectory")
    $stage = 'version'
    $application = Join-Path $installDirectory 'Tro.exe'
    $installedVersion = (Get-Item -LiteralPath $application).VersionInfo.FileVersion
    if ($installedVersion -notmatch ('^' + [regex]::Escape($Version) + '(\.0)?$')) {
        throw 'Installed executable version does not match the release.'
    }
    $stage = 'native_driver'
    foreach ($relativePath in @('resources\cua-driver\cua-driver.exe', 'resources\cua-driver\CompanionBuild.json')) {
        $expected = Get-FileHash -LiteralPath (Join-Path $root ('win-unpacked\' + $relativePath)) -Algorithm SHA256
        $actual = Get-FileHash -LiteralPath (Join-Path $installDirectory $relativePath) -Algorithm SHA256
        if ($expected.Hash -ne $actual.Hash) { throw 'Installed native driver does not match the packaged build.' }
    }
    $stage = 'shortcuts'
    Assert-ShortcutTarget $startMenuLink $application
    Assert-ShortcutTarget $desktopLink $application
    Write-Output (@{ event = 'release.installer.verified'; version = $Version; shortcuts = 2 } | ConvertTo-Json -Compress)
} catch {
    Write-Output (@{ event = 'release.installer.failed'; stage = $stage } | ConvertTo-Json -Compress)
    throw
} finally {
    $uninstaller = Join-Path $installDirectory 'Uninstall Tro.exe'
    if (Test-Path -LiteralPath $uninstaller -PathType Leaf) {
        Assert-TemporaryInstallPath $uninstaller $env:RUNNER_TEMP
        try {
            Invoke-InstallerProcess $uninstaller @('/S')
            # NSIS can hand cleanup to a temporary copy of the uninstaller.
            $deadline = [DateTime]::UtcNow.AddSeconds(30)
            while ((Test-Path -LiteralPath (Join-Path $installDirectory 'Tro.exe')) -and [DateTime]::UtcNow -lt $deadline) {
                Start-Sleep -Milliseconds 200
            }
            if ((Test-Path -LiteralPath (Join-Path $installDirectory 'Tro.exe')) -or
                (Test-Path -LiteralPath $startMenuLink) -or (Test-Path -LiteralPath $desktopLink)) {
                throw 'Installer probe uninstallation left application files or shortcuts.'
            }
        } catch {
            Write-Output (@{ event = 'release.installer.failed'; stage = 'uninstall' } | ConvertTo-Json -Compress)
            throw
        }
    }
}
