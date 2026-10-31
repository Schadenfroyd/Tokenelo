# Windows-only lifecycle regressions. Most cases extract real functions; the final source-assembled
# child File case executes actual top-level dispatch and transaction helpers with fake compiler,
# scheduler, CIM and mutex boundaries. No real task, service, production mutex or installer is run.
[CmdletBinding()]
param([string]$OutputPath,[switch]$ExistingOnly,[switch]$DispatchOnly,
    [ValidateSet('uninstall','install','stop-race','foreign')][string]$DispatchScenario,[switch]$CoordinatorOnly,
    [switch]$SecurityModuleOnly,[switch]$RecoveryHeaderOnly)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($ExistingOnly -and ($DispatchOnly -or $DispatchScenario)) {
    throw '-ExistingOnly cannot be combined with dispatch-only filters.'
}
if ($DispatchScenario -and -not $DispatchOnly) {
    throw '-DispatchScenario requires -DispatchOnly.'
}
if ($CoordinatorOnly -and ($ExistingOnly -or $DispatchOnly -or $DispatchScenario)) {
    throw '-CoordinatorOnly cannot be combined with other lifecycle test filters.'
}
if ($SecurityModuleOnly -and ($ExistingOnly -or $DispatchOnly -or $DispatchScenario -or $CoordinatorOnly)) {
    throw '-SecurityModuleOnly cannot be combined with other lifecycle test filters.'
}
if ($RecoveryHeaderOnly -and ($ExistingOnly -or $DispatchOnly -or $DispatchScenario -or $CoordinatorOnly -or $SecurityModuleOnly)) {
    throw '-RecoveryHeaderOnly cannot be combined with other lifecycle test filters.'
}
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$source = Join-Path $repo 'scripts\install-service-windows.ps1'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
foreach ($definition in $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
    Invoke-Expression $definition.Extent.Text
}
$TaskName = 'TokeneloDaemon'
$TrayTaskName = 'TokeneloTray'
$CheckoutRepoRoot = 'C:\Temp\tokenelo-lifecycle-policy-fixture'
$RepoRoot = $CheckoutRepoRoot
$DaemonEntry = Join-Path $RepoRoot 'dist\daemon\main.js'
$TrayEntry = Join-Path $RepoRoot 'dist\tray\main.js'
$RuntimeMode = 'checkout'
$BundledElectronPath = $null
$LauncherRoot = Join-Path $RepoRoot 'scripts'
$nodePath = 'C:\Program Files\nodejs\node.exe'
$principal = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$originalLocalAppData = $env:LOCALAPPDATA
$results = [Collections.Generic.List[object]]::new()
$script:realBuildLauncher = (Get-Command Build-TokeneloLauncher).ScriptBlock
$script:realPublishLauncher = (Get-Command Publish-TokeneloLauncher).ScriptBlock
$script:realStopTokeneloTask = (Get-Command Stop-TokeneloTask).ScriptBlock
$script:realRemoveUninstallLauncher = (Get-Command Remove-TokeneloUninstallLauncher).ScriptBlock
$script:realNoReparseAncestors = (Get-Command Assert-TokeneloNoReparseAncestors).ScriptBlock
$script:realLifecycleMutexFactory = (Get-Command New-TokeneloLifecycleMutex).ScriptBlock
$script:realCoordinatorLifecycleValidator = (Get-Command Assert-TokeneloCoordinatorLifecycleLeaseAlive).ScriptBlock

function Fake-New-TokeneloLifecycleMutex {
    param([string]$Name)
    $handle=[pscustomobject]@{Name=$Name;Caller=$script:fakeMutexState.NextCaller;State=$script:fakeMutexState;Disposed=$false}
    $script:fakeMutexState.Names.Add($Name)
    Add-Member -InputObject $handle -MemberType ScriptMethod -Name WaitOne -Value {
        param([int]$Timeout)
        $state=$this.State
        if($Timeout -ne 0){throw 'Fake mutex expected nonblocking acquisition'}
        if($state.AbandonedNext){
            $state.AbandonedNext=$false; $state.Owner=$this.Caller; $state.Depth=1; $state.Acquisitions++
            throw [Threading.AbandonedMutexException]::new()
        }
        if($state.Owner -and $state.Owner -cne $this.Caller){$state.Contentions++; return $false}
        if(-not $state.Owner){$state.Owner=$this.Caller; $state.Acquisitions++}
        $state.Depth++
        return $true
    }
    Add-Member -InputObject $handle -MemberType ScriptMethod -Name ReleaseMutex -Value {
        $state=$this.State
        if($state.FailRelease){throw 'Simulated mutex release failure'}
        if($state.Owner -cne $this.Caller -or $state.Depth -lt 1){throw 'Fake mutex released without caller ownership'}
        $state.Depth--; $state.Releases++
        if($state.Depth -eq 0){$state.Owner=$null}
    }
    Add-Member -InputObject $handle -MemberType ScriptMethod -Name Dispose -Value {
        $this.State.Disposals++; $this.Disposed=$true
    }
    return $handle
}

function Reset-Fixture {
    Set-Item -Path Function:\Build-TokeneloLauncher -Value $script:realBuildLauncher
    Set-Item -Path Function:\Publish-TokeneloLauncher -Value $script:realPublishLauncher
    Set-Item -Path Function:\Stop-TokeneloTask -Value $script:realStopTokeneloTask
    Set-Item -Path Function:\Remove-TokeneloUninstallLauncher -Value $script:realRemoveUninstallLauncher
    Set-Item -Path Function:\Assert-TokeneloNoReparseAncestors -Value $script:realNoReparseAncestors
    Set-Item -Path Function:\Assert-TokeneloCoordinatorLifecycleLeaseAlive -Value $script:realCoordinatorLifecycleValidator
    $script:fakeMutexState=[pscustomobject]@{Owner=$null;Depth=0;NextCaller='caller-A';AbandonedNext=$false;FailRelease=$false;
        Acquisitions=0;Releases=0;Disposals=0;Contentions=0;Names=[Collections.Generic.List[string]]::new()}
    Set-Item -Path Function:\New-TokeneloLifecycleMutex -Value (Get-Command Fake-New-TokeneloLifecycleMutex).ScriptBlock
    $env:LOCALAPPDATA=$script:originalLocalAppData
    $script:RepoRoot = $script:CheckoutRepoRoot
    $script:DaemonEntry = Join-Path $script:RepoRoot 'dist\daemon\main.js'
    $script:TrayEntry = Join-Path $script:RepoRoot 'dist\tray\main.js'
    $script:RuntimeMode = 'checkout'
    $script:BundledElectronPath = $null
    $script:LauncherRoot = Join-Path $script:RepoRoot 'scripts'
    $script:tasks = @{}
    $script:processesBefore = @(); $script:processesAfter = @()
    $script:mutations = [Collections.Generic.List[string]]::new()
    $script:stopped = $false; $script:queryDenied = $false; $script:cimDenied = $false
    $script:stayRunning = $false
    $script:registerTaskObjects = $false
    $script:failRegisterName = $null; $script:failRegisterAfterMutation = $false; $script:mutateLauncherBeforeRegisterFailureRole=$null
    $script:failEnableName = $null; $script:failEnableAfterMutation = $false
    $script:failStartName = $null; $script:failStartAfterMutation = $false
    $script:failStopName = $null
    $script:failUnregisterName = $null; $script:failUnregisterAfterMutation = $false; $script:unregisterNoOpName = $null
    $script:foreignAfterUnregisterFailureName = $null; $script:failRestoreXmlName = $null; $script:failRestoreXmlAfterMutation = $false
    $script:processAfterUnregisterName = $null
    $script:failLauncherRemoveRole = $null; $script:failLauncherRemoveAfterMutation = $false
    $script:failCompileRole = $null; $script:mutateTaskOnCompile = $null; $script:unknownStagingOnCompile = $false
    $script:failPublishRole = $null; $script:mutateTaskOnPublish = $null; $script:mutateLauncherOnPublishRole = $null
    $script:mutateTaskOnEnable = $null; $script:mutateTaskBeforeStop = $null; $script:didMutateBeforeStop = $false
    $script:mutateLauncherDuringRestoreCheck=$false; $script:restoreTargetCheckCount=0
    $script:compileOrder = [Collections.Generic.List[string]]::new()
    $script:events = [Collections.Generic.List[string]]::new()
    $script:callerLocalAppData = $null
    $script:transactionProcessSnapshots = @{}
    $script:observedCleanupSeconds = [Collections.Generic.List[double]]::new()
    $script:transactionStopReceipts = [Collections.Generic.List[object]]::new()
    $script:registerTaskObjects = $false
    $script:restoredXml = @{}
    $script:schedulerQueryCount=0
}
function New-FixtureTask([string]$Name = $TaskName, [string]$User = $principal) {
    $role = if ($Name -eq $TrayTaskName) { 'tray' } else { 'daemon' }
    $execute = Get-TokeneloLauncherPath -Role $role
    $runtime = if ($RuntimeMode -eq 'packaged') { $BundledElectronPath } else { $nodePath }
    $arguments = '"' + $runtime + '" "' + $DaemonEntry + '"'
    if ($Name -eq $TrayTaskName) {
        if ($RuntimeMode -eq 'packaged') {
            $arguments = '"' + $BundledElectronPath + '" "--tokenelo-packaged-app"'
        } else {
            $electron = Join-Path $RepoRoot 'node_modules\electron\dist\electron.exe'
            $arguments = '"' + $electron + '" "' + $TrayEntry + '"'
        }
    }
    $taskSettings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
    $taskSettings.Priority=4
    $task = [pscustomobject]@{ TaskName=$Name; TaskPath='\'; Principal=[pscustomobject]@{UserId=$User;LogonType='Interactive';RunLevel='Limited'};
        Actions=@([pscustomobject]@{Execute=$execute;Arguments=$arguments});
        Triggers=@([pscustomobject]@{AtLogOn=$true;TriggerType='LogonTrigger';Enabled=$true;User=$User}); State='Running';
        RegistrationInfo=[pscustomobject]@{URI=('\'+$Name);SecurityDescriptor='';Description=$null;Author=$null;Date=$null};
        Settings=$taskSettings }
    $script:tasks[$Name] = $task
    return $task
}
function Get-FixtureTaskXml($Task) {
    $action=$Task.Actions[0]; $trigger=$Task.Triggers[0]; $settings=$Task.Settings
    $registration=$null
    if($Task.PSObject.Properties['RegistrationInfo']){$registration=$Task.RegistrationInfo}
    $securityDescriptor=if($registration -and $registration.PSObject.Properties['SecurityDescriptor']){[string]$registration.SecurityDescriptor}else{''}
    $registrationXml='<SecurityDescriptor>'+[Security.SecurityElement]::Escape($securityDescriptor)+'</SecurityDescriptor>'
    if($registration -and $registration.Author){$registrationXml+='<Author>'+[Security.SecurityElement]::Escape([string]$registration.Author)+'</Author>'}
    if($registration -and $registration.Date){$registrationXml+='<Date>'+[Security.SecurityElement]::Escape([string]$registration.Date)+'</Date>'}
    if($registration -and $registration.Description){$registrationXml+='<Description>'+[Security.SecurityElement]::Escape([string]$registration.Description)+'</Description>'}
    if($registration -and $registration.URI){$registrationXml+='<URI>'+[Security.SecurityElement]::Escape([string]$registration.URI)+'</URI>'}
    $triggersXml=''
    foreach($candidate in @($Task.Triggers)){
        $type=if($candidate.TriggerType){[string]$candidate.TriggerType}elseif($candidate.AtLogOn){'LogonTrigger'}else{'BootTrigger'}
        $triggerEnabled=$true
        if($candidate.PSObject.Properties['Enabled']){$triggerEnabled=[bool]$candidate.Enabled}
        $userXml=if($candidate.User){'<UserId>'+[Security.SecurityElement]::Escape([string]$candidate.User)+'</UserId>'}else{''}
        $triggersXml+='<'+$type+'><Enabled>'+([string]$triggerEnabled).ToLowerInvariant()+'</Enabled>'+$userXml+'</'+$type+'>'
    }
    $enabled=if($settings.Enabled){'true'}else{'false'}
    $disallowBattery=if($settings.AllowStartIfOnBatteries){'false'}else{'true'}
    $stopBattery=if($settings.DontStopIfGoingOnBatteries){'false'}else{'true'}
    $idle=$settings.IdleSettings
    $settingsXml='<MultipleInstancesPolicy>'+[string]$settings.MultipleInstances+'</MultipleInstancesPolicy>'+
        '<DisallowStartIfOnBatteries>'+$disallowBattery+'</DisallowStartIfOnBatteries>'+ '<StopIfGoingOnBatteries>'+$stopBattery+'</StopIfGoingOnBatteries>'+
        '<AllowHardTerminate>'+([string][bool]$settings.AllowHardTerminate).ToLowerInvariant()+'</AllowHardTerminate>'+
        '<StartWhenAvailable>'+([string][bool]$settings.StartWhenAvailable).ToLowerInvariant()+'</StartWhenAvailable>'+
        '<RunOnlyIfNetworkAvailable>'+([string][bool]$settings.RunOnlyIfNetworkAvailable).ToLowerInvariant()+'</RunOnlyIfNetworkAvailable>'+
        '<IdleSettings><Duration>'+[string]$idle.Duration+'</Duration><WaitTimeout>'+[string]$idle.WaitTimeout+'</WaitTimeout><StopOnIdleEnd>'+([string][bool]$idle.StopOnIdleEnd).ToLowerInvariant()+
        '</StopOnIdleEnd><RestartOnIdle>'+([string][bool]$idle.RestartOnIdle).ToLowerInvariant()+'</RestartOnIdle></IdleSettings>'+
        '<AllowStartOnDemand>'+([string][bool]$settings.AllowDemandStart).ToLowerInvariant()+'</AllowStartOnDemand><Enabled>'+$enabled+'</Enabled>'+
        '<Hidden>'+([string][bool]$settings.Hidden).ToLowerInvariant()+'</Hidden><RunOnlyIfIdle>'+([string][bool]$settings.RunOnlyIfIdle).ToLowerInvariant()+
        '</RunOnlyIfIdle><DisallowStartOnRemoteAppSession>'+([string][bool]$settings.DisallowStartOnRemoteAppSession).ToLowerInvariant()+
        '</DisallowStartOnRemoteAppSession><UseUnifiedSchedulingEngine>'+([string][bool]$settings.UseUnifiedSchedulingEngine).ToLowerInvariant()+
        '</UseUnifiedSchedulingEngine><WakeToRun>'+([string][bool]$settings.WakeToRun).ToLowerInvariant()+'</WakeToRun><ExecutionTimeLimit>'+[Xml.XmlConvert]::ToString($settings.ExecutionTimeLimit)+'</ExecutionTimeLimit>'+
        '<Priority>'+[string]$settings.Priority+'</Priority>'
    if($settings.RestartCount -gt 0){$settingsXml+='<RestartOnFailure><Interval>'+[string]$settings.RestartInterval+'</Interval><Count>'+[string]$settings.RestartCount+'</Count></RestartOnFailure>'}
    $principalLogon=if($Task.Principal.LogonType -in @('Interactive','InteractiveToken')){'InteractiveToken'}else{[string]$Task.Principal.LogonType}
    $principalRunLevel=if($Task.Principal.RunLevel -in @('Limited','LeastPrivilege')){'LeastPrivilege'}else{[string]$Task.Principal.RunLevel}
    '<Task version="1.3"><RegistrationInfo>'+$registrationXml+'</RegistrationInfo><Triggers>'+$triggersXml+'</Triggers><Principals><Principal><UserId>'+[Security.SecurityElement]::Escape([string]$Task.Principal.UserId)+
        '</UserId><LogonType>'+ $principalLogon +'</LogonType><RunLevel>'+ $principalRunLevel +'</RunLevel></Principal></Principals><Settings>'+$settingsXml+'</Settings><Actions><Exec><Command>'+[Security.SecurityElement]::Escape([string]$action.Execute)+
        '</Command><Arguments>'+[Security.SecurityElement]::Escape([string]$action.Arguments)+'</Arguments></Exec></Actions></Task>'
}
function New-FixtureProcess([int]$Id, [int]$Parent, [string]$Command = 'child', [int]$Age = 0) {
    [pscustomobject]@{ ProcessId=$Id;ParentProcessId=$Parent;CommandLine=$Command;CreationDate=[datetime]'2026-10-08T12:00:00Z' + [timespan]::FromSeconds($Age) }
}
function Use-PackagedRuntimeFixture($Fixture) {
    $context = Resolve-TokeneloPackagedContext -AppRoot $Fixture.AppRoot -ElectronPath $Fixture.Electron `
        -HelperScriptRoot (Join-Path $Fixture.AppRoot 'scripts') -LocalAppData $Fixture.LocalAppData
    $script:RepoRoot=$context.AppRoot; $script:DaemonEntry=$context.DaemonEntry; $script:TrayEntry=$context.TrayEntry
    $script:RuntimeMode=$context.RuntimeMode; $script:BundledElectronPath=$context.ElectronPath
    $script:LauncherRoot=$context.LauncherRoot; $env:LOCALAPPDATA=$Fixture.LocalAppData
    New-Item -ItemType Directory -Path $script:LauncherRoot -Force | Out-Null
    Set-TestRecoveryDirectoryPrivateAcl -Path $script:LauncherRoot -Sid ([string][Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
    return $context
}
function Fake-Build-TokeneloLauncher {
    param([ValidateSet('daemon','tray')][string]$Role,[string]$OutputPath)
    $script:compileOrder.Add($Role)
    $script:events.Add('compile:'+$Role)
    if($script:failCompileRole -eq $Role){throw "Simulated $Role compile failure"}
    [IO.File]::WriteAllText($OutputPath,('fixture-new-launcher-'+$Role),[Text.UTF8Encoding]::new($false))
    if($script:unknownStagingOnCompile){[IO.File]::WriteAllText((Join-Path (Split-Path -Parent $OutputPath) 'unexpected.txt'),'fixture-unowned',[Text.UTF8Encoding]::new($false))}
    if($script:mutateTaskOnCompile -eq 'principal' -and $script:tasks.ContainsKey($TaskName)){
        $script:tasks[$TaskName].Principal.UserId='OTHER\user'
    } elseif($script:mutateTaskOnCompile -eq 'xml' -and $script:tasks.ContainsKey($TaskName)){
        $script:tasks[$TaskName].Triggers[0].User='OTHER\user'
    }
    return $OutputPath
}
function Fake-Publish-TokeneloLauncher {
    param($Transaction,$Plan)
    $script:events.Add('publish:'+$Plan.Role)
    if($script:failPublishRole -eq $Plan.Role){throw "Simulated $($Plan.Role) publication failure"}
    if($script:mutateTaskOnPublish -eq 'xml' -and $Plan.Role -eq 'daemon' -and $script:tasks.ContainsKey($TrayTaskName)){
        $script:tasks[$TrayTaskName].Triggers[0].User='OTHER\user'
    } elseif($script:mutateTaskOnPublish -eq 'principal' -and $Plan.Role -eq 'daemon' -and $script:tasks.ContainsKey($TrayTaskName)){
        $script:tasks[$TrayTaskName].Principal.UserId='OTHER\user'
    } elseif($script:mutateTaskOnPublish -eq 'registration-uri' -and $Plan.Role -eq 'daemon' -and $script:tasks.ContainsKey($TrayTaskName)){
        $script:tasks[$TrayTaskName].RegistrationInfo.URI='\ForeignTray'
    } elseif($script:mutateTaskOnPublish -eq 'registration-security' -and $Plan.Role -eq 'daemon' -and $script:tasks.ContainsKey($TrayTaskName)){
        $script:tasks[$TrayTaskName].RegistrationInfo.SecurityDescriptor='D:(A;;FA;;;WD)'
    }
    if($script:mutateLauncherOnPublishRole -eq $Plan.Role -and (Test-Path -LiteralPath $Plan.LauncherPath)){
        [IO.File]::WriteAllText($Plan.LauncherPath,'fixture-external-launcher-change',[Text.UTF8Encoding]::new($false))
    }
    & $script:realPublishLauncher -Transaction $Transaction -Plan $Plan
}
function Set-FakeTransactionCompiler {
    Set-Item -Path Function:\Build-TokeneloLauncher -Value (Get-Command Fake-Build-TokeneloLauncher).ScriptBlock
}
function Set-FakeTransactionPublisher {
    Set-Item -Path Function:\Publish-TokeneloLauncher -Value (Get-Command Fake-Publish-TokeneloLauncher).ScriptBlock
}
function Fake-Stop-TokeneloTask {
    param($Owned,[ValidateRange(0.05,25)][double]$CleanupTimeoutSeconds=25,[string]$ExpectedXmlCanonical)
    $script:observedCleanupSeconds.Add($CleanupTimeoutSeconds)
    if($script:transactionProcessSnapshots.ContainsKey($Owned.Name)){
        $snapshot=$script:transactionProcessSnapshots[$Owned.Name]
        $script:processesBefore=@($snapshot.Before); $script:processesAfter=@($snapshot.After); $script:stopped=$false
    }
    $receipt=& $script:realStopTokeneloTask -Owned $Owned -CleanupTimeoutSeconds $CleanupTimeoutSeconds `
        -ExpectedXmlCanonical $ExpectedXmlCanonical
    if($receipt){$script:transactionStopReceipts.Add($receipt)}
    return $receipt
}
function Set-FakeTransactionStop {
    Set-Item -Path Function:\Stop-TokeneloTask -Value (Get-Command Fake-Stop-TokeneloTask).ScriptBlock
}
function Fake-DriftBeforeStop-TokeneloTask {
    param($Owned,[ValidateRange(0.05,25)][double]$CleanupTimeoutSeconds=25,[string]$ExpectedXmlCanonical)
    if($script:mutateTaskBeforeStop -and -not $script:didMutateBeforeStop){
        $script:didMutateBeforeStop=$true
        $script:tasks[$Owned.Name].Triggers[0].User='OTHER\user'
    }
    & $script:realStopTokeneloTask -Owned $Owned -CleanupTimeoutSeconds $CleanupTimeoutSeconds `
        -ExpectedXmlCanonical $ExpectedXmlCanonical
}
function Set-FakeDriftBeforeStop {
    Set-Item -Path Function:\Stop-TokeneloTask -Value (Get-Command Fake-DriftBeforeStop-TokeneloTask).ScriptBlock
}
function Fake-ReparseCheckWithLauncherRace {
    param([string]$Path,[string]$Description='Tokenelo filesystem path')
    & $script:realNoReparseAncestors -Path $Path -Description $Description
    if($script:mutateLauncherDuringRestoreCheck -and $Description -ceq 'Rollback target for daemon'){
        $script:restoreTargetCheckCount++
        if($script:restoreTargetCheckCount -eq 2){
            [IO.File]::WriteAllText($Path,'fixture-immediate-restore-race',[Text.UTF8Encoding]::new($false))
        }
    }
}
function Set-FakeLauncherRaceDuringRestoreCheck {
    Set-Item -Path Function:\Assert-TokeneloNoReparseAncestors -Value (Get-Command Fake-ReparseCheckWithLauncherRace).ScriptBlock
}
function Initialize-PackagedTransactionFixture($Fixture,[bool]$WithTasks=$false,[bool]$DaemonEnabled=$true,[bool]$TrayEnabled=$true) {
    $null=Use-PackagedRuntimeFixture $Fixture
    $script:registerTaskObjects=$true
    if($WithTasks){
        $daemon=New-FixtureTask
        $daemon.Settings.Enabled=$DaemonEnabled; $daemon.State=if($DaemonEnabled){'Running'}else{'Disabled'}
        $tray=New-FixtureTask -Name $TrayTaskName
        $tray.Settings.Enabled=$TrayEnabled; $tray.State=if($TrayEnabled){'Running'}else{'Disabled'}
        foreach($role in @('daemon','tray')){
            $path=Get-TokeneloLauncherPath -Role $role
            [IO.File]::WriteAllText($path,('fixture-old-launcher-'+$role),[Text.UTF8Encoding]::new($false))
        }
    }
}
function Set-TestRecoveryDirectoryPrivateAcl([string]$Path,[string]$Sid) {
    $null=Import-TokeneloNativeSecurityModule
    $acl=[Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true,$false)
    $acl.SetOwner([Security.Principal.SecurityIdentifier]::new($Sid))
    $inherit=[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    $principals=@($Sid,'S-1-5-18','S-1-5-32-544')
    foreach($principalSid in $principals){
        $identity=[Security.Principal.SecurityIdentifier]::new([string]$principalSid)
        $rule=[Security.AccessControl.FileSystemAccessRule]::new($identity,[Security.AccessControl.FileSystemRights]::FullControl,
            $inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
        $acl.AddAccessRule($rule)
    }
    $setAcl=Get-Command -Name 'Set-Acl' -Module 'Microsoft.PowerShell.Security' -ErrorAction Stop
    & $setAcl -LiteralPath $Path -AclObject $acl -ErrorAction Stop
}
function Assert-TestProtectedRecoveryDirectoryAcl([string]$Path,[string]$Sid) {
    $acl=Get-TokeneloCoordinatorFileAcl -Path $Path
    if(-not $acl.AreAccessRulesProtected -or
        $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $Sid){
        throw 'Synthetic recovery directory did not retain a protected current-owner DACL.'
    }
    $expected=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach($expectedSid in @($Sid,'S-1-5-18','S-1-5-32-544')){$null=$expected.Add([string]$expectedSid)}
    $rules=@($acl.GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier]))
    $inherit=[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    if($rules.Count -ne 3){throw 'Synthetic recovery directory DACL did not contain exactly three principals.'}
    foreach($rule in $rules){
        $ruleSid=$rule.IdentityReference.Value
        if(-not $expected.Remove($ruleSid) -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
            $rule.IsInherited -or [int]$rule.FileSystemRights -ne [int][Security.AccessControl.FileSystemRights]::FullControl -or
            $rule.InheritanceFlags -ne $inherit -or $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None){
            throw 'Synthetic recovery directory DACL did not match owner, SYSTEM and Administrators full-control rules.'
        }
    }
    if($expected.Count -ne 0){throw 'Synthetic recovery directory DACL omitted an expected principal.'}
    return [string]$acl.Sddl
}
function Set-FixtureTaskHome([string]$DataHome) {
    foreach($name in @($TaskName,$TrayTaskName)){
        if($script:tasks.ContainsKey($name)){
            $script:tasks[$name].Actions[0].Arguments += ' '+(Quote-TokeneloPath $DataHome)
        }
    }
}
function New-TestUninstallHeaderTransaction($Fixture,[string[]]$PresentRoles=@('tray','daemon')) {
    $null=Use-PackagedRuntimeFixture $Fixture
    $script:registerTaskObjects=$true
    $script:tasks=@{}
    $dataHome=Join-Path $Fixture.Parent 'isolated header data home'
    foreach($role in @('tray','daemon')){
        if($PresentRoles -ccontains $role){
            $name=if($role -ceq 'tray'){$TrayTaskName}else{$TaskName}
            $task=New-FixtureTask -Name $name
            $task.Actions[0].Arguments += ' '+(Quote-TokeneloPath $dataHome)
            $task.Settings.Enabled=$true; $task.State='Running'
            [IO.File]::WriteAllText((Get-TokeneloLauncherPath -Role $role),('fixture-original-'+$role),[Text.UTF8Encoding]::new($false))
        }
    }
    $sid=[string][Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $recoveryBase=Join-Path $Fixture.LocalAppData 'Tokenelo\recovery'
    New-Item -ItemType Directory -Path $recoveryBase -Force | Out-Null
    foreach($directory in @($Fixture.Parent,$Fixture.LocalAppData,(Join-Path $Fixture.LocalAppData 'Tokenelo'),$recoveryBase)){
        Set-TestRecoveryDirectoryPrivateAcl -Path $directory -Sid $sid
    }
    $id=[Guid]::NewGuid().ToString('N'); $recoveryRoot=Join-Path $recoveryBase $id
    New-Item -ItemType Directory -Path $recoveryRoot | Out-Null
    Set-TestRecoveryDirectoryPrivateAcl -Path $recoveryRoot -Sid $sid
    $plans=[Collections.Generic.List[object]]::new()
    foreach($role in @('tray','daemon')){
        $name=if($role -ceq 'tray'){$TrayTaskName}else{$TaskName}
        $owned=Get-OwnedTokeneloTask -Name $name
        $launcher=Get-TokeneloLauncherPath -Role $role
        $snapshot=Get-TokeneloTaskSnapshot -Owned $owned -Name $name -Role $role -LauncherPath $launcher -SnapshotRoot $recoveryRoot
        $plans.Add([ordered]@{Name=$name;Role=$role;Owned=$owned;LauncherPath=$launcher;Snapshot=$snapshot;
            StopReceipt=$null;UnregisterRequested=$false;LauncherRemovalRequested=$false})
    }
    $lease=[pscustomobject]@{Name=(Get-TokeneloLifecycleMutexName);Owned=$true;Abandoned=$false;Coordinator=$false}
    $transaction=[ordered]@{Id=$id;RecoveryRoot=$recoveryRoot;StagingRoot=$null;JournalPath=(Join-Path $recoveryRoot 'journal.jsonl');
        Plans=@($plans.ToArray());TaskMutationStarted=$false;FileMutationStarted=$false;CleanupComplete=$false;
        RollbackComplete=$false;OwnershipUncertain=$false;LifecycleLease=$lease}
    Write-TokeneloTransactionJournal -Transaction $transaction -Phase 'preflight-complete'
    foreach($plan in @($transaction.Plans)){Write-TokeneloTransactionJournal -Transaction $transaction -Phase 'snapshot-saved' -Role $plan.Role}
    $installRoot=if($RuntimeMode -eq 'packaged'){[IO.Path]::GetFullPath((Split-Path -Parent (Split-Path -Parent $RepoRoot)))}else{[IO.Path]::GetFullPath($RepoRoot)}
    $header=Write-TokeneloUninstallRecoveryHeader -Transaction $transaction -CurrentSid $sid `
        -PackageIdentity 'com.elostudios.tokenelo' -InstallRoot $installRoot -RuntimeMode $RuntimeMode
    Write-TokeneloTransactionJournal -Transaction $transaction -Phase 'recovery-header-written' -Detail $header.Sha256
    $expectedHomes=@{tray=$null;daemon=$null}
    foreach($plan in @($transaction.Plans)){if($plan.Snapshot.Present){$expectedHomes[$plan.Role]=$dataHome}}
    return [pscustomobject]@{Fixture=$Fixture;Transaction=$transaction;Header=$header;DataHome=$dataHome;
        CurrentSid=$sid;InstallRoot=$installRoot;ExpectedHomes=$expectedHomes;RecoveryRoot=$recoveryRoot}
}
function Read-TestUninstallHeader($Context,[string]$HeaderHash=$Context.Header.Sha256,[string]$Sid=$Context.CurrentSid,
    [string]$Package='com.elostudios.tokenelo',[string]$InstallRoot=$Context.InstallRoot,[string]$LauncherRoot=$script:LauncherRoot,
    [hashtable]$ExpectedHomes=$Context.ExpectedHomes) {
    return Read-TokeneloUninstallRecoveryTransaction -RecoveryRoot $Context.RecoveryRoot -ExpectedHeaderSha256 $HeaderHash `
        -ExpectedCurrentSid $Sid -ExpectedPackageIdentity $Package -ExpectedInstallRoot $InstallRoot `
        -ExpectedRuntimeMode 'packaged' -ExpectedLauncherRoot $LauncherRoot -ExpectedDataHomeByRole $ExpectedHomes
}
function Rewrite-TestUninstallHeaderHome($Context,[ValidateSet('tray','daemon')][string]$Role,$HeaderHome,$OwnedTaskHome) {
    $headerBytes=[IO.File]::ReadAllBytes($Context.Header.Path)
    $headerText=[Text.UTF8Encoding]::new($false,$true).GetString($headerBytes)
    $header=ConvertFrom-TokeneloUninstallHeaderJson -Json $headerText -Description 'Synthetic home-nullability header'
    $roleRecord=@($header.roles|Where-Object{$_.role -ceq $Role})[0]
    if(-not $roleRecord){throw "Fixture did not contain the requested $Role role."}
    $roleRecord.dataHomeDirectory=$HeaderHome
    if($roleRecord.present){$roleRecord.ownedTask.homeDirectory=$OwnedTaskHome}
    $newBytes=[Text.UTF8Encoding]::new($false).GetBytes(($header|ConvertTo-Json -Compress -Depth 8))
    [IO.File]::WriteAllBytes($Context.Header.Path,$newBytes)
    $newHash=Get-TokeneloSha256 $newBytes
    $journalLines=[Collections.Generic.List[string]]::new()
    $markerCount=0
    foreach($line in [IO.File]::ReadAllLines($Context.Transaction.JournalPath)){
        $record=ConvertFrom-TokeneloUninstallHeaderJson -Json $line -Description 'Synthetic transaction journal record'
        if($record.phase -ceq 'recovery-header-written'){$record.detail=$newHash;$markerCount++}
        $canonicalRecord=[ordered]@{recordedAt=[string]$record.recordedAt;transactionId=[string]$record.transactionId;
            phase=[string]$record.phase;role=[string]$record.role;detail=[string]$record.detail}
        $journalLines.Add(($canonicalRecord|ConvertTo-Json -Compress -Depth 8))
    }
    if($markerCount -ne 1){throw 'Synthetic header rewrite found no unique immutable header marker.'}
    [IO.File]::WriteAllText($Context.Transaction.JournalPath,(($journalLines.ToArray() -join "`n")+"`n"),[Text.UTF8Encoding]::new($false))
    $Context.Header.Sha256=$newHash
    $Context.Header.Header=$header
    return $newHash
}
function Fake-HeaderProbeStop {
    param($Owned,[ValidateRange(0.05,25)][double]$CleanupTimeoutSeconds=25,[string]$ExpectedXmlCanonical,$LifecycleLease)
    if(-not $script:headerBeforeFirstStop){
        $base=Join-Path $env:LOCALAPPDATA 'Tokenelo\recovery'
        $roots=@(Get-ChildItem -LiteralPath $base -Directory -Force)
        if($roots.Count -ne 1){throw 'Synthetic recovery root was missing before first task stop.'}
        $headerPath=Join-Path $roots[0].FullName 'transaction.header.json'
        if(-not (Test-Path -LiteralPath $headerPath -PathType Leaf)){throw 'Immutable recovery header was missing before first task stop.'}
        $headerHash=Get-TokeneloSha256 ([IO.File]::ReadAllBytes($headerPath))
        $records=@([IO.File]::ReadAllLines((Join-Path $roots[0].FullName 'journal.jsonl'))|ForEach-Object{$_|ConvertFrom-Json})
        $marker=@($records|Where-Object{$_.phase -ceq 'recovery-header-written' -and $_.detail -ceq $headerHash})
        if($marker.Count -ne 1){throw 'Recovery header hash was not journaled before first task stop.'}
        $script:headerBeforeFirstStop=$true
    }
    & $script:realStopTokeneloTask -Owned $Owned -CleanupTimeoutSeconds $CleanupTimeoutSeconds `
        -ExpectedXmlCanonical $ExpectedXmlCanonical -LifecycleLease $LifecycleLease
}
function Invoke-FixtureTransaction([string]$DataHome,[switch]$WithTray) {
    $lease=Enter-TokeneloLifecycleMutex
    try {
        if($lease.Abandoned){throw 'A previous lifecycle transaction abandoned the mutex; inspect retained recovery journals before retrying.'}
        $expectedDaemon=Get-OwnedTokeneloTask -Name $TaskName
        $expectedTray=Get-OwnedTokeneloTask -Name $TrayTaskName
        Invoke-TokeneloInstallTransaction -RuntimeExecutable $BundledElectronPath -HomeDirectory $DataHome `
            -InstallTray:$WithTray -ExpectedDaemon $expectedDaemon -ExpectedTray $expectedTray -LifecycleLease $lease
    } finally { Exit-TokeneloLifecycleMutex -Lease $lease }
}
function Invoke-FixtureUninstall($LifecycleLease) {
    Invoke-TokeneloUninstallTransaction -LifecycleLease $LifecycleLease
}
function Assert-FixtureParent([string]$Path) {
    $parent=[IO.Path]::GetFullPath($Path)
    $tempRoot=[IO.Path]::GetFullPath('C:\Temp').TrimEnd('\')+'\'
    Assert-That ($parent.StartsWith($tempRoot,[StringComparison]::OrdinalIgnoreCase)) 'Transaction fixture escaped C:\Temp.'
    Remove-Item -LiteralPath $parent -Recurse -Force
}
function New-PackagedRuntimeFixture([ValidateSet('sibling','equal','descendant')][string]$Layout = 'sibling') {
    $parent = Join-Path 'C:\Temp' ('tokenelo-r3263-package-mode-' + [Guid]::NewGuid().ToString('N'))
    $localAppData = Join-Path $parent 'User\AppData\Local'
    $installRoot = switch ($Layout) {
        'equal' { Join-Path $localAppData 'Tokenelo\launchers' }
        'descendant' { Join-Path $localAppData 'Tokenelo' }
        default { Join-Path $parent 'Program Files\Tokenelo' }
    }
    $appRoot = Join-Path $installRoot 'resources\app'
    foreach ($directory in @((Join-Path $appRoot 'scripts\windows'), (Join-Path $appRoot 'dist\daemon'),
        (Join-Path $appRoot 'dist\tray'), $localAppData)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    [IO.File]::WriteAllText((Join-Path $installRoot 'Tokenelo.exe'), 'fixture executable')
    [IO.File]::WriteAllText((Join-Path $appRoot 'package.json'), '{"private":true,"type":"module","main":"dist/tray/main.js"}')
    [IO.File]::WriteAllText((Join-Path $appRoot 'dist\daemon\main.js'), 'fixture daemon')
    [IO.File]::WriteAllText((Join-Path $appRoot 'dist\tray\main.js'), 'fixture tray')
    [IO.File]::WriteAllText((Join-Path $appRoot 'scripts\windows\TokeneloHiddenLauncher.cs'), '// fixture launcher')
    [IO.File]::WriteAllText((Join-Path $appRoot 'scripts\install-service-windows.ps1'), '# fixture helper')
    [pscustomobject]@{ Parent=$parent; InstallRoot=$installRoot; AppRoot=$appRoot;
        Electron=(Join-Path $installRoot 'Tokenelo.exe'); LocalAppData=$localAppData }
}
function Get-ScheduledTask {
    [CmdletBinding()] param([string]$TaskName, [string]$TaskPath)
    $script:schedulerQueryCount++
    if ($script:queryDenied) { throw 'Simulated access denied' }
    if ($TaskName) { if (-not $script:tasks.ContainsKey($TaskName)) { throw 'Simulated missing task' }; return $script:tasks[$TaskName] }
    @($script:tasks.Values)
}
function Export-ScheduledTask {
    [CmdletBinding()] param([string]$TaskName,[string]$TaskPath,$InputObject)
    $task=if($InputObject){$InputObject}else{$script:tasks[$TaskName]}
    Get-FixtureTaskXml $task
}
function Get-CimInstance {
    [CmdletBinding()] param([string]$ClassName)
    if ($script:cimDenied) { throw 'Simulated process query denied' }
    if ($script:stopped) { return $script:processesAfter }; return $script:processesBefore
}
function Disable-ScheduledTask {
    [CmdletBinding()] param([string]$TaskName,[string]$TaskPath)
    $script:events.Add('disable:'+$TaskName)
    $script:mutations.Add('disable:'+$TaskName); $script:tasks[$TaskName].Settings.Enabled=$false
}
function Stop-ScheduledTask {
    [CmdletBinding()] param([string]$TaskName,[string]$TaskPath)
    $script:events.Add('stop:'+$TaskName)
    if($script:failStopName -eq $TaskName){$script:mutations.Add('disable:'+$TaskName);$script:tasks[$TaskName].Settings.Enabled=$false;throw 'Simulated cleanup timeout'}
    $script:mutations.Add('stop:'+$TaskName); $script:stopped=$true
    if (-not $script:stayRunning) { $script:tasks[$TaskName].State='Disabled' }
}
function Enable-ScheduledTask {
    [CmdletBinding()] param([string]$TaskName,[string]$TaskPath)
    $script:events.Add('enable:'+$TaskName)
    $script:mutations.Add('enable:'+$TaskName); $script:tasks[$TaskName].Settings.Enabled=$true; $script:tasks[$TaskName].State='Ready'
    if($script:mutateTaskOnEnable -eq 'xml' -and $TaskName -eq 'TokeneloDaemon' -and $script:tasks.ContainsKey($TrayTaskName)){
        $script:tasks[$TrayTaskName].Triggers[0].User='OTHER\user'
    }
    if($script:failEnableName -eq $TaskName){if(-not $script:failEnableAfterMutation){$script:tasks[$TaskName].Settings.Enabled=$false;$script:tasks[$TaskName].State='Disabled'};throw 'Simulated enable failure'}
}
function Start-ScheduledTask {
    [CmdletBinding()] param([string]$TaskName,[string]$TaskPath)
    $script:events.Add('start:'+$TaskName)
    if($script:failStartName -eq $TaskName -and -not $script:failStartAfterMutation){throw 'Simulated start failure before mutation'}
    $script:mutations.Add('start:'+$TaskName); $script:tasks[$TaskName].State='Running'
    if($script:failStartName -eq $TaskName -and $script:failStartAfterMutation){throw 'Simulated start failure after mutation'}
}
function Unregister-ScheduledTask {
    [CmdletBinding(SupportsShouldProcess)] param([string]$TaskName,[string]$TaskPath)
    $script:events.Add('unregister:'+$TaskName)
    if($script:failUnregisterName -eq $TaskName -and -not $script:failUnregisterAfterMutation){
        if($script:foreignAfterUnregisterFailureName -eq $TaskName){$null=New-FixtureTask -Name $TrayTaskName -User 'OTHER\user'}
        throw 'Simulated unregister failure before mutation'
    }
    if($script:unregisterNoOpName -eq $TaskName){return}
    if($script:processAfterUnregisterName -eq $TaskName){
        $removedTask=$script:tasks[$TaskName]; $action=$removedTask.Actions[0]
        $script:processesAfter=@(New-FixtureProcess 990 0 ('"'+$action.Execute+'" '+$action.Arguments))
    }
    $script:mutations.Add('remove:'+$TaskName); $script:tasks.Remove($TaskName)
    if($script:failUnregisterName -eq $TaskName -and $script:failUnregisterAfterMutation){throw 'Simulated unregister failure after mutation'}
}
function New-ScheduledTaskAction { param([string]$Execute,[string]$Argument) [pscustomobject]@{Execute=$Execute;Arguments=$Argument} }
function New-ScheduledTaskTrigger { param([switch]$AtLogOn,[string]$User) [pscustomobject]@{AtLogOn=[bool]$AtLogOn;TriggerType=if($AtLogOn){'LogonTrigger'}else{'BootTrigger'};Enabled=$true;User=$User} }
function New-ScheduledTaskPrincipal { param([string]$UserId,[string]$LogonType,[string]$RunLevel) [pscustomobject]@{UserId=$UserId;LogonType=$LogonType;RunLevel=$RunLevel} }
function New-ScheduledTaskSettingsSet {
    param([timespan]$ExecutionTimeLimit,[switch]$AllowStartIfOnBatteries,[switch]$DontStopIfGoingOnBatteries,[string]$MultipleInstances,[switch]$Disable)
    [pscustomobject]@{Priority=7;Enabled=(-not [bool]$Disable);ExecutionTimeLimit=$ExecutionTimeLimit;AllowStartIfOnBatteries=[bool]$AllowStartIfOnBatteries;DontStopIfGoingOnBatteries=[bool]$DontStopIfGoingOnBatteries;MultipleInstances=$MultipleInstances;
        AllowDemandStart=$true;AllowHardTerminate=$true;Hidden=$false;RestartCount=0;RestartInterval=$null;RunOnlyIfIdle=$false;RunOnlyIfNetworkAvailable=$false;StartWhenAvailable=$false;WakeToRun=$false;
        DisallowStartOnRemoteAppSession=$false;UseUnifiedSchedulingEngine=$true;IdleSettings=[pscustomobject]@{Duration='PT10M';WaitTimeout='PT1H';StopOnIdleEnd=$true;RestartOnIdle=$false}}
}
function New-ScheduledTask { param($Action,$Trigger,$Principal,$Settings) [pscustomobject]@{TaskName=$null;TaskPath='\';Actions=@($Action);Triggers=@($Trigger);Principal=$Principal;Settings=$Settings;RegistrationInfo=[pscustomobject]@{URI=$null;SecurityDescriptor='';Author=$null;Date=$null;Description=$null};State=if($Settings.Enabled){'Ready'}else{'Disabled'}} }
function Register-ScheduledTask {
    [CmdletBinding()] param([string]$TaskName,[string]$TaskPath,$Action,$Trigger,$Principal,$Settings,[string]$Xml,[switch]$Force)
    if(-not $Xml -and $script:failRegisterName -eq $TaskName -and -not $script:failRegisterAfterMutation){
        if($script:mutateLauncherBeforeRegisterFailureRole){
            $launcher=Get-TokeneloLauncherPath -Role $script:mutateLauncherBeforeRegisterFailureRole
            [IO.File]::WriteAllText($launcher,'fixture-external-launcher-change',[Text.UTF8Encoding]::new($false))
        }
        throw 'Simulated registration failure'
    }
    if($Xml){
        if($script:failRestoreXmlName -eq $TaskName -and -not $script:failRestoreXmlAfterMutation){throw 'Simulated rollback registration failure before mutation'}
        $script:events.Add('restore-xml:'+$TaskName)
        [xml]$document=$Xml
        $getValue={param($path) $node=$document.SelectSingleNode($path); if($node){$node.InnerText}else{$null}}
        $principalUser=& $getValue "//*[local-name()='Principals']/*[local-name()='Principal']/*[local-name()='UserId']"
        $command=& $getValue "//*[local-name()='Actions']/*[local-name()='Exec']/*[local-name()='Command']"
        $arguments=& $getValue "//*[local-name()='Actions']/*[local-name()='Exec']/*[local-name()='Arguments']"
        $registrationUri=& $getValue "//*[local-name()='RegistrationInfo']/*[local-name()='URI']"
        $securityDescriptor=& $getValue "//*[local-name()='RegistrationInfo']/*[local-name()='SecurityDescriptor']"
        $registrationAuthor=& $getValue "//*[local-name()='RegistrationInfo']/*[local-name()='Author']"
        $registrationDate=& $getValue "//*[local-name()='RegistrationInfo']/*[local-name()='Date']"
        $registrationDescription=& $getValue "//*[local-name()='RegistrationInfo']/*[local-name()='Description']"
        $triggerUser=& $getValue "//*[local-name()='Triggers']/*[local-name()='LogonTrigger']/*[local-name()='UserId']"
        $triggerEnabled=(& $getValue "//*[local-name()='Triggers']/*[local-name()='LogonTrigger']/*[local-name()='Enabled']") -ne 'false'
        $enabled=(& $getValue "//*[local-name()='Settings']/*[local-name()='Enabled']") -eq 'true'
        $priority=[int](& $getValue "//*[local-name()='Settings']/*[local-name()='Priority']")
        $multi=& $getValue "//*[local-name()='Settings']/*[local-name()='MultipleInstancesPolicy']"
        $duration=& $getValue "//*[local-name()='Settings']/*[local-name()='IdleSettings']/*[local-name()='Duration']"
        $waitTimeout=& $getValue "//*[local-name()='Settings']/*[local-name()='IdleSettings']/*[local-name()='WaitTimeout']"
        $stopOnIdle=& $getValue "//*[local-name()='Settings']/*[local-name()='IdleSettings']/*[local-name()='StopOnIdleEnd']"
        $restartOnIdle=& $getValue "//*[local-name()='Settings']/*[local-name()='IdleSettings']/*[local-name()='RestartOnIdle']"
        $executionTimeLimit=& $getValue "//*[local-name()='Settings']/*[local-name()='ExecutionTimeLimit']"
        $settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([Xml.XmlConvert]::ToTimeSpan($executionTimeLimit)) `
            -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances $multi
        $settings.Enabled=$enabled; $settings.Priority=$priority
        $settings.AllowStartIfOnBatteries=(& $getValue "//*[local-name()='Settings']/*[local-name()='DisallowStartIfOnBatteries']") -ne 'true'
        $settings.DontStopIfGoingOnBatteries=(& $getValue "//*[local-name()='Settings']/*[local-name()='StopIfGoingOnBatteries']") -ne 'true'
        $settings.AllowDemandStart=(& $getValue "//*[local-name()='Settings']/*[local-name()='AllowStartOnDemand']") -eq 'true'
        $settings.AllowHardTerminate=(& $getValue "//*[local-name()='Settings']/*[local-name()='AllowHardTerminate']") -eq 'true'
        $settings.Hidden=(& $getValue "//*[local-name()='Settings']/*[local-name()='Hidden']") -eq 'true'
        $settings.RunOnlyIfIdle=(& $getValue "//*[local-name()='Settings']/*[local-name()='RunOnlyIfIdle']") -eq 'true'
        $settings.RunOnlyIfNetworkAvailable=(& $getValue "//*[local-name()='Settings']/*[local-name()='RunOnlyIfNetworkAvailable']") -eq 'true'
        $settings.StartWhenAvailable=(& $getValue "//*[local-name()='Settings']/*[local-name()='StartWhenAvailable']") -eq 'true'
        $settings.WakeToRun=(& $getValue "//*[local-name()='Settings']/*[local-name()='WakeToRun']") -eq 'true'
        $settings.DisallowStartOnRemoteAppSession=(& $getValue "//*[local-name()='Settings']/*[local-name()='DisallowStartOnRemoteAppSession']") -eq 'true'
        $settings.UseUnifiedSchedulingEngine=(& $getValue "//*[local-name()='Settings']/*[local-name()='UseUnifiedSchedulingEngine']") -eq 'true'
        $settings.IdleSettings=[pscustomobject]@{Duration=$duration;WaitTimeout=$waitTimeout;StopOnIdleEnd=($stopOnIdle -eq 'true');RestartOnIdle=($restartOnIdle -eq 'true')}
        $task=[pscustomobject]@{TaskName=$TaskName;TaskPath='\';Principal=[pscustomobject]@{UserId=$principalUser;LogonType='Interactive';RunLevel='Limited'};
            Actions=@([pscustomobject]@{Execute=$command;Arguments=$arguments});Triggers=@([pscustomobject]@{AtLogOn=$true;TriggerType='LogonTrigger';Enabled=$triggerEnabled;User=$triggerUser});
            RegistrationInfo=[pscustomobject]@{URI=$registrationUri;SecurityDescriptor=$securityDescriptor;Author=$registrationAuthor;Date=$registrationDate;Description=$registrationDescription};
            Settings=$settings;
            State=if($enabled){'Ready'}else{'Disabled'}}
        if($script:registerTaskObjects){$script:tasks[$TaskName]=$task}
        $script:restoredXml[$TaskName]=$Xml
        if($script:failRestoreXmlName -eq $TaskName -and $script:failRestoreXmlAfterMutation){throw 'Simulated rollback registration failure after mutation'}
    } else {
        $script:events.Add('register:'+$TaskName+':enabled='+[string]$Settings.Enabled)
        $script:registeredAction=$Action; $script:registeredTrigger=$Trigger; $script:registeredPrincipal=$Principal; $script:registeredSettings=$Settings
        if($script:registerTaskObjects){
            $task=[pscustomobject]@{TaskName=$TaskName;TaskPath='\';Principal=$Principal;Actions=@($Action);Triggers=@($Trigger);Settings=$Settings;
                State=if($Settings.Enabled){'Ready'}else{'Disabled'}}
            $script:tasks[$TaskName]=$task
        }
    }
    if(-not $Xml -and $script:failRegisterName -eq $TaskName -and $script:failRegisterAfterMutation){throw 'Simulated registration failure after mutation'}
}
function Fake-RegisterWithLauncherMetadataCheck {
    [CmdletBinding()] param([string]$TaskName,[string]$TaskPath,$Action,$Trigger,$Principal,$Settings,[string]$Xml,[switch]$Force)
    if($Xml -and $script:restoreExpectedLauncherMetadata -and $script:restoreExpectedLauncherMetadata.ContainsKey($TaskName)){
        $expected=$script:restoreExpectedLauncherMetadata[$TaskName]
        $path=Get-TokeneloLauncherPath -Role $expected.Role
        $state=Get-TokeneloCoordinatorFileState -Path $path -ExpectedOwnerSid $expected.OwnerSid
        if($state.Sha256 -cne $expected.Sha256 -or $state.Length -ne $expected.Length -or
            $state.Attributes -ne $expected.Attributes -or $state.AclSha256 -cne $expected.AclSha256){
            throw "Launcher metadata was not restored before task registration for $($expected.Role)."
        }
        $script:launcherMetadataVerifiedBeforeRegister.Add($TaskName)
    }
    & $script:realFixtureRegisterScheduledTask @PSBoundParameters
}
function Fake-Remove-TokeneloUninstallLauncher {
    param($Transaction,$Plan)
    if($script:failLauncherRemoveRole -eq $Plan.Role -and -not $script:failLauncherRemoveAfterMutation){throw "Simulated $($Plan.Role) launcher removal failure before mutation"}
    & $script:realRemoveUninstallLauncher -Transaction $Transaction -Plan $Plan
    if($script:failLauncherRemoveRole -eq $Plan.Role -and $script:failLauncherRemoveAfterMutation){throw "Simulated $($Plan.Role) launcher removal failure after mutation"}
}
function Set-FakeUninstallLauncherRemoval {
    Set-Item -Path Function:\Remove-TokeneloUninstallLauncher -Value (Get-Command Fake-Remove-TokeneloUninstallLauncher).ScriptBlock
}
function Assert-That($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Assert-Refused([scriptblock]$Action, [string]$Pattern) {
    $caught = $null
    try { & $Action } catch { $caught = $_.Exception.Message }
    Assert-That ($caught -and $caught -match $Pattern) ('Expected refusal matching '+$Pattern+'; actual: '+$caught)
}
function Case([string]$Name,[scriptblock]$Action) {
    if($ExistingOnly -and $Name -ceq 'actual child File dispatch covers entry lease install and uninstall transactions with fake OS boundaries'){return}
    if($DispatchOnly -and $Name -cne 'actual child File dispatch covers entry lease install and uninstall transactions with fake OS boundaries'){return}
    if($CoordinatorOnly -and $Name -cne 'coordinator parent exit fails before the next task mutation'){return}
    if($SecurityModuleOnly -and $Name -cne 'native security module binding stays on PSHOME under a foreign-first module path'){return}
    if($RecoveryHeaderOnly -and $Name -notlike 'uninstall recovery header *' -and $Name -notlike 'uninstall recovery rollback *'){return}
    Reset-Fixture
    try { & $Action; $results.Add([pscustomobject]@{name=$Name;passed=$true}) }
    catch { $results.Add([pscustomobject]@{name=$Name;passed=$false;error=$_.Exception.Message}) }
}
function Get-TestForeignSecurityModuleRoot {
    if ($PSVersionTable.PSVersion.Major -le 5) {
        $otherShell = Get-Command -Name 'pwsh.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $otherShell) { throw 'The foreign PowerShell 7 module root is unavailable for this owned fixture.' }
        $foreignRoot = Join-Path (Split-Path -Parent $otherShell.Source) 'Modules'
    } else {
        $foreignRoot = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\Modules'
    }
    $foreignManifest = Join-Path $foreignRoot 'Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'
    if (-not [IO.File]::Exists($foreignManifest)) { throw 'The foreign Security module manifest is unavailable for this owned fixture.' }
    return [IO.Path]::GetFullPath($foreignRoot)
}

Case 'native security module binding stays on PSHOME under a foreign-first module path' {
    $fixtureParent = Join-Path 'C:\Temp' ('tokenelo-r3322-service-security-fixture-' + [Guid]::NewGuid().ToString('N'))
    if (Test-Path -LiteralPath $fixtureParent) { throw 'Security module fixture path already exists.' }
    $originalModulePath = $env:PSModulePath
    try {
        $null = New-Item -ItemType Directory -Path $fixtureParent
        $fixtureFile = Join-Path $fixtureParent 'sample.txt'
        [IO.File]::WriteAllText($fixtureFile, 'owned synthetic ACL fixture', [Text.UTF8Encoding]::new($false))
        $nativeRoot = [IO.Path]::GetFullPath((Join-Path $PSHOME 'Modules'))
        $nativeManifest = [IO.Path]::GetFullPath((Join-Path $nativeRoot 'Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'))
        if (-not [IO.File]::Exists($nativeManifest)) { throw 'The native Security module manifest is unavailable.' }
        $foreignRoot = Get-TestForeignSecurityModuleRoot
        Assert-That ($foreignRoot -ine $nativeRoot) 'The ambient module fixture did not use a different PowerShell module root.'
        $env:PSModulePath = $foreignRoot + ';' + $nativeRoot
        Assert-That (($env:PSModulePath -split ';')[0] -ieq $foreignRoot) 'The test did not put the foreign module root first in this process.'

        $resolvedManifest = Import-TokeneloNativeSecurityModule
        Assert-That ($resolvedManifest -ceq $nativeManifest) 'The helper did not return the exact PSHOME Security manifest.'
        $loaded = @(Get-Module -Name 'Microsoft.PowerShell.Security')
        Assert-That ($loaded.Count -eq 1 -and [IO.Path]::GetFullPath($loaded[0].Path) -ceq $nativeManifest) `
            'The loaded Security module identity did not match the current runtime PSHOME.'
        $acl = Get-TokeneloCoordinatorFileAcl -Path $fixtureFile
        Assert-That ($acl.GetType().FullName -ceq 'System.Security.AccessControl.FileSecurity') `
            'The production coordinator ACL helper did not read the owned synthetic file.'
        $missingManifest = Join-Path $fixtureParent 'missing\Microsoft.PowerShell.Security.psd1'
        Assert-Refused { Assert-TokeneloNativeSecurityManifestAvailable -ManifestPath $missingManifest } 'native Microsoft.PowerShell.Security module is unavailable'
    } finally {
        $env:PSModulePath = $originalModulePath
        Assert-FixtureParent $fixtureParent
    }
}

function Invoke-ActualDispatchChild([string]$Scenario,$Fixture) {
    $productText=[IO.File]::ReadAllText($source)
    $productTokens=$null; $productErrors=$null
    $productAst=[Management.Automation.Language.Parser]::ParseInput($productText,[ref]$productTokens,[ref]$productErrors)
    if($productErrors.Count){throw 'Product helper did not parse before AST assembly.'}
    $imports=@($productAst.FindAll({param($node) $node -is [Management.Automation.Language.CommandAst] -and $node.GetCommandName() -ceq 'Import-Module'},$true))
    $securityImports=@($imports|Where-Object{$_.Extent.Text -match 'Import-Module\s+-Name\s+\$manifestPath'})
    $platformImports=@($imports|Where-Object{$_.Extent.Text -match 'ScheduledTasks\.psd1|CimCmdlets\.psd1'})
    if($imports.Count -ne 3 -or $securityImports.Count -ne 1 -or $platformImports.Count -ne 2){
        throw 'Expected one native Security import and the two platform task/CIM module imports at the child boundary.'
    }
    $nativeImportCall=$productText.IndexOf('$null = Import-TokeneloNativeSecurityModule',[StringComparison]::Ordinal)
    $scheduledImport=$productText.IndexOf('ScheduledTasks.psd1',[StringComparison]::Ordinal)
    $cimImport=$productText.IndexOf('CimCmdlets.psd1',[StringComparison]::Ordinal)
    if($nativeImportCall -lt 0 -or $nativeImportCall -gt $scheduledImport -or $nativeImportCall -gt $cimImport){
        throw 'The native Security module must be bound before the platform module imports.'
    }
    $edits=@($platformImports|ForEach-Object{[pscustomobject]@{Start=$_.Extent.StartOffset;End=$_.Extent.EndOffset}}|Sort-Object Start -Descending)
    foreach($edit in $edits){$productText=$productText.Remove($edit.Start,$edit.End-$edit.Start)}
    $entryMarker='$entryLease = Enter-TokeneloLifecycleMutex'
    if(([regex]::Matches($productText,[regex]::Escape($entryMarker))).Count -ne 1){throw 'Could not identify the unique actual top-level entry lease marker.'}
    $testText=[IO.File]::ReadAllText($PSCommandPath)
    $testTokens=$null; $testErrors=$null
    $testAst=[Management.Automation.Language.Parser]::ParseInput($testText,[ref]$testTokens,[ref]$testErrors)
    $helperNames=@('New-FixtureTask','Get-FixtureTaskXml','New-ScheduledTaskSettingsSet','New-ScheduledTaskAction',
        'New-ScheduledTaskTrigger','New-ScheduledTaskPrincipal','New-ScheduledTask','Assert-TestProtectedRecoveryDirectoryAcl')
    $helpers=[Collections.Generic.List[string]]::new()
    foreach($name in $helperNames){
        $wanted=$name
        $matches=@($testAst.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $wanted},$true)|Select-Object -First 1)
        if($matches.Count -ne 1){throw ('Missing exact test fixture function for child: '+$name)}
        $helpers.Add($matches[0].Extent.Text)
    }
    $tracePath=Join-Path $Fixture.Parent ('dispatch-'+$Scenario+'.trace')
    $setup=[Collections.Generic.List[string]]::new()
    $setup.Add('$script:dispatchScenario='''+$Scenario+'''')
    $setup.Add('$script:dispatchTracePath='''+$tracePath+'''')
    $setup.Add('$script:dispatchTasks=@{}; $script:tasks=$script:dispatchTasks; $script:dispatchInitialized=$false')
    $setup.Add('$script:dispatchFactoryCount=0; $script:dispatchReleaseCount=0; $script:dispatchDisposeCount=0; $script:dispatchUninstallCommitted=$false; $script:dispatchPrejournalChecked=$false')
    $setup.Add('$script:dispatchExpectedLocalAppDataSddl='''+$Fixture.LocalAppDataSddl+'''; $script:dispatchExpectedTokeneloSddl='''+$Fixture.TokeneloSddl+'''')
    $setup.Add('function Add-DispatchTrace([string]$Value){[IO.File]::AppendAllText($script:dispatchTracePath,$Value+[Environment]::NewLine,[Text.UTF8Encoding]::new($false))}')
    $setup.Add('$script:dispatchOriginalJournal=(Get-Command -Name Write-TokeneloTransactionJournal -CommandType Function -ErrorAction Stop).ScriptBlock')
    $setup.Add('function Write-TokeneloTransactionJournal {')
    $setup.Add(' param($Transaction,[string]$Phase,[string]$Role='''',[string]$Detail='''')')
    $setup.Add(' if($script:dispatchScenario -eq ''uninstall'' -and $Phase -ceq ''preflight-complete'' -and -not $script:dispatchPrejournalChecked){')
    $setup.Add('  $script:dispatchPrejournalChecked=$true; $sid=[string][Security.Principal.WindowsIdentity]::GetCurrent().User.Value')
    $setup.Add('  $localSddl=Assert-TestProtectedRecoveryDirectoryAcl -Path $env:LOCALAPPDATA -Sid $sid')
    $setup.Add('  $tokeneloPath=Join-Path $env:LOCALAPPDATA ''Tokenelo''; $tokeneloSddl=Assert-TestProtectedRecoveryDirectoryAcl -Path $tokeneloPath -Sid $sid')
    $setup.Add('  if($localSddl -cne $script:dispatchExpectedLocalAppDataSddl -or $tokeneloSddl -cne $script:dispatchExpectedTokeneloSddl){throw ''Recovery provisioning changed a preexisting parent ACL.''}')
    $setup.Add('  $basePath=Join-Path $tokeneloPath ''recovery''; $null=Assert-TestProtectedRecoveryDirectoryAcl -Path $basePath -Sid $sid')
    $setup.Add('  $null=Assert-TestProtectedRecoveryDirectoryAcl -Path $Transaction.RecoveryRoot -Sid $sid')
    $setup.Add('  if(@(Get-ChildItem -LiteralPath $Transaction.RecoveryRoot -Force -ErrorAction Stop).Count -ne 0){throw ''Recovery root was not empty before the first journal record.''}')
    $setup.Add('  Add-DispatchTrace ''recovery-root-private-empty-before-first-journal''')
    $setup.Add(' }')
    $setup.Add(' & $script:dispatchOriginalJournal -Transaction $Transaction -Phase $Phase -Role $Role -Detail $Detail')
    $setup.Add('}')
    $setup.Add('function Initialize-DispatchTasks {')
    $setup.Add(' if($script:dispatchInitialized){return}; $script:dispatchInitialized=$true; Add-DispatchTrace (''initialize:''+$script:dispatchScenario)')
    $setup.Add(' if($script:dispatchScenario -eq ''install''){return}')
    $setup.Add(' $sid=[string][Security.Principal.WindowsIdentity]::GetCurrent().User.Value')
    $setup.Add(' $null=New-FixtureTask -Name $script:TaskName -User $sid')
    $setup.Add(' $trayUser=if($script:dispatchScenario -eq ''foreign''){''OTHER\user''}else{$sid}')
    $setup.Add(' $null=New-FixtureTask -Name $script:TrayTaskName -User $trayUser; Add-DispatchTrace (''fixture-task-count:''+$script:dispatchTasks.Count)')
    $setup.Add(' foreach($role in @(''daemon'',''tray'')){[IO.File]::WriteAllText((Get-TokeneloLauncherPath -Role $role),(''fixture-old-launcher-''+$role),[Text.UTF8Encoding]::new($false))}')
    $setup.Add(' $sentinel=Join-Path $env:LOCALAPPDATA ''Tokenelo\user-data\sentinel.txt''; $null=New-Item -ItemType Directory -Path (Split-Path -Parent $sentinel) -Force; [IO.File]::WriteAllText($sentinel,''preserve-me'',[Text.UTF8Encoding]::new($false))')
    $setup.Add('}')
    $setup.Add('function New-TokeneloLifecycleMutex {param([string]$Name); $script:dispatchFactoryCount++; Add-DispatchTrace (''mutex-create:''+$Name); $m=[pscustomobject]@{Owned=$false;Disposed=$false}; Add-Member -InputObject $m -MemberType ScriptMethod -Name WaitOne -Value {param([int]$Timeout) if($Timeout -ne 0){throw ''Expected nonblocking test mutex''}; $this.Owned=$true; return $true}; Add-Member -InputObject $m -MemberType ScriptMethod -Name ReleaseMutex -Value {if(-not $this.Owned){throw ''Fake mutex release without ownership''}; $this.Owned=$false; $script:dispatchReleaseCount++; Add-DispatchTrace ''mutex-release''}; Add-Member -InputObject $m -MemberType ScriptMethod -Name Dispose -Value {$this.Disposed=$true; $script:dispatchDisposeCount++; Add-DispatchTrace ''mutex-dispose''}; return $m}')
    $setup.Add('function Get-ScheduledTask { [CmdletBinding()] param([string]$TaskName,[string]$TaskPath); Initialize-DispatchTasks; if($script:dispatchUninstallCommitted){Add-DispatchTrace (''query-after-uninstall:''+$TaskName)}; if($TaskName){if(-not $script:dispatchTasks.ContainsKey($TaskName)){throw ''Simulated missing task''}; return $script:dispatchTasks[$TaskName]}; return @($script:dispatchTasks.Values) }')
    $setup.Add('function Export-ScheduledTask { [CmdletBinding()] param([string]$TaskName,[string]$TaskPath,$InputObject); Get-FixtureTaskXml $InputObject }')
    $setup.Add('function Get-CimInstance { param([string]$ClassName); Add-DispatchTrace (''cim:''+$ClassName); @() }')
    $setup.Add('function Disable-ScheduledTask { [CmdletBinding()] param([string]$TaskName,[string]$TaskPath); Add-DispatchTrace (''disable:''+$TaskName); $script:dispatchTasks[$TaskName].Settings.Enabled=$false }')
    $setup.Add('function Stop-ScheduledTask { [CmdletBinding()] param([string]$TaskName,[string]$TaskPath); Add-DispatchTrace (''stop:''+$TaskName); $script:dispatchTasks[$TaskName].State=''Disabled''; if($script:dispatchScenario -eq ''stop-race'' -and $TaskName -eq $TrayTaskName){$script:dispatchTasks[$script:TaskName].Principal.UserId=''OTHER\user''} }')
    $setup.Add('function Unregister-ScheduledTask { [CmdletBinding(SupportsShouldProcess=$true)] param([string]$TaskName,[string]$TaskPath); Add-DispatchTrace (''unregister:''+$TaskName); $null=$script:dispatchTasks.Remove($TaskName) }')
    $setup.Add('function Enable-ScheduledTask { [CmdletBinding()] param([string]$TaskName,[string]$TaskPath); Add-DispatchTrace (''enable:''+$TaskName); $script:dispatchTasks[$TaskName].Settings.Enabled=$true; $script:dispatchTasks[$TaskName].State=''Ready'' }')
    $setup.Add('function Start-ScheduledTask { [CmdletBinding()] param([string]$TaskName,[string]$TaskPath); Add-DispatchTrace (''start:''+$TaskName); $script:dispatchTasks[$TaskName].State=''Running'' }')
    $setup.Add('function Register-ScheduledTask { [CmdletBinding()] param([string]$TaskName,[string]$TaskPath,$Action,$Trigger,$Principal,$Settings,[string]$Xml,[switch]$Force); if($Xml){throw ''Unexpected XML restore in child install case''}; Add-DispatchTrace (''register:''+$TaskName); $task=New-ScheduledTask -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings; $task.TaskName=$TaskName; $task.RegistrationInfo=[pscustomobject]@{URI=(''\''+$TaskName);SecurityDescriptor='''';Author=$null;Date=$null;Description=$null}; $task.State=if($Settings.Enabled){''Ready''}else{''Disabled''}; $script:dispatchTasks[$TaskName]=$task }')
    $setup.Add('function Build-TokeneloLauncher { param([ValidateSet(''daemon'',''tray'')][string]$Role,[Parameter(Mandatory=$true)][string]$OutputPath); Add-DispatchTrace (''compile:''+$Role); [IO.File]::WriteAllText($OutputPath,(''fixture-new-launcher-''+$Role),[Text.UTF8Encoding]::new($false)); return $OutputPath }')
    $setup.Add('function Write-Host { param([Parameter(ValueFromRemainingArguments=$true)][object[]]$Object); $message=$Object -join '' ''; Add-DispatchTrace (''host:''+$message); if($message.StartsWith(''Removed owned task registrations and launcher files;'',[StringComparison]::Ordinal)){$script:dispatchUninstallCommitted=$true} }')
    $setup.Add('$null=New-Item -ItemType Directory -Path (Join-Path $env:LOCALAPPDATA ''Tokenelo\launchers'') -Force')
    $fakeBoundary=$setup -join "`r`n"
    $helperText=$helpers -join "`r`n"
    $childText=$productText.Replace($entryMarker,$fakeBoundary+"`r`n"+$entryMarker)
    $childPath=Join-Path $Fixture.AppRoot 'scripts\install-service-windows.ps1'
    [IO.File]::WriteAllText($childPath,($childText),[Text.UTF8Encoding]::new($false))
    # Fixture function definitions are placed after product functions and before the actual top-level dispatch.
    $childText=[IO.File]::ReadAllText($childPath)
    $childText=$childText.Replace($fakeBoundary+"`r`n"+$entryMarker,$helperText+"`r`n"+$fakeBoundary+"`r`n"+$entryMarker)
    [IO.File]::WriteAllText($childPath,$childText,[Text.UTF8Encoding]::new($false))
    $childHost=if($PSVersionTable.PSEdition -eq 'Core'){Join-Path $PSHOME 'pwsh.exe'}else{Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'}
    $dataHome=Join-Path $Fixture.Parent 'isolated user data home'
    $psi=[Diagnostics.ProcessStartInfo]::new(); $psi.FileName=$childHost
    $arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$childPath+'" -PackagedAppRoot "'+$Fixture.AppRoot+'" -PackagedElectronPath "'+$Fixture.Electron+'"'
    if($Scenario -eq 'uninstall' -or $Scenario -eq 'stop-race' -or $Scenario -eq 'foreign'){$arguments+=' -Uninstall'}
    else{$arguments+=' -HomeDirectory "'+$dataHome+'"'}
    $psi.Arguments=$arguments; $psi.UseShellExecute=$false; $psi.CreateNoWindow=$true; $psi.RedirectStandardOutput=$true; $psi.RedirectStandardError=$true
    $psi.EnvironmentVariables['LOCALAPPDATA']=$Fixture.LocalAppData
    $process=[Diagnostics.Process]::Start($psi); $stdoutTask=$process.StandardOutput.ReadToEndAsync(); $stderrTask=$process.StandardError.ReadToEndAsync()
    if(-not $process.WaitForExit(25000)){$process.Kill();$process.WaitForExit();throw ('Child lifecycle exceeded 25 seconds: '+$Scenario)}
    [pscustomobject]@{Scenario=$Scenario;ExitCode=$process.ExitCode;Stdout=$stdoutTask.Result;Stderr=$stderrTask.Result;Trace=[IO.File]::ReadAllText($tracePath);Fixture=$Fixture;TracePath=$tracePath}
}

Case 'missing registration is a no-op' {
    $owned = Get-OwnedTokeneloTask $TaskName
    Assert-That ($null -eq $owned) 'Missing task became owned'
    Stop-TokeneloTask $owned
    Uninstall-TokeneloTask $owned $TaskName
    Assert-That ($mutations.Count -eq 0) 'Missing task changed scheduler'
}
Case 'supported two-argument daemon and same-user SID' {
    $null = New-FixtureTask -User ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
    $owned = Get-OwnedTokeneloTask $TaskName
    Assert-That ($owned.ChildCommand -eq ('"'+$nodePath+'" "'+$DaemonEntry+'"')) 'Node identity lost'
}
Case 'same-user short account name resolves by SID' {
    $shortName=$principal.Split('\')[-1]
    $null=New-FixtureTask -User $shortName
    $null=Get-OwnedTokeneloTask $TaskName
}
Case 'optional absolute data directory is accepted' {
    $task = New-FixtureTask; $task.Actions[0].Arguments += ' "C:\Temp\isolated home"'
    $null = Get-OwnedTokeneloTask $TaskName
}
Case 'relative optional data directory is refused' {
    $task = New-FixtureTask; $task.Actions[0].Arguments += ' "relative-home"'
    Assert-Refused { Get-OwnedTokeneloTask $TaskName } 'supported daemon action'
    Assert-That ($mutations.Count -eq 0) 'Bad directory mutated task'
}
Case 'foreign principal is refused' {
    $null = New-FixtureTask -User 'OTHER\user'
    Assert-Refused { Get-OwnedTokeneloTask $TaskName } 'another principal'
    Assert-That ($mutations.Count -eq 0) 'Foreign task mutated'
}
Case 'legacy action is refused' {
    $task = New-FixtureTask; $task.Actions[0].Execute='C:\Windows\System32\wscript.exe'
    Assert-Refused { Get-OwnedTokeneloTask $TaskName } 'legacy installation'
    Assert-That ($mutations.Count -eq 0) 'Legacy action mutated'
}
Case 'foreign daemon entry is refused' {
    $task = New-FixtureTask; $task.Actions[0].Arguments='"'+$nodePath+'" "C:\other\main.js"'
    Assert-Refused { Get-OwnedTokeneloTask $TaskName } 'supported daemon action'
}
Case 'extra action is refused' {
    $task = New-FixtureTask; $task.Actions += $task.Actions[0]
    Assert-Refused { Get-OwnedTokeneloTask $TaskName } 'unsupported action'
}
Case 'extra daemon argument is refused' {
    $task = New-FixtureTask; $task.Actions[0].Arguments += ' --extra'
    Assert-Refused { Get-OwnedTokeneloTask $TaskName } 'supported daemon action'
}
Case 'scheduler access failure is not absence' {
    $queryDenied=$true; $script:queryDenied=$true
    Assert-Refused { Get-OwnedTokeneloTask $TaskName } 'access denied'
    Assert-That ($mutations.Count -eq 0) 'Access failure mutated scheduler'
}
Case 'task action change before stop is refused' {
    $task=New-FixtureTask; $owned=Get-OwnedTokeneloTask $TaskName
    $task.Actions[0].Arguments += ' "C:\Temp\changed-home"'
    Assert-Refused { Stop-TokeneloTask $owned } 'changed before mutation'
    Assert-That ($mutations.Count -eq 0) 'Changed task was stopped'
}
Case 'process query failure refuses stop before disable' {
    $null=New-FixtureTask; $owned=Get-OwnedTokeneloTask $TaskName; $script:cimDenied=$true
    Assert-Refused { Stop-TokeneloTask $owned } 'process query denied'
    Assert-That ($mutations.Count -eq 0) 'Process query failure changed scheduler'
}
Case 'daemon cleanup includes child and grandchild and retains foreign PID reuse' {
    $null=New-FixtureTask; $owned=Get-OwnedTokeneloTask $TaskName
    $script:processesBefore=@((New-FixtureProcess 101 0 ('"'+$owned.Execute+'" '+$owned.Arguments)),(New-FixtureProcess 102 101 $owned.ChildCommand),(New-FixtureProcess 103 102),(New-FixtureProcess 104 103))
    $script:processesAfter=@(New-FixtureProcess 104 0 'foreign process with reused PID' 5)
    $receipt=Stop-TokeneloTask $owned
    Assert-That ($receipt.TrackedProcesses.Count -eq 4) 'Descendant closure incomplete'
    Uninstall-TokeneloTask $owned $TaskName $receipt
    Assert-That (($mutations -join ',') -eq 'disable:TokeneloDaemon,stop:TokeneloDaemon,remove:TokeneloDaemon') 'Stop/removal ordering wrong'
    Assert-That ($processesAfter.Count -eq 1) 'Foreign process changed'
}
Case 'surviving child retains disabled registration' {
    $null=New-FixtureTask; $owned=Get-OwnedTokeneloTask $TaskName
    $script:processesBefore=@((New-FixtureProcess 101 0 $owned.ChildCommand),(New-FixtureProcess 102 101))
    $script:processesAfter=@($processesBefore[1])
    Assert-Refused { Stop-TokeneloTask $owned -CleanupTimeoutSeconds .05 } 'did not finish process cleanup'
    Assert-That ($tasks.ContainsKey($TaskName) -and -not $tasks[$TaskName].Settings.Enabled) 'Failed stop lost registration'
    Assert-That (-not ($mutations -contains 'remove:TokeneloDaemon')) 'Surviving child was unregistered'
}
Case 'task still running is refused even without process match' {
    $null=New-FixtureTask; $owned=Get-OwnedTokeneloTask $TaskName; $script:stayRunning=$true
    Assert-Refused { Stop-TokeneloTask $owned -CleanupTimeoutSeconds .05 } 'did not finish process cleanup'
}
Case 'new matching process after stop is refused' {
    $null=New-FixtureTask; $owned=Get-OwnedTokeneloTask $TaskName
    $script:processesAfter=@(New-FixtureProcess 900 0 $owned.ChildCommand)
    Assert-Refused { Stop-TokeneloTask $owned -CleanupTimeoutSeconds .05 } 'did not finish process cleanup'
}
Case 'removal without a verified stop receipt is refused' {
    $null=New-FixtureTask; $owned=Get-OwnedTokeneloTask $TaskName
    Assert-Refused { Uninstall-TokeneloTask $owned $TaskName } 'no verified stop receipt'
    Assert-That ($mutations.Count -eq 0) 'Removal bypassed stop'
}
Case 'ownership change after stop retains registration' {
    $task=New-FixtureTask; $owned=Get-OwnedTokeneloTask $TaskName; $receipt=Stop-TokeneloTask $owned
    $task.Principal.UserId='OTHER\user'
    Assert-Refused { Uninstall-TokeneloTask $owned $TaskName $receipt } 'another principal'
    Assert-That ($tasks.ContainsKey($TaskName)) 'Changed task removed'
}
Case 'enabled registration after stop is refused' {
    $task=New-FixtureTask; $owned=Get-OwnedTokeneloTask $TaskName; $receipt=Stop-TokeneloTask $owned
    $task.Settings.Enabled=$true
    Assert-Refused { Uninstall-TokeneloTask $owned $TaskName $receipt } 'resumed before removal'
}
Case 'surviving tracked descendant after stop receipt is refused' {
    $null=New-FixtureTask; $owned=Get-OwnedTokeneloTask $TaskName
    $script:processesBefore=@((New-FixtureProcess 101 0 $owned.ChildCommand),(New-FixtureProcess 102 101))
    $receipt=Stop-TokeneloTask $owned; $script:processesAfter=@($processesBefore[1])
    Assert-Refused { Uninstall-TokeneloTask $owned $TaskName $receipt } 'resumed before removal'
}
Case 'tray uses its own exact action and owned cleanup' {
    $null=New-FixtureTask -Name $TrayTaskName; $owned=Get-OwnedTokeneloTask $TrayTaskName
    $script:processesBefore=@((New-FixtureProcess 201 0 ($owned.Execute+' '+$owned.Arguments)),(New-FixtureProcess 202 201))
    $receipt=Stop-TokeneloTask $owned; Uninstall-TokeneloTask $owned $TrayTaskName $receipt
    Assert-That ($receipt.TrackedProcesses.Count -eq 2) 'Tray children were not tracked'
}
Case 'unsupported tray argument is refused' {
    $task=New-FixtureTask -Name $TrayTaskName; $task.Actions[0].Arguments += ' --extra'
    Assert-Refused { Get-OwnedTokeneloTask $TrayTaskName } 'tray action'
}
Case 'structured registration preserves Program Files arguments and least privilege' {
    $arguments='"C:\Program Files\nodejs\node.exe" "C:\Temp\application path\main.js" "C:\Temp\data path"'
    foreach ($registrationName in @($TaskName,$TrayTaskName)) {
    Register-TokeneloTaskAction $registrationName 'C:\Temp\application path\launcher.exe' $arguments
    Assert-That ($registeredAction.Execute -eq 'C:\Temp\application path\launcher.exe' -and $registeredAction.Arguments -eq $arguments) 'Task argument boundaries changed'
    Assert-That ($registeredTrigger.AtLogOn -and $registeredTrigger.User -eq $principal) 'Logon trigger scope wrong'
    Assert-That ($registeredPrincipal.UserId -eq $principal -and $registeredPrincipal.LogonType -eq 'Interactive' -and $registeredPrincipal.RunLevel -eq 'Limited') 'Task privilege or logon type wrong'
    Assert-That ($registeredSettings.ExecutionTimeLimit.Ticks -eq 0 -and $registeredSettings.AllowStartIfOnBatteries -and $registeredSettings.DontStopIfGoingOnBatteries -and $registeredSettings.MultipleInstances -eq 'IgnoreNew') 'Continuous tracker settings wrong'
    Assert-That ($registeredSettings.Priority -eq 4) 'Reports and tray inherited background scheduling'
    }
}
Case 'root and trailing-backslash data paths retain their closing quote' {
    Assert-That ((Quote-TokeneloPath 'C:\') -eq '"C:\\"') 'Drive root quote is wrong'
    Assert-That ((Quote-TokeneloPath 'C:\Temp\data\') -eq '"C:\Temp\data\\"') 'Trailing backslash quote is wrong'
}
Case 'data directory validation rejects quotes and relative paths' {
    Assert-Refused { Resolve-TokeneloDataDirectory 'relative' } 'absolute path'
    Assert-Refused { Resolve-TokeneloDataDirectory 'C:\Temp\bad"path' } 'without quotes'
    Assert-That ($mutations.Count -eq 0) 'Directory validation mutated scheduler'
}
Case 'tray shares the configured home and child identity' {
    $task=New-FixtureTask -Name $TrayTaskName; $task.Actions[0].Arguments += ' "C:\Temp\custom-home"'
    $owned=Get-OwnedTokeneloTask $TrayTaskName
    Assert-That ($owned.HomeDirectory -eq 'C:\Temp\custom-home') 'Tray home lost'
    Assert-That ($owned.ChildCommand -eq ('"'+(Join-Path $RepoRoot 'node_modules\electron\dist\electron.exe')+'" "'+(Join-Path $RepoRoot 'dist\tray\main.js')+'"')) 'Tray child identity wrong'
}
Case 'other Electron installation is refused' {
    $task=New-FixtureTask -Name $TrayTaskName
    $task.Actions[0].Arguments='"C:\other\electron.exe" "'+(Join-Path $RepoRoot 'dist\tray\main.js')+'"'
    Assert-Refused { Get-OwnedTokeneloTask $TrayTaskName } 'tray action'
    Assert-That ($mutations.Count -eq 0) 'Other installation changed'
}
Case 'packaged mode uses only its app root and bundled Electron for both roles' {
    $fixture = New-PackagedRuntimeFixture
    try {
        $otherAppRoot = Join-Path (Split-Path -Parent $fixture.AppRoot) 'other'
        Copy-Item -LiteralPath $fixture.AppRoot -Destination $otherAppRoot -Recurse
        Assert-Refused { Resolve-TokeneloPackagedContext -AppRoot $otherAppRoot -ElectronPath $fixture.Electron `
            -HelperScriptRoot (Join-Path $otherAppRoot 'scripts') -LocalAppData $fixture.LocalAppData } 'resources\\app directory'
        Assert-That ($mutations.Count -eq 0) 'Wrong packaged layout changed scheduler state'

        $context = Resolve-TokeneloPackagedContext -AppRoot $fixture.AppRoot -ElectronPath $fixture.Electron `
            -HelperScriptRoot (Join-Path $fixture.AppRoot 'scripts') -LocalAppData $fixture.LocalAppData
        Assert-That ($context.RuntimeMode -eq 'packaged') 'Packaged mode was not selected'
        Assert-That ($context.DaemonEntry -eq (Join-Path $fixture.AppRoot 'dist\daemon\main.js')) 'Daemon entry was not rooted in resources/app'
        Assert-That ($context.TrayEntry -eq (Join-Path $fixture.AppRoot 'dist\tray\main.js')) 'Tray entry was not rooted in resources/app'
        Assert-That (-not $context.LauncherRoot.StartsWith($fixture.AppRoot, [StringComparison]::OrdinalIgnoreCase)) 'Launcher output was placed inside the installed app'

        $script:RepoRoot = $context.AppRoot
        $script:DaemonEntry = $context.DaemonEntry
        $script:TrayEntry = $context.TrayEntry
        $script:RuntimeMode = $context.RuntimeMode
        $script:BundledElectronPath = $context.ElectronPath
        $script:LauncherRoot = $context.LauncherRoot

        $daemonTask = New-FixtureTask
        $ownedDaemon = Get-OwnedTokeneloTask $TaskName
        Assert-That ($ownedDaemon.ChildCommand -eq ('"' + $fixture.Electron + '" "' + $context.DaemonEntry + '"')) 'Packaged daemon action did not bind Electron to the daemon entry'
        $daemonArguments = Get-TokeneloDaemonActionArguments -RuntimeExecutable $fixture.Electron -Entry $context.DaemonEntry -HomeDirectory 'C:\Temp\packaged home'
        Assert-That ($daemonArguments -eq ('"' + $fixture.Electron + '" "' + $context.DaemonEntry + '" "C:\Temp\packaged home"')) 'Packaged daemon action lost its user-home boundary'

        $trayTask = New-FixtureTask -Name $TrayTaskName
        $ownedTray = Get-OwnedTokeneloTask $TrayTaskName
        Assert-That ($trayTask.Actions[0].Arguments -eq ('"' + $fixture.Electron + '" "--tokenelo-packaged-app"')) 'Packaged tray action did not use the app package main'
        Assert-That ($null -eq $ownedTray.ChildCommand) 'Packaged tray child fallback must not match an unrelated GUI instance'
        $trayArguments = Get-TokeneloTrayActionArguments -HomeDirectory 'C:\Temp\packaged home'
        Assert-That ($trayArguments -eq ('"' + $fixture.Electron + '" "--tokenelo-packaged-app" "C:\Temp\packaged home"')) 'Packaged tray action lost its user-home boundary'

        $daemonTask.Actions[0].Arguments = '"' + $nodePath + '" "' + $context.DaemonEntry + '"'
        Assert-Refused { Get-OwnedTokeneloTask $TaskName } 'supported daemon action'
        Assert-That ($mutations.Count -eq 0) 'Invalid packaged runtime changed scheduler state'
        Assert-Refused { Resolve-TokeneloPackagedContext -AppRoot $fixture.AppRoot -ElectronPath $fixture.Electron `
            -HelperScriptRoot (Join-Path $fixture.AppRoot 'scripts') -LocalAppData $fixture.LocalAppData -CheckoutNodePath $nodePath } 'bundled Electron runtime'
    } finally {
        $parent = [IO.Path]::GetFullPath($fixture.Parent)
        $tempRoot = [IO.Path]::GetFullPath('C:\Temp').TrimEnd('\') + '\'
        if (-not $parent.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Packaged fixture escaped C:\Temp.' }
        Remove-Item -LiteralPath $parent -Recurse -Force
    }
}
Case 'packaged tray stop ignores an unrelated same-executable GUI process' {
    $fixture = New-PackagedRuntimeFixture
    try {
        $context = Resolve-TokeneloPackagedContext -AppRoot $fixture.AppRoot -ElectronPath $fixture.Electron `
            -HelperScriptRoot (Join-Path $fixture.AppRoot 'scripts') -LocalAppData $fixture.LocalAppData
        $script:RepoRoot = $context.AppRoot
        $script:DaemonEntry = $context.DaemonEntry
        $script:TrayEntry = $context.TrayEntry
        $script:RuntimeMode = $context.RuntimeMode
        $script:BundledElectronPath = $context.ElectronPath
        $script:LauncherRoot = $context.LauncherRoot

        $null = New-FixtureTask -Name $TrayTaskName
        $owned = Get-OwnedTokeneloTask $TrayTaskName
        Assert-That ($null -eq $owned.ChildCommand) 'Packaged tray has a broad executable fallback'
        $launcherCommand = $owned.Execute + ' ' + $owned.Arguments
        $appCommand = '"' + $fixture.Electron + '"'
        $script:processesBefore = @(
            (New-FixtureProcess 201 0 $launcherCommand),
            (New-FixtureProcess 202 201 $appCommand),
            (New-FixtureProcess 900 0 $appCommand 30)
        )
        $script:processesAfter = @((New-FixtureProcess 900 0 $appCommand 30))

        $receipt = Stop-TokeneloTask -Owned $owned
        Assert-That ($receipt.ProcessCleanupVerified) 'Packaged tray stop did not complete its owned cleanup'
        Assert-That ($receipt.TrackedProcesses.Count -eq 2 -and
            @($receipt.TrackedProcesses | Where-Object { $_.ProcessId -in @(201,202) }).Count -eq 2) 'Owned launcher/child closure was not tracked'
        Assert-That (@($receipt.TrackedProcesses | Where-Object { $_.ProcessId -eq 900 }).Count -eq 0) 'Unrelated same-executable GUI process was tracked'
        Assert-That ($processesAfter.Count -eq 1 -and $processesAfter[0].ProcessId -eq 900 -and
            $processesAfter[0].CreationDate -eq $processesBefore[2].CreationDate) 'Unrelated GUI process identity did not survive stop'
        Assert-That (($mutations -join ',') -eq 'disable:TokeneloTray,stop:TokeneloTray') 'Stop mutated an unrelated task or process'
    } finally {
        $parent = [IO.Path]::GetFullPath($fixture.Parent)
        $tempRoot = [IO.Path]::GetFullPath('C:\Temp').TrimEnd('\') + '\'
        if (-not $parent.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Packaged fixture escaped C:\Temp.' }
        Remove-Item -LiteralPath $parent -Recurse -Force
    }
}
Case 'packaged launcher root refuses equality and descendants but allows a sibling' {
    $sibling = New-PackagedRuntimeFixture -Layout sibling
    try {
        $context = Resolve-TokeneloPackagedContext -AppRoot $sibling.AppRoot -ElectronPath $sibling.Electron `
            -HelperScriptRoot (Join-Path $sibling.AppRoot 'scripts') -LocalAppData $sibling.LocalAppData
        Assert-That (-not (Test-TokeneloPathWithin -Path $context.LauncherRoot -Parent $sibling.InstallRoot)) 'Sibling launcher root was classified inside the install root'
    } finally {
        $parent = [IO.Path]::GetFullPath($sibling.Parent)
        $tempRoot = [IO.Path]::GetFullPath('C:\Temp').TrimEnd('\') + '\'
        if (-not $parent.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Packaged fixture escaped C:\Temp.' }
        Remove-Item -LiteralPath $parent -Recurse -Force
    }

    foreach ($layout in @('equal','descendant')) {
        $fixture = New-PackagedRuntimeFixture -Layout $layout
        try {
            $launcherRoot = Join-Path $fixture.LocalAppData 'Tokenelo\launchers'
            Assert-That (Test-TokeneloPathWithin -Path $launcherRoot -Parent $fixture.InstallRoot) `
                ($layout + ' launcher root was not classified inside the install root')
            Assert-Refused { Resolve-TokeneloPackagedContext -AppRoot $fixture.AppRoot -ElectronPath $fixture.Electron `
                -HelperScriptRoot (Join-Path $fixture.AppRoot 'scripts') -LocalAppData $fixture.LocalAppData } 'outside the application directory'
            Assert-That ($mutations.Count -eq 0) ($layout + ' launcher path refusal mutated scheduler state')
        } finally {
            $parent = [IO.Path]::GetFullPath($fixture.Parent)
            $tempRoot = [IO.Path]::GetFullPath('C:\Temp').TrimEnd('\') + '\'
            if (-not $parent.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Packaged fixture escaped C:\Temp.' }
            Remove-Item -LiteralPath $parent -Recurse -Force
        }
    }
}
Case 'first install compiles both roles and registers disabled before enabling either' {
    $fixture=New-PackagedRuntimeFixture
    try {
        Initialize-PackagedTransactionFixture $fixture
        Set-FakeTransactionCompiler
        $transactionDataHome=Join-Path $fixture.Parent 'isolated user data home'
        $result=Invoke-FixtureTransaction -DataHome $transactionDataHome -WithTray
        $compileDaemon=$events.IndexOf('compile:daemon'); $compileTray=$events.IndexOf('compile:tray')
        $registerDaemon=$events.IndexOf('register:TokeneloDaemon:enabled=False')
        $registerTray=$events.IndexOf('register:TokeneloTray:enabled=False')
        $enableDaemon=$events.IndexOf('enable:TokeneloDaemon'); $enableTray=$events.IndexOf('enable:TokeneloTray')
        Assert-That ($compileDaemon -ge 0 -and $compileTray -gt $compileDaemon -and $compileTray -lt $registerDaemon) 'Both launcher roles were not compiled before the first task registration'
        Assert-That ($registerDaemon -ge 0 -and $registerTray -gt $registerDaemon -and $registerTray -lt $enableDaemon) 'Both task registrations were not disabled before enable'
        Assert-That ($enableDaemon -ge 0 -and $enableTray -gt $enableDaemon) 'Task enable order did not follow daemon then tray'
        Assert-That ($tasks.Count -eq 2 -and $tasks.ContainsKey($TaskName) -and $tasks.ContainsKey($TrayTaskName)) 'First install did not create both stable task IDs'
        Assert-That ($tasks[$TaskName].Settings.Enabled -and $tasks[$TrayTaskName].Settings.Enabled) 'First install did not enable both requested tasks'
        Assert-That ((Get-OwnedTokeneloTask $TaskName).HomeDirectory -eq $transactionDataHome -and (Get-OwnedTokeneloTask $TrayTaskName).HomeDirectory -eq $transactionDataHome) 'Configured home was not carried to both task actions'
        Assert-That (@($events | Where-Object { $_ -like 'start:*' }).Count -eq 0) 'Successful first install explicitly started a task'
        $journal=Get-Content -LiteralPath (Join-Path $result.RecoveryRoot 'journal.jsonl') -Raw
        Assert-That ($journal -match '"phase":"committed"') 'Commit phase was not durably journaled'
        Assert-That (-not (Test-Path -LiteralPath (Join-Path $LauncherRoot ('.tokenelo-stage-'+$result.TransactionId)))) 'Committed staging files were retained'
        Assert-That (([IO.File]::ReadAllText((Get-TokeneloLauncherPath -Role 'daemon'))) -eq 'fixture-new-launcher-daemon') 'Daemon launcher was not published'
        Assert-That (([IO.File]::ReadAllText((Get-TokeneloLauncherPath -Role 'tray'))) -eq 'fixture-new-launcher-tray') 'Tray launcher was not published'
    } finally {
        $env:LOCALAPPDATA=$originalLocalAppData
        Assert-FixtureParent $fixture.Parent
    }
}
Case 'second launcher compile failure leaves existing task and launcher state untouched' {
    $fixture=New-PackagedRuntimeFixture
    try {
        Initialize-PackagedTransactionFixture $fixture -WithTasks $true -DaemonEnabled $true -TrayEnabled $false
        $transactionDataHome=Join-Path $fixture.Parent 'isolated user data home'
        Set-FixtureTaskHome $transactionDataHome
        $oldDaemon=[IO.File]::ReadAllText((Get-TokeneloLauncherPath -Role 'daemon'))
        $oldTray=[IO.File]::ReadAllText((Get-TokeneloLauncherPath -Role 'tray'))
        Set-FakeTransactionCompiler; $script:failCompileRole='tray'
        Assert-Refused { Invoke-FixtureTransaction -DataHome $transactionDataHome -WithTray } 'failed before task mutation'
        Assert-That (($compileOrder -join ',') -eq 'daemon,tray') 'Second role was not the injected compile failure'
        Assert-That ($mutations.Count -eq 0 -and @($events | Where-Object { $_ -match '^(stop|disable|register|enable|start):' }).Count -eq 0) 'Compile failure mutated a task'
        Assert-That ($tasks[$TaskName].Settings.Enabled -and -not $tasks[$TrayTaskName].Settings.Enabled) 'Compile failure changed prior enabled states'
        Assert-That ([IO.File]::ReadAllText((Get-TokeneloLauncherPath -Role 'daemon')) -eq $oldDaemon -and
            [IO.File]::ReadAllText((Get-TokeneloLauncherPath -Role 'tray')) -eq $oldTray) 'Compile failure changed a published launcher'
        Assert-That (@(Get-ChildItem (Join-Path $fixture.LocalAppData 'Tokenelo\recovery') -Directory).Count -eq 1) 'Compile failure did not retain its bounded preparation receipt'
        $recovery=Get-ChildItem (Join-Path $fixture.LocalAppData 'Tokenelo\recovery') -Directory|Select-Object -First 1
        $journal=Get-Content (Join-Path $recovery.FullName 'journal.jsonl') -Raw
        Assert-That ($journal -match 'preparation-failed-unchanged') 'Safe pre-mutation failure was not marked terminal for later retry'
    } finally {
        $env:LOCALAPPDATA=$originalLocalAppData
        Assert-FixtureParent $fixture.Parent
    }
}
Case 'first and second launcher publication failures restore mixed-enabled update state' {
    foreach($failRole in @('daemon','tray')){
        Reset-Fixture
        $fixture=New-PackagedRuntimeFixture
        try {
            Initialize-PackagedTransactionFixture $fixture -WithTasks $true -DaemonEnabled $true -TrayEnabled $false
            $transactionDataHome=Join-Path $fixture.Parent 'isolated user data home'
            Set-FixtureTaskHome $transactionDataHome
            $oldDaemon=[IO.File]::ReadAllText((Get-TokeneloLauncherPath -Role 'daemon'))
            $oldTray=[IO.File]::ReadAllText((Get-TokeneloLauncherPath -Role 'tray'))
            $oldDaemonArgs=$tasks[$TaskName].Actions[0].Arguments; $oldTrayArgs=$tasks[$TrayTaskName].Actions[0].Arguments
            Set-FakeTransactionCompiler; Set-FakeTransactionPublisher; $script:failPublishRole=$failRole
            Assert-Refused { Invoke-FixtureTransaction -DataHome $transactionDataHome -WithTray } 'original task definitions, enabled state and launcher bytes were restored'
            Assert-That ([IO.File]::ReadAllText((Get-TokeneloLauncherPath -Role 'daemon')) -eq $oldDaemon -and
                [IO.File]::ReadAllText((Get-TokeneloLauncherPath -Role 'tray')) -eq $oldTray) ($failRole+' publish failure did not restore exact launcher bytes')
            Assert-That ($tasks[$TaskName].Actions[0].Arguments -eq $oldDaemonArgs -and $tasks[$TrayTaskName].Actions[0].Arguments -eq $oldTrayArgs) ($failRole+' publish failure did not restore task actions')
            Assert-That ($tasks[$TaskName].Settings.Enabled -and -not $tasks[$TrayTaskName].Settings.Enabled) ($failRole+' publish failure did not restore mixed enabled states')
            Assert-That (@($events | Where-Object { $_ -like 'register:*' }).Count -eq 0) 'Publication failure reached task registration'
            Assert-That (@($events | Where-Object { $_ -eq 'start:TokeneloDaemon' }).Count -eq 1) 'Rollback did not restart the previously running daemon exactly once'
        } finally {
            $env:LOCALAPPDATA=$originalLocalAppData
            Assert-FixtureParent $fixture.Parent
        }
    }
}
Case 'daemon and tray registration failures restore task XML and launcher bytes' {
    foreach($failName in @($TaskName,$TrayTaskName)){
        Reset-Fixture
        $fixture=New-PackagedRuntimeFixture
        try {
            Initialize-PackagedTransactionFixture $fixture -WithTasks $true -DaemonEnabled $true -TrayEnabled $true
            $transactionDataHome=Join-Path $fixture.Parent 'isolated user data home'
            Set-FixtureTaskHome $transactionDataHome
            $oldDaemon=[IO.File]::ReadAllText((Get-TokeneloLauncherPath -Role 'daemon'))
            $oldTray=[IO.File]::ReadAllText((Get-TokeneloLauncherPath -Role 'tray'))
            $oldDaemonXml=Get-FixtureTaskXml $tasks[$TaskName]; $oldTrayXml=Get-FixtureTaskXml $tasks[$TrayTaskName]
            Set-FakeTransactionCompiler; $script:failRegisterName=$failName
            Assert-Refused { Invoke-FixtureTransaction -DataHome $transactionDataHome -WithTray } 'original task definitions, enabled state and launcher bytes were restored'
            Assert-That ([IO.File]::ReadAllText((Get-TokeneloLauncherPath -Role 'daemon')) -eq $oldDaemon -and
                [IO.File]::ReadAllText((Get-TokeneloLauncherPath -Role 'tray')) -eq $oldTray) ($failName+' register failure did not restore launcher bytes')
            Assert-That ((Get-FixtureTaskXml $tasks[$TaskName]) -eq $oldDaemonXml -and
                (Get-FixtureTaskXml $tasks[$TrayTaskName]) -eq $oldTrayXml) ($failName+' register failure did not restore exact task XML')
            Assert-That ($tasks[$TaskName].Settings.Enabled -and $tasks[$TrayTaskName].Settings.Enabled) ($failName+' register failure did not restore enabled flags')
            Assert-That (($tasks[$TaskName].State -eq 'Running') -and ($tasks[$TrayTaskName].State -eq 'Running')) 'Rollback did not restore prior running tasks'
            Assert-That (@($events | Where-Object { $_ -eq 'start:TokeneloDaemon' }).Count -eq 1 -and
                @($events | Where-Object { $_ -eq 'start:TokeneloTray' }).Count -eq 1) 'Rollback start order/state was not restored'
        } finally {
            $env:LOCALAPPDATA=$originalLocalAppData
            Assert-FixtureParent $fixture.Parent
        }
    }
}
Case 'second enable failure stops both new roles and removes only first-install outputs' {
    $fixture=New-PackagedRuntimeFixture
    try {
        Initialize-PackagedTransactionFixture $fixture
        Set-FakeTransactionCompiler
        $script:failEnableName=$TrayTaskName; $script:failEnableAfterMutation=$true
        Assert-Refused { Invoke-FixtureTransaction -DataHome (Join-Path $fixture.Parent 'isolated user data home') -WithTray } `
            'original task definitions, enabled state and launcher bytes were restored'
        Assert-That ($tasks.Count -eq 0) 'First-install rollback left a transaction-created task registered'
        Assert-That (-not (Test-Path -LiteralPath (Get-TokeneloLauncherPath -Role 'daemon')) -and
            -not (Test-Path -LiteralPath (Get-TokeneloLauncherPath -Role 'tray'))) 'First-install rollback retained a transaction-created launcher'
        Assert-That (@($events | Where-Object { $_ -like 'start:*' }).Count -eq 0) 'First-install rollback started an actor'
        Assert-That (@($events | Where-Object { $_ -like 'unregister:*' }).Count -eq 2) 'First-install rollback did not remove both exact disabled tasks'
    } finally {
        $env:LOCALAPPDATA=$originalLocalAppData
        Assert-FixtureParent $fixture.Parent
    }
}
Case 'rollback enable failure compensates by disabling the restored pair' {
    $fixture=New-PackagedRuntimeFixture
    try {
        Initialize-PackagedTransactionFixture $fixture -WithTasks $true -DaemonEnabled $true -TrayEnabled $true
        $transactionDataHome=Join-Path $fixture.Parent 'isolated user data home'
        Set-FixtureTaskHome $transactionDataHome
        $oldDaemon=[IO.File]::ReadAllText((Get-TokeneloLauncherPath -Role 'daemon'))
        $oldTray=[IO.File]::ReadAllText((Get-TokeneloLauncherPath -Role 'tray'))
        Set-FakeTransactionCompiler; $script:failEnableName=$TrayTaskName; $script:failEnableAfterMutation=$true
        Assert-Refused { Invoke-FixtureTransaction -DataHome $transactionDataHome -WithTray } 'rollback could not be proven'
        Assert-That (-not $tasks[$TaskName].Settings.Enabled -and -not $tasks[$TrayTaskName].Settings.Enabled) 'Failed enabled-state restore left one task enabled'
        Assert-That ($tasks[$TaskName].State -eq 'Disabled' -and $tasks[$TrayTaskName].State -eq 'Disabled') 'Failed enabled-state restore left a task running'
        Assert-That ([IO.File]::ReadAllText((Get-TokeneloLauncherPath -Role 'daemon')) -eq $oldDaemon -and
            [IO.File]::ReadAllText((Get-TokeneloLauncherPath -Role 'tray')) -eq $oldTray) 'Failed enabled-state restore did not retain original launchers'
        Assert-That (@($events|Where-Object{$_ -like 'start:*'}).Count -eq 0) 'Failed enabled-state restore restarted a task'
        $recovery=Get-ChildItem (Join-Path $fixture.LocalAppData 'Tokenelo\recovery') -Directory|Select-Object -First 1
        $journal=Get-Content (Join-Path $recovery.FullName 'journal.jsonl') -Raw
        Assert-That ($journal -match 'manual-recovery-required') 'Failed enabled-state restore did not retain its recovery disposition'
    } finally {
        $env:LOCALAPPDATA=$originalLocalAppData
        Assert-FixtureParent $fixture.Parent
    }
}
Case 'owner and task XML drift after compilation fail before task mutation' {
    foreach($drift in @('principal','xml')){
        Reset-Fixture
        $fixture=New-PackagedRuntimeFixture
        try {
            Initialize-PackagedTransactionFixture $fixture -WithTasks $true -DaemonEnabled $true -TrayEnabled $true
            $transactionDataHome=Join-Path $fixture.Parent 'isolated user data home'
            Set-FixtureTaskHome $transactionDataHome
            $oldDaemon=[IO.File]::ReadAllText((Get-TokeneloLauncherPath -Role 'daemon'))
            $oldTray=[IO.File]::ReadAllText((Get-TokeneloLauncherPath -Role 'tray'))
            Set-FakeTransactionCompiler; $script:mutateTaskOnCompile=$drift
            $pattern=if($drift -eq 'principal'){'another principal'}else{'AtLogOn trigger is not limited to the current user|XML changed during transaction'}
            Assert-Refused { Invoke-FixtureTransaction -DataHome $transactionDataHome -WithTray } $pattern
            Assert-That (@($events | Where-Object { $_ -match '^(disable|stop|publish|register|enable|start):' }).Count -eq 0) ($drift+' drift caused a task/file mutation')
            Assert-That ([IO.File]::ReadAllText((Get-TokeneloLauncherPath -Role 'daemon')) -eq $oldDaemon -and
                [IO.File]::ReadAllText((Get-TokeneloLauncherPath -Role 'tray')) -eq $oldTray) ($drift+' drift changed a launcher')
        } finally {
            $env:LOCALAPPDATA=$originalLocalAppData
            Assert-FixtureParent $fixture.Parent
        }
    }
}
Case 'cleanup timeout keeps tasks disabled with journal and never publishes or restarts' {
    $fixture=New-PackagedRuntimeFixture
    try {
        Initialize-PackagedTransactionFixture $fixture -WithTasks $true -DaemonEnabled $true -TrayEnabled $true
        $transactionDataHome=Join-Path $fixture.Parent 'isolated user data home'
        Set-FixtureTaskHome $transactionDataHome
        $oldDaemon=[IO.File]::ReadAllText((Get-TokeneloLauncherPath -Role 'daemon'))
        $oldTray=[IO.File]::ReadAllText((Get-TokeneloLauncherPath -Role 'tray'))
        Set-FakeTransactionCompiler; Set-FakeTransactionStop; $script:failStopName=$TaskName
        Assert-Refused { Invoke-FixtureTransaction -DataHome $transactionDataHome -WithTray } 'Install transaction stopped without proving cleanup'
        Assert-That ($observedCleanupSeconds.Count -eq 2 -and @($observedCleanupSeconds|Where-Object{$_ -ne 25}).Count -eq 0) 'Transaction did not retain the 25-second cleanup bound'
        Assert-That (-not $tasks[$TaskName].Settings.Enabled -and -not $tasks[$TrayTaskName].Settings.Enabled) 'Cleanup uncertainty re-enabled a task'
        Assert-That ([IO.File]::ReadAllText((Get-TokeneloLauncherPath -Role 'daemon')) -eq $oldDaemon -and
            [IO.File]::ReadAllText((Get-TokeneloLauncherPath -Role 'tray')) -eq $oldTray) 'Cleanup uncertainty published a launcher'
        Assert-That (@($events | Where-Object { $_ -like 'publish:*' -or $_ -like 'register:*' -or $_ -like 'enable:*' -or $_ -like 'start:*' }).Count -eq 0) 'Cleanup uncertainty performed a later transaction step'
        $recovery=Get-ChildItem (Join-Path $fixture.LocalAppData 'Tokenelo\recovery') -Directory|Select-Object -First 1
        $journal=Get-Content (Join-Path $recovery.FullName 'journal.jsonl') -Raw
        Assert-That ($journal -match 'manual-recovery-required') 'Cleanup uncertainty did not retain recovery disposition'
    } finally {
        $env:LOCALAPPDATA=$originalLocalAppData
        Assert-FixtureParent $fixture.Parent
    }
}
Case 'transaction cleanup ignores a foreign process after owned PID reuse and preserves mixed enabled state' {
    $fixture=New-PackagedRuntimeFixture
    try {
        Initialize-PackagedTransactionFixture $fixture -WithTasks $true -DaemonEnabled $true -TrayEnabled $false
        $transactionDataHome=Join-Path $fixture.Parent 'isolated user data home'
        Set-FixtureTaskHome $transactionDataHome
        $homeData=Join-Path $fixture.Parent 'owned home'; New-Item -ItemType Directory -Path $homeData -Force|Out-Null
        $sentinels=@('config.json','token','ledger.sqlite','cursors.json','rowids.json')
        foreach($name in $sentinels){[IO.File]::WriteAllText((Join-Path $homeData $name),('synthetic-'+$name),[Text.UTF8Encoding]::new($false))}
        $sentinelHashes=@{}; foreach($name in $sentinels){$sentinelHashes[$name]=Get-TokeneloSha256 ([IO.File]::ReadAllBytes((Join-Path $homeData $name)))}
        $daemonOwned=Get-OwnedTokeneloTask $TaskName
        $launcherCommand=$daemonOwned.Execute+' '+$daemonOwned.Arguments
        $childCommand=$daemonOwned.ChildCommand
        $script:transactionProcessSnapshots[$TrayTaskName]=@{Before=@();After=@()}
        $script:transactionProcessSnapshots[$TaskName]=@{
            Before=@((New-FixtureProcess 501 0 $launcherCommand),(New-FixtureProcess 502 501 $childCommand))
            After=@((New-FixtureProcess 502 0 'foreign process after PID reuse' 30))
        }
        Set-FakeTransactionCompiler; Set-FakeTransactionStop
        $null=Invoke-FixtureTransaction -DataHome $transactionDataHome -WithTray
        $daemonReceipt=@($transactionStopReceipts|Where-Object{$_.Owned.Name -eq $TaskName})[0]
        Assert-That ($daemonReceipt.TrackedProcesses.Count -eq 2 -and @($daemonReceipt.TrackedProcesses|Where-Object{$_.ProcessId -eq 502}).Count -eq 1) 'Owned process closure was not captured'
        Assert-That (@($daemonReceipt.TrackedProcesses|Where-Object{$_.ProcessId -eq 502 -and $_.CreationDate -eq $processesAfter[0].CreationDate}).Count -eq 0) 'Reused foreign PID was treated as the owned process'
        Assert-That ($tasks[$TaskName].Settings.Enabled -and -not $tasks[$TrayTaskName].Settings.Enabled) 'Successful update did not preserve mixed enabled states'
        Assert-That (@($events|Where-Object{$_ -like 'start:*'}).Count -eq 0) 'Successful update explicitly restarted an actor'
        foreach($name in $sentinels){$after=Get-TokeneloSha256 ([IO.File]::ReadAllBytes((Join-Path $homeData $name)));Assert-That ($after -eq $sentinelHashes[$name]) ('Owned data changed: '+$name)}
        Assert-That ((Get-OwnedTokeneloTask $TaskName).HomeDirectory -eq $transactionDataHome -and (Get-OwnedTokeneloTask $TrayTaskName).HomeDirectory -eq $transactionDataHome) 'Update lost the configured data home'
    } finally {
        $env:LOCALAPPDATA=$originalLocalAppData
        Assert-FixtureParent $fixture.Parent
    }
}
Case 'transaction stop refuses XML drift between outer validation and first stop read' {
    $fixture=New-PackagedRuntimeFixture
    try {
        Initialize-PackagedTransactionFixture $fixture -WithTasks $true -DaemonEnabled $true -TrayEnabled $true
        $transactionDataHome=Join-Path $fixture.Parent 'isolated user data home'
        Set-FixtureTaskHome $transactionDataHome
        $oldDaemon=[IO.File]::ReadAllText((Get-TokeneloLauncherPath -Role 'daemon'))
        $oldTray=[IO.File]::ReadAllText((Get-TokeneloLauncherPath -Role 'tray'))
        Set-FakeTransactionCompiler; $script:mutateTaskBeforeStop='xml'; Set-FakeDriftBeforeStop
        Assert-Refused { Invoke-FixtureTransaction -DataHome $transactionDataHome -WithTray } 'XML changed between transaction validation and stop'
        Assert-That ($didMutateBeforeStop) 'The stop seam did not inject the task XML change'
        Assert-That (@($events|Where-Object{$_ -match '^(disable|stop|publish|register|enable|start):'}).Count -eq 0) 'XML drift was changed after a task/file mutation'
        Assert-That ($tasks[$TaskName].Settings.Enabled -and $tasks[$TrayTaskName].Settings.Enabled) 'Refused first stop changed enabled state'
        Assert-That ([IO.File]::ReadAllText((Get-TokeneloLauncherPath -Role 'daemon')) -eq $oldDaemon -and
            [IO.File]::ReadAllText((Get-TokeneloLauncherPath -Role 'tray')) -eq $oldTray) 'Refused first stop changed launcher bytes'
        $recovery=Get-ChildItem (Join-Path $fixture.LocalAppData 'Tokenelo\recovery') -Directory|Select-Object -First 1
        Assert-That ((Get-Content (Join-Path $recovery.FullName 'journal.jsonl') -Raw) -match 'manual-recovery-required') 'Stop refusal did not retain its recovery receipt'
    } finally {
        $env:LOCALAPPDATA=$originalLocalAppData
        Assert-FixtureParent $fixture.Parent
    }
}
Case 'publisher refuses an external launcher replacement without overwriting it' {
    $fixture=New-PackagedRuntimeFixture
    try {
        Initialize-PackagedTransactionFixture $fixture -WithTasks $true -DaemonEnabled $true -TrayEnabled $true
        $transactionDataHome=Join-Path $fixture.Parent 'isolated user data home'
        Set-FixtureTaskHome $transactionDataHome
        $oldTray=[IO.File]::ReadAllText((Get-TokeneloLauncherPath -Role 'tray'))
        Set-FakeTransactionCompiler; Set-FakeTransactionPublisher; $script:mutateLauncherOnPublishRole='daemon'
        Assert-Refused { Invoke-FixtureTransaction -DataHome $transactionDataHome -WithTray } 'changed after snapshot; publish refused'
        Assert-That ([IO.File]::ReadAllText((Get-TokeneloLauncherPath -Role 'daemon')) -eq 'fixture-external-launcher-change') 'Publisher overwrote an external launcher replacement'
        Assert-That ([IO.File]::ReadAllText((Get-TokeneloLauncherPath -Role 'tray')) -eq $oldTray) 'Refused publish touched the other launcher'
        Assert-That (@($events|Where-Object{$_ -match '^(register|enable|start):'}).Count -eq 0) 'Uncertain launcher ownership reached task registration or activation'
        $recovery=Get-ChildItem (Join-Path $fixture.LocalAppData 'Tokenelo\recovery') -Directory|Select-Object -First 1
        Assert-That ((Get-Content (Join-Path $recovery.FullName 'journal.jsonl') -Raw) -match 'manual-recovery-required') 'Launcher mismatch did not retain manual recovery evidence'
    } finally {
        $env:LOCALAPPDATA=$originalLocalAppData
        Assert-FixtureParent $fixture.Parent
    }
}
Case 'staging cleanup retains unexpected content and blocks another transaction' {
    $fixture=New-PackagedRuntimeFixture
    try {
        Initialize-PackagedTransactionFixture $fixture
        Set-FakeTransactionCompiler; $script:failCompileRole='tray'; $script:unknownStagingOnCompile=$true
        Assert-Refused { Invoke-FixtureTransaction -DataHome (Join-Path $fixture.Parent 'isolated user data home') -WithTray } 'preparation failed before task mutation'
        $stage=Get-ChildItem -LiteralPath $LauncherRoot -Directory -Filter '.tokenelo-stage-*'|Select-Object -First 1
        Assert-That ($stage) 'Unrecognized staging content was recursively deleted'
        Assert-That ((Test-Path -LiteralPath (Join-Path $stage.FullName 'unexpected.txt')) -and
            (Test-Path -LiteralPath (Join-Path $stage.FullName 'daemon.launcher.candidate.exe'))) 'Unexpected or transaction candidate evidence was lost'
        $recovery=Get-ChildItem (Join-Path $fixture.LocalAppData 'Tokenelo\recovery') -Directory|Select-Object -First 1
        $journal=Get-Content (Join-Path $recovery.FullName 'journal.jsonl') -Raw
        Assert-That ($journal -match 'manual-recovery-required' -and $journal -notmatch 'preparation-failed-unchanged') 'Uncertain staging cleanup was marked safe to retry'
        Assert-That (@($mutations|Where-Object{$_ -match '^(disable|stop|register|enable|start|publish):'}).Count -eq 0) 'Preparation cleanup mutated a task'
        Assert-Refused { Invoke-FixtureTransaction -DataHome (Join-Path $fixture.Parent 'isolated user data home') -WithTray } 'earlier Tokenelo install transaction is incomplete'
        Assert-That ($compileOrder.Count -eq 2) 'Incomplete-journal guard started another compilation'
    } finally {
        $env:LOCALAPPDATA=$originalLocalAppData
        Assert-FixtureParent $fixture.Parent
    }
}
Case 'rollback refuses owner, task XML, URI and security descriptor drift before restore' {
    foreach($drift in @('xml','principal','registration-uri','registration-security')){
        Reset-Fixture
        $fixture=New-PackagedRuntimeFixture
        try {
            Initialize-PackagedTransactionFixture $fixture -WithTasks $true -DaemonEnabled $true -TrayEnabled $true
            $transactionDataHome=Join-Path $fixture.Parent 'isolated user data home'
            Set-FixtureTaskHome $transactionDataHome
            $oldDaemon=[IO.File]::ReadAllText((Get-TokeneloLauncherPath -Role 'daemon'))
            $oldTray=[IO.File]::ReadAllText((Get-TokeneloLauncherPath -Role 'tray'))
            Set-FakeTransactionCompiler; Set-FakeTransactionPublisher; $script:mutateTaskOnPublish=$drift
            Assert-Refused { Invoke-FixtureTransaction -DataHome $transactionDataHome -WithTray } 'rollback could not be proven'
            Assert-That (@($events|Where-Object{$_ -match '^(restore-xml|unregister|enable|start):'}).Count -eq 0) ($drift+' drift was overwritten or activated during rollback')
            Assert-That (-not $tasks[$TaskName].Settings.Enabled -and -not $tasks[$TrayTaskName].Settings.Enabled) ($drift+' drift caused a task re-enable')
            Assert-That ([IO.File]::ReadAllText((Get-TokeneloLauncherPath -Role 'daemon')) -eq $oldDaemon -and
                [IO.File]::ReadAllText((Get-TokeneloLauncherPath -Role 'tray')) -eq $oldTray) ($drift+' drift changed launcher bytes')
            $recovery=Get-ChildItem (Join-Path $fixture.LocalAppData 'Tokenelo\recovery') -Directory|Select-Object -First 1
            Assert-That ((Get-Content (Join-Path $recovery.FullName 'journal.jsonl') -Raw) -match 'manual-recovery-required') ($drift+' drift lacked a manual recovery journal')
        } finally {
            $env:LOCALAPPDATA=$originalLocalAppData
            Assert-FixtureParent $fixture.Parent
        }
    }
}
Case 'registration that throws after applying changes fails closed with exact recovery backups' {
    foreach($failName in @($TaskName,$TrayTaskName)){
        Reset-Fixture
        $fixture=New-PackagedRuntimeFixture
        try {
            Initialize-PackagedTransactionFixture $fixture -WithTasks $true -DaemonEnabled $true -TrayEnabled $true
            $transactionDataHome=Join-Path $fixture.Parent 'isolated user data home'
            Set-FixtureTaskHome $transactionDataHome
            Set-FakeTransactionCompiler; $script:failRegisterName=$failName; $script:failRegisterAfterMutation=$true
            Assert-Refused { Invoke-FixtureTransaction -DataHome $transactionDataHome -WithTray } 'rollback could not be proven'
            Assert-That (-not $tasks[$TaskName].Settings.Enabled -and -not $tasks[$TrayTaskName].Settings.Enabled) ($failName+' after-mutation registration left a task enabled')
            Assert-That (@($events|Where-Object{$_ -match '^(restore-xml|unregister|enable|start):'}).Count -eq 0) ($failName+' after-mutation failure tried an unproven restore')
            $recovery=Get-ChildItem (Join-Path $fixture.LocalAppData 'Tokenelo\recovery') -Directory|Select-Object -First 1
            foreach($role in @('daemon','tray')){
                $backup=Join-Path $recovery.FullName ($role+'.launcher.original.exe')
                Assert-That ((Test-Path -LiteralPath $backup) -and [IO.File]::ReadAllText($backup) -eq ('fixture-old-launcher-'+$role)) ($role+' original launcher recovery bytes were not retained')
            }
            Assert-That ((Get-Content (Join-Path $recovery.FullName 'journal.jsonl') -Raw) -match 'manual-recovery-required') ($failName+' after-mutation failure lacked a recovery disposition')
        } finally {
            $env:LOCALAPPDATA=$originalLocalAppData
            Assert-FixtureParent $fixture.Parent
        }
    }
}
Case 'rollback XML drift after first restored enable compensates other owned roles' {
    $fixture=New-PackagedRuntimeFixture
    try {
        Initialize-PackagedTransactionFixture $fixture -WithTasks $true -DaemonEnabled $true -TrayEnabled $true
        $transactionDataHome=Join-Path $fixture.Parent 'isolated user data home'
        Set-FixtureTaskHome $transactionDataHome
        Set-FakeTransactionCompiler; $script:failRegisterName=$TaskName; $script:mutateTaskOnEnable='xml'
        Assert-Refused { Invoke-FixtureTransaction -DataHome $transactionDataHome -WithTray } 'no task was re-enabled or restarted after uncertainty'
        Assert-That (-not $tasks[$TaskName].Settings.Enabled -and -not $tasks[$TrayTaskName].Settings.Enabled) 'Post-enable XML drift left an owned task enabled'
        Assert-That (@($events|Where-Object{$_ -eq ('stop:'+ $TaskName)}).Count -ge 2) 'Compensation did not stop the still-proven daemon after tray XML drift'
        Assert-That (@($events|Where-Object{$_ -like 'start:*'}).Count -eq 0) 'Post-enable uncertainty started another task'
        $recovery=Get-ChildItem (Join-Path $fixture.LocalAppData 'Tokenelo\recovery') -Directory|Select-Object -First 1
        Assert-That ((Get-Content (Join-Path $recovery.FullName 'journal.jsonl') -Raw) -match 'restore-enable-compensation-incomplete') 'Partial compensation failures were not retained in the journal'
    } finally {
        $env:LOCALAPPDATA=$originalLocalAppData
        Assert-FixtureParent $fixture.Parent
    }
}
Case 'rollback start failure after process launch stops both restored roles' {
    $fixture=New-PackagedRuntimeFixture
    try {
        Initialize-PackagedTransactionFixture $fixture -WithTasks $true -DaemonEnabled $true -TrayEnabled $true
        $transactionDataHome=Join-Path $fixture.Parent 'isolated user data home'
        Set-FixtureTaskHome $transactionDataHome
        Set-FakeTransactionCompiler; $script:failRegisterName=$TaskName
        $script:failStartName=$TaskName; $script:failStartAfterMutation=$true
        Assert-Refused { Invoke-FixtureTransaction -DataHome $transactionDataHome -WithTray } 'no task was re-enabled or restarted after uncertainty'
        Assert-That (-not $tasks[$TaskName].Settings.Enabled -and -not $tasks[$TrayTaskName].Settings.Enabled -and
            $tasks[$TaskName].State -eq 'Disabled' -and $tasks[$TrayTaskName].State -eq 'Disabled') 'Start failure left a restored task enabled or running'
        Assert-That (@($events|Where-Object{$_ -like 'start:*'}).Count -eq 1) 'A later task started after the first restored start failed'
        Assert-That (@($events|Where-Object{$_ -eq ('stop:'+ $TaskName)}).Count -ge 2 -and
            @($events|Where-Object{$_ -eq ('stop:'+ $TrayTaskName)}).Count -ge 2) 'Compensation did not attempt cleanup for both restored roles'
    } finally {
        $env:LOCALAPPDATA=$originalLocalAppData
        Assert-FixtureParent $fixture.Parent
    }
}
Case 'nonterminal recovery journal blocks another transaction before compilation' {
    $fixture=New-PackagedRuntimeFixture
    try {
        Initialize-PackagedTransactionFixture $fixture
        $recoveryBase=Join-Path $fixture.LocalAppData 'Tokenelo\recovery'
        $id=[Guid]::NewGuid().ToString('N'); $recovery=Join-Path $recoveryBase $id
        New-Item -ItemType Directory -Path $recovery -Force|Out-Null
        $record=[ordered]@{recordedAt=[datetime]::UtcNow.ToString('o');transactionId=$id;phase='snapshot-saved';role='daemon';detail='fixture'}
        [IO.File]::WriteAllText((Join-Path $recovery 'journal.jsonl'),(($record|ConvertTo-Json -Compress)+"`n"),[Text.UTF8Encoding]::new($false))
        Set-FakeTransactionCompiler
        Assert-Refused { Invoke-FixtureTransaction -DataHome (Join-Path $fixture.Parent 'isolated user data home') -WithTray } 'earlier Tokenelo install transaction is incomplete'
        Assert-That ($compileOrder.Count -eq 0 -and $tasks.Count -eq 0 -and $mutations.Count -eq 0) 'Incomplete recovery guard began build or task mutation'
        Assert-That (@(Get-ChildItem -LiteralPath $recoveryBase -Directory).Count -eq 1) 'Blocked invocation created a new recovery transaction'
    } finally {
        $env:LOCALAPPDATA=$originalLocalAppData
        Assert-FixtureParent $fixture.Parent
    }
}
Case 'supported task registration accepts absent or exact taskpath URI' {
    $fixture=New-PackagedRuntimeFixture
    try {
        Initialize-PackagedTransactionFixture $fixture -WithTasks $true -DaemonEnabled $true -TrayEnabled $true
        $tasks[$TaskName].RegistrationInfo.URI=$null
        $withoutUri=Get-OwnedTokeneloTask -Name $TaskName
        Assert-That ($withoutUri.Name -eq $TaskName) 'Supported task without URI was not recognized'
        $tasks[$TaskName].RegistrationInfo.URI='\TokeneloDaemon'
        $withUri=Get-OwnedTokeneloTask -Name $TaskName
        Assert-That ($withUri.Name -eq $TaskName) 'Supported exact taskpath URI was not recognized'
        Assert-That ($mutations.Count -eq 0) 'Metadata recognition changed a task'
    } finally {
        $env:LOCALAPPDATA=$originalLocalAppData
        Assert-FixtureParent $fixture.Parent
    }
}
Case 'preflight refuses unsupported task metadata triggers and settings without mutation' {
    foreach($variant in @('uri','security','description','extra-trigger','disabled-trigger','priority','custom-setting')){
        Reset-Fixture
        $fixture=New-PackagedRuntimeFixture
        try {
            Initialize-PackagedTransactionFixture $fixture -WithTasks $true -DaemonEnabled $true -TrayEnabled $true
            $transactionDataHome=Join-Path $fixture.Parent 'isolated user data home'
            Set-FixtureTaskHome $transactionDataHome
            switch($variant){
                'uri' {$tasks[$TaskName].RegistrationInfo.URI='\ForeignTask'}
                'security' {$tasks[$TaskName].RegistrationInfo.SecurityDescriptor='D:(A;;FA;;;WD)'}
                'description' {$tasks[$TaskName].RegistrationInfo.Description='custom task metadata'}
                'extra-trigger' {$tasks[$TaskName].Triggers+=,[pscustomobject]@{AtLogOn=$false;TriggerType='BootTrigger';Enabled=$true;User=$null}}
                'disabled-trigger' {$tasks[$TaskName].Triggers[0].Enabled=$false}
                'priority' {$tasks[$TaskName].Settings.Priority=7}
                'custom-setting' {$tasks[$TaskName].Settings.StartWhenAvailable=$true}
            }
            $expectedDaemonXml=Get-FixtureTaskXml $tasks[$TaskName]
            $expectedTrayXml=Get-FixtureTaskXml $tasks[$TrayTaskName]
            $oldDaemon=[IO.File]::ReadAllText((Get-TokeneloLauncherPath -Role 'daemon'))
            $oldTray=[IO.File]::ReadAllText((Get-TokeneloLauncherPath -Role 'tray'))
            Set-FakeTransactionCompiler
            Assert-Refused { Invoke-FixtureTransaction -DataHome $transactionDataHome -WithTray } `
                'unsupported|current user|interactive limited|RegistrationInfo|trigger|settings|security descriptor'
            Assert-That ($compileOrder.Count -eq 0 -and $mutations.Count -eq 0) ($variant+' definition reached build or task mutation')
            Assert-That ((Get-FixtureTaskXml $tasks[$TaskName]) -eq $expectedDaemonXml -and
                (Get-FixtureTaskXml $tasks[$TrayTaskName]) -eq $expectedTrayXml) ($variant+' definition was changed during refusal')
            Assert-That ([IO.File]::ReadAllText((Get-TokeneloLauncherPath -Role 'daemon')) -eq $oldDaemon -and
                [IO.File]::ReadAllText((Get-TokeneloLauncherPath -Role 'tray')) -eq $oldTray) ($variant+' refusal changed a launcher')
        } finally {
            $env:LOCALAPPDATA=$originalLocalAppData
            Assert-FixtureParent $fixture.Parent
        }
    }
}
Case 'LOCALAPPDATA junction ancestor into app is refused before any app-relative write' {
    $fixture=New-PackagedRuntimeFixture
    $junction=$null
    try {
        $null=Use-PackagedRuntimeFixture $fixture
        $target=Join-Path $fixture.AppRoot 'redirect-target'
        New-Item -ItemType Directory -Path $target -Force|Out-Null
        $junction=Join-Path $fixture.Parent 'RedirectedLocalAppData'
        New-Item -ItemType Junction -Path $junction -Target $target|Out-Null
        $env:LOCALAPPDATA=$junction
        $script:LauncherRoot=Join-Path $junction 'Tokenelo\launchers'
        $script:tasks=@{}
        $script:registerTaskObjects=$true
        Set-FakeTransactionCompiler
        $lexicalRecovery=Join-Path $junction 'Tokenelo\recovery\candidate'
        Assert-That (-not (Test-TokeneloPathWithin -Path $lexicalRecovery -Parent $fixture.InstallRoot)) 'Fixture did not demonstrate the lexical containment gap'
        Assert-Refused { Invoke-FixtureTransaction -DataHome (Join-Path $fixture.Parent 'isolated user data home') -WithTray } 'reparse point'
        Assert-That ($compileOrder.Count -eq 0 -and $mutations.Count -eq 0) 'Junction refusal reached build or task mutation'
        Assert-That (-not (Test-Path -LiteralPath (Join-Path $target 'Tokenelo'))) 'Refused transaction wrote through the junction into the app'
    } finally {
        if($junction -and (Test-Path -LiteralPath $junction)){Remove-Item -LiteralPath $junction -Force}
        $env:LOCALAPPDATA=$originalLocalAppData
        Assert-FixtureParent $fixture.Parent
    }
}
Case 'rollback refuses to replace a launcher changed after publication' {
    $fixture=New-PackagedRuntimeFixture
    try {
        Initialize-PackagedTransactionFixture $fixture -WithTasks $true -DaemonEnabled $true -TrayEnabled $true
        $transactionDataHome=Join-Path $fixture.Parent 'isolated user data home'
        Set-FixtureTaskHome $transactionDataHome
        Set-FakeTransactionCompiler
        $script:failRegisterName=$TrayTaskName
        $script:mutateLauncherBeforeRegisterFailureRole='daemon'
        Assert-Refused { Invoke-FixtureTransaction -DataHome $transactionDataHome -WithTray } 'rollback could not be proven'
        Assert-That ([IO.File]::ReadAllText((Get-TokeneloLauncherPath -Role 'daemon')) -eq 'fixture-external-launcher-change') 'Rollback overwrote the externally changed launcher'
        Assert-That (-not $tasks[$TaskName].Settings.Enabled -and -not $tasks[$TrayTaskName].Settings.Enabled) 'Unknown launcher change re-enabled a task'
        Assert-That (@($events|Where-Object{$_ -match '^(restore-xml|unregister|enable|start):'}).Count -eq 0) 'Unknown launcher change reached task restoration or activation'
        $recovery=Get-ChildItem (Join-Path $fixture.LocalAppData 'Tokenelo\recovery') -Directory|Select-Object -First 1
        $backup=Join-Path $recovery.FullName 'daemon.launcher.original.exe'
        Assert-That ([IO.File]::ReadAllText($backup) -eq 'fixture-old-launcher-daemon') 'Recovery did not retain the original launcher bytes'
        Assert-That ((Get-Content (Join-Path $recovery.FullName 'journal.jsonl') -Raw) -match 'manual-recovery-required') 'Unknown launcher change lacked manual recovery disposition'
    } finally {
        $env:LOCALAPPDATA=$originalLocalAppData
        Assert-FixtureParent $fixture.Parent
    }
}
Case 'rollback rechecks a launcher hash immediately before replacement' {
    $fixture=New-PackagedRuntimeFixture
    try {
        Initialize-PackagedTransactionFixture $fixture -WithTasks $true -DaemonEnabled $true -TrayEnabled $true
        $transactionDataHome=Join-Path $fixture.Parent 'isolated user data home'
        Set-FixtureTaskHome $transactionDataHome
        Set-FakeTransactionCompiler
        $script:failRegisterName=$TrayTaskName
        $script:mutateLauncherDuringRestoreCheck=$true
        Set-FakeLauncherRaceDuringRestoreCheck
        Assert-Refused { Invoke-FixtureTransaction -DataHome $transactionDataHome -WithTray } 'changed immediately before restore'
        Assert-That ($restoreTargetCheckCount -eq 2) 'The immediate pre-replacement restore seam did not run'
        Assert-That ([IO.File]::ReadAllText((Get-TokeneloLauncherPath -Role 'daemon')) -eq 'fixture-immediate-restore-race') 'Immediate hash recheck failed to preserve the changed target'
        Assert-That (-not $tasks[$TaskName].Settings.Enabled -and -not $tasks[$TrayTaskName].Settings.Enabled) 'Immediate restore race re-enabled a task'
        Assert-That (@($events|Where-Object{$_ -match '^(restore-xml|unregister|enable|start):'}).Count -eq 0) 'Immediate restore race reached task restoration or activation'
    } finally {
        $env:LOCALAPPDATA=$originalLocalAppData
        Assert-FixtureParent $fixture.Parent
    }
}
Case 'uninstall commits owned task and launcher removal while retaining user data and recovery snapshots' {
    $fixture=New-PackagedRuntimeFixture
    try {
        Initialize-PackagedTransactionFixture $fixture -WithTasks $true -DaemonEnabled $true -TrayEnabled $false
        $dataHome=Join-Path $fixture.Parent 'isolated user data home'
        New-Item -ItemType Directory -Path $dataHome -Force|Out-Null
        $sentinel=Join-Path $dataHome 'user-data-sentinel.txt'
        [IO.File]::WriteAllText($sentinel,'keep user data',[Text.UTF8Encoding]::new($false))
        Set-FixtureTaskHome $dataHome
        $originalXml=@{daemon=(Get-TokeneloTaskXml $TaskName);tray=(Get-TokeneloTaskXml $TrayTaskName)}
        $originalLauncher=@{daemon=[IO.File]::ReadAllText((Get-TokeneloLauncherPath daemon));tray=[IO.File]::ReadAllText((Get-TokeneloLauncherPath tray))}
        $result=Invoke-FixtureUninstall
        Assert-That ($result.Changed -and $tasks.Count -eq 0) 'Owned task registrations remain after uninstall'
        Assert-That (-not (Test-Path -LiteralPath (Get-TokeneloLauncherPath daemon)) -and -not (Test-Path -LiteralPath (Get-TokeneloLauncherPath tray))) 'Owned launcher files remain after uninstall'
        Assert-That ([IO.File]::ReadAllText($sentinel) -eq 'keep user data') 'Uninstall changed user data'
        foreach($role in @('daemon','tray')){
            $xmlBackup=Join-Path $result.RecoveryRoot ($role+'.task.xml')
            $launcherBackup=Join-Path $result.RecoveryRoot ($role+'.launcher.original.exe')
            Assert-That ([IO.File]::ReadAllText($xmlBackup) -ceq $originalXml[$role]) ($role+' task XML recovery copy changed')
            Assert-That ([IO.File]::ReadAllText($launcherBackup) -ceq $originalLauncher[$role]) ($role+' launcher recovery copy changed')
        }
        $journal=Get-Content -LiteralPath (Join-Path $result.RecoveryRoot 'journal.jsonl') -Raw
        Assert-That ($journal -match '"phase":"committed"' -and $journal -notmatch 'manual-recovery-required') 'Successful uninstall did not end in a committed retained journal'
        Assert-That (($mutations -join ',') -match '^disable:TokeneloTray,stop:TokeneloTray,disable:TokeneloDaemon,stop:TokeneloDaemon,remove:TokeneloTray,remove:TokeneloDaemon$') 'Uninstall task order was not stop both roles then unregister tray and daemon'
    } finally { $env:LOCALAPPDATA=$originalLocalAppData; Assert-FixtureParent $fixture.Parent }
}
function Fake-AssertCoordinatorLeaseAlive {
    param($Lease)
    if ($Lease -and $Lease.Coordinator -and $script:coordinatorExitAfterTrayStop -and
        $script:events -contains 'stop:TokeneloTray' -and $script:events -notcontains 'disable:TokeneloDaemon') {
        $script:coordinatorExitAfterTrayStop=$false
        throw 'Simulated coordinator parent exit after tray cleanup.'
    }
}
Case 'coordinator parent exit fails before the next task mutation' {
    $fixture=New-PackagedRuntimeFixture
    try {
        Initialize-PackagedTransactionFixture $fixture -WithTasks $true -DaemonEnabled $true -TrayEnabled $true
        Set-FixtureTaskHome (Join-Path $fixture.Parent 'isolated user data home')
        $lease=[pscustomobject]@{Name=(Get-TokeneloLifecycleMutexName);Owned=$true;Abandoned=$false;Coordinator=$true}
        $script:coordinatorExitAfterTrayStop=$true
        Set-Item -Path Function:\Assert-TokeneloCoordinatorLifecycleLeaseAlive -Value (Get-Command Fake-AssertCoordinatorLeaseAlive).ScriptBlock
        Assert-Refused { Invoke-FixtureUninstall -LifecycleLease $lease } 'without verifying cleanup of every role'
        Assert-That (($mutations -join ',') -ceq 'disable:TokeneloTray,stop:TokeneloTray') 'Helper mutated a task after the coordinator parent exited'
        Assert-That ($tasks.Count -eq 2 -and -not $tasks[$TrayTaskName].Settings.Enabled -and $tasks[$TaskName].Settings.Enabled) 'Parent exit changed the next role or re-enabled a role'
        Assert-That (@($events|Where-Object{$_ -like 'unregister:*' -or $_ -like 'remove:*'}).Count -eq 0) 'Parent exit continued into unregister or launcher removal'
        Assert-That ((Test-Path -LiteralPath (Get-TokeneloLauncherPath daemon)) -and (Test-Path -LiteralPath (Get-TokeneloLauncherPath tray))) 'Parent exit removed a launcher after cleanup stopped'
    } finally {
        Set-Item -Path Function:\Assert-TokeneloCoordinatorLifecycleLeaseAlive -Value $script:realCoordinatorLifecycleValidator
        $env:LOCALAPPDATA=$originalLocalAppData
        Assert-FixtureParent $fixture.Parent
    }
}
Case 'second task unregister failure restores exact original enabled and launcher state' {
    $fixture=New-PackagedRuntimeFixture
    try {
        Initialize-PackagedTransactionFixture $fixture -WithTasks $true -DaemonEnabled $true -TrayEnabled $false
        $dataHome=Join-Path $fixture.Parent 'isolated user data home'; Set-FixtureTaskHome $dataHome
        $original=@{daemon=[IO.File]::ReadAllText((Get-TokeneloLauncherPath daemon));tray=[IO.File]::ReadAllText((Get-TokeneloLauncherPath tray))}
        $script:failUnregisterName=$TaskName; $script:failUnregisterAfterMutation=$true
        Assert-Refused { Invoke-FixtureUninstall } 'original task definitions, enabled/running state and launcher bytes were restored'
        Assert-That ($tasks.Count -eq 2 -and $tasks[$TaskName].Settings.Enabled -and -not $tasks[$TrayTaskName].Settings.Enabled) 'Rollback did not preserve mixed original enabled states'
        Assert-That ($tasks[$TaskName].State -eq 'Running' -and $tasks[$TrayTaskName].State -eq 'Disabled') 'Rollback did not preserve original running state'
        foreach($role in @('daemon','tray')){Assert-That ([IO.File]::ReadAllText((Get-TokeneloLauncherPath $role)) -ceq $original[$role]) ($role+' launcher bytes were not restored')}
        Assert-That (($events -join ',') -match 'restore-xml:TokeneloTray' -and $events -contains 'enable:TokeneloDaemon') 'Rollback did not restore the removed role and prior enabled role'
        $recovery=Get-ChildItem -LiteralPath (Join-Path $fixture.LocalAppData 'Tokenelo\recovery') -Directory|Select-Object -First 1
        Assert-That ((Get-Content -LiteralPath (Join-Path $recovery.FullName 'journal.jsonl') -Raw) -match '"phase":"rollback-complete"') 'Completed rollback was not journaled'
    } finally { $env:LOCALAPPDATA=$originalLocalAppData; Assert-FixtureParent $fixture.Parent }
}
Case 'second launcher deletion failure after mutation restores both roles' {
    $fixture=New-PackagedRuntimeFixture
    try {
        Initialize-PackagedTransactionFixture $fixture -WithTasks $true -DaemonEnabled $true -TrayEnabled $true
        Set-FixtureTaskHome (Join-Path $fixture.Parent 'isolated user data home')
        $original=@{daemon=[IO.File]::ReadAllText((Get-TokeneloLauncherPath daemon));tray=[IO.File]::ReadAllText((Get-TokeneloLauncherPath tray))}
        Set-FakeUninstallLauncherRemoval
        $script:failLauncherRemoveRole='daemon'; $script:failLauncherRemoveAfterMutation=$true
        Assert-Refused { Invoke-FixtureUninstall } 'original task definitions, enabled/running state and launcher bytes were restored'
        Assert-That ($tasks.Count -eq 2 -and $tasks[$TaskName].Settings.Enabled -and $tasks[$TrayTaskName].Settings.Enabled) 'Launcher failure rollback did not restore both tasks'
        foreach($role in @('daemon','tray')){Assert-That ([IO.File]::ReadAllText((Get-TokeneloLauncherPath $role)) -ceq $original[$role]) ($role+' launcher bytes were not restored after deletion')}
        Assert-That (@($events|Where-Object{$_ -like 'restore-xml:*'}).Count -eq 2) 'Removed registrations were not restored after second launcher failure'
    } finally { $env:LOCALAPPDATA=$originalLocalAppData; Assert-FixtureParent $fixture.Parent }
}
Case 'unregister success without task absence fails postcheck and rolls back' {
    $fixture=New-PackagedRuntimeFixture
    try {
        Initialize-PackagedTransactionFixture $fixture -WithTasks $true -DaemonEnabled $true -TrayEnabled $true
        Set-FixtureTaskHome (Join-Path $fixture.Parent 'isolated user data home')
        $script:unregisterNoOpName=$TaskName
        Assert-Refused { Invoke-FixtureUninstall } 'original task definitions, enabled/running state and launcher bytes were restored'
        Assert-That ($tasks.Count -eq 2 -and $tasks[$TaskName].Settings.Enabled -and $tasks[$TrayTaskName].Settings.Enabled) 'Postcheck rollback did not preserve both roles'
        Assert-That (@($events|Where-Object{$_ -like 'restore-xml:*'}).Count -eq 1 -and $events -contains 'restore-xml:TokeneloTray') 'Postcheck rollback rewrote a still-owned task or failed to restore the removed role'
        Assert-That ((Test-Path -LiteralPath (Get-TokeneloLauncherPath daemon)) -and (Test-Path -LiteralPath (Get-TokeneloLauncherPath tray))) 'Postcheck failure removed a launcher'
    } finally { $env:LOCALAPPDATA=$originalLocalAppData; Assert-FixtureParent $fixture.Parent }
}
Case 'rollback registration failure retains recovery and never enables a role' {
    $fixture=New-PackagedRuntimeFixture
    try {
        Initialize-PackagedTransactionFixture $fixture -WithTasks $true -DaemonEnabled $true -TrayEnabled $true
        Set-FixtureTaskHome (Join-Path $fixture.Parent 'isolated user data home')
        $script:failUnregisterName=$TaskName; $script:failRestoreXmlName=$TrayTaskName
        Assert-Refused { Invoke-FixtureUninstall } 'rollback could not be proven'
        Assert-That ($fakeMutexState.Owner -eq $null -and $fakeMutexState.Acquisitions -eq $fakeMutexState.Releases) 'Rollback failure did not release its owned lifecycle lease in finally'
        Assert-That (-not $tasks.ContainsKey($TrayTaskName) -and $tasks.ContainsKey($TaskName) -and -not $tasks[$TaskName].Settings.Enabled) 'Uncertain rollback activated a surviving task'
        Assert-That (@($events|Where-Object{$_ -match '^(enable|start):'}).Count -eq 0) 'Rollback enabled or started tasks after a restore error'
        $recovery=Get-ChildItem -LiteralPath (Join-Path $fixture.LocalAppData 'Tokenelo\recovery') -Directory|Select-Object -First 1
        Assert-That ((Test-Path -LiteralPath (Join-Path $recovery.FullName 'tray.task.xml')) -and (Test-Path -LiteralPath (Join-Path $recovery.FullName 'tray.launcher.original.exe'))) 'Rollback failure lost immutable recovery snapshots'
        Assert-That ((Get-Content -LiteralPath (Join-Path $recovery.FullName 'journal.jsonl') -Raw) -match 'manual-recovery-required') 'Rollback uncertainty lacks a manual recovery disposition'
    } finally { $env:LOCALAPPDATA=$originalLocalAppData; Assert-FixtureParent $fixture.Parent }
}
Case 'foreign replacement after unregister failure prevents all rollback writes and enables' {
    $fixture=New-PackagedRuntimeFixture
    try {
        Initialize-PackagedTransactionFixture $fixture -WithTasks $true -DaemonEnabled $true -TrayEnabled $true
        Set-FixtureTaskHome (Join-Path $fixture.Parent 'isolated user data home')
        $script:failUnregisterName=$TaskName; $script:foreignAfterUnregisterFailureName=$TaskName
        Assert-Refused { Invoke-FixtureUninstall } 'rollback could not be proven'
        Assert-That ($tasks.ContainsKey($TrayTaskName) -and $tasks[$TrayTaskName].Principal.UserId -eq 'OTHER\user') 'Foreign task fixture was not present'
        Assert-That ($tasks.ContainsKey($TaskName) -and -not $tasks[$TaskName].Settings.Enabled) 'Known owned role was enabled despite a foreign replacement'
        Assert-That (@($events|Where-Object{$_ -match '^(restore-xml|enable|start):'}).Count -eq 0) 'Rollback mutated another role before preflighting the foreign replacement'
        $recovery=Get-ChildItem -LiteralPath (Join-Path $fixture.LocalAppData 'Tokenelo\recovery') -Directory|Select-Object -First 1
        Assert-That ((Get-Content -LiteralPath (Join-Path $recovery.FullName 'journal.jsonl') -Raw) -match 'manual-recovery-required') 'Foreign replacement uncertainty was not retained'
    } finally { $env:LOCALAPPDATA=$originalLocalAppData; Assert-FixtureParent $fixture.Parent }
}
Case 'new owned process after unregister blocks task restoration and activation' {
    $fixture=New-PackagedRuntimeFixture
    try {
        Initialize-PackagedTransactionFixture $fixture -WithTasks $true -DaemonEnabled $true -TrayEnabled $true
        Set-FixtureTaskHome (Join-Path $fixture.Parent 'isolated user data home')
        $script:failUnregisterName=$TaskName; $script:processAfterUnregisterName=$TrayTaskName
        Assert-Refused { Invoke-FixtureUninstall } 'rollback could not be proven'
        Assert-That (-not $tasks.ContainsKey($TrayTaskName) -and $tasks.ContainsKey($TaskName) -and -not $tasks[$TaskName].Settings.Enabled) 'Rollback restored or enabled a task despite a matching process'
        Assert-That (@($events|Where-Object{$_ -match '^(restore-xml|enable|start):'}).Count -eq 0) 'Rollback wrote or activated a task while an owned process remained'
        Assert-That ($processesAfter.Count -eq 1 -and $processesAfter[0].ProcessId -eq 990) 'The process boundary fixture was not retained'
    } finally { $env:LOCALAPPDATA=$originalLocalAppData; Assert-FixtureParent $fixture.Parent }
}
Case 'second role cleanup failure leaves registrations intact and does not unregister or delete' {
    $fixture=New-PackagedRuntimeFixture
    try {
        Initialize-PackagedTransactionFixture $fixture -WithTasks $true -DaemonEnabled $true -TrayEnabled $true
        Set-FixtureTaskHome (Join-Path $fixture.Parent 'isolated user data home')
        $script:failStopName=$TaskName
        Assert-Refused { Invoke-FixtureUninstall } 'without verifying cleanup of every role'
        Assert-That ($tasks.Count -eq 2 -and -not $tasks[$TaskName].Settings.Enabled -and -not $tasks[$TrayTaskName].Settings.Enabled) 'Unverified cleanup did not conservatively retain both disabled registrations'
        Assert-That (@($mutations|Where-Object{$_ -like 'remove:*'}).Count -eq 0 -and
            (Test-Path -LiteralPath (Get-TokeneloLauncherPath daemon)) -and (Test-Path -LiteralPath (Get-TokeneloLauncherPath tray))) 'Incomplete cleanup proceeded to unregister or launcher deletion'
    } finally { $env:LOCALAPPDATA=$originalLocalAppData; Assert-FixtureParent $fixture.Parent }
}
Case 'install and uninstall share one stable Global per-SID mutex and release successful leases' {
    $fixture=New-PackagedRuntimeFixture
    try {
        Initialize-PackagedTransactionFixture $fixture
        Set-FakeTransactionCompiler
        $install=Invoke-FixtureTransaction -DataHome (Join-Path $fixture.Parent 'isolated user data home')
        $uninstall=Invoke-FixtureUninstall
        $sid=[string][Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $expectedName='Global\Tokenelo-ServiceLifecycle-'+$sid
        Assert-That ($uninstall.Changed -and $tasks.Count -eq 0) 'The second serialized lifecycle entrypoint did not complete uninstall'
        Assert-That ($fakeMutexState.Names.Count -eq 2 -and @($fakeMutexState.Names|Where-Object{$_ -cne $expectedName}).Count -eq 0) 'Install and uninstall did not use the same stable Global per-SID mutex'
        Assert-That ($fakeMutexState.Acquisitions -eq 2 -and $fakeMutexState.Releases -eq 2 -and $fakeMutexState.Owner -eq $null) 'Successful install/uninstall did not release both owned mutex leases'
    } finally { $env:LOCALAPPDATA=$originalLocalAppData; Assert-FixtureParent $fixture.Parent }
}
Case 'second session contention refuses before scheduler preflight or journal creation' {
    $fixture=New-PackagedRuntimeFixture
    try {
        Initialize-PackagedTransactionFixture $fixture -WithTasks $true -DaemonEnabled $true -TrayEnabled $true
        $beforeQueries=$schedulerQueryCount
        $lease=Enter-TokeneloLifecycleMutex
        try {
            $script:fakeMutexState.NextCaller='caller-B'
            Assert-Refused { Invoke-FixtureUninstall } 'already running for this Windows account'
            Assert-That ($schedulerQueryCount -eq $beforeQueries) 'Contending second caller reached task ownership preflight'
            Assert-That (-not (Test-Path -LiteralPath (Join-Path $fixture.LocalAppData 'Tokenelo\recovery'))) 'Contending caller created a recovery journal directory'
            Assert-That ($tasks.Count -eq 2 -and $mutations.Count -eq 0 -and $fakeMutexState.Contentions -eq 1) 'Contending caller changed task state or failed to observe contention'
            Assert-That ($fakeMutexState.Releases -eq 0 -and $fakeMutexState.Owner -eq 'caller-A') 'Contending caller released a different caller lease'
        } finally { Exit-TokeneloLifecycleMutex -Lease $lease }
        Assert-That ($fakeMutexState.Owner -eq $null -and $fakeMutexState.Releases -eq 1) 'First caller did not release its owned mutex lease'
    } finally { $env:LOCALAPPDATA=$originalLocalAppData; Assert-FixtureParent $fixture.Parent }
}
Case 'abandoned mutex fails closed and preserves incomplete journal bytes' {
    $fixture=New-PackagedRuntimeFixture
    try {
        Initialize-PackagedTransactionFixture $fixture -WithTasks $true -DaemonEnabled $true -TrayEnabled $true
        $recoveryBase=Join-Path $fixture.LocalAppData 'Tokenelo\recovery'
        $priorId=[Guid]::NewGuid().ToString('N'); $priorRoot=Join-Path $recoveryBase $priorId
        New-Item -ItemType Directory -Path $priorRoot -Force|Out-Null
        $record=[ordered]@{recordedAt=[datetime]::UtcNow.ToString('o');transactionId=$priorId;phase='manual-recovery-required';role='';detail='retained fixture'}
        $journalPath=Join-Path $priorRoot 'journal.jsonl'
        [IO.File]::WriteAllText($journalPath,(($record|ConvertTo-Json -Compress)+"`n"),[Text.UTF8Encoding]::new($false))
        $beforeHash=Get-TokeneloSha256 ([IO.File]::ReadAllBytes($journalPath))
        $script:fakeMutexState.AbandonedNext=$true
        Assert-Refused { Invoke-FixtureUninstall } 'previous lifecycle transaction abandoned the mutex'
        Assert-That ((Get-TokeneloSha256 ([IO.File]::ReadAllBytes($journalPath))) -ceq $beforeHash) 'Abandoned mutex handling rewrote or deleted the incomplete journal'
        Assert-That ($tasks.Count -eq 2 -and $mutations.Count -eq 0 -and $fakeMutexState.Owner -eq $null) 'Abandoned lock changed tasks or failed to release only the acquired lease'
        Assert-Refused { Invoke-FixtureUninstall } 'earlier Tokenelo install transaction is incomplete'
        Assert-That ((Get-TokeneloSha256 ([IO.File]::ReadAllBytes($journalPath))) -ceq $beforeHash -and $tasks.Count -eq 2 -and $mutations.Count -eq 0) 'Retry cleared recovery evidence or mutated task state'
        Assert-That ($fakeMutexState.Acquisitions -eq $fakeMutexState.Releases) 'Abandoned/retry paths leaked an acquired mutex lease'
    } finally { $env:LOCALAPPDATA=$originalLocalAppData; Assert-FixtureParent $fixture.Parent }
}
Case 'mutex release failure propagates and never claims the lease was released' {
    $lease=Enter-TokeneloLifecycleMutex
    $script:fakeMutexState.FailRelease=$true
    Assert-Refused { Exit-TokeneloLifecycleMutex -Lease $lease } 'Simulated mutex release failure'
    Assert-That ($fakeMutexState.Owner -eq 'caller-A' -and $fakeMutexState.Depth -eq 1 -and
        $fakeMutexState.Releases -eq 0 -and $fakeMutexState.Disposals -eq 1) 'Release failure was hidden or ownership was falsely cleared'
}
Case 'actual install wrapper resolves script-scope helper and forwards each argument from a child File' {
    $fixtureParent=Join-Path 'C:\Temp' ('tokenelo-lock-wrapper-child-'+[Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $fixtureParent -Force|Out-Null
    try {
        $functionText=@{}
        foreach($name in @('Get-TokeneloLifecycleMutexName','Enter-TokeneloLifecycleMutex','Exit-TokeneloLifecycleMutex','Invoke-TokeneloInstallTransaction')){
            $wanted=$name
            $definition=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $wanted},$true)|Select-Object -First 1)
            Assert-That ($definition.Count -eq 1) ('Source function missing for child-scope regression: '+$name)
            $functionText[$name]=$definition[0].Extent.Text
        }
        $childPath=Join-Path $fixtureParent 'install-wrapper-child.ps1'
        $outputPath=Join-Path $fixtureParent 'result.txt'
        $outputPathLine='$script:childOutputPath="' + $outputPath + '"'
        $scaffoldLines = @(
            '$ErrorActionPreference="Stop"',
            '$script:releaseCount=0',
            '$script:factoryName=$null',
            '$script:captured=$null',
            'function New-TokeneloLifecycleMutex {',
            '    param([string]$Name)',
            '    $script:factoryName=$Name',
            '    $mutex=[pscustomobject]@{Owned=$false;Disposed=$false}',
            '    Add-Member -InputObject $mutex -MemberType ScriptMethod -Name WaitOne -Value {param([int]$Timeout) if($Timeout -ne 0){throw "expected nonblocking wait"}; $this.Owned=$true; return $true}',
            '    Add-Member -InputObject $mutex -MemberType ScriptMethod -Name ReleaseMutex -Value {if(-not $this.Owned){throw "release without ownership"}; $this.Owned=$false; $script:releaseCount++}',
            '    Add-Member -InputObject $mutex -MemberType ScriptMethod -Name Dispose -Value {$this.Disposed=$true}',
            '    $script:fakeMutex=$mutex',
            '    return $mutex',
            '}',
            'function Invoke-TokeneloInstallTransactionUnlocked {',
            '    param([string]$RuntimeExecutable,[string]$HomeDirectory,[switch]$InstallTray,$ExpectedDaemon,$ExpectedTray)',
            '    $script:captured=[pscustomobject]@{RuntimeExecutable=$RuntimeExecutable;HomeDirectory=$HomeDirectory;InstallTray=[bool]$InstallTray;ExpectedDaemon=$ExpectedDaemon;ExpectedTray=$ExpectedTray}',
            '    return [pscustomobject]@{transactionId="child-stub"}',
            '}'
        )
        $scaffold=$scaffoldLines -join "`r`n"
        $scaffold += "`r`n"+$outputPathLine
        $dispatchLines = @(
            '$daemon=[pscustomobject]@{role="daemon";marker="D"}',
            '$tray=[pscustomobject]@{role="tray";marker="T"}',
            '$result=Invoke-TokeneloInstallTransaction -RuntimeExecutable "C:\fixture runtime\electron.exe" -HomeDirectory "C:\fixture home\data" -InstallTray -ExpectedDaemon $daemon -ExpectedTray $tray',
            '$sid=[string][Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
            '$expectedName="Global\Tokenelo-ServiceLifecycle-"+$sid',
            'if($script:factoryName -cne $expectedName){throw "The actual per-SID mutex name was not passed to the fake factory."}',
            'if($script:captured.RuntimeExecutable -cne "C:\fixture runtime\electron.exe" -or $script:captured.HomeDirectory -cne "C:\fixture home\data" -or -not $script:captured.InstallTray -or -not [object]::ReferenceEquals($script:captured.ExpectedDaemon,$daemon) -or -not [object]::ReferenceEquals($script:captured.ExpectedTray,$tray)){throw "The actual wrapper did not forward every install argument."}',
            'if($result.transactionId -cne "child-stub" -or $script:releaseCount -ne 1 -or $script:fakeMutex.Owned -or -not $script:fakeMutex.Disposed){throw "The actual wrapper did not release its acquired fake lease after dispatch."}',
            '[IO.File]::WriteAllText($script:childOutputPath,"script-scope-wrapper-ok",[Text.UTF8Encoding]::new($false))'
        )
        $dispatch=$dispatchLines -join "`r`n"
        $childScript=$scaffold+"`r`n"+$functionText['Get-TokeneloLifecycleMutexName']+"`r`n"+
            $functionText['Enter-TokeneloLifecycleMutex']+"`r`n"+$functionText['Exit-TokeneloLifecycleMutex']+"`r`n"+
            $functionText['Invoke-TokeneloInstallTransaction']+"`r`n"+$dispatch
        [IO.File]::WriteAllText($childPath,$childScript,[Text.UTF8Encoding]::new($false))
        $childHost=if($PSVersionTable.PSEdition -eq 'Core'){Join-Path $PSHOME 'pwsh.exe'}else{Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'}
        $psi=[Diagnostics.ProcessStartInfo]::new(); $psi.FileName=$childHost
        $psi.Arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$childPath+'"'
        $psi.UseShellExecute=$false; $psi.CreateNoWindow=$true; $psi.RedirectStandardOutput=$true; $psi.RedirectStandardError=$true
        $process=[Diagnostics.Process]::Start($psi); $stdoutTask=$process.StandardOutput.ReadToEndAsync(); $stderrTask=$process.StandardError.ReadToEndAsync(); $process.WaitForExit()
        $stdout=$stdoutTask.Result; $stderr=$stderrTask.Result
        Assert-That ($process.ExitCode -eq 0) ('Child File wrapper failed: '+(($stderr -split "`r?`n"|Select-Object -First 4)-join ' '))
        Assert-That ((Test-Path -LiteralPath $outputPath) -and [IO.File]::ReadAllText($outputPath) -ceq 'script-scope-wrapper-ok') 'Child File did not observe helper visibility and complete argument forwarding'
    } finally { Assert-FixtureParent $fixtureParent }
}
Case 'uninstall recovery header is durable before first task mutation' {
    $fixture=New-PackagedRuntimeFixture
    try {
        Initialize-PackagedTransactionFixture $fixture -WithTasks $true -DaemonEnabled $true -TrayEnabled $true
        Set-FixtureTaskHome (Join-Path $fixture.Parent 'isolated header data home')
        $sid=[string][Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $recoveryBase=Join-Path $fixture.LocalAppData 'Tokenelo\recovery'
        New-Item -ItemType Directory -Path $recoveryBase -Force | Out-Null
        foreach($directory in @($fixture.Parent,$fixture.LocalAppData,(Join-Path $fixture.LocalAppData 'Tokenelo'),$recoveryBase)){
            Set-TestRecoveryDirectoryPrivateAcl -Path $directory -Sid $sid
        }
        $script:headerBeforeFirstStop=$false
        Set-Item -Path Function:\Stop-TokeneloTask -Value (Get-Command Fake-HeaderProbeStop).ScriptBlock
        $result=Invoke-FixtureUninstall
        Assert-That ($result.Changed -and $script:headerBeforeFirstStop) 'Uninstall reached a fake task stop before the immutable header was written'
        Assert-That ($result.RecoveryHeaderPath -and (Test-Path -LiteralPath $result.RecoveryHeaderPath -PathType Leaf)) 'Uninstall did not retain its transaction header'
        Assert-That ((Get-TokeneloSha256 ([IO.File]::ReadAllBytes($result.RecoveryHeaderPath))) -ceq $result.RecoveryHeaderSha256) 'Uninstall returned a header hash that did not match its durable bytes'
        Assert-That ($tasks.Count -eq 0 -and $mutations.Count -gt 0) 'Fake scheduler boundary did not observe a completed two-role uninstall'
    } finally { $env:LOCALAPPDATA=$originalLocalAppData; Assert-FixtureParent $fixture.Parent }
}
Case 'uninstall recovery header roundtrips both and absent roles without task queries' {
    $pairFixture=New-PackagedRuntimeFixture; $absentFixture=New-PackagedRuntimeFixture
    try {
        $pair=New-TestUninstallHeaderTransaction -Fixture $pairFixture -PresentRoles @('tray','daemon')
        $beforeQueries=$schedulerQueryCount; $script:cimDenied=$true
        $pairRead=Read-TestUninstallHeader -Context $pair
        $script:cimDenied=$false
        Assert-That ($schedulerQueryCount -eq $beforeQueries -and $mutations.Count -eq 0) 'Read-only reconstruction queried tasks or mutated fake OS state'
        Assert-That ($pairRead.ReconstructedFromRecoveryHeader -and -not $pairRead.LifecycleLease -and
            $pairRead.Id -ceq $pair.Transaction.Id -and $pairRead.RecoveryHeaderSha256 -ceq $pair.Header.Sha256) 'Pair reconstruction did not preserve identity or its read-only status'
        Assert-That (@($pairRead.Plans|Where-Object{$_.Snapshot.Present}).Count -eq 2 -and
            @($pairRead.Plans|Where-Object{$_.Snapshot.XmlSha256}).Count -eq 2 -and
            @($pairRead.Plans|Where-Object{$_.Snapshot.LauncherSha256}).Count -eq 2) 'Both present role snapshots did not roundtrip'
        Assert-That (@($pairRead.Plans|Where-Object{$_.Snapshot.Owned.HomeDirectory -cne $pair.DataHome}).Count -eq 0) 'Independent task data home was not preserved'
        $daemonHeader=$pair.Header.Header.roles[1]
        Assert-That ($daemonHeader.launcherSourceMetadata.sha256 -ceq $daemonHeader.launcherBackup.sha256 -and
            $daemonHeader.launcherSourceMetadata.ownerSid -ceq $pair.CurrentSid -and
            $daemonHeader.launcherSourceMetadata.aclSha256 -match '^[0-9a-f]{64}$' -and
            (Get-TokeneloSha256 ([Text.Encoding]::UTF8.GetBytes($daemonHeader.launcherSourceMetadata.aclSddl))) -ceq $daemonHeader.launcherSourceMetadata.aclSha256) `
            'Header did not retain source launcher owner/attribute/ACL metadata'

        $absent=New-TestUninstallHeaderTransaction -Fixture $absentFixture -PresentRoles @('daemon')
        $beforeQueries=$schedulerQueryCount; $script:cimDenied=$true
        $absentRead=Read-TestUninstallHeader -Context $absent
        $script:cimDenied=$false
        $trayPlan=@($absentRead.Plans|Where-Object{$_.Role -ceq 'tray'})[0]
        $daemonPlan=@($absentRead.Plans|Where-Object{$_.Role -ceq 'daemon'})[0]
        Assert-That ($schedulerQueryCount -eq $beforeQueries -and $mutations.Count -eq 0) 'Absent-role reconstruction queried tasks or mutated fake OS state'
        Assert-That (-not $trayPlan.Snapshot.Present -and -not $trayPlan.Snapshot.Owned -and
            -not $trayPlan.Snapshot.LauncherPresent -and $null -eq $trayPlan.Snapshot.XmlPath -and
            $daemonPlan.Snapshot.Present -and $daemonPlan.Snapshot.Owned.HomeDirectory -ceq $absent.DataHome) 'Absent role did not remain typed and empty while preserving daemon identity'
    } finally {
        $script:cimDenied=$false; $env:LOCALAPPDATA=$originalLocalAppData
        Assert-FixtureParent $pairFixture.Parent; Assert-FixtureParent $absentFixture.Parent
    }
}
Case 'uninstall recovery header refuses caller identity pin content ACL and unknown path drift' {
    $fixture=New-PackagedRuntimeFixture
    try {
        $context=New-TestUninstallHeaderTransaction -Fixture $fixture -PresentRoles @('tray','daemon')
        Assert-Refused { Read-TestUninstallHeader -Context $context -HeaderHash ('0'*64) } 'independently supplied hash'
        Assert-Refused { Read-TestUninstallHeader -Context $context -Sid 'S-1-5-21-111-222-333-444' } 'current Windows account'
        Assert-Refused { Read-TestUninstallHeader -Context $context -Package 'com.foreign.tokenelo' } 'package identity'
        Assert-Refused { Read-TestUninstallHeader -Context $context -InstallRoot (Join-Path $fixture.Parent 'other-install') } 'caller supplied context'
        Assert-Refused { Read-TestUninstallHeader -Context $context -LauncherRoot (Join-Path $fixture.Parent 'foreign-launchers') } 'launcher root'
        $wrongHomes=@{tray=(Join-Path $fixture.Parent 'other-home');daemon=(Join-Path $fixture.Parent 'other-home')}
        Assert-Refused { Read-TestUninstallHeader -Context $context -ExpectedHomes $wrongHomes } 'data home'

        $daemonPlan=@($context.Transaction.Plans|Where-Object{$_.Role -ceq 'daemon'})[0]
        $sourceLauncher=$daemonPlan.LauncherPath; $sourceAclSddl=(Get-Acl -LiteralPath $sourceLauncher).Sddl
        $sourceAcl=Get-Acl -LiteralPath $sourceLauncher
        $foreignRule=[Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-11'),
            [Security.AccessControl.FileSystemRights]::Modify,[Security.AccessControl.AccessControlType]::Allow)
        $sourceAcl.AddAccessRule($foreignRule)
        $nativeSetAcl=Get-Command -Name 'Set-Acl' -Module 'Microsoft.PowerShell.Security' -ErrorAction Stop
        & $nativeSetAcl -LiteralPath $sourceLauncher -AclObject $sourceAcl -ErrorAction Stop
        Assert-Refused { Assert-TokeneloUninstallSnapshotLauncherState -Snapshot $daemonPlan.Snapshot -Path $sourceLauncher } 'ACL grants write access to another principal'
        $restoreSourceAcl=[Security.AccessControl.FileSecurity]::new()
        $restoreSourceAcl.SetSecurityDescriptorSddlForm($sourceAclSddl,[Security.AccessControl.AccessControlSections]::All)
        & $nativeSetAcl -LiteralPath $sourceLauncher -AclObject $restoreSourceAcl -ErrorAction Stop

        $launcherBackup=Join-Path $context.RecoveryRoot 'daemon.launcher.original.exe'
        $originalLauncherBytes=[IO.File]::ReadAllBytes($launcherBackup)
        $tamperedLauncher=[byte[]]$originalLauncherBytes.Clone(); $tamperedLauncher[0]=$tamperedLauncher[0] -bxor 1
        [IO.File]::WriteAllBytes($launcherBackup,$tamperedLauncher)
        $launcherMeta=$context.Header.Header.roles[1].launcherBackup
        [IO.File]::SetAttributes($launcherBackup,[IO.FileAttributes]$launcherMeta.attributes)
        Assert-Refused { Read-TestUninstallHeader -Context $context } 'immutable header|backup metadata'
        [IO.File]::WriteAllBytes($launcherBackup,$originalLauncherBytes)
        [IO.File]::SetAttributes($launcherBackup,[IO.FileAttributes]$launcherMeta.attributes)

        $sentinel=Join-Path $fixture.LocalAppData 'Tokenelo\data-sentinel.txt'
        [IO.File]::WriteAllText($sentinel,'preserve-this-fixture-data',[Text.UTF8Encoding]::new($false))
        $validReconstruction=Read-TestUninstallHeader -Context $context
        $originalHeaderBytes=[IO.File]::ReadAllBytes($context.Header.Path)
        $headerObject=ConvertFrom-TokeneloUninstallHeaderJson -Json ([Text.UTF8Encoding]::new($false,$true).GetString($originalHeaderBytes))
        $aclXml=$headerObject.roles[0].taskXmlBackup
        $aclPath=Join-Path $context.RecoveryRoot ([string]$aclXml.relativePath)
        $savedAcl=(Get-Acl -LiteralPath $aclPath).Sddl
        $acl=Get-Acl -LiteralPath $aclPath
        $foreignRule=[Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-11'),
            [Security.AccessControl.FileSystemRights]::Modify,[Security.AccessControl.AccessControlType]::Allow)
        $acl.AddAccessRule($foreignRule)
        & $nativeSetAcl -LiteralPath $aclPath -AclObject $acl -ErrorAction Stop
        Assert-Refused { Read-TestUninstallHeader -Context $context } 'ACL grants write access to another principal'
        $restoreAcl=[Security.AccessControl.FileSecurity]::new()
        $restoreAcl.SetSecurityDescriptorSddlForm($savedAcl,[Security.AccessControl.AccessControlSections]::All)
        & $nativeSetAcl -LiteralPath $aclPath -AclObject $restoreAcl -ErrorAction Stop

        $extra=Join-Path $context.RecoveryRoot 'foreign.extra'
        [IO.File]::WriteAllText($extra,'foreign fixture bytes',[Text.UTF8Encoding]::new($false))
        Assert-Refused { Read-TestUninstallHeader -Context $context } 'missing or unknown entries'
        Assert-That ([IO.File]::ReadAllText($extra) -ceq 'foreign fixture bytes' -and [IO.File]::ReadAllText($sentinel) -ceq 'preserve-this-fixture-data') 'Refusal changed an unknown fixture file or adjacent data sentinel'
        Remove-Item -LiteralPath $extra -Force

        $journalPath=$context.Transaction.JournalPath; $completeJournal=[IO.File]::ReadAllBytes($journalPath)
        $keptRecords=[Collections.Generic.List[string]]::new()
        foreach($line in [IO.File]::ReadAllLines($journalPath)){
            $record=ConvertFrom-TokeneloUninstallHeaderJson -Json $line -Description 'Fixture journal record'
            if($record.phase -ceq 'snapshot-saved' -and $record.role -ceq 'daemon'){continue}
            $keptRecords.Add([string]$line)
        }
        [IO.File]::WriteAllText($journalPath,(($keptRecords.ToArray() -join "`n")+"`n"),[Text.UTF8Encoding]::new($false))
        Assert-Refused { Read-TestUninstallHeader -Context $context } 'complete pre-mutation role snapshot'
        [IO.File]::WriteAllBytes($journalPath,$completeJournal)

        $xmlBackup=Join-Path $context.RecoveryRoot 'tray.task.xml'; $heldBackup=$xmlBackup+'.held'
        Move-Item -LiteralPath $xmlBackup -Destination $heldBackup
        $missingBackupRefused=$false
        try { $null=Read-TestUninstallHeader -Context $context } catch { $missingBackupRefused=$true }
        finally { Move-Item -LiteralPath $heldBackup -Destination $xmlBackup }
        Assert-That $missingBackupRefused 'Read-only reconstruction accepted a missing task XML backup'

        $headerObject.roles[0].taskXmlBackup.relativePath='../data-sentinel.txt'
        $badHeaderBytes=[Text.UTF8Encoding]::new($false).GetBytes(($headerObject | ConvertTo-Json -Compress -Depth 8))
        [IO.File]::WriteAllBytes($context.Header.Path,$badHeaderBytes)
        $badHeaderHash=Get-TokeneloSha256 $badHeaderBytes
        $journalLines=[Collections.Generic.List[string]]::new()
        foreach($line in [IO.File]::ReadAllLines($context.Transaction.JournalPath)){
            $record=ConvertFrom-TokeneloUninstallHeaderJson -Json $line -Description 'Fixture transaction journal record'
            if($record.phase -ceq 'recovery-header-written'){$record.detail=$badHeaderHash}
            $canonicalRecord=[ordered]@{recordedAt=[string]$record.recordedAt;transactionId=[string]$record.transactionId;
                phase=[string]$record.phase;role=[string]$record.role;detail=[string]$record.detail}
            $journalLines.Add(($canonicalRecord|ConvertTo-Json -Compress -Depth 8))
        }
        [IO.File]::WriteAllText($context.Transaction.JournalPath,(($journalLines.ToArray() -join "`n")+"`n"),[Text.UTF8Encoding]::new($false))
        Assert-Refused { Read-TestUninstallHeader -Context $context -HeaderHash $badHeaderHash } 'exact role-owned filename'
        Assert-That ([IO.File]::ReadAllText($sentinel) -ceq 'preserve-this-fixture-data') 'Rejected backup path read or changed the adjacent data sentinel'
        $script:coordinatorGuardCalls=0
        Set-Item -Path Function:\Assert-TokeneloCoordinatorLifecycleLeaseAlive -Value {
            param($Lease)
            $script:coordinatorGuardCalls++
            if(-not $Lease.Coordinator){throw 'Synthetic rollback needs a coordinator lease'}
        }
        $validReconstruction.LifecycleLease=[pscustomobject]@{Name=(Get-TokeneloLifecycleMutexName);Owned=$true;Abandoned=$false;Coordinator=$true}
        $beforeQueries=$schedulerQueryCount; $journalBeforeRollback=[IO.File]::ReadAllBytes($context.Transaction.JournalPath)
        Assert-Refused { Invoke-TokeneloUninstallRollback -Transaction $validReconstruction -Failure 'fixture recovery request' } 'header changed after reconstruction'
        Assert-That ($coordinatorGuardCalls -eq 1 -and $schedulerQueryCount -eq $beforeQueries -and
            (Get-TokeneloSha256 ([IO.File]::ReadAllBytes($context.Transaction.JournalPath))) -ceq (Get-TokeneloSha256 $journalBeforeRollback)) `
            'Stale header rollback guard queried tasks or wrote a journal record'
        $dtdRejected=$false
        try { $null=Get-TokeneloCanonicalTaskXml -Xml '<!DOCTYPE Task [<!ENTITY x SYSTEM "file:///C:/fixture-secret">]><Task>&x;</Task>' } catch { $dtdRejected=$true }
        Assert-That $dtdRejected 'Task XML canonicalizer accepted DTD/external entity content'
    } finally { $env:LOCALAPPDATA=$originalLocalAppData; Assert-FixtureParent $fixture.Parent }
}
Case 'uninstall recovery header rejects partial journals and needs a fresh coordinator lease' {
    $fixture=New-PackagedRuntimeFixture
    try {
        $context=New-TestUninstallHeaderTransaction -Fixture $fixture -PresentRoles @('tray','daemon')
        $journalPath=$context.Transaction.JournalPath
        $originalJournal=[IO.File]::ReadAllBytes($journalPath)
        $stream=[IO.File]::Open($journalPath,[IO.FileMode]::Append,[IO.FileAccess]::Write,[IO.FileShare]::Read)
        try { $partial=[Text.Encoding]::UTF8.GetBytes('{"phase":');$stream.Write($partial,0,$partial.Length);$stream.Flush($true) } finally { $stream.Dispose() }
        Assert-Refused { Read-TestUninstallHeader -Context $context } 'truncated|partial'
        [IO.File]::WriteAllBytes($journalPath,$originalJournal)
        foreach($role in @('tray','daemon')){
            Write-TokeneloTransactionJournal -Transaction $context.Transaction -Phase 'stop-requested' -Role $role
            Write-TokeneloTransactionJournal -Transaction $context.Transaction -Phase 'task-stopped' -Role $role
        }
        Write-TokeneloTransactionJournal -Transaction $context.Transaction -Phase 'cleanup-complete'
        $beforeQueries=$schedulerQueryCount; $script:cimDenied=$true
        $reconstructed=Read-TestUninstallHeader -Context $context
        Assert-That ($schedulerQueryCount -eq $beforeQueries -and $reconstructed.CleanupComplete -and
            $reconstructed.TaskMutationStarted -and $null -eq $reconstructed.LifecycleLease) 'Recovery read was not pure or did not reconstruct the cleanup state'
        $journalBeforeRollback=[IO.File]::ReadAllBytes($journalPath)
        Assert-Refused { Invoke-TokeneloUninstallRollback -Transaction $reconstructed -Failure 'fixture recovery request' } 'fresh owned per-account lifecycle lease'
        $reconstructed.LifecycleLease=[pscustomobject]@{Name=(Get-TokeneloLifecycleMutexName);Owned=$true;Abandoned=$false;Coordinator=$false}
        Assert-Refused { Invoke-TokeneloUninstallRollback -Transaction $reconstructed -Failure 'fixture recovery request' } 'current NSIS coordinator lease'
        Assert-That ($schedulerQueryCount -eq $beforeQueries -and
            (Get-TokeneloSha256 ([IO.File]::ReadAllBytes($journalPath))) -ceq (Get-TokeneloSha256 $journalBeforeRollback)) 'Rollback refusal queried tasks or changed retained journal bytes'
    } finally { $script:cimDenied=$false; $env:LOCALAPPDATA=$originalLocalAppData; Assert-FixtureParent $fixture.Parent }
}
Case 'uninstall recovery header preserves null homes and rejects empty or swapped home values' {
    $fixture=New-PackagedRuntimeFixture
    try {
        $context=New-TestUninstallHeaderTransaction -Fixture $fixture -PresentRoles @('tray','daemon')
        $homes=@{tray=$context.DataHome;daemon=$null}
        Rewrite-TestUninstallHeaderHome -Context $context -Role 'daemon' -HeaderHome $null -OwnedTaskHome $null | Out-Null
        $nullHomeRead=Read-TestUninstallHeader -Context $context -ExpectedHomes $homes
        $daemonPlan=@($nullHomeRead.Plans|Where-Object{$_.Role -ceq 'daemon'})[0]
        Assert-That ($null -eq $daemonPlan.Snapshot.Owned.HomeDirectory) 'A true null data home did not survive immutable header reconstruction'

        Rewrite-TestUninstallHeaderHome -Context $context -Role 'daemon' -HeaderHome $null -OwnedTaskHome '' | Out-Null
        Assert-Refused { Read-TestUninstallHeader -Context $context -ExpectedHomes $homes } 'home nullability|data home|non-empty'
        Rewrite-TestUninstallHeaderHome -Context $context -Role 'daemon' -HeaderHome '' -OwnedTaskHome $null | Out-Null
        Assert-Refused { Read-TestUninstallHeader -Context $context -ExpectedHomes $homes } 'non-empty|data home'
        Assert-Refused { Read-TestUninstallHeader -Context $context -ExpectedHomes @{tray=$context.DataHome;daemon=''} } 'non-empty canonical absolute path or null'

        $daemonPlan=@($context.Transaction.Plans|Where-Object{$_.Role -ceq 'daemon'})[0]
        $owned=$daemonPlan.Owned
        $daemonPlan.Snapshot.Owned=[pscustomobject]@{Name=$owned.Name;Execute=$owned.Execute;Arguments=$owned.Arguments;
            Principal=$owned.Principal;ChildCommand=$owned.ChildCommand;HomeDirectory=$null;Enabled=$owned.Enabled;State=$owned.State}
        $beforeHeaderHash=Get-TokeneloSha256 ([IO.File]::ReadAllBytes($context.Header.Path))
        Assert-Refused { Write-TokeneloUninstallRecoveryHeader -Transaction $context.Transaction -CurrentSid $context.CurrentSid `
            -PackageIdentity 'com.elostudios.tokenelo' -InstallRoot $context.InstallRoot -RuntimeMode 'packaged' } 'home nullability'
        $daemonPlan.Snapshot.Owned.HomeDirectory=''
        Assert-Refused { Write-TokeneloUninstallRecoveryHeader -Transaction $context.Transaction -CurrentSid $context.CurrentSid `
            -PackageIdentity 'com.elostudios.tokenelo' -InstallRoot $context.InstallRoot -RuntimeMode 'packaged' } 'non-empty string or null'
        Assert-That ((Get-TokeneloSha256 ([IO.File]::ReadAllBytes($context.Header.Path))) -ceq $beforeHeaderHash) `
            'Invalid writer home values changed the immutable header bytes'
    } finally { $env:LOCALAPPDATA=$originalLocalAppData; Assert-FixtureParent $fixture.Parent }

    $absentFixture=New-PackagedRuntimeFixture
    try {
        $absent=New-TestUninstallHeaderTransaction -Fixture $absentFixture -PresentRoles @('daemon')
        Rewrite-TestUninstallHeaderHome -Context $absent -Role 'tray' -HeaderHome '' -OwnedTaskHome $null | Out-Null
        Assert-Refused { Read-TestUninstallHeader -Context $absent } 'non-empty|data home'
    } finally { $env:LOCALAPPDATA=$originalLocalAppData; Assert-FixtureParent $absentFixture.Parent }
}
Case 'uninstall recovery rollback restores missing launcher ACL and attributes before task registration' {
    $fixture=New-PackagedRuntimeFixture
    $originalRegister=(Get-Command Register-ScheduledTask).ScriptBlock
    try {
        $context=New-TestUninstallHeaderTransaction -Fixture $fixture -PresentRoles @('daemon')
        $transaction=Read-TestUninstallHeader -Context $context
        $transaction.CleanupComplete=$true
        $transaction.LifecycleLease=[pscustomobject]@{Name=(Get-TokeneloLifecycleMutexName);Owned=$true;Abandoned=$false;Coordinator=$true}
        $script:tasks=@{}
        $script:restoreExpectedLauncherMetadata=@{}
        foreach($plan in @($transaction.Plans)){
            if(-not $plan.Snapshot.Present){continue}
            $plan.UnregisterRequested=$true
            $plan.LauncherRemovalRequested=$true
            $metadata=$plan.Snapshot.LauncherSourceMetadata
            $script:restoreExpectedLauncherMetadata[$plan.Name]=[pscustomobject]@{Role=$plan.Role;OwnerSid=$metadata.OwnerSid;
                Sha256=$metadata.Sha256;Length=$metadata.Length;Attributes=$metadata.Attributes;AclSha256=$metadata.AclSha256}
            [IO.File]::Delete($plan.LauncherPath)
        }
        $script:launcherMetadataVerifiedBeforeRegister=[Collections.Generic.List[string]]::new()
        $script:realFixtureRegisterScheduledTask=$originalRegister
        Set-Item -Path Function:\Register-ScheduledTask -Value (Get-Command Fake-RegisterWithLauncherMetadataCheck).ScriptBlock
        Set-Item -Path Function:\Assert-TokeneloCoordinatorLifecycleLeaseAlive -Value {
            param($Lease)
            if(-not $Lease -or -not $Lease.Owned -or $Lease.Abandoned){throw 'Synthetic current lifecycle lease is not held'}
        }
        Invoke-TokeneloUninstallRollback -Transaction $transaction -Failure 'synthetic missing-launcher metadata recovery'
        Assert-That ($script:launcherMetadataVerifiedBeforeRegister -contains $TaskName) 'Task registration did not observe the restored launcher metadata first'
        $daemonPlan=@($transaction.Plans|Where-Object{$_.Role -ceq 'daemon'})[0]
        $metadata=$daemonPlan.Snapshot.LauncherSourceMetadata
        $state=Get-TokeneloCoordinatorFileState -Path $daemonPlan.LauncherPath -ExpectedOwnerSid $metadata.OwnerSid
        Assert-That ($state.Sha256 -ceq $metadata.Sha256 -and $state.Length -eq $metadata.Length -and
            $state.Attributes -eq $metadata.Attributes -and $state.AclSha256 -ceq $metadata.AclSha256) `
            'Restored launcher did not match captured bytes, owner, DACL and attributes'
        Assert-That ($tasks.ContainsKey($TaskName) -and $tasks[$TaskName].Settings.Enabled) 'The synthetic rollback did not restore its original task state'
        Assert-That (Test-Path -LiteralPath (Join-Path $context.RecoveryRoot 'daemon.launcher.original.exe') -PathType Leaf) `
            'Successful metadata restoration removed the immutable launcher backup'
    } finally {
        Set-Item -Path Function:\Register-ScheduledTask -Value $originalRegister
        $script:restoreExpectedLauncherMetadata=$null
        $env:LOCALAPPDATA=$originalLocalAppData
        Assert-FixtureParent $fixture.Parent
    }
}
Case 'uninstall recovery rollback retains a newly created launcher when its fresh lease expires' {
    $fixture=New-PackagedRuntimeFixture
    try {
        $context=New-TestUninstallHeaderTransaction -Fixture $fixture -PresentRoles @('daemon')
        $transaction=$context.Transaction
        $transaction.LifecycleLease=[pscustomobject]@{Name=(Get-TokeneloLifecycleMutexName);Owned=$true;Abandoned=$false;Coordinator=$false}
        $script:tasks=@{}
        $script:restoreLeaseChecks=0
        foreach($plan in @($transaction.Plans)){
            if(-not $plan.Snapshot.Present){continue}
            $plan.UnregisterRequested=$true
            $plan.LauncherRemovalRequested=$true
            [IO.File]::Delete($plan.LauncherPath)
        }
        Set-Item -Path Function:\Assert-TokeneloCoordinatorLifecycleLeaseAlive -Value {
            param($Lease)
            $script:restoreLeaseChecks++
            if($script:restoreLeaseChecks -eq 2){throw 'Simulated fresh lifecycle lease loss before ACL mutation'}
        }
        Assert-Refused { Restore-TokeneloLaunchers -Transaction $transaction -AllowMissingOriginalTasks `
            -AllowMissingOriginalLaunchers -LifecycleLease $transaction.LifecycleLease } 'fresh lifecycle lease loss'
        $daemonPlan=@($transaction.Plans|Where-Object{$_.Role -ceq 'daemon'})[0]
        Assert-That ($script:restoreLeaseChecks -eq 2 -and (Test-Path -LiteralPath $daemonPlan.LauncherPath -PathType Leaf)) `
            'Lease loss did not retain the exclusively created launcher for manual recovery'
        Assert-That ((Get-TokeneloSha256 ([IO.File]::ReadAllBytes($daemonPlan.LauncherPath))) -ceq $daemonPlan.Snapshot.LauncherSha256) `
            'Lease loss changed the created launcher bytes'
        Assert-That (Test-Path -LiteralPath $daemonPlan.Snapshot.LauncherBytesPath -PathType Leaf) 'Lease loss removed the immutable launcher backup'
        Assert-That ($tasks.Count -eq 0 -and $mutations.Count -eq 0) 'Lease loss registered tasks or mutated scheduler state'
    } finally { $env:LOCALAPPDATA=$originalLocalAppData; Assert-FixtureParent $fixture.Parent }
}
Case 'uninstall recovery rollback refuses ACL or attribute drift on a restored launcher' {
    $aclFixture=New-PackagedRuntimeFixture
    try {
        $context=New-TestUninstallHeaderTransaction -Fixture $aclFixture -PresentRoles @('daemon')
        $transaction=$context.Transaction
        $transaction.LifecycleLease=[pscustomobject]@{Name=(Get-TokeneloLifecycleMutexName);Owned=$true;Abandoned=$false;Coordinator=$false}
        $script:tasks=@{}
        $daemonPlan=@($transaction.Plans|Where-Object{$_.Role -ceq 'daemon'})[0]
        $daemonPlan.UnregisterRequested=$true; $daemonPlan.LauncherRemovalRequested=$true
        [IO.File]::Delete($daemonPlan.LauncherPath)
        Set-Item -Path Function:\Assert-TokeneloCoordinatorLifecycleLeaseAlive -Value { param($Lease) }
        Restore-TokeneloLaunchers -Transaction $transaction -AllowMissingOriginalTasks -AllowMissingOriginalLaunchers `
            -LifecycleLease $transaction.LifecycleLease
        $beforeBytes=[IO.File]::ReadAllBytes($daemonPlan.LauncherPath)
        $acl=[Security.AccessControl.FileSecurity]::new()
        $acl.SetAccessRuleProtection($true,$false)
        $currentSid=[string][Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $acl.SetOwner([Security.Principal.SecurityIdentifier]::new($currentSid))
        $foreignRule=[Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),
            [Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow)
        $acl.AddAccessRule($foreignRule)
        $nativeSetAcl=Get-Command -Name 'Set-Acl' -Module 'Microsoft.PowerShell.Security' -ErrorAction Stop
        & $nativeSetAcl -LiteralPath $daemonPlan.LauncherPath -AclObject $acl -ErrorAction Stop
        Assert-Refused { Restore-TokeneloLaunchers -Transaction $transaction -AllowMissingOriginalTasks -AllowMissingOriginalLaunchers `
            -LifecycleLease $transaction.LifecycleLease } 'write access to another principal|metadata changed'
        Assert-That ((Get-TokeneloSha256 ([IO.File]::ReadAllBytes($daemonPlan.LauncherPath))) -ceq (Get-TokeneloSha256 $beforeBytes)) `
            'ACL drift refusal overwrote launcher bytes'
        Assert-That (Test-Path -LiteralPath $daemonPlan.Snapshot.LauncherBytesPath -PathType Leaf) 'ACL drift refusal removed the recovery backup'
    } finally { $env:LOCALAPPDATA=$originalLocalAppData; Assert-FixtureParent $aclFixture.Parent }

    $attributeFixture=New-PackagedRuntimeFixture
    try {
        $context=New-TestUninstallHeaderTransaction -Fixture $attributeFixture -PresentRoles @('daemon')
        $transaction=$context.Transaction
        $transaction.LifecycleLease=[pscustomobject]@{Name=(Get-TokeneloLifecycleMutexName);Owned=$true;Abandoned=$false;Coordinator=$false}
        $script:tasks=@{}
        $daemonPlan=@($transaction.Plans|Where-Object{$_.Role -ceq 'daemon'})[0]
        $daemonPlan.UnregisterRequested=$true; $daemonPlan.LauncherRemovalRequested=$true
        [IO.File]::Delete($daemonPlan.LauncherPath)
        Set-Item -Path Function:\Assert-TokeneloCoordinatorLifecycleLeaseAlive -Value { param($Lease) }
        Restore-TokeneloLaunchers -Transaction $transaction -AllowMissingOriginalTasks -AllowMissingOriginalLaunchers `
            -LifecycleLease $transaction.LifecycleLease
        $beforeBytes=[IO.File]::ReadAllBytes($daemonPlan.LauncherPath)
        $currentAttributes=[IO.File]::GetAttributes($daemonPlan.LauncherPath)
        [IO.File]::SetAttributes($daemonPlan.LauncherPath,$currentAttributes -bor [IO.FileAttributes]::Temporary)
        Assert-Refused { Restore-TokeneloLaunchers -Transaction $transaction -AllowMissingOriginalTasks -AllowMissingOriginalLaunchers `
            -LifecycleLease $transaction.LifecycleLease } 'metadata changed'
        Assert-That ((Get-TokeneloSha256 ([IO.File]::ReadAllBytes($daemonPlan.LauncherPath))) -ceq (Get-TokeneloSha256 $beforeBytes)) `
            'Attribute drift refusal overwrote launcher bytes'
        Assert-That (Test-Path -LiteralPath $daemonPlan.Snapshot.LauncherBytesPath -PathType Leaf) 'Attribute drift refusal removed the recovery backup'
    } finally { $env:LOCALAPPDATA=$originalLocalAppData; Assert-FixtureParent $attributeFixture.Parent }
}
Case 'actual child File dispatch covers entry lease install and uninstall transactions with fake OS boundaries' {
    $fixtures=[Collections.Generic.List[object]]::new()
    try {
        $dispatchScenarios=if($DispatchScenario){@($DispatchScenario)}else{@('uninstall','install','stop-race','foreign')}
        foreach($scenario in $dispatchScenarios){
            $fixture=New-PackagedRuntimeFixture
            $fixtures.Add($fixture)
            if($scenario -eq 'uninstall'){
                $sid=[string][Security.Principal.WindowsIdentity]::GetCurrent().User.Value
                $tokeneloRoot=Join-Path $fixture.LocalAppData 'Tokenelo'
                New-Item -ItemType Directory -Path $tokeneloRoot -Force | Out-Null
                Set-TestRecoveryDirectoryPrivateAcl -Path $fixture.LocalAppData -Sid $sid
                Set-TestRecoveryDirectoryPrivateAcl -Path $tokeneloRoot -Sid $sid
                $fixture|Add-Member -NotePropertyName LocalAppDataSddl -NotePropertyValue ([string](Get-TokeneloCoordinatorFileAcl -Path $fixture.LocalAppData).Sddl)
                $fixture|Add-Member -NotePropertyName TokeneloSddl -NotePropertyValue ([string](Get-TokeneloCoordinatorFileAcl -Path $tokeneloRoot).Sddl)
            }
            $child=Invoke-ActualDispatchChild -Scenario $scenario -Fixture $fixture
            $traceLines=@($child.Trace -split "`r?`n"|Where-Object{$_})
            $mutexCreates=@($traceLines|Where-Object{$_ -like 'mutex-create:*'})
            $mutexReleases=@($traceLines|Where-Object{$_ -ceq 'mutex-release'})
            $mutexDisposals=@($traceLines|Where-Object{$_ -ceq 'mutex-dispose'})
            Assert-That ($mutexCreates.Count -eq 1 -and $mutexReleases.Count -eq 1 -and $mutexDisposals.Count -eq 1) ($scenario+': actual outer dispatch did not acquire/release exactly one fake per-SID lease')
            if($scenario -eq 'uninstall'){
                Assert-That ($child.ExitCode -eq 0) ('Actual top-level uninstall child failed: '+(($child.Stderr -split "`r?`n"|Select-Object -First 4)-join ' '))
                $trayStop=[array]::IndexOf($traceLines,'stop:TokeneloTray'); $daemonStop=[array]::IndexOf($traceLines,'stop:TokeneloDaemon')
                $trayRemove=[array]::IndexOf($traceLines,'unregister:TokeneloTray'); $daemonRemove=[array]::IndexOf($traceLines,'unregister:TokeneloDaemon')
                Assert-That ($trayStop -ge 0 -and $daemonStop -gt $trayStop -and $trayRemove -ge 0 -and $daemonRemove -gt $trayRemove) 'Actual uninstall did not stop and unregister tray before daemon'
                Assert-That (@($traceLines|Where-Object{$_ -like 'query-after-uninstall:*'}).Count -eq 0) 'Actual top-level uninstall fell through into a later scheduler/stop query after commit'
                Assert-That (-not (Test-Path -LiteralPath (Join-Path $fixture.LocalAppData 'Tokenelo\launchers\tokenelo-daemon-launcher.exe')) -and
                    -not (Test-Path -LiteralPath (Join-Path $fixture.LocalAppData 'Tokenelo\launchers\tokenelo-tray-launcher.exe'))) 'Actual uninstall retained one of its fixture-owned launchers'
                Assert-That ([IO.File]::ReadAllText((Join-Path $fixture.LocalAppData 'Tokenelo\user-data\sentinel.txt')) -ceq 'preserve-me') 'Actual uninstall changed the isolated user-data sentinel'
                $recoveryBase=Join-Path $fixture.LocalAppData 'Tokenelo\recovery'
                $recoveryRoots=@(Get-ChildItem -LiteralPath $recoveryBase -Directory -Force)
                Assert-That ($recoveryRoots.Count -eq 1) 'Actual uninstall did not retain exactly one transaction recovery directory'
                $recoveryRoot=$recoveryRoots[0].FullName
                Assert-That ($traceLines -contains 'recovery-root-private-empty-before-first-journal') 'Actual uninstall did not prove protected empty recovery storage before its first journal write'
                $baseSddl=Assert-TestProtectedRecoveryDirectoryAcl -Path $recoveryBase -Sid ([string][Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
                $null=Assert-TestProtectedRecoveryDirectoryAcl -Path $recoveryRoot -Sid ([string][Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
                Assert-That ($baseSddl -and (Get-TokeneloCoordinatorFileAcl -Path $fixture.LocalAppData).Sddl -ceq $fixture.LocalAppDataSddl -and
                    (Get-TokeneloCoordinatorFileAcl -Path (Join-Path $fixture.LocalAppData 'Tokenelo')).Sddl -ceq $fixture.TokeneloSddl) 'Recovery provisioning changed an existing LocalAppData or Tokenelo directory ACL'
                Assert-That ((Get-ChildItem -LiteralPath $recoveryBase -Recurse -File).Count -gt 0) 'Actual uninstall failed to retain immutable task/launcher recovery snapshots'
                $oldLocalAppData=$env:LOCALAPPDATA
                try {
                    $env:LOCALAPPDATA=$fixture.LocalAppData
                    $sid=[string][Security.Principal.WindowsIdentity]::GetCurrent().User.Value
                    $beforeFiles=@(Get-ChildItem -LiteralPath $recoveryRoot -File -Force|ForEach-Object{[pscustomobject]@{Name=$_.Name;Hash=(Get-TokeneloSha256 ([IO.File]::ReadAllBytes($_.FullName)))}}|Sort-Object Name)
                    $beforeRootSddl=[string](Get-TokeneloCoordinatorFileAcl -Path $recoveryRoot).Sddl
                    $lease=[pscustomobject]@{Name=(Get-TokeneloLifecycleMutexName);Owned=$true;Abandoned=$false;Coordinator=$false}
                    Assert-Refused { New-TokeneloPrivateUninstallRecoveryDirectory -RecoveryBase $recoveryBase `
                        -RecoveryRoot $recoveryRoot -ExpectedOwnerSid $sid -LifecycleLease $lease } 'already exists'
                    $afterFiles=@(Get-ChildItem -LiteralPath $recoveryRoot -File -Force|ForEach-Object{[pscustomobject]@{Name=$_.Name;Hash=(Get-TokeneloSha256 ([IO.File]::ReadAllBytes($_.FullName)))}}|Sort-Object Name)
                    Assert-That ((ConvertTo-Json -InputObject $beforeFiles -Compress) -ceq (ConvertTo-Json -InputObject $afterFiles -Compress) -and
                        (Get-TokeneloCoordinatorFileAcl -Path $recoveryRoot).Sddl -ceq $beforeRootSddl) 'Recovery-root collision changed existing files or ACL'
                } finally { $env:LOCALAPPDATA=$oldLocalAppData }
            } elseif($scenario -eq 'install'){
                Assert-That ($child.ExitCode -eq 0) ('Actual top-level install child failed: '+(($child.Stderr -split "`r?`n"|Select-Object -First 5)-join ' '))
                $compile=[array]::IndexOf($traceLines,'compile:daemon'); $register=[array]::IndexOf($traceLines,'register:TokeneloDaemon'); $enable=[array]::IndexOf($traceLines,'enable:TokeneloDaemon')
                Assert-That ($compile -ge 0 -and $register -gt $compile -and $enable -gt $register) 'Actual install wrapper did not reach the actual unlocked transaction helper and task publication sequence'
                Assert-That (Test-Path -LiteralPath (Join-Path $fixture.LocalAppData 'Tokenelo\launchers\tokenelo-daemon-launcher.exe')) 'Actual install helper did not publish its isolated daemon launcher'
            } elseif($scenario -eq 'stop-race'){
                Assert-That ($child.ExitCode -ne 0) 'Actual uninstall accepted a role whose owner changed after stopping the tray'
                Assert-That (@($traceLines|Where-Object{$_ -ceq 'stop:TokeneloTray'}).Count -eq 1 -and
                    @($traceLines|Where-Object{$_ -ceq 'disable:TokeneloDaemon' -or $_ -ceq 'stop:TokeneloDaemon'}).Count -eq 0) 'Actual uninstall mutated the changed daemon after its between-role revalidation refusal'
            } else {
                Assert-That ($child.ExitCode -ne 0) 'Actual uninstall accepted a foreign task at preflight'
                Assert-That (@($traceLines|Where-Object{$_ -match '^(disable|stop|unregister|register|enable):'}).Count -eq 0) 'Foreign-role refusal occurred after a scheduler mutation'
            }
        }
    } finally { foreach($fixture in $fixtures){Assert-FixtureParent $fixture.Parent} }
}
$failed=@($results | Where-Object { -not $_.passed })
if ($SecurityModuleOnly -and $results.Count -ne 1) { throw 'SecurityModuleOnly must execute exactly one owned ACL fixture case.' }
if ($RecoveryHeaderOnly -and $results.Count -ne 8) { throw 'RecoveryHeaderOnly must execute exactly eight bounded recovery-header cases.' }
$algorithm=[Security.Cryptography.SHA256]::Create()
try { $sourceHash=[BitConverter]::ToString($algorithm.ComputeHash([IO.File]::ReadAllBytes($source))).Replace('-','').ToLowerInvariant() }
finally { $algorithm.Dispose() }
$report=[pscustomobject]@{ recordedAt=[datetime]::UtcNow.ToString('o'); scope='Real lifecycle functions with simulated scheduler/CIM; not installed task acceptance';
    passed=$results.Count-$failed.Count;failed=$failed.Count;cases=@($results);sourceSha256=$sourceHash;realTasksChanged=$false }
$json=$report | ConvertTo-Json -Depth 8
if ($OutputPath) { [IO.File]::WriteAllText($OutputPath,$json+"`n",[Text.UTF8Encoding]::new($false)) }
$json
if ($failed.Count) { exit 1 }
