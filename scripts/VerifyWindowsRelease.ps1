param(
    [ValidateSet('Verify', 'UnsignedResources', 'SignedFile', 'Test')]
    [string]$Mode = 'Verify',
    [string]$Directory = 'release',
    [string]$Publisher = $env:AZURE_SIGNING_PUBLISHER,
    [switch]$RequireUpdateMetadata
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Test-PortableExecutable {
    param([string]$Path)
    $stream = [System.IO.File]::OpenRead($Path)
    try {
        # Other OS native prebuilds can have the same .node extension.
        return $stream.ReadByte() -eq 0x4d -and $stream.ReadByte() -eq 0x5a
    } finally {
        $stream.Dispose()
    }
}

function Assert-Signature {
    param([string]$Status, [string]$ActualPublisher, [bool]$HasCodeSigningEku,
          [bool]$HasTimestamp, [string]$ExpectedPublisher = '')
    if ($Status -ne 'Valid') {
        throw "Authenticode verification failed ($Status). Check trust, revocation connectivity, or tampering."
    }
    if (-not $HasCodeSigningEku) {
        throw 'The certificate does not permit code signing.'
    }
    if ($ExpectedPublisher -and ($ActualPublisher -cne $ExpectedPublisher -or -not $HasTimestamp)) {
        throw 'Tro publisher or trusted timestamp did not match.'
    }
}

function Read-Signature {
    param([string]$Path, [string]$ExpectedPublisher = '')
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    $actualPublisher = ''
    if ($null -ne $signature.SignerCertificate) {
        $actualPublisher = $signature.SignerCertificate.GetNameInfo(
            [System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
    }
    $hasCodeSigningEku = $null -ne $signature.SignerCertificate -and
        @($signature.SignerCertificate.Extensions | Where-Object {
            $_ -is [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]
        } | ForEach-Object { $_.EnhancedKeyUsages } | Where-Object {
            $_.Value -eq '1.3.6.1.5.5.7.3.3'
        }).Count -gt 0
    Assert-Signature -Status $signature.Status.ToString() -ActualPublisher $actualPublisher `
        -HasCodeSigningEku $hasCodeSigningEku -HasTimestamp ($null -ne $signature.TimeStamperCertificate) `
        -ExpectedPublisher $ExpectedPublisher
    return [ordered]@{
        status = $signature.Status.ToString()
        publisher = $actualPublisher
        timestamped = $null -ne $signature.TimeStamperCertificate
    }
}

function Assert-UpdateMetadata {
    param([string]$Content, [string]$InstallerName, [string]$Sha512, [long]$Size)
    # Accept the single-file YAML shape emitted by our pinned builder, not arbitrary YAML.
    # Artifact names contain no spaces/quotes. Fail closed if builder changes this shape.
    $urls = [regex]::Matches($Content, '(?m)^  - url: ([A-Za-z0-9._-]+)\r?$')
    $paths = [regex]::Matches($Content, '(?m)^path: ([A-Za-z0-9._-]+)\r?$')
    $hashes = [regex]::Matches($Content, '(?m)^(?:    )?sha512: ([A-Za-z0-9+/=]+)\r?$')
    $sizes = [regex]::Matches($Content, '(?m)^    size: ([0-9]+)\r?$')
    if ($urls.Count -ne 1 -or $paths.Count -ne 1 -or $hashes.Count -ne 2 -or $sizes.Count -ne 1) {
        throw "Invalid latest.yml layout (urls=$($urls.Count), paths=$($paths.Count), hashes=$($hashes.Count), sizes=$($sizes.Count))."
    }
    if ($urls[0].Groups[1].Value -cne $InstallerName -or $paths[0].Groups[1].Value -cne $InstallerName) {
        throw 'latest.yml installer name does not match the final signed installer.'
    }
    if ($hashes[0].Groups[1].Value -cne $Sha512 -or $hashes[1].Groups[1].Value -cne $Sha512) {
        throw 'latest.yml SHA-512 does not match the final signed installer.'
    }
    $metadataSize = 0L
    if (-not [long]::TryParse($sizes[0].Groups[1].Value, [ref]$metadataSize) -or $metadataSize -ne $Size) {
        throw 'latest.yml size does not match the final signed installer.'
    }
}

function Assert-UpdateManifest {
    param([string]$Directory, [System.IO.FileInfo]$Installer, [switch]$Required)
    # The generic feed for this Windows x64 target uses latest.yml. Builder diagnostic
    # YAML can exist even without a feed and must not be verified or uploaded as updates.
    $metadataPath = Join-Path $Directory 'latest.yml'
    if (-not (Test-Path -LiteralPath $metadataPath -PathType Leaf)) {
        if ($Required) { throw 'Required Windows update metadata is missing: latest.yml.' }
        return
    }
    $digest = [System.Security.Cryptography.SHA512]::HashData([System.IO.File]::ReadAllBytes($Installer.FullName))
    Assert-UpdateMetadata (Get-Content -LiteralPath $metadataPath -Raw) $Installer.Name `
        ([Convert]::ToBase64String($digest)) $Installer.Length
    Write-Output 'Verified Windows update metadata: latest.yml.'
}

function Invoke-VerificationTests {
    $temporaryDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
    New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null
    try {
        $file = Join-Path $temporaryDirectory 'Fixture.node'
        [System.IO.File]::WriteAllBytes($file, [byte[]]@(0x4d, 0x5a))
        if (-not (Test-PortableExecutable $file)) { throw 'PE detection failed.' }
        [System.IO.File]::WriteAllBytes($file, [byte[]]@(0x7f, 0x45))
        if (Test-PortableExecutable $file) { throw 'Non-PE detection failed.' }
        Assert-Signature 'Valid' 'Tro Test' $true $true 'Tro Test'
        Assert-Signature 'Valid' 'Vendor Test' $true $false
        foreach ($case in @(
            @('NotSigned', 'Tro Test', $true, $true),
            @('HashMismatch', 'Tro Test', $true, $true),
            @('UnknownError', 'Tro Test', $true, $true),
            @('Valid', 'Wrong Publisher', $true, $true),
            @('Valid', 'Tro Test', $false, $true),
            @('Valid', 'Tro Test', $true, $false)
        )) {
            $rejected = $false
            try { Assert-Signature $case[0] $case[1] $case[2] $case[3] 'Tro Test' }
            catch { $rejected = $true }
            if (-not $rejected) { throw 'Invalid signature fixture was accepted.' }
        }
        $metadata = "version: 0.1.0`nfiles:`n  - url: Tro-setup.exe`n    sha512: YWJj`n    size: 10`npath: Tro-setup.exe`nsha512: YWJj`n"
        Assert-UpdateMetadata $metadata 'Tro-setup.exe' 'YWJj' 10
        foreach ($case in @(
            @{ content = $metadata.Replace('size: 10', 'size: 11'); reason = 'size does not match' },
            @{ content = $metadata.Replace('size: 10', 'size: 999999999999999999999'); reason = 'size does not match' },
            @{ content = $metadata.Replace('YWJj', 'bad'); reason = 'SHA-512 does not match' },
            @{ content = $metadata.Replace('Tro-setup.exe', 'Wrong-setup.exe'); reason = 'installer name does not match' },
            @{ content = $metadata.Replace('Tro-setup.exe', '../bad.exe'); reason = 'layout' },
            @{ content = ''; reason = 'layout' }
        )) {
            $rejected = $false
            try { Assert-UpdateMetadata $case.content 'Tro-setup.exe' 'YWJj' 10 }
            catch {
                $rejected = $_.Exception.Message.Contains('latest.yml') -and
                    $_.Exception.Message.Contains($case.reason)
            }
            if (-not $rejected) { throw 'Invalid update fixture was accepted.' }
        }
        $installerPath = Join-Path $temporaryDirectory 'Tro-setup.exe'
        [System.IO.File]::WriteAllBytes($installerPath, [byte[]]@(0x4d, 0x5a))
        $installer = Get-Item -LiteralPath $installerPath
        [System.IO.File]::WriteAllText((Join-Path $temporaryDirectory 'builder-debug.yml'), "x64:`n  firstOrDefaultFilePatterns: []`n")
        Assert-UpdateManifest -Directory $temporaryDirectory -Installer $installer
        $rejected = $false
        try { Assert-UpdateManifest -Directory $temporaryDirectory -Installer $installer -Required }
        catch { $rejected = $_.Exception.Message -ceq 'Required Windows update metadata is missing: latest.yml.' }
        if (-not $rejected) { throw 'Builder diagnostic YAML was accepted as a required update manifest.' }
        $digest = [System.Security.Cryptography.SHA512]::HashData([System.IO.File]::ReadAllBytes($installerPath))
        $manifestPath = Join-Path $temporaryDirectory 'latest.yml'
        $manifest = $metadata.Replace('YWJj', [Convert]::ToBase64String($digest)).Replace('size: 10', 'size: 2')
        [System.IO.File]::WriteAllText($manifestPath, $manifest)
        Assert-UpdateManifest -Directory $temporaryDirectory -Installer $installer -Required
        # Changing signed installer bytes after metadata generation must still fail.
        [System.IO.File]::WriteAllBytes($installerPath, [byte[]]@(0x4d, 0x5b))
        foreach ($required in @($false, $true)) {
            $rejected = $false
            try { Assert-UpdateManifest -Directory $temporaryDirectory -Installer $installer -Required:$required }
            catch { $rejected = $_.Exception.Message -ceq 'latest.yml SHA-512 does not match the final signed installer.' }
            if (-not $rejected) { throw 'Changed installer bytes were accepted.' }
        }
        Write-Output 'Windows verification fixtures passed.'
    } finally {
        Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force
    }
}

if ($Mode -eq 'Test') {
    Invoke-VerificationTests
    exit 0
}

$root = (Resolve-Path -LiteralPath $Directory).Path
if ($Mode -eq 'SignedFile') {
    if ([string]::IsNullOrWhiteSpace($Publisher)) { throw 'Expected Tro publisher is required.' }
    Read-Signature $root $Publisher | Out-Null
    Write-Output 'Verified signed Windows file before packaging.'
    exit 0
}
if ($Mode -eq 'UnsignedResources') {
    $unsigned = [System.Collections.Generic.List[string]]::new()
    foreach ($file in Get-ChildItem -LiteralPath $root -File -Recurse) {
        if ($file.Extension -notin @('.exe', '.dll', '.node') -or -not (Test-PortableExecutable $file.FullName)) {
            continue
        }
        $relativePath = [System.IO.Path]::GetRelativePath($root, $file.FullName)
        # electron-builder edits/signs the main executable after afterPack.
        if ($relativePath -ceq 'Tro.exe') { continue }
        $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
        if ($signature.Status.ToString() -eq 'NotSigned') {
            $unsigned.Add($relativePath)
        } else {
            Read-Signature $file.FullName | Out-Null
        }
    }
    ConvertTo-Json -InputObject @($unsigned.ToArray()) -Compress
    exit 0
}

if ([string]::IsNullOrWhiteSpace($Publisher)) { throw 'Expected Tro publisher is required.' }
$appDirectory = Join-Path $root 'win-unpacked'
foreach ($entry in @('Tro.exe', 'resources/cua-driver/cua-driver.exe',
    'resources/cua-sdk/node_modules/@trycua/cua-driver/dist/index.js',
    'resources/cua-sdk/node_modules/@ubjs/core/dist/esm/index.js',
    'resources/cua-sdk/node_modules/@ubjs/node/typescript/dist/resolve-lib.js')) {
    if (-not (Test-Path -LiteralPath (Join-Path $appDirectory $entry) -PathType Leaf)) {
        throw "Required packaged resource is missing: $entry"
    }
}
$installers = @(Get-ChildItem -LiteralPath $root -File -Filter 'Tro-*-windows-x64-setup.exe')
if ($installers.Count -ne 1) { throw 'Expected exactly one Windows x64 installer.' }
$installer = $installers[0]
if (-not (Test-Path -LiteralPath ($installer.FullName + '.blockmap'))) {
    throw 'Installer blockmap is missing.'
}
$records = [System.Collections.Generic.List[object]]::new()
$hasNativeHook = $false
foreach ($file in @((Get-ChildItem -LiteralPath $appDirectory -File -Recurse)) + @($installer)) {
    if ($file.Extension -notin @('.exe', '.dll', '.node') -or -not (Test-PortableExecutable $file.FullName)) {
        continue
    }
    $expectedPublisher = ''
    if ($file.FullName -eq $installer.FullName -or $file.FullName -eq (Join-Path $appDirectory 'Tro.exe')) {
        $expectedPublisher = $Publisher
    }
    $record = Read-Signature $file.FullName $expectedPublisher
    $record.path = [System.IO.Path]::GetRelativePath($root, $file.FullName).Replace('\', '/')
    $record.sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    $record.version = $file.VersionInfo.FileVersion
    $records.Add($record)
    if ($record.path -match '/uiohook-napi/prebuilds/win32-x64/[^/]+\.node$') { $hasNativeHook = $true }
}
if (-not $hasNativeHook) { throw 'Windows x64 native shortcut addon is missing.' }
Assert-UpdateManifest -Directory $root -Installer $installer -Required:$RequireUpdateMetadata
$records.ToArray() | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $root 'WindowsSignatures.json') -Encoding utf8
Write-Output "Verified $($records.Count) Windows executable signatures."
