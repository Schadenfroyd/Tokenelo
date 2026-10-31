[CmdletBinding()]
param([ValidateSet('all','manifest-assembler','full-runtime-positive','archive-v2-absent-install','archive-v1-absent-install','archive-receipt-mismatch','archive-extra-output','root-metadata-drift','source-root-acl-drift','corrupt-output','hash-drift','reparse','preexisting-root','partial-io','metadata-mismatch','manifest-case-collision','manifest-omits-runtime','manifest-omits-core-sentinel','ads','unexpected-element','unknown-root-extra','sensitive-manifest','sqlite-header','source-acl-drift','exclusive-root-race','mapped-network-drive','local-drive-policy','foreign-read-acl','foreign-acl','native-security-module-path','restore-positive-absent-install','restore-partial-current-retained','restore-v1-refused','restore-unexpected-current-refused','restore-reparse-refused','restore-ads-refused','restore-foreign-acl-refused','restore-copy-failure-retains','restore-publish-failure-renames-back','restore-guard-refusal-retains','restore-stage-tamper-refused','restore-foreign-publish-target-manual','restore-guard-string-true-rejected','restore-guard-integer-one-rejected','restore-guard-multiple-values-rejected','restore-publish-late-guard-loss-restores-current','manifest-assembler-positive-direct','manifest-assembler-positive-clone','manifest-assembler-template-pin-rejected','manifest-assembler-inventory-rejected','manifest-assembler-missing-extra-root','manifest-assembler-sensitive-sqlite','manifest-assembler-reparse-ads','manifest-assembler-uninstaller-receipt','manifest-assembler-template-attributes','manifest-assembler-guard-rejected','manifest-assembler-no-angle-target','manifest-assembler-declared-angle-missing','manifest-assembler-missing-core-target')][string]$Case = 'all')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$modulePath = Join-Path $repo 'scripts\windows\TokeneloPayloadRecovery.psm1'
Import-Module $modulePath -Force
$payloadModule = Get-Module -Name 'TokeneloPayloadRecovery'
if (-not $payloadModule) { throw 'Payload recovery module did not load for its bounded Windows tests.' }
$currentSid = [string][Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$caseResults = [Collections.Generic.List[object]]::new()

function Invoke-TestBoundedProcess {
    param([Diagnostics.ProcessStartInfo]$StartInfo,[string]$Name,[int]$TimeoutMs=5000)
    $proc=$null
    try{
        $proc=[Diagnostics.Process]::Start($StartInfo)
        $stdoutTask=$proc.StandardOutput.ReadToEndAsync();$stderrTask=$proc.StandardError.ReadToEndAsync()
        if(-not $proc.WaitForExit($TimeoutMs)){
            try{$proc.Kill()}catch{}
            $exited=$proc.WaitForExit(1000)
            $stdoutReady=$stdoutTask.Wait(1000);$stderrReady=$stderrTask.Wait(1000)
            $stdout=if($stdoutReady){$stdoutTask.Result}else{'<stdout not drained>'}
            $stderr=if($stderrReady){$stderrTask.Result}else{'<stderr not drained>'}
            throw "$Name timeout; pid=$($proc.Id); exitedAfterKill=$exited; $stderr $stdout"
        }
        $stdoutReady=$stdoutTask.Wait(1000);$stderrReady=$stderrTask.Wait(1000)
        if(-not $stdoutReady -or -not $stderrReady){throw "$Name exited but streams did not drain; pid=$($proc.Id)"}
        $stdout=$stdoutTask.Result;$stderr=$stderrTask.Result
        return [pscustomobject]@{ExitCode=$proc.ExitCode;Stdout=$stdout;Stderr=$stderr;ProcessId=$proc.Id}
    }finally{if($proc){$proc.Dispose()}}
}

function Invoke-TestIcacls {
    param([string]$Arguments)
    $exe=Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)) 'System32\icacls.exe'
    $psi=[Diagnostics.ProcessStartInfo]::new();$psi.FileName=$exe;$psi.Arguments=$Arguments
    $psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.WindowStyle=[Diagnostics.ProcessWindowStyle]::Hidden
    $psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
    $result=Invoke-TestBoundedProcess -StartInfo $psi -Name 'Fixture icacls'
    if($result.ExitCode -ne 0){throw "Fixture icacls failed ($($result.ExitCode)): $($result.Stderr) $($result.Stdout)"}
}

function New-TestPrivateDirectory {
    param([string]$Path,[string]$Sid)
    if(Test-Path -LiteralPath $Path){throw "Fixture path already exists: $Path"}
    $null = New-Item -ItemType Directory -Path ([Management.Automation.WildcardPattern]::Escape($Path)) -ErrorAction Stop
    Invoke-TestIcacls -Arguments ('"'+$Path+'" /inheritance:r /grant:r *'+$Sid+':(OI)(CI)F *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F')
}

function Get-TestSha256 {
    param([byte[]]$Bytes)
    $sha=[Security.Cryptography.SHA256]::Create()
    try{return [BitConverter]::ToString($sha.ComputeHash($Bytes)).Replace('-','').ToLowerInvariant()}
    finally{$sha.Dispose()}
}

function Get-TestDirectorySddl {
    param([string]$Path)
    $acl=& $payloadModule {param([string]$Target) Get-TokeneloPayloadAcl -Path $Target -Directory} $Path
    return [string]$acl.Sddl
}

function Get-TestFileSddl {
    param([string]$Path)
    $method=[IO.File].GetMethod('GetAccessControl',[type[]]@([string]))
    if($null -ne $method){$acl=$method.Invoke($null,@($Path))}
    else{
        $extensionType=[type]::GetType('System.IO.FileSystemAclExtensions, System.IO.FileSystem.AccessControl')
        if(-not $extensionType){Add-Type -AssemblyName System.IO.FileSystem.AccessControl -ErrorAction Stop;$extensionType=[type]::GetType('System.IO.FileSystemAclExtensions, System.IO.FileSystem.AccessControl')}
        if(-not $extensionType){throw 'Native .NET file ACL extension was unavailable without loading the PowerShell Security module.'}
        $extensionMethod=$extensionType.GetMethod('GetAccessControl',[type[]]@([IO.FileInfo]))
        if(-not $extensionMethod){throw 'Native .NET file ACL method was unavailable without loading the PowerShell Security module.'}
        $acl=$extensionMethod.Invoke($null,@([IO.FileInfo]::new($Path)))
    }
    if ($acl.PSObject.Properties['Sddl']) { return [string]$acl.Sddl }
    return [string]$acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All)
}

function Get-TestFileAccessSids {
    param([string]$Path)
    $method=[IO.File].GetMethod('GetAccessControl',[type[]]@([string]))
    if($null -ne $method){$acl=$method.Invoke($null,@($Path))}else{$acl=Get-Acl -LiteralPath $Path}
    return @($acl.Access|ForEach-Object{$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value})
}

function New-TestManifest {
    param([string]$InstallRoot,[string]$Sid,[string]$PackageIdentity='com.elostudios.tokenelo',[switch]$BadAttributeType,[string[]]$AdditionalRelativeFiles=@())
    $relativeFiles=@('Tokenelo.exe','Uninstall Tokenelo.exe','chrome_100_percent.pak','chrome_200_percent.pak','icudtl.dat',
        'libEGL.dll','libGLESv2.dll','resources.pak','snapshot_blob.bin','v8_context_snapshot.bin','locales/en-US.pak',
        'resources/app.asar','resources/native/bin/helper.dll')+@($AdditionalRelativeFiles)
    $entries=[Collections.Generic.List[object]]::new()
    foreach($relative in $relativeFiles){
        $path=Join-Path $InstallRoot ($relative.Replace('/','\'))
        $bytes=[IO.File]::ReadAllBytes($path)
        $attributes=[int][IO.File]::GetAttributes($path)
        if($BadAttributeType -and $relative -ceq 'Tokenelo.exe'){$attributes=[string]$attributes}
        $entries.Add([ordered]@{relativePath=$relative;sizeBytes=[long]$bytes.Length;sha256=(Get-TestSha256 -Bytes $bytes);attributes=$attributes})
    }
    $manifest=[ordered]@{schemaVersion=2;manifestScope='full-install-root';packageIdentity=$PackageIdentity;installRoot=$InstallRoot;userSid=$Sid;
        applicationExe='Tokenelo.exe';uninstallerExe='Uninstall Tokenelo.exe';resourcesRoot='resources';files=@($entries.ToArray())}
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($manifest|ConvertTo-Json -Depth 8 -Compress))
    return [pscustomobject]@{Bytes=$bytes;Sha256=(Get-TestSha256 -Bytes $bytes)}
}

function New-TestFixture {
    $fixtureRoot=Join-Path 'C:\Temp' ('tokenelo-r3287-payload-fixture-'+[guid]::NewGuid().ToString('N'))
    New-TestPrivateDirectory -Path $fixtureRoot -Sid $currentSid
    $install=Join-Path $fixtureRoot 'install'
    $recoveryParent=Join-Path $fixtureRoot 'recovery'
    New-TestPrivateDirectory -Path $install -Sid $currentSid
    New-TestPrivateDirectory -Path $recoveryParent -Sid $currentSid
    $resources=Join-Path $install 'resources'
    $native=Join-Path $resources 'native'
    $bin=Join-Path $native 'bin'
    $locales=Join-Path $install 'locales'
    New-TestPrivateDirectory -Path $resources -Sid $currentSid
    New-TestPrivateDirectory -Path $native -Sid $currentSid
    New-TestPrivateDirectory -Path $bin -Sid $currentSid
    New-TestPrivateDirectory -Path $locales -Sid $currentSid
    $payload=@{
        'Tokenelo.exe'=[Text.Encoding]::UTF8.GetBytes('fixture-tokenelo-executable-v1')
        'Uninstall Tokenelo.exe'=[Text.Encoding]::UTF8.GetBytes('fixture-tokenelo-uninstaller-v1')
        'chrome_100_percent.pak'=[Text.Encoding]::UTF8.GetBytes('fixture-chrome-100-pak-v1')
        'chrome_200_percent.pak'=[Text.Encoding]::UTF8.GetBytes('fixture-chrome-200-pak-v1')
        'icudtl.dat'=[Text.Encoding]::UTF8.GetBytes('fixture-icu-data-v1')
        'libEGL.dll'=[Text.Encoding]::UTF8.GetBytes('fixture-libegl-v1')
        'libGLESv2.dll'=[Text.Encoding]::UTF8.GetBytes('fixture-libgles-v1')
        'resources.pak'=[Text.Encoding]::UTF8.GetBytes('fixture-resources-pak-v1')
        'snapshot_blob.bin'=[Text.Encoding]::UTF8.GetBytes('fixture-snapshot-blob-v1')
        'v8_context_snapshot.bin'=[Text.Encoding]::UTF8.GetBytes('fixture-v8-context-v1')
        'locales/en-US.pak'=[Text.Encoding]::UTF8.GetBytes('fixture-en-us-locale-v1')
        'resources/app.asar'=[Text.Encoding]::UTF8.GetBytes('fixture-packaged-app-resource-v1')
        'resources/native/bin/helper.dll'=[Text.Encoding]::UTF8.GetBytes('fixture-native-helper-resource-v1')
    }
    foreach($relative in $payload.Keys){
        $path=Join-Path $install ($relative.Replace('/','\'))
        [IO.File]::WriteAllBytes($path,[byte[]]$payload[$relative])
    }
    $manifest=New-TestManifest -InstallRoot $install -Sid $currentSid
    return [pscustomobject]@{Root=$fixtureRoot;Install=$install;RecoveryParent=$recoveryParent;
        RecoveryRoot=(Join-Path $recoveryParent ([guid]::NewGuid().ToString('N')));Manifest=$manifest;Payload=$payload;Sid=$currentSid}
}

function Get-TestManifestTreeFingerprint {
    param([Parameter(Mandatory=$true)][string]$Path)
    $root=[IO.Path]::GetFullPath($Path).TrimEnd('\')
    $records=[Collections.Generic.List[string]]::new()
    $rootState=Get-Item -LiteralPath $root -Force -ErrorAction Stop
    $records.Add(('ROOT|'+[int]$rootState.Attributes+'|'+(Get-TestDirectorySddl -Path $root)))
    $pending=[Collections.Generic.Stack[string]]::new();$pending.Push($root)
    while($pending.Count -gt 0){
        $directory=$pending.Pop()
        foreach($item in @(Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop)){
            $relative=$item.FullName.Substring($root.Length).TrimStart('\')
            if($item.PSIsContainer){
                $acl=& $payloadModule {param([string]$Target) Get-TokeneloPayloadAcl -Path $Target -Directory} $item.FullName
            }else{
                $acl=& $payloadModule {param([string]$Target) Get-TokeneloPayloadAcl -Path $Target} $item.FullName
            }
            if($item.PSIsContainer){
                $records.Add(('D|'+$relative+'|'+[int]$item.Attributes+'|'+[string]$acl.Sddl))
                if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0){$pending.Push($item.FullName)}
            }else{
                $bytes=[IO.File]::ReadAllBytes($item.FullName)
                $records.Add(('F|'+$relative+'|'+[int]$item.Attributes+'|'+$bytes.Length+'|'+(Get-TestSha256 -Bytes $bytes)+'|'+[string]$acl.Sddl))
            }
        }
    }
    $sorted=[string[]]$records.ToArray();[Array]::Sort($sorted,[StringComparer]::Ordinal)
    return Get-TestSha256 -Bytes ([Text.UTF8Encoding]::new($false).GetBytes(($sorted -join "`n")))
}

function New-TestManifestAssemblerGuard {
    param($Fixture,[string[]]$RejectBoundaries=@(),
        [ValidateSet('boolean-true','string-true','integer-one','multiple-values')][string]$OutputMode='boolean-true')
    $receipt=$Fixture.UninstallerBindingReceipt
    $transactionId=[string]$receipt.transactionId
    $leaseName=[string]$receipt.leaseName
    $userSid=[string]$receipt.userSid
    $executionMode=[string]$receipt.executionMode
    $runningImagePath=[string]$receipt.runningImagePath
    $coordinatorProcessId=[long]$receipt.coordinatorProcessId
    $coordinatorBirth=[string]$receipt.coordinatorProcessStartUtcTicks
    $reject=$RejectBoundaries
    $validator={
        param([string]$Boundary,[string]$TransactionId,[string]$LeaseName,[string]$UserSid)
        if($TransactionId -cne $transactionId -or $LeaseName -cne $leaseName -or $UserSid -cne $userSid -or
            $receipt.transactionId -cne $transactionId -or $receipt.leaseName -cne $leaseName -or
            $receipt.userSid -cne $userSid -or $receipt.executionMode -cne $executionMode -or
            $receipt.runningImagePath -cne $runningImagePath -or
            [long]$receipt.coordinatorProcessId -ne $coordinatorProcessId -or
            $receipt.coordinatorProcessStartUtcTicks -cne $coordinatorBirth -or $reject -ccontains $Boundary){return $false}
        if($OutputMode -ceq 'string-true'){return 'True'}
        if($OutputMode -ceq 'integer-one'){return 1}
        if($OutputMode -ceq 'multiple-values'){return @($true,$false)}
        return $true
    }.GetNewClosure()
    return [pscustomobject]@{schemaVersion=1;leaseName=$leaseName;userSid=$userSid;transactionId=$transactionId;
        actorsQuiesced=$true;validate=$validator}
}

function New-TestManifestAssemblerFixture {
    param([ValidateSet('installed-image','byte-matching-temp-clone')][string]$ExecutionMode='byte-matching-temp-clone')
    $root=Join-Path 'C:\Temp' ('tokenelo-r3331-manifest-fixture-'+[guid]::NewGuid().ToString('N'))
    New-TestPrivateDirectory -Path $root -Sid $currentSid
    $install=Join-Path $root 'install';New-TestPrivateDirectory -Path $install -Sid $currentSid
    foreach($relative in @('resources','locales','resources\app','resources\app\dist',
        'resources\app\dist\tray','resources\app\dist\daemon')){
        New-TestPrivateDirectory -Path (Join-Path $install $relative) -Sid $currentSid
    }
    $packageBytes=[Text.UTF8Encoding]::new($false).GetBytes('{"name":"tokenelo","private":true,"type":"module","main":"dist/tray/main.js"}' + "`n")
    $uninstallerBytes=[Text.Encoding]::UTF8.GetBytes('synthetic Tokenelo uninstaller image v1')
    $payload=[ordered]@{
        'Tokenelo.exe'=[Text.Encoding]::UTF8.GetBytes('synthetic Tokenelo executable v1')
        'icudtl.dat'=[Text.Encoding]::UTF8.GetBytes('synthetic ICU payload v1')
        'resources.pak'=[Text.Encoding]::UTF8.GetBytes('synthetic resource pack v1')
        'libEGL.dll'=[Text.Encoding]::UTF8.GetBytes('synthetic EGL runtime v1')
        'libGLESv2.dll'=[Text.Encoding]::UTF8.GetBytes('synthetic GLES runtime v1')
        'v8_context_snapshot.bin'=[Text.Encoding]::UTF8.GetBytes('synthetic V8 snapshot v1')
        'locales/en-US.pak'=[Text.Encoding]::UTF8.GetBytes('synthetic locale v1')
        'resources/app/package.json'=$packageBytes
        'resources/app/dist/tray/main.js'=[Text.Encoding]::UTF8.GetBytes('synthetic tray entry v1')
        'resources/app/dist/daemon/main.js'=[Text.Encoding]::UTF8.GetBytes('synthetic daemon entry v1')
        'Uninstall Tokenelo.exe'=$uninstallerBytes
    }
    foreach($relative in $payload.Keys){
        $path=Join-Path $install ($relative.Replace('/','\'))
        [IO.File]::WriteAllBytes($path,[byte[]]$payload[$relative])
    }
    $inventoryFiles=[string[]]@($payload.Keys|Where-Object{$_ -cne 'Uninstall Tokenelo.exe'})
    [Array]::Sort($inventoryFiles,[StringComparer]::Ordinal)
    $inventory=[ordered]@{schemaVersion=1;kind='tokenelo-windows-payload-expected-inventory';
        packageIdentity='com.elostudios.tokenelo';applicationPackageName='tokenelo';files=$inventoryFiles}
    $inventoryBytes=[Text.UTF8Encoding]::new($false).GetBytes((($inventory|ConvertTo-Json -Depth 4 -Compress)+"`n"))
    $inventorySha=Get-TestSha256 -Bytes $inventoryBytes
    $templateFiles=[Collections.Generic.List[object]]::new()
    foreach($relative in $inventoryFiles){
        $bytes=[IO.File]::ReadAllBytes((Join-Path $install ($relative.Replace('/','\'))))
        $templateFiles.Add([ordered]@{relativePath=$relative;sizeBytes=[long]$bytes.Length;sha256=(Get-TestSha256 -Bytes $bytes)})
    }
    $template=[ordered]@{
        schemaVersion=1;kind='tokenelo-windows-nsis-payload-template';manifestScope='unpacked-install-template'
        packageIdentity='com.elostudios.tokenelo';fullInstallRoot=$false;fullRootReady=$false;restoreInputAllowed=$false
        trustedExpectedFileSetSha256=$inventorySha;expectedFileSetProvenance='caller-supplied; this producer does not authenticate its origin'
        applicationExe='Tokenelo.exe';applicationPackagePath='resources/app/package.json'
        generatedUninstallerPath='Uninstall Tokenelo.exe';templateRelativePath='resources/app/windows-payload-manifest.template.json'
        files=@($templateFiles.ToArray())
        runtimeBindingContract=[ordered]@{
            templateSelfIncluded=$false;generatedUninstallerIncluded=$false;compiledNsisMustPinTemplateSha256=$true
            runtimeAssemblerMustAddTemplateAndVerifiedUninstaller=$true;runtimeAssemblerMustVerifyEveryFileSizeAndSha256=$true
            windowsFileAttributesOwnerAndAcl='runtime-bound-after-content-match'
            windowsReparsePoints='must-be-rejected-by-windows-runtime-assembler'
            ntfsAlternateStreams='must-be-rejected-by-windows-runtime-assembler'
            pathBasedChecksDoNotProveHostileConcurrentWriterSafety=$true;signedPackageOrPackageAuthenticityAttested=$false
        }
    }
    $templateBytes=[Text.UTF8Encoding]::new($false).GetBytes((($template|ConvertTo-Json -Depth 8 -Compress)+"`n"))
    $templatePath=Join-Path $install 'resources\app\windows-payload-manifest.template.json'
    [IO.File]::WriteAllBytes($templatePath,$templateBytes)
    $cloneDir=Join-Path $root 'running-image';New-TestPrivateDirectory -Path $cloneDir -Sid $currentSid
    $clonePath=Join-Path $cloneDir 'Uninstall Tokenelo.exe'
    if($ExecutionMode -ceq 'byte-matching-temp-clone'){[IO.File]::WriteAllBytes($clonePath,$uninstallerBytes)}
    $installedPath=Join-Path $install 'Uninstall Tokenelo.exe'
    $runningImagePath=if($ExecutionMode -ceq 'installed-image'){$installedPath}else{$clonePath}
    $uninstallerSha=Get-TestSha256 -Bytes $uninstallerBytes
    $receipt=[pscustomobject]@{
        schemaVersion=1;kind='tokenelo-windows-uninstaller-binding';packageIdentity='com.elostudios.tokenelo'
        installRoot=$install;userSid=$currentSid;leaseName=('Global\Tokenelo-ServiceLifecycle-'+$currentSid)
        transactionId=[guid]::NewGuid().ToString('N');executionMode=$ExecutionMode
        uninstallerRelativePath='Uninstall Tokenelo.exe';installedSizeBytes=[long]$uninstallerBytes.Length
        installedSha256=$uninstallerSha;runningImagePath=$runningImagePath
        runningImageSizeBytes=[long]$uninstallerBytes.Length;runningImageSha256=$uninstallerSha
        coordinatorProcessId=[long]12345;coordinatorProcessStartUtcTicks=[DateTime]::UtcNow.Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)
    }
    $fixture=[pscustomobject]@{Root=$root;Install=$install;Sid=$currentSid;PackageIdentity='com.elostudios.tokenelo'
        Payload=$payload;InventoryFiles=$inventoryFiles;InventoryBytes=$inventoryBytes;InventorySha256=$inventorySha
        TemplatePath=$templatePath;TemplateBytes=$templateBytes;TemplateSha256=(Get-TestSha256 -Bytes $templateBytes)
        UninstallerBindingReceipt=$receipt;ExecutionMode=$ExecutionMode}
    $fixture | Add-Member -NotePropertyName LifecycleGuard -NotePropertyValue (New-TestManifestAssemblerGuard -Fixture $fixture)
    return $fixture
}

function Rebuild-TestManifestAssemblerBindings {
    param($Fixture)
    $templateRelative='resources/app/windows-payload-manifest.template.json'
    $relativeFiles=[Collections.Generic.List[string]]::new()
    foreach($file in @(Get-ChildItem -LiteralPath $Fixture.Install -File -Force -Recurse)){
        $relative=$file.FullName.Substring($Fixture.Install.Length).TrimStart('\').Replace('\','/')
        if($relative -cne 'Uninstall Tokenelo.exe' -and $relative -cne $templateRelative){$relativeFiles.Add($relative)}
    }
    $inventoryFiles=[string[]]$relativeFiles.ToArray();[Array]::Sort($inventoryFiles,[StringComparer]::Ordinal)
    $inventory=[ordered]@{schemaVersion=1;kind='tokenelo-windows-payload-expected-inventory';
        packageIdentity='com.elostudios.tokenelo';applicationPackageName='tokenelo';files=$inventoryFiles}
    $inventoryBytes=[Text.UTF8Encoding]::new($false).GetBytes((($inventory|ConvertTo-Json -Depth 4 -Compress)+"`n"))
    $inventorySha=Get-TestSha256 -Bytes $inventoryBytes
    $entries=[Collections.Generic.List[object]]::new()
    foreach($relative in $inventoryFiles){
        $bytes=[IO.File]::ReadAllBytes((Join-Path $Fixture.Install ($relative.Replace('/','\'))))
        $entries.Add([ordered]@{relativePath=$relative;sizeBytes=[long]$bytes.Length;sha256=(Get-TestSha256 -Bytes $bytes)})
    }
    $template=[ordered]@{
        schemaVersion=1;kind='tokenelo-windows-nsis-payload-template';manifestScope='unpacked-install-template'
        packageIdentity='com.elostudios.tokenelo';fullInstallRoot=$false;fullRootReady=$false;restoreInputAllowed=$false
        trustedExpectedFileSetSha256=$inventorySha;expectedFileSetProvenance='caller-supplied; this producer does not authenticate its origin'
        applicationExe='Tokenelo.exe';applicationPackagePath='resources/app/package.json'
        generatedUninstallerPath='Uninstall Tokenelo.exe';templateRelativePath=$templateRelative
        files=@($entries.ToArray())
        runtimeBindingContract=[ordered]@{
            templateSelfIncluded=$false;generatedUninstallerIncluded=$false;compiledNsisMustPinTemplateSha256=$true
            runtimeAssemblerMustAddTemplateAndVerifiedUninstaller=$true;runtimeAssemblerMustVerifyEveryFileSizeAndSha256=$true
            windowsFileAttributesOwnerAndAcl='runtime-bound-after-content-match'
            windowsReparsePoints='must-be-rejected-by-windows-runtime-assembler'
            ntfsAlternateStreams='must-be-rejected-by-windows-runtime-assembler'
            pathBasedChecksDoNotProveHostileConcurrentWriterSafety=$true;signedPackageOrPackageAuthenticityAttested=$false
        }
    }
    $templateBytes=[Text.UTF8Encoding]::new($false).GetBytes((($template|ConvertTo-Json -Depth 8 -Compress)+"`n"))
    $templatePath=Join-Path $Fixture.Install ($templateRelative.Replace('/','\'))
    [IO.File]::WriteAllBytes($templatePath,$templateBytes)
    $Fixture.InventoryFiles=$inventoryFiles;$Fixture.InventoryBytes=$inventoryBytes;$Fixture.InventorySha256=$inventorySha
    $Fixture.TemplateBytes=$templateBytes;$Fixture.TemplateSha256=Get-TestSha256 -Bytes $templateBytes
}

function Invoke-TestManifestAssembler {
    param($Fixture,[string]$CompiledTemplateSha256=$Fixture.TemplateSha256,
        [byte[]]$TrustedInventoryBytes=$Fixture.InventoryBytes,[string]$TrustedInventorySha256=$Fixture.InventorySha256,
        $UninstallerBindingReceipt=$Fixture.UninstallerBindingReceipt,$LifecycleGuard=$Fixture.LifecycleGuard)
    return New-TokeneloPayloadManifestFromTemplate -InstallRoot $Fixture.Install -ExpectedInstallRoot $Fixture.Install `
        -PackageIdentity $Fixture.PackageIdentity -UserSid $Fixture.Sid -CompiledTemplateSha256 $CompiledTemplateSha256 `
        -TrustedInventoryBytes $TrustedInventoryBytes -TrustedInventorySha256 $TrustedInventorySha256 `
        -UninstallerBindingReceipt $UninstallerBindingReceipt -LifecycleGuard $LifecycleGuard
}

function Assert-TestManifestAssemblerSuccess {
    param($Fixture)
    $before=Get-TestManifestTreeFingerprint -Path $Fixture.Root
    $result=Invoke-TestManifestAssembler -Fixture $Fixture
    $manifest=[Text.Encoding]::UTF8.GetString([byte[]]$result.ExpectedManifestBytes)|ConvertFrom-Json -ErrorAction Stop
    $expectedKeys=@('schemaVersion','manifestScope','packageIdentity','installRoot','userSid','applicationExe','uninstallerExe','resourcesRoot','files')
    Assert-Test -Condition ($manifest.schemaVersion -eq 2 -and $manifest.manifestScope -ceq 'full-install-root' -and
        $manifest.packageIdentity -ceq $Fixture.PackageIdentity -and $manifest.installRoot -ieq $Fixture.Install -and
        $manifest.userSid -ceq $Fixture.Sid -and $manifest.applicationExe -ceq 'Tokenelo.exe' -and
        $manifest.uninstallerExe -ceq 'Uninstall Tokenelo.exe' -and @($manifest.PSObject.Properties.Name).Count -eq $expectedKeys.Count -and
        @($manifest.PSObject.Properties.Name|Where-Object{$expectedKeys -cnotcontains $_}).Count -eq 0) `
        -Message 'factory must return only the exact schema-2 full-root contract'
    Assert-Test -Condition ((Get-TestSha256 -Bytes ([byte[]]$result.ExpectedManifestBytes)) -ceq $result.ExpectedManifestSha256) `
        -Message 'returned manifest SHA must bind the exact returned bytes'
    Assert-Test -Condition ($result.TemplateSha256 -ceq $Fixture.TemplateSha256 -and
        $result.TrustedInventorySha256 -ceq $Fixture.InventorySha256 -and
        $result.UninstallerSha256 -ceq $Fixture.UninstallerBindingReceipt.installedSha256 -and
        $result.UninstallerExecutionMode -ceq $Fixture.ExecutionMode -and $result.LeaseVerifiedByModule -eq $false) `
        -Message 'result must report bound inputs without claiming independent lease proof'
    Assert-Test -Condition ($result.CoordinatorProcessId -eq $Fixture.UninstallerBindingReceipt.coordinatorProcessId -and
        $result.CoordinatorProcessStartUtcTicks -ceq $Fixture.UninstallerBindingReceipt.coordinatorProcessStartUtcTicks) `
        -Message 'result must expose receipt identity metadata without independently attesting it'
    $expectedPaths=[Collections.Generic.List[string]]::new()
    foreach($path in $Fixture.InventoryFiles){$expectedPaths.Add($path)}
    $expectedPaths.Add('resources/app/windows-payload-manifest.template.json')
    $expectedPaths.Add('Uninstall Tokenelo.exe')
    Assert-Test -Condition ($manifest.files.Count -eq $expectedPaths.Count -and $result.FileCount -eq $expectedPaths.Count) `
        -Message 'full-root manifest must include each inventory path plus template and uninstaller'
    $actualSet=New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    $total=[long]0
    foreach($entry in $manifest.files){
        Assert-Test -Condition (@($entry.PSObject.Properties.Name).Count -eq 4 -and
            @($entry.PSObject.Properties.Name|Where-Object{@('relativePath','sizeBytes','sha256','attributes') -cnotcontains $_}).Count -eq 0) `
            -Message 'full-root manifest file entry must contain only the four schema-2 fields'
        Assert-Test -Condition ($actualSet.Add([string]$entry.relativePath)) -Message ('duplicate manifest path '+$entry.relativePath)
        $path=Join-Path $Fixture.Install ($entry.relativePath.Replace('/','\'))
        $bytes=[IO.File]::ReadAllBytes($path)
        Assert-Test -Condition ($bytes.Length -eq [long]$entry.sizeBytes -and
            (Get-TestSha256 -Bytes $bytes) -ceq $entry.sha256 -and
            [int][IO.File]::GetAttributes($path) -eq [int]$entry.attributes) `
            -Message ('manifest content/metadata mismatch for '+$entry.relativePath)
        $total += [long]$entry.sizeBytes
    }
    foreach($path in $expectedPaths){Assert-Test -Condition ($actualSet.Contains($path)) -Message ('missing full-root path '+$path)}
    Assert-Test -Condition ($total -eq [long]$result.TotalBytes) -Message 'reported total bytes must match the complete manifest'
    Assert-Test -Condition ((Get-TestManifestTreeFingerprint -Path $Fixture.Root) -ceq $before) `
        -Message 'manifest assembly must not write or alter payload, clone, attributes, or ACLs'
    $validated=& $payloadModule {param([byte[]]$Bytes,[string]$Sha,[string]$Root,[string]$Sid,[string]$Identity)
        Assert-TokeneloRecoveryManifest -ManifestBytes $Bytes -ManifestSha256 $Sha -InstallRoot $Root -UserSid $Sid -PackageIdentity $Identity
    } ([byte[]]$result.ExpectedManifestBytes) ([string]$result.ExpectedManifestSha256) $Fixture.Install $Fixture.Sid $Fixture.PackageIdentity
    Assert-Test -Condition ($validated.Files.Count -eq $manifest.files.Count) -Message 'existing recovery schema validator must accept factory output'
    return $result
}

function Assert-TestManifestAssemblerRefusal {
    param($Fixture,[scriptblock]$Action,[string[]]$ExpectedCodes,[string]$Message)
    $before=Get-TestManifestTreeFingerprint -Path $Fixture.Root
    Assert-TestPayloadFailureCode -Action $Action -ExpectedCodes $ExpectedCodes -Message $Message
    Assert-Test -Condition ((Get-TestManifestTreeFingerprint -Path $Fixture.Root) -ceq $before) `
        -Message ($Message+'; refusal must leave the synthetic install and receipt unchanged')
}

function Assert-TestPayloadFailureCode {
    param([scriptblock]$Action,[string[]]$ExpectedCodes,[string]$Message)
    $caught=$null
    try{& $Action|Out-Null}catch{$caught=$_}
    Assert-Test -Condition ($null -ne $caught) -Message $Message
    $exception=$caught.Exception;$actual=$null
    while($exception){
        if($exception.Data.Contains('TokeneloPayloadCode')){$actual=[string]$exception.Data['TokeneloPayloadCode'];break}
        $exception=$exception.InnerException
    }
    Assert-Test -Condition ($ExpectedCodes -ccontains $actual) -Message ($Message+'; code='+[string]$actual)
}

function Invoke-TestSnapshot {
    param($Fixture,[byte[]]$ManifestBytes=$Fixture.Manifest.Bytes,[string]$ManifestSha256=$Fixture.Manifest.Sha256,
        [string]$PackageIdentity='com.elostudios.tokenelo',[bool]$ActorsQuiesced=$true,[bool]$LeaseHeld=$true)
    return New-TokeneloPayloadRecoverySnapshot -InstallRoot $Fixture.Install -ExpectedInstallRoot $Fixture.Install `
        -RecoveryParent $Fixture.RecoveryParent -RecoveryRoot $Fixture.RecoveryRoot -PackageIdentity $PackageIdentity `
        -UserSid $Fixture.Sid -ExpectedManifestBytes $ManifestBytes -ExpectedManifestSha256 $ManifestSha256 `
        -CallerActorsQuiesced $ActorsQuiesced -CallerLeaseHeld $LeaseHeld `
        -CallerLeaseName ('Global\Tokenelo-ServiceLifecycle-'+$Fixture.Sid)
}

function Invoke-TestArchive {
    param($Fixture,[string]$MetadataSha256)
    if(-not $MetadataSha256){$MetadataSha256=Get-TestSha256 -Bytes ([IO.File]::ReadAllBytes((Join-Path $Fixture.RecoveryRoot 'payload-recovery.json')))}
    return Test-TokeneloPayloadRecoveryArchive -RecoveryRoot $Fixture.RecoveryRoot -RecoveryParent $Fixture.RecoveryParent `
        -PackageIdentity 'com.elostudios.tokenelo' -InstallRoot $Fixture.Install -UserSid $Fixture.Sid `
        -ExpectedManifestBytes $Fixture.Manifest.Bytes -ExpectedManifestSha256 $Fixture.Manifest.Sha256 `
        -ExpectedSnapshotMetadataSha256 $MetadataSha256
}

function New-TestRestoreFixture {
    $fixture=New-TestFixture
    $appParent=Join-Path $fixture.Root 'app'
    New-TestPrivateDirectory -Path $appParent -Sid $fixture.Sid
    $oldInstall=Join-Path $fixture.Root 'install-before-relocation'
    [IO.Directory]::Move($fixture.Install,$oldInstall)
    $fixture.Install=Join-Path $appParent 'Tokenelo'
    [IO.Directory]::Move($oldInstall,$fixture.Install)
    $fixture.Manifest=New-TestManifest -InstallRoot $fixture.Install -Sid $fixture.Sid
    return $fixture
}

function New-TestRestoreGuard {
    param($Fixture,[string[]]$RejectBoundaries=@(),[string]$TamperBoundary,[string]$TamperPath,
        [string]$PublishOccupantDirectory,[string]$TransactionId,
        [ValidateSet('boolean-true','string-true','integer-one','multiple-values')][string]$OutputMode='boolean-true')
    $rejectExpression=''
    if($RejectBoundaries.Count -gt 0){
        $parts=@($RejectBoundaries|ForEach-Object{"`$Boundary -ceq '"+([string]$_).Replace("'","''")+"'"})
        $rejectExpression='if('+($parts -join ' -or ')+'){return $false};'
    }
    $tamperExpression=''
    if($TamperBoundary){
        $escapedBoundary=$TamperBoundary.Replace("'","''")
        $escapedPath=$TamperPath.Replace("'","''")
        $tamperExpression="if(`$Boundary -ceq '$escapedBoundary'){[IO.File]::WriteAllText('$escapedPath','injected-stage-tamper',[Text.UTF8Encoding]::new(`$false))};"
    }
    $occupantExpression=''
    if($PublishOccupantDirectory){
        $escapedDirectory=$PublishOccupantDirectory.Replace("'","''")
        $escapedSentinel=(Join-Path $PublishOccupantDirectory 'foreign-destination-sentinel.txt').Replace("'","''")
        $occupantExpression="if(`$Boundary -ceq 'publish-stage'){`$null=[IO.Directory]::CreateDirectory('$escapedDirectory');[IO.File]::WriteAllText('$escapedSentinel','foreign-destination-retained',[Text.UTF8Encoding]::new(`$false))};"
    }
    $returnExpression=switch($OutputMode){
        'string-true' {"Write-Output 'True'"}
        'integer-one' {'Write-Output 1'}
        'multiple-values' {'Write-Output ([bool]$true);Write-Output ([bool]$false)'}
        default {'Write-Output ([bool]$true)'}
    }
    $validator=[scriptblock]::Create("param([string]`$Boundary,[string]`$TransactionId,[string]`$LeaseName,[string]`$UserSid);$rejectExpression$tamperExpression$occupantExpression$returnExpression")
    if(-not $TransactionId){$TransactionId=[guid]::NewGuid().ToString('N')}
    return [pscustomobject]@{schemaVersion=1;leaseName=('Global\Tokenelo-ServiceLifecycle-'+$Fixture.Sid);userSid=$Fixture.Sid
        transactionId=$TransactionId;actorsQuiesced=$true;validate=$validator}
}

function Invoke-TestRestore {
    param($Fixture,$Guard,[string]$MetadataSha256)
    if(-not $MetadataSha256){$MetadataSha256=Get-TestSha256 -Bytes ([IO.File]::ReadAllBytes((Join-Path $Fixture.RecoveryRoot 'payload-recovery.json')))}
    return Restore-TokeneloPayloadRecoverySnapshot -InstallRoot $Fixture.Install -ExpectedInstallRoot $Fixture.Install `
        -RecoveryParent $Fixture.RecoveryParent -RecoveryRoot $Fixture.RecoveryRoot -PackageIdentity 'com.elostudios.tokenelo' `
        -UserSid $Fixture.Sid -ExpectedManifestBytes $Fixture.Manifest.Bytes -ExpectedManifestSha256 $Fixture.Manifest.Sha256 `
        -ExpectedSnapshotMetadataSha256 $MetadataSha256 -LifecycleGuard $Guard
}

function Get-TestArchiveFingerprint {
    param([string]$Path)
    $records=[Collections.Generic.List[object]]::new()
    $rootAcl=Get-Acl -LiteralPath $Path
    $records.Add([ordered]@{relativePath='.';kind='directory';attributes=[int][IO.File]::GetAttributes($Path);sddl=[string]$rootAcl.Sddl;sha256=$null})
    foreach($item in @(Get-ChildItem -LiteralPath $Path -Force -Recurse|Sort-Object FullName)){
        $relative=$item.FullName.Substring($Path.Length).TrimStart('\').Replace('\','/')
        if($item.PSIsContainer){$acl=Get-Acl -LiteralPath $item.FullName;$hash=$null;$kind='directory'}
        else{$acl=Get-Acl -LiteralPath $item.FullName;$hash=Get-TestSha256 -Bytes ([IO.File]::ReadAllBytes($item.FullName));$kind='file'}
        $records.Add([ordered]@{relativePath=$relative;kind=$kind;attributes=[int]$item.Attributes;sddl=[string]$acl.Sddl;sha256=$hash})
    }
    $json=ConvertTo-Json -InputObject @($records.ToArray()) -Depth 6 -Compress
    return Get-TestSha256 -Bytes ([Text.UTF8Encoding]::new($false).GetBytes($json))
}

function Assert-TestRestoredInstall {
    param($Fixture)
    $verified=Test-TokeneloPayloadRecoverySnapshot -RecoveryRoot $Fixture.RecoveryRoot -RecoveryParent $Fixture.RecoveryParent `
        -PackageIdentity 'com.elostudios.tokenelo' -InstallRoot $Fixture.Install -UserSid $Fixture.Sid `
        -ExpectedManifestBytes $Fixture.Manifest.Bytes -ExpectedManifestSha256 $Fixture.Manifest.Sha256
    Assert-Test -Condition ($verified.Verified -and $verified.SchemaVersion -eq 2 -and $verified.FileCount -eq 13) `
        -Message 'published restore tree must pass the independent live payload verifier'
    $saved=[Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes((Join-Path $Fixture.RecoveryRoot 'payload-recovery.json')))|ConvertFrom-Json
    $payload=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$saved.payloadBase64))|ConvertFrom-Json
    $acl=Get-Acl -LiteralPath $Fixture.Install
    $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    $aclEquivalent=& (Get-Module TokeneloPayloadRecovery) {param($Left,$Right)
        Test-TokeneloPayloadAclsEquivalent -LeftSddl $Left -RightSddl $Right} $acl.Sddl ([string]$payload.installRootState.sourceAclSddl)
    Assert-Test -Condition ($owner -ceq [string]$payload.installRootState.ownerSid -and
        $aclEquivalent -and
        [int][IO.File]::GetAttributes($Fixture.Install) -eq [int]$payload.installRootState.sourceAttributes) `
        -Message 'restored install-root owner, DACL, and attributes must match archived v2 metadata'
}

function Assert-TestRestoreJournal {
    param($Result,[string]$ExpectedLastStatus)
    $paths=@($Result.journalPaths)
    Assert-Test -Condition ($paths.Count -ge 3) -Message 'restore operation should retain typed journal phase records'
    $records=@($paths|ForEach-Object{[Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($_))|ConvertFrom-Json})
    for($i=0;$i -lt $records.Count;$i++){
        Assert-Test -Condition ($records[$i].sequence -eq ($i+1) -and $records[$i].recordType -ceq 'TokeneloPayloadRestorePhase' -and
            $records[$i].recoveryArchiveMutated -ne $true) -Message 'journal records must be typed, sequential and append-only'
    }
    Assert-Test -Condition ($records[-1].status -ceq $ExpectedLastStatus) -Message "final phase should report $ExpectedLastStatus"
}

function Assert-TestMalformedRestoreGuardRefused {
    param($Fixture,[ValidateSet('string-true','integer-one','multiple-values')][string]$OutputMode)
    $guard=New-TestRestoreGuard -Fixture $Fixture -OutputMode $OutputMode
    $before=Get-TestArchiveFingerprint -Path $Fixture.Install
    $transactionRoot=Join-Path ([IO.Path]::GetDirectoryName($Fixture.Install)) ('TokeneloPayloadRestore-'+$guard.transactionId)
    Assert-TestFailure -Action {Invoke-TestRestore -Fixture $Fixture -Guard $guard -MetadataSha256 ('0'*64)} `
        -Message "restore must reject guard output mode '$OutputMode'"
    Assert-Test -Condition (-not (Test-Path -LiteralPath $transactionRoot)) `
        -Message "malformed '$OutputMode' guard output must be refused before transaction creation"
    Assert-Test -Condition ((Get-TestArchiveFingerprint -Path $Fixture.Install) -ceq $before) `
        -Message "malformed '$OutputMode' guard output must leave install tree unchanged"
}

function Convert-TestSnapshotToV1 {
    param($Fixture)
    $path=Join-Path $Fixture.RecoveryRoot 'payload-recovery.json'
    $envelope=[Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($path))|ConvertFrom-Json
    $payloadBytes=[Convert]::FromBase64String([string]$envelope.payloadBase64)
    $payload=[Text.Encoding]::UTF8.GetString($payloadBytes)|ConvertFrom-Json
    $payload.PSObject.Properties.Remove('installRootState')
    $payload.schemaVersion=1
    $payloadBytes=[Text.UTF8Encoding]::new($false).GetBytes(($payload|ConvertTo-Json -Depth 10 -Compress))
    $oldEnvelope=[ordered]@{schemaVersion=1;payloadBase64=[Convert]::ToBase64String($payloadBytes);payloadSha256=(Get-TestSha256 -Bytes $payloadBytes)}
    $oldBytes=[Text.UTF8Encoding]::new($false).GetBytes(($oldEnvelope|ConvertTo-Json -Depth 4 -Compress))
    [IO.File]::WriteAllBytes($path,$oldBytes)
    return Get-TestSha256 -Bytes $oldBytes
}

function Assert-Test {
    param([bool]$Condition,[string]$Message)
    if(-not $Condition){throw "Assertion failed: $Message"}
}

function Assert-TestFailure {
    param([scriptblock]$Action,[string]$Message)
    $failed=$false
    try{& $Action|Out-Null}catch{$failed=$true}
    Assert-Test -Condition $failed -Message $Message
}

function Assert-TestSourceBytesUnchanged {
    param($Fixture)
    foreach($relative in $Fixture.Payload.Keys){
        $path=Join-Path $Fixture.Install ($relative.Replace('/','\'))
        $actual=[IO.File]::ReadAllBytes($path)
        $expected=[byte[]]$Fixture.Payload[$relative]
        Assert-Test -Condition ((Get-TestSha256 -Bytes $actual) -ceq (Get-TestSha256 -Bytes $expected)) `
            -Message "source file changed: $relative"
    }
}

function New-TestForeignSetAclModuleRoot {
    param([string]$Path,[string]$Sid)
    New-TestPrivateDirectory -Path $Path -Sid $Sid
    $moduleDirectory=Join-Path $Path 'Microsoft.PowerShell.Security'
    New-TestPrivateDirectory -Path $moduleDirectory -Sid $Sid
    $moduleSource=@'
function Set-Acl {
    [CmdletBinding()]
    param([string]$LiteralPath,[object]$AclObject)
    $global:TokeneloPayloadRestoreForeignSetAclCalled = $true
    throw 'synthetic_foreign_set_acl_dispatch'
}
Export-ModuleMember -Function Set-Acl
'@
    $manifestSource=@'
@{
    RootModule = 'Microsoft.PowerShell.Security.psm1'
    ModuleVersion = '1.0.0'
    GUID = '0404c09a-1436-40ab-8e0c-c0f91376fc13'
    FunctionsToExport = @('Set-Acl')
    CmdletsToExport = @()
    VariablesToExport = @()
    AliasesToExport = @()
}
'@
    [IO.File]::WriteAllText((Join-Path $moduleDirectory 'Microsoft.PowerShell.Security.psm1'),$moduleSource,[Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $moduleDirectory 'Microsoft.PowerShell.Security.psd1'),$manifestSource,[Text.UTF8Encoding]::new($false))
    return [IO.Path]::GetFullPath($Path)
}

function Invoke-PayloadCase {
    param([string]$Name)
    $fixture=if($Name -like 'restore-*'){
        New-TestRestoreFixture
    }elseif($Name -like 'manifest-assembler-*'){
        if($Name -ceq 'manifest-assembler-positive-direct'){
            New-TestManifestAssemblerFixture -ExecutionMode 'installed-image'
        }else{
            New-TestManifestAssemblerFixture -ExecutionMode 'byte-matching-temp-clone'
        }
    }else{
        New-TestFixture
    }
    $details=[ordered]@{case=$Name;passed=$false;fixtureRoot=$fixture.Root}
    switch($Name){
        'manifest-assembler-positive-direct' {
            $result=Assert-TestManifestAssemblerSuccess -Fixture $fixture
            Assert-Test -Condition ($result.UninstallerExecutionMode -ceq 'installed-image') `
                -Message 'direct installed-image receipt must bind the installed executable'
            $details.fileCount=$result.FileCount;$details.totalBytes=$result.TotalBytes
        }
        'manifest-assembler-positive-clone' {
            $result=Assert-TestManifestAssemblerSuccess -Fixture $fixture
            Assert-Test -Condition ($result.UninstallerExecutionMode -ceq 'byte-matching-temp-clone') `
                -Message 'temp-clone receipt must bind byte-identical installed and running images'
            $details.fileCount=$result.FileCount;$details.totalBytes=$result.TotalBytes
        }

        'manifest-assembler-no-angle-target' {
            foreach($relative in @('libEGL.dll','libGLESv2.dll')){
                $source=Join-Path $fixture.Install $relative
                $retained=Join-Path $fixture.Root ('retained-'+$relative)
                [IO.File]::Move($source,$retained)
            }
            Rebuild-TestManifestAssemblerBindings -Fixture $fixture
            $fixture.LifecycleGuard=New-TestManifestAssemblerGuard -Fixture $fixture
            $anglePaths=@('libEGL.dll','libGLESv2.dll')
            Assert-Test -Condition (@($fixture.InventoryFiles|Where-Object{$anglePaths -ccontains $_}).Count -eq 0) -Message 'trusted complete inventory for the actual target layout omits absent ANGLE files'
            $result=Assert-TestManifestAssemblerSuccess -Fixture $fixture
            $manifest=[Text.Encoding]::UTF8.GetString([byte[]]$result.ExpectedManifestBytes)|ConvertFrom-Json -ErrorAction Stop
            Assert-Test -Condition (@($manifest.files|Where-Object{$anglePaths -ccontains $_.relativePath}).Count -eq 0) -Message 'full-root output must not invent ANGLE files absent from the pinned target inventory'
            $details.fileCount=$result.FileCount;$details.totalBytes=$result.TotalBytes
        }
        'manifest-assembler-declared-angle-missing' {
            Rebuild-TestManifestAssemblerBindings -Fixture $fixture
            $fixture.LifecycleGuard=New-TestManifestAssemblerGuard -Fixture $fixture
            Assert-Test -Condition ($fixture.InventoryFiles -ccontains 'libEGL.dll') -Message 'ANGLE must remain in the complete inventory when the trusted target lists it'
            $missing=Join-Path $fixture.Install 'libEGL.dll'
            $retained=Join-Path $fixture.Root 'retained-declared-libEGL.dll'
            [IO.File]::Move($missing,$retained)
            Assert-TestManifestAssemblerRefusal -Fixture $fixture -ExpectedCodes @('payload_path_missing') -Message 'a trusted ANGLE row must still refuse when its actual target file is missing' -Action {
                Invoke-TestManifestAssembler -Fixture $fixture
            }
        }
        'manifest-assembler-missing-core-target' {
            $missing=Join-Path $fixture.Install 'icudtl.dat'
            $retained=Join-Path $fixture.Root 'retained-missing-icudtl.dat'
            [IO.File]::Move($missing,$retained)
            Rebuild-TestManifestAssemblerBindings -Fixture $fixture
            $fixture.LifecycleGuard=New-TestManifestAssemblerGuard -Fixture $fixture
            Assert-Test -Condition ($fixture.InventoryFiles -cnotcontains 'icudtl.dat') -Message 'synthetic actual target layout has no ICU runtime sentinel'
            Assert-TestManifestAssemblerRefusal -Fixture $fixture -ExpectedCodes @('payload_manifest_runtime_incomplete') -Message 'the common Electron ICU sentinel remains required even when absent from the complete target inventory' -Action {
                Invoke-TestManifestAssembler -Fixture $fixture
            }
        }
        'manifest-assembler-template-pin-rejected' {
            Assert-TestManifestAssemblerRefusal -Fixture $fixture -ExpectedCodes @('payload_template_pin_mismatch') `
                -Message 'compiled template digest must be a separately supplied exact pin' -Action {
                    Invoke-TestManifestAssembler -Fixture $fixture -CompiledTemplateSha256 ('0'*64)
                }
        }
        'manifest-assembler-inventory-rejected' {
            Assert-TestManifestAssemblerRefusal -Fixture $fixture -ExpectedCodes @('payload_inventory_hash_mismatch') `
                -Message 'external expected inventory digest mismatch must refuse' -Action {
                    Invoke-TestManifestAssembler -Fixture $fixture -TrustedInventorySha256 ('0'*64)
                }
            $inventory=[Text.Encoding]::UTF8.GetString([byte[]]$fixture.InventoryBytes)|ConvertFrom-Json -ErrorAction Stop
            $forgedFiles=[string[]]@($inventory.files)+@('resources/app/extra.js')
            [Array]::Sort($forgedFiles,[StringComparer]::Ordinal)
            $inventory.files=$forgedFiles
            $forgedBytes=[Text.UTF8Encoding]::new($false).GetBytes((($inventory|ConvertTo-Json -Depth 4 -Compress)+"`n"))
            $forgedSha=Get-TestSha256 -Bytes $forgedBytes
            Assert-TestManifestAssemblerRefusal -Fixture $fixture -ExpectedCodes @('payload_template_identity_reject') `
                -Message 'independently supplied inventory path list must match the pinned template' -Action {
                    Invoke-TestManifestAssembler -Fixture $fixture -TrustedInventoryBytes $forgedBytes -TrustedInventorySha256 $forgedSha
                }
        }
        'manifest-assembler-missing-extra-root' {
            $extra=Join-Path $fixture.Install 'unlisted-runtime.bin'
            [IO.File]::WriteAllText($extra,'synthetic unlisted runtime file',[Text.UTF8Encoding]::new($false))
            Assert-TestManifestAssemblerRefusal -Fixture $fixture -ExpectedCodes @('payload_unexpected_source_element') `
                -Message 'an unlisted regular file anywhere under install root must refuse' -Action {
                    Invoke-TestManifestAssembler -Fixture $fixture
                }
            $held=Join-Path $fixture.Root 'retained-missing-file-fixture.bin'
            [IO.File]::Move((Join-Path $fixture.Install 'resources\app\dist\daemon\main.js'),$held)
            Assert-TestManifestAssemblerRefusal -Fixture $fixture -ExpectedCodes @('payload_path_missing') `
                -Message 'a missing trusted runtime file must refuse before returning a manifest' -Action {
                    Invoke-TestManifestAssembler -Fixture $fixture
                }
        }
        'manifest-assembler-sensitive-sqlite' {
            $sensitive=Join-Path $fixture.Install 'resources\app\data'
            New-TestPrivateDirectory -Path $sensitive -Sid $fixture.Sid
            [IO.File]::WriteAllText((Join-Path $sensitive 'session.json'),'synthetic private session',[Text.UTF8Encoding]::new($false))
            Rebuild-TestManifestAssemblerBindings -Fixture $fixture
            $fixture.LifecycleGuard=New-TestManifestAssemblerGuard -Fixture $fixture
            Assert-TestManifestAssemblerRefusal -Fixture $fixture -ExpectedCodes @('payload_sensitive_path_reject') `
                -Message 'known private-data paths must never enter the full payload manifest' -Action {
                    Invoke-TestManifestAssembler -Fixture $fixture
                }

            $sqliteFixture=New-TestManifestAssemblerFixture
            $sqlitePath=Join-Path $sqliteFixture.Install 'resources\app\dist\tray\main.js'
            [IO.File]::WriteAllBytes($sqlitePath,[Text.Encoding]::ASCII.GetBytes("SQLite format 3`0synthetic fixture"))
            Rebuild-TestManifestAssemblerBindings -Fixture $sqliteFixture
            $sqliteFixture.LifecycleGuard=New-TestManifestAssemblerGuard -Fixture $sqliteFixture
            Assert-TestManifestAssemblerRefusal -Fixture $sqliteFixture -ExpectedCodes @('payload_database_header_reject') `
                -Message 'SQLite payload content must be refused even if listed in the template' -Action {
                    Invoke-TestManifestAssembler -Fixture $sqliteFixture
                }
        }
        'manifest-assembler-reparse-ads' {
            $outside=Join-Path $fixture.Root 'outside-synthetic-tree'
            New-TestPrivateDirectory -Path $outside -Sid $fixture.Sid
            [IO.File]::WriteAllText((Join-Path $outside 'sentinel.txt'),'fixture target',[Text.UTF8Encoding]::new($false))
            $junction=Join-Path $fixture.Install 'resources\synthetic-junction'
            $psi=[Diagnostics.ProcessStartInfo]::new();$psi.FileName=$env:ComSpec
            $psi.Arguments='/d /c mklink /J "'+$junction+'" "'+$outside+'"'
            $psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.WindowStyle=[Diagnostics.ProcessWindowStyle]::Hidden
            $psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
            $linkResult=Invoke-TestBoundedProcess -StartInfo $psi -Name 'Manifest fixture junction creation'
            if($linkResult.ExitCode -ne 0){throw "Manifest fixture junction creation failed ($($linkResult.ExitCode)): $($linkResult.Stderr) $($linkResult.Stdout)"}
            Assert-TestManifestAssemblerRefusal -Fixture $fixture -ExpectedCodes @('payload_reparse_reject') `
                -Message 'reparse-point directories must be refused from the complete root scan' -Action {
                    Invoke-TestManifestAssembler -Fixture $fixture
                }

            $adsFixture=New-TestManifestAssemblerFixture
            $adsPath=Join-Path $adsFixture.Install 'Tokenelo.exe'
            Set-Content -LiteralPath $adsPath -Stream 'fixture-stream' -Value 'synthetic ADS' -NoNewline
            $adsFixture.LifecycleGuard=New-TestManifestAssemblerGuard -Fixture $adsFixture
            Assert-TestManifestAssemblerRefusal -Fixture $adsFixture -ExpectedCodes @('payload_ads_reject') `
                -Message 'NTFS alternate data streams must be refused' -Action {
                    Invoke-TestManifestAssembler -Fixture $adsFixture
                }
        }
        'manifest-assembler-uninstaller-receipt' {
            $fixture.UninstallerBindingReceipt.executionMode='unknown-mode'
            $fixture.LifecycleGuard=New-TestManifestAssemblerGuard -Fixture $fixture
            Assert-TestManifestAssemblerRefusal -Fixture $fixture -ExpectedCodes @('payload_uninstaller_receipt_identity_reject') `
                -Message 'unsupported uninstaller execution mode must refuse' -Action {
                    Invoke-TestManifestAssembler -Fixture $fixture
                }

            $fixture=New-TestManifestAssemblerFixture
            $fixture.UninstallerBindingReceipt.runningImagePath=(Join-Path $fixture.Install 'Tokenelo.exe')
            $fixture.LifecycleGuard=New-TestManifestAssemblerGuard -Fixture $fixture
            Assert-TestManifestAssemblerRefusal -Fixture $fixture -ExpectedCodes @('payload_uninstaller_receipt_path_reject') `
                -Message 'a purported temp clone inside the install root must refuse' -Action {
                    Invoke-TestManifestAssembler -Fixture $fixture
                }

            $fixture=New-TestManifestAssemblerFixture
            $fixture.UninstallerBindingReceipt.coordinatorProcessStartUtcTicks='01'
            $fixture.LifecycleGuard=New-TestManifestAssemblerGuard -Fixture $fixture
            Assert-TestManifestAssemblerRefusal -Fixture $fixture -ExpectedCodes @('payload_uninstaller_receipt_identity_reject') `
                -Message 'noncanonical process birth ticks must refuse' -Action {
                    Invoke-TestManifestAssembler -Fixture $fixture
                }

            $fixture=New-TestManifestAssemblerFixture
            $fixture.LifecycleGuard=New-TestManifestAssemblerGuard -Fixture $fixture
            $fixture.UninstallerBindingReceipt.coordinatorProcessId++
            Assert-TestManifestAssemblerRefusal -Fixture $fixture -ExpectedCodes @('payload_restore_guard_reject') `
                -Message 'caller guard must bind the receipt process identity at preflight' -Action {
                    Invoke-TestManifestAssembler -Fixture $fixture
                }

            $fixture=New-TestManifestAssemblerFixture
            [IO.File]::WriteAllText([string]$fixture.UninstallerBindingReceipt.runningImagePath,
                'changed synthetic clone',[Text.UTF8Encoding]::new($false))
            $fixture.LifecycleGuard=New-TestManifestAssemblerGuard -Fixture $fixture
            Assert-TestManifestAssemblerRefusal -Fixture $fixture -ExpectedCodes @('payload_uninstaller_runtime_image_mismatch') `
                -Message 'running clone bytes must equal the verified installed image bytes' -Action {
                    Invoke-TestManifestAssembler -Fixture $fixture
                }
        }
        'manifest-assembler-template-attributes' {
            $template=[Text.Encoding]::UTF8.GetString([byte[]]$fixture.TemplateBytes)|ConvertFrom-Json -ErrorAction Stop
            $template.files[0]|Add-Member -NotePropertyName attributes -NotePropertyValue 32
            $fixture.TemplateBytes=[Text.UTF8Encoding]::new($false).GetBytes((($template|ConvertTo-Json -Depth 8 -Compress)+"`n"))
            [IO.File]::WriteAllBytes($fixture.TemplatePath,[byte[]]$fixture.TemplateBytes)
            $fixture.TemplateSha256=Get-TestSha256 -Bytes $fixture.TemplateBytes
            $fixture.LifecycleGuard=New-TestManifestAssemblerGuard -Fixture $fixture
            Assert-TestManifestAssemblerRefusal -Fixture $fixture -ExpectedCodes @('payload_template_file_contract_reject') `
                -Message 'untrusted attributes in the template must be rejected rather than copied' -Action {
                    Invoke-TestManifestAssembler -Fixture $fixture
                }
        }
        'manifest-assembler-guard-rejected' {
            foreach($mode in @('string-true','integer-one','multiple-values')){
                $fixture.LifecycleGuard=New-TestManifestAssemblerGuard -Fixture $fixture -OutputMode $mode
                Assert-TestManifestAssemblerRefusal -Fixture $fixture -ExpectedCodes @('payload_restore_guard_reject') `
                    -Message ("lifecycle validator output mode $mode must be rejected") -Action {
                        Invoke-TestManifestAssembler -Fixture $fixture
                    }
            }
            $fixture.LifecycleGuard=New-TestManifestAssemblerGuard -Fixture $fixture -RejectBoundaries @('manifest-before-return')
            Assert-TestManifestAssemblerRefusal -Fixture $fixture -ExpectedCodes @('payload_restore_guard_reject') `
                -Message 'lifecycle guard loss before returning manifest bytes must refuse' -Action {
                    Invoke-TestManifestAssembler -Fixture $fixture
                }
            $good=$fixture.LifecycleGuard
            $fixture.LifecycleGuard=[pscustomobject]@{schemaVersion=1;leaseName=$good.leaseName;userSid=$good.userSid;
                transactionId=$good.transactionId;actorsQuiesced='True';validate=$good.validate}
            Assert-TestManifestAssemblerRefusal -Fixture $fixture -ExpectedCodes @('payload_restore_guard_contract_reject') `
                -Message 'string actorsQuiesced must not pass strict lifecycle guard typing' -Action {
                    Invoke-TestManifestAssembler -Fixture $fixture
                }
        }
        'native-security-module-path' {
            $inheritedModulePath = $env:PSModulePath
            $nativeRoot = [IO.Path]::GetFullPath((Join-Path $PSHOME 'Modules'))
            $nativeManifest = [IO.Path]::GetFullPath((Join-Path $nativeRoot 'Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'))
            $foreignRoot = New-TestForeignSetAclModuleRoot -Path (Join-Path $fixture.Root 'synthetic-foreign-module-root') -Sid $fixture.Sid
            if (-not [IO.File]::Exists($nativeManifest)) { throw 'The native Security module manifest is unavailable.' }
            Assert-Test -Condition ($foreignRoot -ine $nativeRoot) -Message 'synthetic foreign module root must differ from PSHOME'
            $aclPath = Join-Path $fixture.Install 'resources\app.asar'
            $sourceSddl = Get-TestFileSddl -Path $aclPath
            $standaloneScript=Join-Path $fixture.Root 'standalone-setacl-native-module-test.ps1'
            $standaloneSource=@'
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
Import-Module -Name $env:TOKENELO_SETACL_TEST_MODULE -Force -ErrorAction Stop
$module=Get-Module -Name 'TokeneloPayloadRecovery'
$dotNetMethod=($null -ne [IO.File].GetMethod('GetAccessControl',[type[]]@([string])))
$loadedAfterRead=$null
$global:TokeneloPayloadRestoreForeignSetAclCalled=$false
$global:TokeneloPayloadRestoreForeignGetAclCalled=$false
function global:Get-Acl {
    $global:TokeneloPayloadRestoreForeignGetAclCalled=$true
    return [pscustomobject]@{Marker='foreign'}
}
if($PSVersionTable.PSVersion.Major -le 5 -and $dotNetMethod){
    $null=& $module {param([string]$Path) Get-TokeneloPayloadAcl -Path $Path} $env:TOKENELO_SETACL_TEST_FILE
    $loadedAfterRead=@(Get-Module -Name 'Microsoft.PowerShell.Security').Count
    if($loadedAfterRead -ne 0){throw 'PS51 .NET ACL read unexpectedly preloaded Security.'}
}
$readerBranch=if($dotNetMethod){'dotnet-reflection'}else{'native-command-fallback'}
$fallbackBranchExecuted=$false
$fallbackReadEquivalent=$null
if(-not $dotNetMethod){
$fallbackBranchExecuted=$true
$fallbackRead=& $module {param([string]$Path) Get-TokeneloPayloadAcl -Path $Path} $env:TOKENELO_SETACL_TEST_FILE
$fallbackReadEquivalent=& $module {param([string]$Left,[string]$Right) Test-TokeneloPayloadAclsEquivalent -LeftSddl $Left -RightSddl $Right} $env:TOKENELO_SETACL_TEST_SDDL $fallbackRead.Sddl
}
$failureCode=$null
try{
    & $module {param([string]$Path,[string]$Sddl,[string]$UserSid)
        Set-TokeneloPayloadRestoreAcl -Path $Path -Sddl $Sddl -UserSid $UserSid
    } $env:TOKENELO_SETACL_TEST_FILE $env:TOKENELO_SETACL_TEST_SDDL $env:TOKENELO_SETACL_TEST_SID
}catch{$failureCode=& $module {param($ErrorRecord) Get-TokeneloPayloadRestoreFailureCode -ErrorRecord $ErrorRecord} $_}
$securityIdentity=& $module {
    $loaded=@(Get-Module -Name 'Microsoft.PowerShell.Security')
    $command=if($loaded.Count -eq 1){Get-Command -Name 'Set-Acl' -Module 'Microsoft.PowerShell.Security' -ErrorAction Stop}else{$null}
    [pscustomobject]@{Count=$loaded.Count;Path=if($loaded.Count -eq 1){[IO.Path]::GetFullPath($loaded[0].Path)}else{$null};
        Source=if($command){$command.Source}else{$null};CommandType=if($command){$command.CommandType.ToString()}else{$null}}
}
$loadedPath=$securityIdentity.Path
$aclEquivalent=$false
if($null -eq $failureCode){
    $state=& $module {param([string]$Path,[string]$UserSid) Get-TokeneloPayloadFileState -Path $Path -ExpectedUserSid $UserSid} `
        $env:TOKENELO_SETACL_TEST_FILE $env:TOKENELO_SETACL_TEST_SID
    $aclEquivalent=& $module {param([string]$Left,[string]$Right) Test-TokeneloPayloadAclsEquivalent -LeftSddl $Left -RightSddl $Right} `
        $env:TOKENELO_SETACL_TEST_SDDL $state.AclSddl
}
$passed=($null -eq $failureCode -and -not [bool]$global:TokeneloPayloadRestoreForeignSetAclCalled -and
    -not [bool]$global:TokeneloPayloadRestoreForeignGetAclCalled -and
    $securityIdentity.Count -eq 1 -and $loadedPath -ceq $env:TOKENELO_SETACL_TEST_NATIVE_MANIFEST -and
    $securityIdentity.Source -ceq 'Microsoft.PowerShell.Security' -and
    $securityIdentity.CommandType -ceq 'Cmdlet' -and $aclEquivalent -and
    (-not $fallbackBranchExecuted -or [bool]$fallbackReadEquivalent))
[pscustomobject]@{passed=$passed;version=$PSVersionTable.PSVersion.ToString();failureCode=$failureCode;
    dotNetAclReadAvailable=$dotNetMethod;securityModuleLoadedAfterRead=$loadedAfterRead;
    foreignSetterInvoked=[bool]$global:TokeneloPayloadRestoreForeignSetAclCalled;foreignGetterInvoked=[bool]$global:TokeneloPayloadRestoreForeignGetAclCalled;securityModulePath=$loadedPath;
    setAclSource=$securityIdentity.Source;setAclCommandType=$securityIdentity.CommandType;aclEquivalent=$aclEquivalent;
    readerBranch=$readerBranch;fallbackBranchExecuted=$fallbackBranchExecuted;fallbackReadEquivalent=$fallbackReadEquivalent} |
    ConvertTo-Json -Compress
if(-not $passed){exit 2}
'@
            [IO.File]::WriteAllText($standaloneScript,$standaloneSource,[Text.UTF8Encoding]::new($false))
            $standalonePsi=[Diagnostics.ProcessStartInfo]::new()
            if($PSVersionTable.PSVersion.Major -le 5){$standalonePsi.FileName=Join-Path $PSHOME 'powershell.exe'}
            else{$standalonePsi.FileName=(Get-Process -Id $PID).Path}
            $standalonePsi.WorkingDirectory=$fixture.Root;$standalonePsi.UseShellExecute=$false
            $standalonePsi.CreateNoWindow=$true;$standalonePsi.WindowStyle=[Diagnostics.ProcessWindowStyle]::Hidden
            $standalonePsi.RedirectStandardOutput=$true;$standalonePsi.RedirectStandardError=$true
            $standalonePsi.Arguments='-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$standaloneScript+'"'
            $standalonePsi.EnvironmentVariables['PSModulePath']=$foreignRoot+';'+$nativeRoot+';'+$inheritedModulePath
            $standalonePsi.EnvironmentVariables['TOKENELO_SETACL_TEST_MODULE']=$modulePath
            $standalonePsi.EnvironmentVariables['TOKENELO_SETACL_TEST_NATIVE_MANIFEST']=$nativeManifest
            $standalonePsi.EnvironmentVariables['TOKENELO_SETACL_TEST_FILE']=$aclPath
            $standalonePsi.EnvironmentVariables['TOKENELO_SETACL_TEST_SDDL']=$sourceSddl
            $standalonePsi.EnvironmentVariables['TOKENELO_SETACL_TEST_SID']=$fixture.Sid
            $childResult=Invoke-TestBoundedProcess -StartInfo $standalonePsi -Name 'Fresh-process native Set-Acl restore' -TimeoutMs 15000
            if($childResult.ExitCode -ne 0){throw "Fresh-process native Set-Acl child refused ($($childResult.ExitCode)): $($childResult.Stderr) $($childResult.Stdout)"}
            $standaloneReceipt=ConvertFrom-Json $childResult.Stdout
            Assert-Test -Condition ($standaloneReceipt.passed -eq $true -and $standaloneReceipt.failureCode -eq $null) `
                -Message ("fresh-process restore must ignore global Get-Acl and foreign-first Set-Acl; result="+$childResult.Stdout)
            if($PSVersionTable.PSVersion.Major -le 5){
                Assert-Test -Condition ($standaloneReceipt.dotNetAclReadAvailable -eq $true -and
                    $standaloneReceipt.securityModuleLoadedAfterRead -eq 0 -and $standaloneReceipt.readerBranch -ceq 'dotnet-reflection' -and
                    $standaloneReceipt.fallbackBranchExecuted -eq $false) `
                    -Message 'PS51 .NET ACL read must not preload the native Security module'
            } else {
                Assert-Test -Condition ($standaloneReceipt.readerBranch -ceq 'native-command-fallback' -and
                    $standaloneReceipt.fallbackBranchExecuted -eq $true -and $standaloneReceipt.fallbackReadEquivalent -eq $true) `
                    -Message 'PS7 ACL reader must exercise native Get-Acl fallback under global shadow'
            }
            Assert-Test -Condition (-not $standaloneReceipt.foreignSetterInvoked -and -not $standaloneReceipt.foreignGetterInvoked -and
                $standaloneReceipt.securityModulePath -ceq $nativeManifest -and
                $standaloneReceipt.setAclSource -ceq 'Microsoft.PowerShell.Security' -and
                $standaloneReceipt.setAclCommandType -ceq 'Cmdlet' -and $standaloneReceipt.aclEquivalent) `
                -Message 'fresh-process ACL restore must use native Set-Acl and ignore shadowed Get-Acl'

            $missingManifest = Join-Path $fixture.Root 'missing\Microsoft.PowerShell.Security.psd1'
            $unavailableRefused = $false
            try {
                & $payloadModule { param([string]$Path) Assert-TokeneloPayloadNativeSecurityManifestAvailable -ManifestPath $Path } $missingManifest
            } catch {
                $unavailableRefused = $_.Exception.Data['TokeneloPayloadCode'] -ceq 'payload_acl_native_security_module_unavailable'
            }
            Assert-Test -Condition $unavailableRefused -Message 'missing native Security module manifest was not refused explicitly'
            $details.nativeSecurityManifest = $nativeManifest
            $details.loadedSecurityModule = $standaloneReceipt.securityModulePath
            $details.dotNetGetAccessControlAvailable = $standaloneReceipt.dotNetAclReadAvailable
            $details.nativeSetAclCommand = $standaloneReceipt.setAclSource
            $details.foreignSetAclInvoked = $standaloneReceipt.foreignSetterInvoked
            $details.foreignGetAclInvoked = $standaloneReceipt.foreignGetterInvoked
            $details.getAclReaderBranch = $standaloneReceipt.readerBranch
            $details.getAclFallbackBranchExecuted = $standaloneReceipt.fallbackBranchExecuted
            $details.getAclFallbackReadEquivalent = $standaloneReceipt.fallbackReadEquivalent
            $details.foreignFirstProcessModulePath = $true
        }
        'restore-positive-absent-install' {
            $created=Invoke-TestSnapshot -Fixture $fixture
            $archiveBefore=Get-TestArchiveFingerprint -Path $fixture.RecoveryRoot
            $prior=Join-Path $fixture.Root 'prior-install-retained-by-test'
            [IO.Directory]::Move($fixture.Install,$prior)
            $guard=New-TestRestoreGuard -Fixture $fixture
            $result=Invoke-TestRestore -Fixture $fixture -Guard $guard -MetadataSha256 $created.SnapshotManifestSha256
            Assert-Test -Condition ($result.status -ceq 'restored' -and -not $result.priorInstallRootPresent -and
                $result.recoveryArchiveMutated -eq $false -and $result.leaseVerifiedByModule -eq $false) `
                -Message ('absent-root restore should publish a v2 payload while disclosing caller-owned guard verification; result='+
                    (ConvertTo-Json -InputObject $result -Depth 5 -Compress))
            Assert-Test -Condition (Test-Path -LiteralPath (Join-Path $prior 'Tokenelo.exe')) -Message 'pre-restore install tree must remain retained by test fixture'
            Assert-TestRestoredInstall -Fixture $fixture
            Assert-TestRestoreJournal -Result $result -ExpectedLastStatus 'restored'
            Assert-Test -Condition ((Get-TestArchiveFingerprint -Path $fixture.RecoveryRoot) -ceq $archiveBefore) `
                -Message 'restore must not mutate the recovery archive'
            $details.guardInvocations=$result.callerGuardInvocations;$details.fileCount=$result.fileCount
        }
        'restore-partial-current-retained' {
            $created=Invoke-TestSnapshot -Fixture $fixture
            $archiveBefore=Get-TestArchiveFingerprint -Path $fixture.RecoveryRoot
            $heldFile=Join-Path $fixture.Root 'Tokenelo.exe-from-partial-install'
            [IO.File]::Move((Join-Path $fixture.Install 'Tokenelo.exe'),$heldFile)
            $result=Invoke-TestRestore -Fixture $fixture -Guard (New-TestRestoreGuard -Fixture $fixture) `
                -MetadataSha256 $created.SnapshotManifestSha256
            Assert-Test -Condition ($result.status -ceq 'restored' -and $result.priorInstallRootPresent -and
                -not $result.priorInstallRootRestored -and (Test-Path -LiteralPath $result.retainedCurrentRoot)) `
                -Message 'restoring over a valid partial current tree must retain that tree as evidence'
            Assert-Test -Condition (Test-Path -LiteralPath $heldFile) -Message 'test-moved partial payload bytes must remain retained'
            Assert-Test -Condition (-not (Test-Path -LiteralPath (Join-Path $result.retainedCurrentRoot 'Tokenelo.exe'))) `
                -Message 'retained partial tree must preserve the exact missing-file state'
            Assert-TestRestoredInstall -Fixture $fixture
            Assert-TestRestoreJournal -Result $result -ExpectedLastStatus 'restored'
            Assert-Test -Condition ((Get-TestArchiveFingerprint -Path $fixture.RecoveryRoot) -ceq $archiveBefore) `
                -Message 'partial-current restore must leave recovery archive unchanged'
        }
        'restore-v1-refused' {
            $null=Invoke-TestSnapshot -Fixture $fixture
            $metadataSha=Convert-TestSnapshotToV1 -Fixture $fixture
            $archiveBefore=Get-TestArchiveFingerprint -Path $fixture.RecoveryRoot
            $guard=New-TestRestoreGuard -Fixture $fixture
            Assert-TestFailure -Action {Invoke-TestRestore -Fixture $fixture -Guard $guard -MetadataSha256 $metadataSha} `
                -Message 'v1 archive must be refused for exact restore because it lacks authenticated root metadata'
            $transactionRoot=Join-Path ([IO.Path]::GetDirectoryName($fixture.Install)) ('TokeneloPayloadRestore-'+$guard.transactionId)
            Assert-Test -Condition (-not (Test-Path -LiteralPath $transactionRoot)) -Message 'v1 refusal must precede restore transaction creation'
            Assert-Test -Condition ((Get-TestArchiveFingerprint -Path $fixture.RecoveryRoot) -ceq $archiveBefore) `
                -Message 'v1 refusal must not mutate its archive'
            Assert-TestSourceBytesUnchanged -Fixture $fixture
        }
        'restore-unexpected-current-refused' {
            $created=Invoke-TestSnapshot -Fixture $fixture
            $archiveBefore=Get-TestArchiveFingerprint -Path $fixture.RecoveryRoot
            $unexpected=Join-Path $fixture.Install 'unmanifested-installer.log'
            [IO.File]::WriteAllText($unexpected,'foreign current tree element',[Text.UTF8Encoding]::new($false))
            $before=Get-TestSha256 -Bytes ([IO.File]::ReadAllBytes($unexpected))
            $guard=New-TestRestoreGuard -Fixture $fixture
            Assert-TestFailure -Action {Invoke-TestRestore -Fixture $fixture -Guard $guard -MetadataSha256 $created.SnapshotManifestSha256} `
                -Message 'unmanifested current install-root element must be refused before transaction creation'
            $transactionRoot=Join-Path ([IO.Path]::GetDirectoryName($fixture.Install)) ('TokeneloPayloadRestore-'+$guard.transactionId)
            Assert-Test -Condition (-not (Test-Path -LiteralPath $transactionRoot)) -Message 'unexpected-tree refusal must precede transaction creation'
            Assert-Test -Condition ((Get-TestSha256 -Bytes ([IO.File]::ReadAllBytes($unexpected))) -ceq $before) `
                -Message 'unexpected current file must remain untouched'
            Assert-Test -Condition ((Get-TestArchiveFingerprint -Path $fixture.RecoveryRoot) -ceq $archiveBefore) `
                -Message 'unexpected-tree refusal must not mutate archive'
        }
        'restore-reparse-refused' {
            $created=Invoke-TestSnapshot -Fixture $fixture
            $outside=Join-Path $fixture.Root 'outside-reparse-target'
            New-TestPrivateDirectory -Path $outside -Sid $fixture.Sid
            $sentinel=Join-Path $outside 'sentinel.txt'
            [IO.File]::WriteAllText($sentinel,'outside-data-retained',[Text.UTF8Encoding]::new($false))
            $junction=Join-Path $fixture.Install 'resources\escape-link'
            $psi=[Diagnostics.ProcessStartInfo]::new();$psi.FileName=$env:ComSpec
            $psi.Arguments='/d /c mklink /J "'+$junction+'" "'+$outside+'"'
            $psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.WindowStyle=[Diagnostics.ProcessWindowStyle]::Hidden
            $psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
            $linkResult=Invoke-TestBoundedProcess -StartInfo $psi -Name 'Restore fixture junction creation'
            if($linkResult.ExitCode -ne 0){throw "Restore fixture junction creation failed ($($linkResult.ExitCode)): $($linkResult.Stderr) $($linkResult.Stdout)"}
            $guard=New-TestRestoreGuard -Fixture $fixture
            Assert-TestFailure -Action {Invoke-TestRestore -Fixture $fixture -Guard $guard -MetadataSha256 $created.SnapshotManifestSha256} `
                -Message 'reparse point in current install tree must be refused before restore mutation'
            $transactionRoot=Join-Path ([IO.Path]::GetDirectoryName($fixture.Install)) ('TokeneloPayloadRestore-'+$guard.transactionId)
            Assert-Test -Condition (-not (Test-Path -LiteralPath $transactionRoot)) -Message 'reparse refusal must precede transaction creation'
            Assert-Test -Condition ((Get-Content -LiteralPath $sentinel -Raw) -ceq 'outside-data-retained') `
                -Message 'restore reparse refusal must leave the junction target untouched'
        }
        'restore-ads-refused' {
            $created=Invoke-TestSnapshot -Fixture $fixture
            $path=Join-Path $fixture.Install 'resources\app.asar'
            Set-Content -LiteralPath $path -Stream 'restore-fixture' -Value 'retained-ads' -NoNewline
            $guard=New-TestRestoreGuard -Fixture $fixture
            Assert-TestFailure -Action {Invoke-TestRestore -Fixture $fixture -Guard $guard -MetadataSha256 $created.SnapshotManifestSha256} `
                -Message 'alternate data stream on the current payload must be refused before restore mutation'
            $transactionRoot=Join-Path ([IO.Path]::GetDirectoryName($fixture.Install)) ('TokeneloPayloadRestore-'+$guard.transactionId)
            Assert-Test -Condition (-not (Test-Path -LiteralPath $transactionRoot)) -Message 'ADS refusal must precede transaction creation'
            Assert-Test -Condition ((Get-Content -LiteralPath $path -Stream 'restore-fixture' -Raw) -ceq 'retained-ads') `
                -Message 'refusal must leave the existing alternate data stream unchanged'
        }
        'restore-foreign-acl-refused' {
            $created=Invoke-TestSnapshot -Fixture $fixture
            $null=Invoke-TestIcacls -Arguments ('"'+$fixture.Install+'" /grant *S-1-5-32-545:(M)')
            $aclAfterInjection=Get-TestDirectorySddl -Path $fixture.Install
            $guard=New-TestRestoreGuard -Fixture $fixture
            Assert-TestFailure -Action {Invoke-TestRestore -Fixture $fixture -Guard $guard -MetadataSha256 $created.SnapshotManifestSha256} `
                -Message 'foreign-writable install-root ACL must be refused before restore mutation'
            $transactionRoot=Join-Path ([IO.Path]::GetDirectoryName($fixture.Install)) ('TokeneloPayloadRestore-'+$guard.transactionId)
            Assert-Test -Condition (-not (Test-Path -LiteralPath $transactionRoot)) -Message 'foreign ACL refusal must precede transaction creation'
            Assert-Test -Condition ((Get-TestDirectorySddl -Path $fixture.Install) -ceq $aclAfterInjection) `
                -Message 'foreign current ACL must remain unchanged on refusal'
        }
        'restore-copy-failure-retains' {
            $created=Invoke-TestSnapshot -Fixture $fixture
            $archiveBefore=Get-TestArchiveFingerprint -Path $fixture.RecoveryRoot
            $originalInstallState=Get-TestArchiveFingerprint -Path $fixture.Install
            $module=Get-Module TokeneloPayloadRecovery
            $originalCopy=& $module {(Get-Command Copy-TokeneloPayloadFileDurable).ScriptBlock}
            & $module {
                param($Original)
                $script:payloadRestoreTestCopyCount=0;$script:payloadRestoreTestOriginalCopy=$Original
                Set-Item -Path Function:\Copy-TokeneloPayloadFileDurable -Value {
                    param([string]$Source,[string]$Destination)
                    $script:payloadRestoreTestCopyCount++
                    if($script:payloadRestoreTestCopyCount -eq 2){
                        $stream=[IO.FileStream]::new($Destination,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
                        try{$buffer=[Text.Encoding]::UTF8.GetBytes('partial-stage');$stream.Write($buffer,0,$buffer.Length);$stream.Flush($true)}finally{$stream.Dispose()}
                        throw 'fixture-injected partial stage copy failure'
                    }
                    & $script:payloadRestoreTestOriginalCopy -Source $Source -Destination $Destination
                }
            } $originalCopy
            try{$result=Invoke-TestRestore -Fixture $fixture -Guard (New-TestRestoreGuard -Fixture $fixture) `
                    -MetadataSha256 $created.SnapshotManifestSha256}
            finally{& $module {param($Original) Set-Item -Path Function:\Copy-TokeneloPayloadFileDurable -Value $Original} $originalCopy}
            Assert-Test -Condition ($result.status -ceq 'failedRetained' -and $result.priorInstallRootPresent -and
                (Test-Path -LiteralPath $fixture.Install) -and (Test-Path -LiteralPath $result.stageRoot)) `
                -Message 'partial stage write failure must retain the original current tree and partial candidate evidence'
            Assert-Test -Condition ((Get-TestArchiveFingerprint -Path $fixture.Install) -ceq $originalInstallState) `
                -Message 'prepublish copy failure must leave live install bytes, ACLs and attributes unchanged'
            $partial=@(Get-ChildItem -LiteralPath $result.stageRoot -File -Recurse -Force|Where-Object{$_.Length -eq [Text.Encoding]::UTF8.GetByteCount('partial-stage')})
            Assert-Test -Condition ($partial.Count -eq 1) -Message 'injected partial staged file must remain for recovery review'
            Assert-TestRestoreJournal -Result $result -ExpectedLastStatus 'failedRetained'
            Assert-Test -Condition ((Get-TestArchiveFingerprint -Path $fixture.RecoveryRoot) -ceq $archiveBefore) `
                -Message 'prepublish copy failure must leave immutable archive unchanged'
        }
        'restore-publish-failure-renames-back' {
            $created=Invoke-TestSnapshot -Fixture $fixture
            $archiveBefore=Get-TestArchiveFingerprint -Path $fixture.RecoveryRoot
            $module=Get-Module TokeneloPayloadRecovery
            $originalMove=& $module {(Get-Command Move-TokeneloPayloadDirectory).ScriptBlock}
            & $module {
                param($Original)
                $script:payloadRestoreTestMoveCount=0;$script:payloadRestoreTestOriginalMove=$Original
                Set-Item -Path Function:\Move-TokeneloPayloadDirectory -Value {
                    param([string]$Source,[string]$Destination)
                    $script:payloadRestoreTestMoveCount++
                    if($script:payloadRestoreTestMoveCount -eq 2){throw 'fixture-injected stage publication failure'}
                    & $script:payloadRestoreTestOriginalMove -Source $Source -Destination $Destination
                }
            } $originalMove
            try{$result=Invoke-TestRestore -Fixture $fixture -Guard (New-TestRestoreGuard -Fixture $fixture) `
                    -MetadataSha256 $created.SnapshotManifestSha256}
            finally{& $module {param($Original) Set-Item -Path Function:\Move-TokeneloPayloadDirectory -Value $Original} $originalMove}
            Assert-Test -Condition ($result.status -ceq 'failedRetained' -and $result.priorInstallRootRestored -and
                (Test-Path -LiteralPath $fixture.Install) -and (-not $result.retainedCurrentRoot) -and
                (Test-Path -LiteralPath $result.stageRoot)) `
                -Message 'failed stage publication should guarded-rename the unchanged retained tree back and retain stage evidence'
            Assert-TestSourceBytesUnchanged -Fixture $fixture
            Assert-TestRestoreJournal -Result $result -ExpectedLastStatus 'failedRetained'
            Assert-Test -Condition ((Get-TestArchiveFingerprint -Path $fixture.RecoveryRoot) -ceq $archiveBefore) `
                -Message 'failed restore and rollback must leave archive unchanged'
        }
        'restore-guard-refusal-retains' {
            $created=Invoke-TestSnapshot -Fixture $fixture
            $archiveBefore=Get-TestArchiveFingerprint -Path $fixture.RecoveryRoot
            $guard=New-TestRestoreGuard -Fixture $fixture -RejectBoundaries @('publish-stage','rename-back-retained-current')
            $result=Invoke-TestRestore -Fixture $fixture -Guard $guard -MetadataSha256 $created.SnapshotManifestSha256
            Assert-Test -Condition ($result.status -ceq 'manualRecoveryRequired' -and $result.initialGuardAccepted -and
                (@($result.PSObject.Properties.Name) -cnotcontains 'callerGuardAccepted') -and
                -not (Test-Path -LiteralPath $fixture.Install) -and (Test-Path -LiteralPath $result.retainedCurrentRoot) -and
                (Test-Path -LiteralPath $result.stageRoot)) `
                -Message 'guard refusal before publish and rollback must retain both trees and require manual recovery'
            Assert-Test -Condition (Test-Path -LiteralPath (Join-Path $result.retainedCurrentRoot 'Tokenelo.exe')) `
                -Message 'guard refusal must preserve the original current tree'
            Assert-TestRestoreJournal -Result $result -ExpectedLastStatus 'manualRecoveryRequired'
            Assert-Test -Condition ((Get-TestArchiveFingerprint -Path $fixture.RecoveryRoot) -ceq $archiveBefore) `
                -Message 'guard refusal must not mutate archive'
        }
        'restore-guard-string-true-rejected' {
            Assert-TestMalformedRestoreGuardRefused -Fixture $fixture -OutputMode 'string-true'
        }
        'restore-guard-integer-one-rejected' {
            Assert-TestMalformedRestoreGuardRefused -Fixture $fixture -OutputMode 'integer-one'
        }
        'restore-guard-multiple-values-rejected' {
            Assert-TestMalformedRestoreGuardRefused -Fixture $fixture -OutputMode 'multiple-values'
        }
        'restore-publish-late-guard-loss-restores-current' {
            $created=Invoke-TestSnapshot -Fixture $fixture
            $archiveBefore=Get-TestArchiveFingerprint -Path $fixture.RecoveryRoot
            $installBefore=Get-TestArchiveFingerprint -Path $fixture.Install
            $transactionId=[guid]::NewGuid().ToString('N')
            $stageRoot=Join-Path (Join-Path ([IO.Path]::GetDirectoryName($fixture.Install)) ('TokeneloPayloadRestore-'+$transactionId)) 'generation'
            $result=Invoke-TestRestore -Fixture $fixture `
                -Guard (New-TestRestoreGuard -Fixture $fixture -RejectBoundaries @('publish-stage-immediate') -TransactionId $transactionId) `
                -MetadataSha256 $created.SnapshotManifestSha256
            Assert-Test -Condition ($result.status -ceq 'failedRetained' -and $result.priorInstallRootRestored -and
                $result.initialGuardAccepted -and (Test-Path -LiteralPath $fixture.Install) -and
                (Test-Path -LiteralPath $stageRoot) -and (-not $result.retainedCurrentRoot)) `
                -Message 'lease loss at the immediate pre-rename guard must keep the candidate staged and restore the unchanged current install'
            Assert-Test -Condition ((Get-TestArchiveFingerprint -Path $fixture.Install) -ceq $installBefore) `
                -Message 'immediate publish guard loss must restore the exact original install tree'
            $stagedFiles=@(Get-ChildItem -LiteralPath $stageRoot -File -Recurse -Force)
            Assert-Test -Condition ($stagedFiles.Count -eq $fixture.Payload.Count) `
                -Message 'immediate publish guard loss must retain the complete candidate at its stage path'
            foreach($relative in $fixture.Payload.Keys){
                $stagedPath=Join-Path $stageRoot ($relative.Replace('/','\'))
                Assert-Test -Condition ((Get-TestSha256 -Bytes ([IO.File]::ReadAllBytes($stagedPath))) -ceq
                    (Get-TestSha256 -Bytes ([byte[]]$fixture.Payload[$relative]))) `
                    -Message "candidate bytes must remain staged after guard loss: $relative"
            }
            Assert-TestRestoreJournal -Result $result -ExpectedLastStatus 'failedRetained'
            Assert-Test -Condition ((Get-TestArchiveFingerprint -Path $fixture.RecoveryRoot) -ceq $archiveBefore) `
                -Message 'immediate publish guard loss must leave the archive unchanged'
        }
        'restore-stage-tamper-refused' {
            $created=Invoke-TestSnapshot -Fixture $fixture
            $archiveBefore=Get-TestArchiveFingerprint -Path $fixture.RecoveryRoot
            $transactionId=[guid]::NewGuid().ToString('N')
            $stageRoot=Join-Path (Join-Path ([IO.Path]::GetDirectoryName($fixture.Install)) ('TokeneloPayloadRestore-'+$transactionId)) 'generation'
            $tamperPath=Join-Path $stageRoot 'Tokenelo.exe'
            $guard=New-TestRestoreGuard -Fixture $fixture -TamperBoundary 'publish-stage' -TamperPath $tamperPath -TransactionId $transactionId
            $result=Invoke-TestRestore -Fixture $fixture -Guard $guard -MetadataSha256 $created.SnapshotManifestSha256
            Assert-Test -Condition ($result.status -ceq 'manualRecoveryRequired' -and -not (Test-Path -LiteralPath $fixture.Install) -and
                (Test-Path -LiteralPath $result.retainedCurrentRoot) -and (Test-Path -LiteralPath $result.stageRoot)) `
                -Message 'stage tamper detected before publication must retain current and candidate trees for manual recovery'
            Assert-Test -Condition ((Get-TestSha256 -Bytes ([IO.File]::ReadAllBytes($tamperPath))) -cne
                (Get-TestSha256 -Bytes ([byte[]]$fixture.Payload['Tokenelo.exe']))) `
                -Message 'tampered stage candidate must not be published into install root'
            Assert-TestRestoreJournal -Result $result -ExpectedLastStatus 'manualRecoveryRequired'
            Assert-Test -Condition ((Get-TestArchiveFingerprint -Path $fixture.RecoveryRoot) -ceq $archiveBefore) `
                -Message 'stage tamper refusal must leave archive unchanged'
        }
        'restore-foreign-publish-target-manual' {
            $created=Invoke-TestSnapshot -Fixture $fixture
            $archiveBefore=Get-TestArchiveFingerprint -Path $fixture.RecoveryRoot
            $guard=New-TestRestoreGuard -Fixture $fixture -PublishOccupantDirectory $fixture.Install
            $result=Invoke-TestRestore -Fixture $fixture -Guard $guard -MetadataSha256 $created.SnapshotManifestSha256
            $sentinel=Join-Path $fixture.Install 'foreign-destination-sentinel.txt'
            Assert-Test -Condition ($result.status -ceq 'manualRecoveryRequired' -and
                (Test-Path -LiteralPath $result.retainedCurrentRoot) -and (Test-Path -LiteralPath $result.stageRoot) -and
                (Test-Path -LiteralPath $fixture.Install)) `
                -Message 'a new publish target after retention must be preserved with retained and staged trees for manual recovery'
            Assert-Test -Condition ((Get-Content -LiteralPath $sentinel -Raw) -ceq 'foreign-destination-retained') `
                -Message 'restore must not overwrite a newly appeared destination'
            Assert-Test -Condition (Test-Path -LiteralPath (Join-Path $result.retainedCurrentRoot 'Tokenelo.exe')) `
                -Message 'prior current payload must remain retained when the publish target is occupied'
            Assert-TestRestoreJournal -Result $result -ExpectedLastStatus 'manualRecoveryRequired'
            Assert-Test -Condition ((Get-TestArchiveFingerprint -Path $fixture.RecoveryRoot) -ceq $archiveBefore) `
                -Message 'foreign publish target refusal must leave the archive unchanged'
        }
        'full-runtime-positive' {
            $created=Invoke-TestSnapshot -Fixture $fixture
            Assert-Test -Condition ($created.LeaseVerifiedByModule -eq $false) -Message 'module must disclose that the lease was caller-asserted'
            Assert-Test -Condition ($created.SchemaVersion -eq 2 -and $created.RootMetadataRestorable) -Message 'new snapshots must record restorable install-root metadata'
            $verified=Test-TokeneloPayloadRecoverySnapshot -RecoveryRoot $fixture.RecoveryRoot -RecoveryParent $fixture.RecoveryParent `
                -PackageIdentity 'com.elostudios.tokenelo' -InstallRoot $fixture.Install -UserSid $fixture.Sid `
                -ExpectedManifestBytes $fixture.Manifest.Bytes -ExpectedManifestSha256 $fixture.Manifest.Sha256
            Assert-Test -Condition ($verified.Verified -and $verified.FileCount -eq 13) -Message 'snapshot should include runtime siblings, locales, uninstaller and resources'
            $archive=Invoke-TestArchive -Fixture $fixture -MetadataSha256 $created.SnapshotManifestSha256
            Assert-Test -Condition ($archive.Verified -and $archive.RootMetadataRestorable -and
                $archive.SnapshotMetadataSha256 -ceq $created.SnapshotManifestSha256) -Message 'archive verifier must bind and return the v2 metadata receipt'
            foreach($relative in $fixture.Payload.Keys){
                $backup=Join-Path $fixture.RecoveryRoot ($relative.Replace('/','\'))
                Assert-Test -Condition ((Get-TestSha256 -Bytes ([IO.File]::ReadAllBytes($backup))) -ceq (Get-TestSha256 -Bytes ([byte[]]$fixture.Payload[$relative]))) `
                    -Message "backup differs from source: $relative"
            }
            Assert-TestSourceBytesUnchanged -Fixture $fixture
            $details.fileCount=$verified.FileCount;$details.payloadBytes=$verified.TotalBytes
        }
        'archive-v2-absent-install' {
            $created=Invoke-TestSnapshot -Fixture $fixture
            $retainedInstall=Join-Path $fixture.Root 'retained-install-fixture'
            [IO.Directory]::Move($fixture.Install,$retainedInstall)
            $archive=Invoke-TestArchive -Fixture $fixture -MetadataSha256 $created.SnapshotManifestSha256
            Assert-Test -Condition ($archive.Verified -and $archive.SchemaVersion -eq 2 -and $archive.RootMetadataRestorable -and
                $archive.FileCount -eq 13) -Message 'v2 archive must remain verifiable when the live install root is absent'
            Assert-Test -Condition (Test-Path -LiteralPath (Join-Path $retainedInstall 'Tokenelo.exe')) -Message 'simulated install tree must remain retained'
            Assert-TestFailure -Action {Test-TokeneloPayloadRecoverySnapshot -RecoveryRoot $fixture.RecoveryRoot -RecoveryParent $fixture.RecoveryParent `
                -PackageIdentity 'com.elostudios.tokenelo' -InstallRoot $fixture.Install -UserSid $fixture.Sid `
                -ExpectedManifestBytes $fixture.Manifest.Bytes -ExpectedManifestSha256 $fixture.Manifest.Sha256} `
                -Message 'live-source verifier must continue to require a present install root'
            $details.rootMetadataRestorable=$archive.RootMetadataRestorable
        }
        'archive-v1-absent-install' {
            $null=Invoke-TestSnapshot -Fixture $fixture
            $receipt=Convert-TestSnapshotToV1 -Fixture $fixture
            $live=Test-TokeneloPayloadRecoverySnapshot -RecoveryRoot $fixture.RecoveryRoot -RecoveryParent $fixture.RecoveryParent `
                -PackageIdentity 'com.elostudios.tokenelo' -InstallRoot $fixture.Install -UserSid $fixture.Sid `
                -ExpectedManifestBytes $fixture.Manifest.Bytes -ExpectedManifestSha256 $fixture.Manifest.Sha256
            [IO.Directory]::Move($fixture.Install,(Join-Path $fixture.Root 'retained-v1-install'))
            $archive=Invoke-TestArchive -Fixture $fixture -MetadataSha256 $receipt
            Assert-Test -Condition ($live.Verified -and $live.SchemaVersion -eq 1 -and -not $live.RootMetadataRestorable -and
                $archive.Verified -and $archive.SchemaVersion -eq 1 -and -not $archive.RootMetadataRestorable) `
                -Message 'v1 archives must stay verifiable but cannot attest restorable install-root metadata'
        }
        'archive-receipt-mismatch' {
            $created=Invoke-TestSnapshot -Fixture $fixture
            $path=Join-Path $fixture.RecoveryRoot 'payload-recovery.json'
            [IO.File]::WriteAllText($path,'tampered metadata receipt',[Text.UTF8Encoding]::new($false))
            Assert-TestFailure -Action {Invoke-TestArchive -Fixture $fixture -MetadataSha256 $created.SnapshotManifestSha256} `
                -Message 'archive verifier must refuse metadata that differs from the external receipt hash'
            Assert-TestSourceBytesUnchanged -Fixture $fixture
        }
        'archive-extra-output' {
            $created=Invoke-TestSnapshot -Fixture $fixture
            [IO.File]::WriteAllText((Join-Path $fixture.RecoveryRoot 'unexpected-root-file.bin'),'foreign',[Text.UTF8Encoding]::new($false))
            Assert-TestFailure -Action {Invoke-TestArchive -Fixture $fixture -MetadataSha256 $created.SnapshotManifestSha256} `
                -Message 'archive verifier must refuse unmanifested recovery-root entries'
            Assert-TestSourceBytesUnchanged -Fixture $fixture
        }
        'root-metadata-drift' {
            $null=Invoke-TestSnapshot -Fixture $fixture
            $before=[IO.File]::GetAttributes($fixture.Install)
            try {
                [IO.File]::SetAttributes($fixture.Install,$before -bor [IO.FileAttributes]::Hidden)
                Assert-TestFailure -Action {Test-TokeneloPayloadRecoverySnapshot -RecoveryRoot $fixture.RecoveryRoot -RecoveryParent $fixture.RecoveryParent `
                    -PackageIdentity 'com.elostudios.tokenelo' -InstallRoot $fixture.Install -UserSid $fixture.Sid `
                    -ExpectedManifestBytes $fixture.Manifest.Bytes -ExpectedManifestSha256 $fixture.Manifest.Sha256} `
                    -Message 'live verifier must reject install-root attribute drift from v2 metadata'
            } finally { [IO.File]::SetAttributes($fixture.Install,$before) }
        }
        'source-root-acl-drift' {
            $module=Get-Module TokeneloPayloadRecovery
            $originalCopy=& $module { (Get-Command Copy-TokeneloPayloadFileDurable).ScriptBlock }
            $testAclMutator=(Get-Command Invoke-TestIcacls).ScriptBlock
            $installRoot=$fixture.Install
            & $module {
                param($OriginalCopy,$AclMutator,$InstallRoot)
                $script:payloadTestOriginalCopy=$OriginalCopy
                $script:payloadTestAclMutator=$AclMutator
                $script:payloadTestRoot=$InstallRoot
                $script:payloadTestRootAclChanged=$false
                Set-Item -Path Function:\Copy-TokeneloPayloadFileDurable -Value {
                    param([string]$Source,[string]$Destination)
                    & $script:payloadTestOriginalCopy -Source $Source -Destination $Destination
                    if(-not $script:payloadTestRootAclChanged){
                        & $script:payloadTestAclMutator -Arguments ('"'+$script:payloadTestRoot+'" /grant *S-1-5-11:(R)')
                        $script:payloadTestRootAclChanged=$true
                    }
                }
            } $originalCopy $testAclMutator $installRoot
            try {
                Assert-TestFailure -Action {Invoke-TestSnapshot -Fixture $fixture} -Message 'install-root ACL drift during snapshot copy must fail closed'
            } finally {
                & $module { param($Original) Set-Item -Path Function:\Copy-TokeneloPayloadFileDurable -Value $Original } $originalCopy
            }
            Assert-Test -Condition (Test-Path -LiteralPath $fixture.RecoveryRoot) -Message 'root ACL drift must retain partial recovery evidence'
            Assert-Test -Condition (-not (Test-Path -LiteralPath (Join-Path $fixture.RecoveryRoot 'payload-recovery.json'))) `
                -Message 'root ACL drift must prevent completion metadata publication'
            Assert-TestSourceBytesUnchanged -Fixture $fixture
        }
        'corrupt-output' {
            $null=Invoke-TestSnapshot -Fixture $fixture
            $target=Join-Path $fixture.RecoveryRoot 'resources\app.asar'
            [IO.File]::WriteAllBytes($target,[Text.Encoding]::UTF8.GetBytes('tampered'))
            Assert-TestFailure -Action {Test-TokeneloPayloadRecoverySnapshot -RecoveryRoot $fixture.RecoveryRoot -RecoveryParent $fixture.RecoveryParent `
                -PackageIdentity 'com.elostudios.tokenelo' -InstallRoot $fixture.Install -UserSid $fixture.Sid `
                -ExpectedManifestBytes $fixture.Manifest.Bytes -ExpectedManifestSha256 $fixture.Manifest.Sha256} `
                -Message 'verification must reject a changed payload byte'
            Assert-TestSourceBytesUnchanged -Fixture $fixture
        }
        'hash-drift' {
            $target=Join-Path $fixture.Install 'resources\app.asar'
            [IO.File]::WriteAllBytes($target,[Text.Encoding]::UTF8.GetBytes('drifted-source'))
            Assert-TestFailure -Action {Invoke-TestSnapshot -Fixture $fixture} -Message 'source hash drift must fail before snapshot creation'
            Assert-Test -Condition (-not (Test-Path -LiteralPath $fixture.RecoveryRoot)) -Message 'preflight failure must not create recovery root'
        }
        'reparse' {
            $outside=Join-Path $fixture.Root 'outside'
            New-TestPrivateDirectory -Path $outside -Sid $fixture.Sid
            [IO.File]::WriteAllText((Join-Path $outside 'sentinel.txt'),'outside-fixture',[Text.UTF8Encoding]::new($false))
            $junction=Join-Path $fixture.Install 'resources\escape-link'
            $psi=[Diagnostics.ProcessStartInfo]::new()
            $psi.FileName=$env:ComSpec
            $psi.Arguments='/d /c mklink /J "'+$junction+'" "'+$outside+'"'
            $psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.WindowStyle=[Diagnostics.ProcessWindowStyle]::Hidden
            $psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
            $junctionResult=Invoke-TestBoundedProcess -StartInfo $psi -Name 'Fixture junction creation'
            if($junctionResult.ExitCode -ne 0){throw "Fixture junction creation failed ($($junctionResult.ExitCode)): $($junctionResult.Stderr) $($junctionResult.Stdout)"}
            Assert-TestFailure -Action {Invoke-TestSnapshot -Fixture $fixture} -Message 'resource reparse point must fail before snapshot creation'
            Assert-Test -Condition (-not (Test-Path -LiteralPath $fixture.RecoveryRoot)) -Message 'reparse rejection must precede recovery mutation'
            Assert-Test -Condition ((Get-Content -LiteralPath (Join-Path $outside 'sentinel.txt') -Raw) -ceq 'outside-fixture') `
                -Message 'junction target must remain untouched'
        }
        'preexisting-root' {
            New-TestPrivateDirectory -Path $fixture.RecoveryRoot -Sid $fixture.Sid
            $sentinel=Join-Path $fixture.RecoveryRoot 'foreign-sentinel.txt'
            [IO.File]::WriteAllText($sentinel,'retain',[Text.UTF8Encoding]::new($false))
            $originalAcl=Get-TestDirectorySddl -Path $fixture.RecoveryRoot
            Assert-TestFailure -Action {Invoke-TestSnapshot -Fixture $fixture} -Message 'preexisting recovery output must be refused'
            Assert-Test -Condition ((Get-Content -LiteralPath $sentinel -Raw) -ceq 'retain') -Message 'preexisting bytes must remain'
            Assert-Test -Condition (@(Get-ChildItem -LiteralPath $fixture.RecoveryRoot -Force).Count -eq 1) -Message 'preexisting output set must remain untouched'
            Assert-Test -Condition ((Get-TestDirectorySddl -Path $fixture.RecoveryRoot) -ceq $originalAcl) -Message 'refusal must not change the existing output ACL'
        }
        'partial-io' {
            $module=Get-Module TokeneloPayloadRecovery
            $originalCopy=& $module { (Get-Command Copy-TokeneloPayloadFileDurable).ScriptBlock }
            & $module {
                Set-Item -Path Function:\Copy-TokeneloPayloadFileDurable -Value {
                    param([string]$Source,[string]$Destination)
                    $stream=[IO.FileStream]::new($Destination,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
                    try{$buffer=[byte[]]::new(7);$read=$stream.Write($buffer,0,$buffer.Length);$stream.Flush($true)}finally{$stream.Dispose()}
                    throw 'injected partial copy failure'
                }
            }
            try {
                Assert-TestFailure -Action {Invoke-TestSnapshot -Fixture $fixture} -Message 'partial output write must surface failure'
            } finally {
                & $module { param($Original) Set-Item -Path Function:\Copy-TokeneloPayloadFileDurable -Value $Original } $originalCopy
            }
            Assert-Test -Condition (Test-Path -LiteralPath $fixture.RecoveryRoot) -Message 'partial recovery root must be retained'
            $partial=@(Get-ChildItem -LiteralPath $fixture.RecoveryRoot -File -Recurse -Force | Where-Object {$_.Length -eq 7})
            Assert-Test -Condition ($partial.Count -eq 1) -Message 'partial output bytes should remain for recovery review'
            Assert-Test -Condition (-not (Test-Path -LiteralPath (Join-Path $fixture.RecoveryRoot 'payload-recovery.json'))) `
                -Message 'incomplete snapshot must not publish its completion manifest'
            Assert-TestSourceBytesUnchanged -Fixture $fixture
            $details.retainedPartialFiles=$partial.Count
        }
        'metadata-mismatch' {
            $bad=New-TestManifest -InstallRoot $fixture.Install -Sid $fixture.Sid -BadAttributeType
            Assert-TestFailure -Action {Invoke-TestSnapshot -Fixture $fixture -ManifestBytes $bad.Bytes -ManifestSha256 $bad.Sha256} `
                -Message 'incorrectly typed manifest attributes must be rejected'
            Assert-Test -Condition (-not (Test-Path -LiteralPath $fixture.RecoveryRoot)) -Message 'invalid metadata must fail before recovery mutation'
        }
        'manifest-case-collision' {
            $manifest=[Text.Encoding]::UTF8.GetString($fixture.Manifest.Bytes)|ConvertFrom-Json
            $original=@($manifest.files|Where-Object{$_.relativePath -ceq 'resources/app.asar'})[0]
            $duplicate=[ordered]@{relativePath='resources/APP.ASAR';sizeBytes=[long]$original.sizeBytes;
                sha256=[string]$original.sha256;attributes=[long]$original.attributes}
            $manifest.files=@($manifest.files)+@($duplicate)
            $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($manifest|ConvertTo-Json -Depth 8 -Compress))
            $digest=Get-TestSha256 -Bytes $bytes
            Assert-TestFailure -Action {Invoke-TestSnapshot -Fixture $fixture -ManifestBytes $bytes -ManifestSha256 $digest} `
                -Message 'case-insensitive duplicate manifest paths must be rejected'
            Assert-Test -Condition (-not (Test-Path -LiteralPath $fixture.RecoveryRoot)) -Message 'manifest path collision must fail before recovery mutation'
        }

        'manifest-omits-core-sentinel' {
            $manifest=[Text.Encoding]::UTF8.GetString($fixture.Manifest.Bytes)|ConvertFrom-Json
            $manifest.files=@($manifest.files|Where-Object{$_.relativePath -cne 'icudtl.dat'})
            $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($manifest|ConvertTo-Json -Depth 8 -Compress))
            $digest=Get-TestSha256 -Bytes $bytes
            Assert-TestPayloadFailureCode -Action {Invoke-TestSnapshot -Fixture $fixture -ManifestBytes $bytes -ManifestSha256 $digest} -ExpectedCodes @('payload_manifest_runtime_incomplete') -Message 'a manifest that omits a common Electron runtime sentinel must be rejected'
            Assert-Test -Condition (-not (Test-Path -LiteralPath $fixture.RecoveryRoot)) -Message 'missing common runtime sentinel must fail before recovery mutation'
        }
        'manifest-omits-runtime' {
            $manifest=[Text.Encoding]::UTF8.GetString($fixture.Manifest.Bytes)|ConvertFrom-Json
            $manifest.files=@($manifest.files|Where-Object{$_.relativePath -in @('Tokenelo.exe','Uninstall Tokenelo.exe','resources/app.asar','resources/native/bin/helper.dll')})
            $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($manifest|ConvertTo-Json -Depth 8 -Compress))
            $digest=Get-TestSha256 -Bytes $bytes
            Assert-TestFailure -Action {Invoke-TestSnapshot -Fixture $fixture -ManifestBytes $bytes -ManifestSha256 $digest} `
                -Message 'resource-only expected manifest must be rejected when Electron runtime siblings and locales are omitted'
            Assert-Test -Condition (-not (Test-Path -LiteralPath $fixture.RecoveryRoot)) -Message 'incomplete runtime manifest must fail before recovery mutation'
        }
        'ads' {
            $streamPath=Join-Path $fixture.Install 'resources\app.asar'
            Set-Content -LiteralPath $streamPath -Stream 'payload-test-stream' -Value 'fixture-alternate-stream' -NoNewline
            Assert-TestFailure -Action {Invoke-TestSnapshot -Fixture $fixture} -Message 'alternate data stream on a source file must be rejected'
            Assert-Test -Condition (-not (Test-Path -LiteralPath $fixture.RecoveryRoot)) -Message 'alternate stream must fail before recovery mutation'
        }
        'unexpected-element' {
            $target=Join-Path $fixture.Install 'resources\unmanifested.bin'
            [IO.File]::WriteAllBytes($target,[Text.Encoding]::UTF8.GetBytes('not-in-trusted-manifest'))
            Assert-TestFailure -Action {Invoke-TestSnapshot -Fixture $fixture} -Message 'unmanifested resource must be rejected'
            Assert-Test -Condition (-not (Test-Path -LiteralPath $fixture.RecoveryRoot)) -Message 'unexpected source must fail before recovery mutation'
        }
        'unknown-root-extra' {
            $target=Join-Path $fixture.Install 'runtime-extra.dll'
            [IO.File]::WriteAllBytes($target,[Text.Encoding]::UTF8.GetBytes('not-in-trusted-install-manifest'))
            Assert-TestFailure -Action {Invoke-TestSnapshot -Fixture $fixture} -Message 'unmanifested install-root runtime sibling must be rejected'
            Assert-Test -Condition (-not (Test-Path -LiteralPath $fixture.RecoveryRoot)) -Message 'unknown root sibling must fail before recovery mutation'
        }
        'sensitive-manifest' {
            foreach($relative in @('resources/config.json','resources/daemon.log','resources/ledger.json','resources/fleet-token')){
                $target=Join-Path $fixture.Install ($relative.Replace('/','\'))
                [IO.File]::WriteAllText($target,'synthetic-sensitive-path',[Text.UTF8Encoding]::new($false))
                $manifest=New-TestManifest -InstallRoot $fixture.Install -Sid $fixture.Sid -AdditionalRelativeFiles @($relative)
                Assert-TestFailure -Action {Invoke-TestSnapshot -Fixture $fixture -ManifestBytes $manifest.Bytes -ManifestSha256 $manifest.Sha256} `
                    -Message "sensitive install artifact '$relative' must be rejected even when present in the trusted manifest"
                Assert-Test -Condition (-not (Test-Path -LiteralPath $fixture.RecoveryRoot)) -Message 'sensitive manifest path must fail before recovery mutation'
            }
        }
        'sqlite-header' {
            $relative='resources/runtime-cache.dat'
            $bytes=[Text.Encoding]::ASCII.GetBytes(('SQLite format 3'+[char]0+'synthetic-db'))
            [IO.File]::WriteAllBytes((Join-Path $fixture.Install ($relative.Replace('/','\'))),$bytes)
            $manifest=New-TestManifest -InstallRoot $fixture.Install -Sid $fixture.Sid -AdditionalRelativeFiles @($relative)
            Assert-TestFailure -Action {Invoke-TestSnapshot -Fixture $fixture -ManifestBytes $manifest.Bytes -ManifestSha256 $manifest.Sha256} `
                -Message 'SQLite database header must be rejected even under an innocuous filename'
            Assert-Test -Condition (-not (Test-Path -LiteralPath $fixture.RecoveryRoot)) -Message 'database header must fail before recovery mutation'
        }
        'source-acl-drift' {
            $module=Get-Module TokeneloPayloadRecovery
            $originalCopy=& $module { (Get-Command Copy-TokeneloPayloadFileDurable).ScriptBlock }
            $testAclMutator=(Get-Command Invoke-TestIcacls).ScriptBlock
            & $module {
                param($OriginalCopy,$AclMutator)
                $script:payloadTestOriginalCopy=$OriginalCopy
                $script:payloadTestAclMutator=$AclMutator
                Set-Item -Path Function:\Copy-TokeneloPayloadFileDurable -Value {
                    param([string]$Source,[string]$Destination)
                    & $script:payloadTestOriginalCopy -Source $Source -Destination $Destination
                    & $script:payloadTestAclMutator -Arguments ('"'+$Source+'" /grant *S-1-5-11:(R)')
                }
            } $originalCopy $testAclMutator
            try {
                Assert-TestFailure -Action {Invoke-TestSnapshot -Fixture $fixture} -Message 'source ACL drift during copy must fail closed'
            } finally {
                & $module { param($Original) Set-Item -Path Function:\Copy-TokeneloPayloadFileDurable -Value $Original } $originalCopy
            }
            Assert-Test -Condition (Test-Path -LiteralPath $fixture.RecoveryRoot) -Message 'ACL drift failure must retain recovery evidence'
            Assert-Test -Condition (-not (Test-Path -LiteralPath (Join-Path $fixture.RecoveryRoot 'payload-recovery.json'))) `
                -Message 'ACL drift must not publish a completion manifest'
            Assert-TestSourceBytesUnchanged -Fixture $fixture
        }
        'exclusive-root-race' {
            $module=Get-Module TokeneloPayloadRecovery
            $originalCreator=& $module { (Get-Command New-TokeneloPrivateDirectory).ScriptBlock }
            $marker=Join-Path $fixture.RecoveryRoot 'concurrent-creator-sentinel.txt'
            & $module {
                param($Target,$Marker,$Original)
                $script:payloadTestRaceTarget=$Target
                $script:payloadTestRaceMarker=$Marker
                $script:payloadTestOriginalDirectoryCreator=$Original
                Set-Item -Path Function:\New-TokeneloPrivateDirectory -Value {
                    param([string]$Path,[string]$UserSid,[switch]$RequireProtectedParent)
                    if($Path -ceq $script:payloadTestRaceTarget){
                        & $script:payloadTestOriginalDirectoryCreator -Path $Path -UserSid $UserSid -RequireProtectedParent:$RequireProtectedParent
                        $createdAcl=(Get-TokeneloPayloadAcl -Path $Path -Directory).Sddl
                        [IO.File]::WriteAllText($script:payloadTestRaceMarker,[string]$createdAcl,[Text.UTF8Encoding]::new($false))
                    }
                    & $script:payloadTestOriginalDirectoryCreator -Path $Path -UserSid $UserSid -RequireProtectedParent:$RequireProtectedParent
                }
            } $fixture.RecoveryRoot $marker $originalCreator
            try {
                Assert-TestFailure -Action {Invoke-TestSnapshot -Fixture $fixture} -Message 'exclusive native create must refuse a recovery root created after preflight'
            } finally {
                & $module { param($Original) Set-Item -Path Function:\New-TokeneloPrivateDirectory -Value $Original } $originalCreator
            }
            Assert-Test -Condition ((Get-Content -LiteralPath $marker -Raw) -ceq (Get-TestDirectorySddl -Path $fixture.RecoveryRoot)) `
                -Message 'racing creator ACL must remain unchanged after exclusive-create refusal'
            Assert-Test -Condition (-not (Test-Path -LiteralPath (Join-Path $fixture.RecoveryRoot 'payload-recovery.json'))) `
                -Message 'racing create refusal must not publish a completion manifest'
        }
        'mapped-network-drive' {
            $module=Get-Module TokeneloPayloadRecovery
            $originalDriveType=& $module { (Get-Command Get-TokeneloPayloadDriveType).ScriptBlock }
            & $module {
                Set-Item -Path Function:\Get-TokeneloPayloadDriveType -Value {
                    param([string]$Root)
                    return [IO.DriveType]::Network
                }
            }
            try {
                Assert-TestFailure -Action {Invoke-TestSnapshot -Fixture $fixture} -Message 'mapped network volume must be refused'
            } finally {
                & $module { param($Original) Set-Item -Path Function:\Get-TokeneloPayloadDriveType -Value $Original } $originalDriveType
            }
            Assert-Test -Condition (-not (Test-Path -LiteralPath $fixture.RecoveryRoot)) -Message 'network-drive refusal must precede recovery mutation'
        }
        'local-drive-policy' {
            $module=Get-Module TokeneloPayloadRecovery
            $driveRoot=[IO.Path]::GetPathRoot($fixture.Install)
            $driveType=& $module { param($Root) Get-TokeneloPayloadDriveType -Root $Root } $driveRoot
            Assert-Test -Condition ($driveType -eq [IO.DriveType]::Fixed) -Message 'fixture must use an approved fixed local volume'
            $created=Invoke-TestSnapshot -Fixture $fixture
            Assert-Test -Condition ($created.FileCount -eq 13) -Message 'fixed local volume should accept the full runtime fixture'
        }
        'foreign-read-acl' {
            $path=Join-Path $fixture.Install 'resources\app.asar'
            Invoke-TestIcacls -Arguments ('"'+$path+'" /grant *S-1-5-11:(RX)')
            $created=Invoke-TestSnapshot -Fixture $fixture
            Assert-Test -Condition ($created.FileCount -eq 13) -Message 'foreign read-and-execute source access should not be misclassified as write access'
            $backup=Join-Path $fixture.RecoveryRoot 'resources\app.asar'
            Assert-Test -Condition (@(Get-TestFileAccessSids -Path $backup) -cnotcontains 'S-1-5-11') `
                -Message 'private recovery output must not inherit a foreign read ACL from the source file'
        }
        'foreign-acl' {
            $path=Join-Path $fixture.Install 'resources\app.asar'
            Invoke-TestIcacls -Arguments ('"'+$path+'" /grant *S-1-5-32-545:(M)')
            Assert-TestFailure -Action {Invoke-TestSnapshot -Fixture $fixture} -Message 'foreign writable source ACL must be rejected'
            Assert-Test -Condition (-not (Test-Path -LiteralPath $fixture.RecoveryRoot)) -Message 'foreign ACL must fail before recovery mutation'
        }
    }
    $details.passed=$true
    return [pscustomobject]$details
}

$manifestAssemblerCases=@('manifest-assembler-positive-direct','manifest-assembler-positive-clone',
    'manifest-assembler-template-pin-rejected','manifest-assembler-inventory-rejected','manifest-assembler-missing-extra-root',
    'manifest-assembler-sensitive-sqlite','manifest-assembler-reparse-ads','manifest-assembler-uninstaller-receipt',
    'manifest-assembler-template-attributes','manifest-assembler-guard-rejected','manifest-assembler-no-angle-target','manifest-assembler-declared-angle-missing','manifest-assembler-missing-core-target')
$cases=if($Case -eq 'all'){
    @('full-runtime-positive','archive-v2-absent-install','archive-v1-absent-install','archive-receipt-mismatch','archive-extra-output',
        'root-metadata-drift','source-root-acl-drift','corrupt-output','hash-drift','reparse','preexisting-root','partial-io',
        'metadata-mismatch','manifest-case-collision','manifest-omits-runtime','manifest-omits-core-sentinel','ads','unexpected-element','unknown-root-extra',
        'sensitive-manifest','sqlite-header','source-acl-drift','exclusive-root-race','mapped-network-drive','local-drive-policy',
        'foreign-read-acl','foreign-acl','native-security-module-path','restore-positive-absent-install','restore-partial-current-retained',
        'restore-v1-refused','restore-unexpected-current-refused','restore-reparse-refused','restore-ads-refused',
        'restore-foreign-acl-refused','restore-copy-failure-retains','restore-publish-failure-renames-back',
        'restore-guard-refusal-retains','restore-stage-tamper-refused','restore-foreign-publish-target-manual',
        'restore-guard-string-true-rejected','restore-guard-integer-one-rejected','restore-guard-multiple-values-rejected',
        'restore-publish-late-guard-loss-restores-current')+$manifestAssemblerCases
}elseif($Case -eq 'manifest-assembler'){$manifestAssemblerCases}else{@($Case)}
foreach($name in $cases){$caseResults.Add((Invoke-PayloadCase -Name $name))}
[pscustomobject]@{suite='Tokenelo Windows payload recovery';hostVersion=$PSVersionTable.PSVersion.ToString();caseCount=$caseResults.Count;
    passed=(@($caseResults|Where-Object{-not $_.passed}).Count -eq 0);results=@($caseResults.ToArray())}|
    ConvertTo-Json -Depth 6 -Compress | Write-Output
