[CmdletBinding()]
param([string]$OutputPath)
$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$helperPath = Join-Path $repo 'scripts\install-service-windows.ps1'
$includePath = Join-Path $repo 'scripts\windows\tokenelo-uninstall.nsh'
$configPath = Join-Path $repo 'packaging\electron-builder.config.cjs'
$source = Get-Content -LiteralPath $helperPath -Raw -Encoding UTF8
$include = Get-Content -LiteralPath $includePath -Raw -Encoding UTF8
$config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8
$checks = [Collections.Generic.List[object]]::new()

function Add-Check {
    param([string]$Name,[bool]$Passed,[string]$Detail='')
    $checks.Add([pscustomobject]@{name=$Name;passed=$Passed;detail=$Detail})
    if (-not $Passed) { throw "Check failed: $Name $Detail" }
}

function Get-TestSha256 {
    param([string]$Path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash([IO.File]::ReadAllBytes($Path))).Replace('-','').ToLowerInvariant() }
    finally { $algorithm.Dispose() }
}

Add-Check 'config selects the NSIS uninstall include' ($config -match "include:\s*path\.join\(repositoryRoot, 'scripts', 'windows', 'tokenelo-uninstall\.nsh'\)")
Add-Check 'uninstaller hooks acquire before retiring tasks' ($include.IndexOf('!macro customUnInit',[StringComparison]::Ordinal) -ge 0 -and
    $include.IndexOf('!macro customUnInstall',[StringComparison]::Ordinal) -gt $include.IndexOf('!macro customUnInit',[StringComparison]::Ordinal))
Add-Check 'installer refuses an existing app before uninstallOldVersion can run' ($include.Contains('!macro customInit') -and
    $include.Contains('${UNINSTALL_REGISTRY_KEY}') -and $include.Contains('${UNINSTALL_FILENAME}') -and
    $include.Contains('"DisplayName"') -and $include.Contains('"UninstallString"') -and $include.Contains('"InstallLocation"') -and
    $include.Contains('$INSTDIR\resources\app\package.json') -and
    $include.Contains('TokeneloInstallerUpgradeRefused:') -and $include.Contains('Abort'))
Add-Check 'hook uses hidden nsExec and aborts on a nonzero helper result' ($include.Contains('nsExec::ExecToLog') -and $include.Contains('SetErrorLevel 1') -and $include.Contains('Abort'))
$customUnInstallStart = $include.IndexOf('!macro customUnInstall',[StringComparison]::Ordinal)
$customUnInstallEnd = $include.IndexOf('!macroend',$customUnInstallStart,[StringComparison]::Ordinal)
$customUnInstall = $include.Substring($customUnInstallStart,$customUnInstallEnd-$customUnInstallStart)
$updateOptions = $customUnInstall.IndexOf('${GetOptions} $0 "--updated" $1',[StringComparison]::Ordinal)
$updateAbort = $customUnInstall.IndexOf('Abort',$updateOptions,[StringComparison]::Ordinal)
$userUninstallPath = $customUnInstall.IndexOf('un.TokeneloRetireUserRequest:',[StringComparison]::Ordinal)
$taskHelperCall = $customUnInstall.IndexOf('Call un.TokeneloRetireServiceTasks',[StringComparison]::Ordinal)
Add-Check 'standalone --updated refuses before helper or payload removal' ($updateOptions -ge 0 -and $updateAbort -gt $updateOptions -and
    $userUninstallPath -gt $updateAbort -and $taskHelperCall -gt $userUninstallPath -and
    $customUnInstall.Substring($updateOptions,$userUninstallPath-$updateOptions).Contains('SetErrorLevel 1'))
Add-Check 'task helper refusal aborts the NSIS section after the function returns' ($customUnInstall.Contains('StrCmp $TokeneloLifecycleRetireResult "0" +2') -and
    [regex]::IsMatch($customUnInstall,'StrCmp \$TokeneloLifecycleRetireResult "0" \+2\s+Abort'))
Add-Check 'helper call is packaged mode and carries direct NSIS identity' ($include.Contains('-PackagedAppRoot "$INSTDIR\resources\app"') -and
    $include.Contains('-PackagedElectronPath "$INSTDIR\Tokenelo.exe"') -and $include.Contains('-LifecycleCoordinatorProcessId') -and
    $include.Contains('-LifecycleCoordinatorExecutablePath "$EXEPATH"') -and
    $include.Contains('!define TOKENELO_INSTALLED_UNINSTALLER_FILENAME "Uninstall Tokenelo.exe"') -and
    $include.Contains('-LifecycleCoordinatorInstalledExecutablePath "$INSTDIR\${TOKENELO_INSTALLED_UNINSTALLER_FILENAME}"'))
Add-Check 'owned lock lifetime extends until uninstaller process exit' ($include.Contains('WaitForSingleObject') -and
    $include.Contains('Global\Tokenelo-ServiceLifecycle-') -and $include.Contains('keeps it until the uninstaller process exits'))
Add-Check 'no direct task or application deletion command appears in the hook' (-not ($include -match '(?im)^\s*(?:Delete|RMDir|ExecWait|schtasks|Stop-Process)\b'))

$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($helperPath,[ref]$tokens,[ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
$requiredFunctions = @('Resolve-TokeneloPackagedContext','Test-TokeneloPathWithin','Get-TokeneloSha256','Assert-TokeneloNoReparseAncestors',
    'Open-TokeneloLifecycleMutexForCoordinator','Get-TokeneloCoordinatorTempRoot','Get-TokeneloCoordinatorFileAcl',
    'Get-TokeneloCoordinatorFileState','Get-TokeneloCoordinatorProcessIdentity','Assert-TokeneloCoordinatorLifecycleLeaseAlive',
    'New-TokeneloCoordinatorLifecycleLease','Enter-TokeneloLifecycleMutex','Exit-TokeneloLifecycleMutex')
foreach ($name in $requiredFunctions) {
    $definition = $ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name},$false)
    if (-not $definition) { throw "Missing coordinator function in product source: $name" }
    Invoke-Expression $definition.Extent.Text
}

$fixtureRoot = Join-Path 'C:\Temp' ('tokenelo-r3290-nsis-tempclone-test-' + [Guid]::NewGuid().ToString('N'))
$installRoot = Join-Path $fixtureRoot 'Tokenelo'
$appRoot = Join-Path $installRoot 'resources\app'
$scriptsRoot = Join-Path $appRoot 'scripts'
$localAppData = Join-Path $fixtureRoot 'local'
$tempRoot = Join-Path $fixtureRoot 'temp'
$tempCloneRoot = Join-Path $tempRoot 'nsis-clone'
$installedUninstallerPath = Join-Path $installRoot 'Uninstall Tokenelo.exe'
$coordinatorPath = Join-Path $tempCloneRoot 'uninst.exe'
$coordinatorPid = 7319
$oldLocalAppData = $env:LOCALAPPDATA
$script:fakeParentPid = $coordinatorPid
$script:fakeParentPath = $coordinatorPath
$script:fakeParentBirth = [DateTime]::UtcNow
$script:fakeParentExists = $true
$script:fakeTempRoot = $tempRoot
$script:mutexMode = 'busy'
$script:mutexState = $null
$script:foreignWriteAclPath = $null
$script:coordinatorAclDriftPath = $null
$script:coordinatorAclCallCount = 0

function Get-TokeneloLifecycleMutexName { return 'Global\Tokenelo-ServiceLifecycle-S-1-5-21-12-34-56-1001' }
function Get-TokeneloCoordinatorTempRoot { return $script:fakeTempRoot }
function Get-CimInstance {
    param([string]$ClassName,[string]$Filter,[string]$ErrorAction)
    if ($ClassName -cne 'Win32_Process') { throw 'Unexpected CIM class in coordinator test.' }
    if ($Filter -ceq ('ProcessId = ' + $PID)) {
        return [pscustomobject]@{ProcessId=$PID;ParentProcessId=$script:fakeParentPid;ExecutablePath=$null}
    }
    if ($Filter -ceq ('ProcessId = ' + $script:fakeParentPid)) {
        if (-not $script:fakeParentExists) { return $null }
        return [pscustomobject]@{ProcessId=$script:fakeParentPid;ParentProcessId=1;ExecutablePath=$script:fakeParentPath;CreationDate=$script:fakeParentBirth}
    }
    return $null
}
function Open-TokeneloLifecycleMutexForCoordinator {
    param([string]$Name)
    $script:mutexState.OpenCount++
    if ($Name -cne (Get-TokeneloLifecycleMutexName)) { throw 'Coordinator requested the wrong per-SID mutex.' }
    return $script:mutexState.Handle
}

function New-FakeCoordinatorMutex {
    $state = [pscustomobject]@{Mode=$script:mutexMode;WaitCount=0;ReleaseCount=0;DisposeCount=0;Handle=$null;OpenCount=0}
    $handle = [pscustomobject]@{State=$state}
    Add-Member -InputObject $handle -MemberType ScriptMethod -Name WaitOne -Value {
        param([int]$Timeout)
        $this.State.WaitCount++
        if ($Timeout -ne 0) { throw 'Coordinator test requires a nonblocking mutex probe.' }
        if ($this.State.Mode -eq 'busy') { return $false }
        if ($this.State.Mode -eq 'free') { return $true }
        if ($this.State.Mode -eq 'abandoned') { throw [Threading.AbandonedMutexException]::new() }
        throw 'Unknown fake mutex mode.'
    }
    Add-Member -InputObject $handle -MemberType ScriptMethod -Name ReleaseMutex -Value {
        $this.State.ReleaseCount++
    }
    Add-Member -InputObject $handle -MemberType ScriptMethod -Name Dispose -Value {
        $this.State.DisposeCount++
    }
    $state.Handle = $handle
    $script:mutexState = $state
}

function New-TestCoordinatorAcl {
    param([switch]$ForeignWrite)
    $ownerSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $rules=[Collections.Generic.List[object]]::new()
    foreach($sid in @($ownerSid,'S-1-5-18','S-1-5-32-544')){
        $rules.Add([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),
            [Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow))
    }
    if($ForeignWrite){
        $rules.Add([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),
            [Security.AccessControl.FileSystemRights]::Write,[Security.AccessControl.AccessControlType]::Allow))
    }
    $ruleText=@($rules|ForEach-Object{ $_.IdentityReference.Value+':'+[string]$_.FileSystemRights }) -join ';'
    $acl=[pscustomobject]@{OwnerSid=$ownerSid;Access=@($rules.ToArray());Sddl=('O:'+ $ownerSid+';'+$ruleText)}
    Add-Member -InputObject $acl -MemberType ScriptMethod -Name GetOwner -Value {
        param($Type)
        return [Security.Principal.SecurityIdentifier]::new([string]$this.OwnerSid)
    }
    return $acl
}

function Get-TestCoordinatorFileAcl {
    param([string]$Path)
    $acl = New-TestCoordinatorAcl -ForeignWrite:($Path -ieq $script:foreignWriteAclPath)
    if ($Path -ieq $script:coordinatorAclDriftPath) {
        $script:coordinatorAclCallCount++
        if ($script:coordinatorAclCallCount -gt 2) { $acl.Sddl += ';drift' }
    }
    return $acl
}

try {
    New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $appRoot 'dist\daemon') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $appRoot 'dist\tray') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $scriptsRoot 'windows') -Force | Out-Null
    New-Item -ItemType Directory -Path $localAppData -Force | Out-Null
    New-Item -ItemType Directory -Path $tempCloneRoot -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $appRoot 'package.json'),'{"private":true,"type":"module","main":"dist/tray/main.js"}',[Text.UTF8Encoding]::new($false))
    foreach ($relative in @('dist\daemon\main.js','dist\tray\main.js','scripts\windows\TokeneloHiddenLauncher.cs','scripts\install-service-windows.ps1')) {
        [IO.File]::WriteAllText((Join-Path $appRoot $relative),'fixture',[Text.UTF8Encoding]::new($false))
    }
    [IO.File]::WriteAllText($installedUninstallerPath,'trusted NSIS uninstaller bytes',[Text.UTF8Encoding]::new($false))
    [IO.File]::Copy($installedUninstallerPath,$coordinatorPath,$false)
    $env:LOCALAPPDATA = $localAppData
    $script:TokeneloHelperScriptRoot = $scriptsRoot
    $script:Uninstall = $true; $script:Stop = $false; $script:WithTray = $false
    $script:NodePath = $null; $script:HomeDirectory = $null
    $script:PackagedAppRoot = $appRoot; $script:PackagedElectronPath = Join-Path $installRoot 'Tokenelo.exe'
    [IO.File]::WriteAllText($script:PackagedElectronPath,'fixture',[Text.UTF8Encoding]::new($false))
    $script:LifecycleCoordinatorProcessId = $coordinatorPid
    $script:LifecycleCoordinatorExecutablePath = $coordinatorPath
    $script:LifecycleCoordinatorInstalledExecutablePath = $installedUninstallerPath
    Set-Item -Path Function:\Get-TokeneloCoordinatorFileAcl -Value (Get-Command Get-TestCoordinatorFileAcl).ScriptBlock

    New-FakeCoordinatorMutex
    $lease = Enter-TokeneloLifecycleMutex
    Add-Check 'normal NSIS temp self-copy joins after matching installed uninstaller bytes and ACLs' ($lease.Coordinator -and $lease.Owned -and
        $lease.Name -ceq (Get-TokeneloLifecycleMutexName) -and $lease.CoordinatorExecutablePath -ceq $coordinatorPath -and
        $lease.InstalledExecutablePath -ceq $installedUninstallerPath -and
        $lease.CoordinatorExecutableState.Sha256 -ceq $lease.InstalledExecutableState.Sha256 -and
        $script:mutexState.ReleaseCount -eq 0 -and $script:mutexState.DisposeCount -eq 1)
    Assert-TokeneloCoordinatorLifecycleLeaseAlive -Lease $lease
    Add-Check 'coordinator process birth and file identity remain valid after admission' ($script:mutexState.WaitCount -eq 2)
    Exit-TokeneloLifecycleMutex -Lease $lease

    $script:fakeParentPath = $installedUninstallerPath
    $script:LifecycleCoordinatorExecutablePath = $installedUninstallerPath
    New-FakeCoordinatorMutex
    $installedImageLease = Enter-TokeneloLifecycleMutex
    Add-Check 'exact installed uninstaller image joins under the same verified parent and mutex checks' ($installedImageLease.Coordinator -and
        $installedImageLease.CoordinatorExecutablePath -ceq $installedUninstallerPath -and
        $installedImageLease.InstalledExecutablePath -ceq $installedUninstallerPath -and
        $installedImageLease.CoordinatorExecutableState.Sha256 -ceq $installedImageLease.InstalledExecutableState.Sha256 -and
        $installedImageLease.CoordinatorExecutableState.AclSha256 -ceq $installedImageLease.InstalledExecutableState.AclSha256 -and
        $script:mutexState.ReleaseCount -eq 0)
    Assert-TokeneloCoordinatorLifecycleLeaseAlive -Lease $installedImageLease
    Exit-TokeneloLifecycleMutex -Lease $installedImageLease
    $script:fakeParentPath = $coordinatorPath
    $script:LifecycleCoordinatorExecutablePath = $coordinatorPath

    $script:coordinatorAclDriftPath = $installedUninstallerPath
    $script:coordinatorAclCallCount = 0
    New-FakeCoordinatorMutex
    $directImageAclDriftRejected = $false
    try { $null = New-TokeneloCoordinatorLifecycleLease -ProcessId $coordinatorPid -ExecutablePath $installedUninstallerPath -InstalledExecutablePath $installedUninstallerPath }
    catch { $directImageAclDriftRejected = $true }
    Add-Check 'direct installed image with an ACL change between identity snapshots refuses before mutex open' ($directImageAclDriftRejected -and $script:mutexState.OpenCount -eq 0)
    $script:coordinatorAclDriftPath = $null
    $script:coordinatorAclCallCount = 0

    $script:fakeParentBirth = $script:fakeParentBirth.AddSeconds(1)
    $birthRejected = $false
    try { Assert-TokeneloCoordinatorLifecycleLeaseAlive -Lease $lease }
    catch { $birthRejected = $true }
    Add-Check 'parent PID reuse or replacement fails the birth-time check' $birthRejected
    $script:fakeParentBirth = $script:fakeParentBirth.AddSeconds(-1)

    New-FakeCoordinatorMutex
    $outsideTempPath = Join-Path $fixtureRoot 'outside-temp\Uninstall Tokenelo.exe'
    $outsideTempRejected = $false
    try { $null = New-TokeneloCoordinatorLifecycleLease -ProcessId $coordinatorPid -ExecutablePath $outsideTempPath -InstalledExecutablePath $installedUninstallerPath }
    catch { $outsideTempRejected = $true }
    Add-Check 'helper refuses an arbitrary executable outside the NSIS temp root' ($outsideTempRejected -and $script:mutexState.OpenCount -eq 0)

    [IO.File]::WriteAllText($coordinatorPath,'changed NSIS clone bytes',[Text.UTF8Encoding]::new($false))
    New-FakeCoordinatorMutex
    $changedCloneRejected = $false
    try { $null = New-TokeneloCoordinatorLifecycleLease -ProcessId $coordinatorPid -ExecutablePath $coordinatorPath -InstalledExecutablePath $installedUninstallerPath }
    catch { $changedCloneRejected = $true }
    Add-Check 'helper refuses changed NSIS temp clone before mutex open' ($changedCloneRejected -and $script:mutexState.OpenCount -eq 0)
    [IO.File]::WriteAllText($coordinatorPath,'trusted NSIS uninstaller bytes',[Text.UTF8Encoding]::new($false))

    New-FakeCoordinatorMutex
    $script:foreignWriteAclPath = $installedUninstallerPath
    $foreignAclRejected = $false
    try { $null = New-TokeneloCoordinatorLifecycleLease -ProcessId $coordinatorPid -ExecutablePath $coordinatorPath -InstalledExecutablePath $installedUninstallerPath }
    catch { $foreignAclRejected = $true }
    Add-Check 'helper refuses foreign-writable installed uninstaller source ACL' ($foreignAclRejected -and $script:mutexState.OpenCount -eq 0)
    $script:foreignWriteAclPath = $null

    New-FakeCoordinatorMutex
    $script:fakeParentBirth = [DateTime]::UtcNow
    $lease = New-TokeneloCoordinatorLifecycleLease -ProcessId $coordinatorPid -ExecutablePath $coordinatorPath -InstalledExecutablePath $installedUninstallerPath
    $script:fakeParentExists = $false
    $parentExitRejected = $false
    try { Assert-TokeneloCoordinatorLifecycleLeaseAlive -Lease $lease }
    catch { $parentExitRejected = $true }
    Add-Check 'parent exit after admission invalidates the virtual lease' ($parentExitRejected)
    $script:fakeParentExists = $true

    foreach ($mode in @('free','abandoned')) {
        New-FakeCoordinatorMutex
        $script:mutexState.Mode = $mode
        $rejected = $false
        try { $null = New-TokeneloCoordinatorLifecycleLease -ProcessId $coordinatorPid -ExecutablePath $coordinatorPath -InstalledExecutablePath $installedUninstallerPath }
        catch { $rejected = $true }
        Add-Check ("helper refuses $mode coordinator mutex") ($rejected -and $script:mutexState.ReleaseCount -eq 1 -and $script:mutexState.DisposeCount -eq 1)
    }

    New-FakeCoordinatorMutex
    $script:fakeParentPid = $coordinatorPid + 1
    $parentRejected = $false
    try { $null = New-TokeneloCoordinatorLifecycleLease -ProcessId $coordinatorPid -ExecutablePath $coordinatorPath -InstalledExecutablePath $installedUninstallerPath }
    catch { $parentRejected = $true }
    Add-Check 'helper refuses a non-direct parent before mutex open' ($parentRejected -and $script:mutexState.OpenCount -eq 0)

    New-FakeCoordinatorMutex
    $script:fakeParentPid = $coordinatorPid
    $script:fakeParentPath = Join-Path $fixtureRoot 'foreign\Uninstall Tokenelo.exe'
    $pathRejected = $false
    try { $null = New-TokeneloCoordinatorLifecycleLease -ProcessId $coordinatorPid -ExecutablePath $coordinatorPath -InstalledExecutablePath $installedUninstallerPath }
    catch { $pathRejected = $true }
    Add-Check 'helper refuses a parent image path mismatch before mutex open' ($pathRejected -and $script:mutexState.OpenCount -eq 0)

    New-FakeCoordinatorMutex
    $script:fakeParentPath = $coordinatorPath
    $script:Stop = $true
    $modeRejected = $false
    try { $null = New-TokeneloCoordinatorLifecycleLease -ProcessId $coordinatorPid -ExecutablePath $coordinatorPath -InstalledExecutablePath $installedUninstallerPath }
    catch { $modeRejected = $true }
    Add-Check 'coordinator lease is unavailable outside uninstall mode' ($modeRejected -and $script:mutexState.OpenCount -eq 0)

    $failed = @($checks | Where-Object { -not $_.passed })
    $report = [pscustomobject]@{
        recordedAt = [datetime]::UtcNow.ToString('o')
        scope = 'NSIS hook source checks and actual coordinator lease functions with private synthetic files plus fake process/mutex boundaries; no NSIS installer, scheduler, service, or product data was executed.'
        passed = $checks.Count - $failed.Count
        failed = $failed.Count
        checks = @($checks)
        helperSha256 = Get-TestSha256 -Path $helperPath
        includeSha256 = Get-TestSha256 -Path $includePath
        configSha256 = Get-TestSha256 -Path $configPath
    }
    $json = $report | ConvertTo-Json -Depth 6
    if ($OutputPath) { [IO.File]::WriteAllText($OutputPath,$json+"`n",[Text.UTF8Encoding]::new($false)) }
    $json
} finally {
    $env:LOCALAPPDATA = $oldLocalAppData
    if ((Test-Path -LiteralPath $fixtureRoot) -and
        [IO.Path]::GetFullPath($fixtureRoot).StartsWith('C:\Temp\tokenelo-r3290-nsis-tempclone-test-',[StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
    }
}
