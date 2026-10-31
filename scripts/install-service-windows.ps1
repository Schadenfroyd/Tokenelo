<#
.SYNOPSIS
    Installs (or removes, with -Uninstall) a per-user Windows Scheduled Task that runs the
    Tokenelo daemon at logon, in the interactive session (DESIGN §12, §15: "Windows scheduled
    task at logon (schtasks /it)").

.DESCRIPTION
    User-level only: the task runs as the current user (no elevation, no SYSTEM account) and is
    registered with an Interactive logon principal so it runs in the caller's own logon session.
    This is the Task Scheduler API equivalent of DESIGN's "schtasks /it" requirement.

    The task name ("TokeneloDaemon") MUST match src/tray/service-detect.ts's
    windowsScheduledTaskInstalled() check ("schtasks /query /tn TokeneloDaemon") exactly, or the
    tray will wrongly think no service is installed and start its own daemon copy alongside this
    one.

    Builds a small GUI-subsystem launcher with the Windows .NET Framework compiler. It creates
    Node with CREATE_NO_WINDOW and assigns the suspended child to an owned kill-on-close job.
    No cmd.exe or window-style-only wrapper is used. stdout/stderr remain in user-local logs.

.PARAMETER Uninstall
    Transactionally disables and stops supported, owned tasks, verifies process cleanup, then
    unregisters them and removes only their exact owned hidden launcher files. Original task XML
    and launcher bytes remain in a per-transaction recovery directory under
    %LOCALAPPDATA%\Tokenelo\recovery. Usage data, configuration, API credentials and logs remain.

.PARAMETER Stop
    Disables startup and stops supported, owned tasks without removing their registrations.
    Installing again enables startup. Legacy or foreign actions require a verified migration.

.PARAMETER HomeDirectory
    Optional absolute Tokenelo home: config, data and logs use separate subdirectories.
    Persisted for daemon and tray. Reinstalling without this option preserves an existing home.
    DataDirectory is retained as an alias for the earlier internal candidate.

.PARAMETER NodePath
    Checkout mode only: path to node.exe. Defaults to whatever `node` resolves to on PATH.

.PARAMETER PackagedAppRoot
    Packaged mode only: absolute path to the staged resources/app directory containing
    package.json and dist. The helper must be run from that app's scripts directory.

.PARAMETER PackagedElectronPath
    Packaged mode only: absolute path to the app's bundled Tokenelo.exe. The daemon task
    uses this executable with ELECTRON_RUN_AS_NODE set by the hidden launcher.

.EXAMPLE
    powershell -File scripts\install-service-windows.ps1
.EXAMPLE
    powershell -File scripts\install-service-windows.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [switch]$Uninstall,
    [switch]$Stop,
    [switch]$WithTray,
    [string]$NodePath,
    [string]$PackagedAppRoot,
    [string]$PackagedElectronPath,
    [int]$LifecycleCoordinatorProcessId,
    [string]$LifecycleCoordinatorExecutablePath,
    [string]$LifecycleCoordinatorInstalledExecutablePath,
    [Alias('DataDirectory')][string]$HomeDirectory
)

$ErrorActionPreference = 'Stop'

function Assert-TokeneloNativeSecurityManifestAvailable {
    param([Parameter(Mandatory=$true)][string]$ManifestPath)
    if (-not [IO.File]::Exists($ManifestPath)) {
        throw 'The native Microsoft.PowerShell.Security module is unavailable.'
    }
}

function Import-TokeneloNativeSecurityModule {
    $manifestPath = [IO.Path]::GetFullPath((Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'))
    Assert-TokeneloNativeSecurityManifestAvailable -ManifestPath $manifestPath
    $loaded = @(Get-Module -Name 'Microsoft.PowerShell.Security')
    $cachedPath = Get-Variable -Name 'TokeneloNativeSecurityModulePath' -Scope Script -ValueOnly -ErrorAction SilentlyContinue
    if ($cachedPath -ceq $manifestPath -and $loaded.Count -eq 1 -and [IO.Path]::GetFullPath($loaded[0].Path) -ieq $manifestPath) {
        return $manifestPath
    }
    if ($loaded.Count -gt 1) { throw 'Multiple Microsoft.PowerShell.Security modules are loaded.' }
    if ($loaded.Count -eq 1 -and [IO.Path]::GetFullPath($loaded[0].Path) -ine $manifestPath) {
        throw 'The loaded Microsoft.PowerShell.Security module is not native to this PowerShell runtime.'
    }
    if ($loaded.Count -eq 0) {
        try { Import-Module -Name $manifestPath -ErrorAction Stop }
        catch { throw 'The native Microsoft.PowerShell.Security module could not be imported.' }
    }
    $loaded = @(Get-Module -Name 'Microsoft.PowerShell.Security')
    if ($loaded.Count -ne 1 -or [IO.Path]::GetFullPath($loaded[0].Path) -ine $manifestPath) {
        throw 'Microsoft.PowerShell.Security did not resolve to the native module for this PowerShell runtime.'
    }
    $aclCommand = Get-Command -Name 'Get-Acl' -Module 'Microsoft.PowerShell.Security' -ErrorAction Stop
    if ($aclCommand.Source -cne 'Microsoft.PowerShell.Security') {
        throw 'Get-Acl did not resolve from the native Microsoft.PowerShell.Security module.'
    }
    Set-Variable -Name 'TokeneloNativeSecurityModulePath' -Scope Script -Value $manifestPath -Force
    return $manifestPath
}

$null = Import-TokeneloNativeSecurityModule
Import-Module (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\Modules\ScheduledTasks\ScheduledTasks.psd1') -ErrorAction Stop
Import-Module (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\Modules\CimCmdlets\CimCmdlets.psd1') -ErrorAction Stop

$TaskName = 'TokeneloDaemon'
$TrayTaskName = 'TokeneloTray'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$TokeneloHelperScriptRoot = $PSScriptRoot
$DaemonEntry = Join-Path $RepoRoot 'dist\daemon\main.js'
$TrayEntry = Join-Path $RepoRoot 'dist\tray\main.js'
$RuntimeMode = 'checkout'
$BundledElectronPath = $null
$LauncherRoot = Join-Path $RepoRoot 'scripts'

function Resolve-NodePath {
    param([string]$Explicit)
    if ($Explicit) {
        return $Explicit
    }
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $cmd) {
        $cmd = Get-Command node -ErrorAction SilentlyContinue
    }
    if (-not $cmd) {
        throw "node was not found on PATH; pass -NodePath 'C:\path\to\node.exe'"
    }
    return $cmd.Source
}

function Resolve-TokeneloPackagedContext {
    param(
        [string]$AppRoot,
        [string]$ElectronPath,
        [string]$HelperScriptRoot,
        [string]$LocalAppData,
        [string]$CheckoutNodePath
    )

    if (-not $AppRoot -or -not $ElectronPath) {
        throw 'Packaged mode requires both -PackagedAppRoot and -PackagedElectronPath.'
    }
    if ($CheckoutNodePath) {
        throw 'Packaged mode uses its bundled Electron runtime; -NodePath is not accepted.'
    }
    foreach ($value in @($AppRoot, $ElectronPath, $HelperScriptRoot, $LocalAppData)) {
        if (-not [IO.Path]::IsPathRooted($value) -or $value -match '["\r\n]') {
            throw 'Packaged paths must be absolute and contain no quotes or line breaks.'
        }
    }

    $resolvedRoot = [IO.Path]::GetFullPath($AppRoot)
    $resolvedScriptRoot = [IO.Path]::GetFullPath($HelperScriptRoot)
    $expectedScriptRoot = [IO.Path]::GetFullPath((Join-Path $resolvedRoot 'scripts'))
    if ($resolvedScriptRoot -ine $expectedScriptRoot) {
        throw 'Packaged service helper must run from the scripts directory inside -PackagedAppRoot.'
    }

    $installRoot = Split-Path -Parent (Split-Path -Parent $resolvedRoot)
    $expectedAppRoot = [IO.Path]::GetFullPath((Join-Path $installRoot 'resources\app'))
    if ($resolvedRoot -ine $expectedAppRoot) {
        throw 'Packaged app root must be the resources\app directory beside the bundled Tokenelo.exe.'
    }
    $expectedElectron = [IO.Path]::GetFullPath((Join-Path $installRoot 'Tokenelo.exe'))
    $resolvedElectron = [IO.Path]::GetFullPath($ElectronPath)
    if ($resolvedElectron -ine $expectedElectron -or -not (Test-Path -LiteralPath $resolvedElectron -PathType Leaf)) {
        throw 'Packaged Electron path must be the Tokenelo.exe adjacent to resources/app.'
    }

    $packagePath = Join-Path $resolvedRoot 'package.json'
    if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) { throw 'Packaged app package.json is missing.' }
    $package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
    if ($package.private -ne $true -or $package.type -ne 'module' -or $package.main -ne 'dist/tray/main.js') {
        throw 'Packaged app metadata does not match the supported Tokenelo tray entrypoint.'
    }
    $daemonEntry = Join-Path $resolvedRoot 'dist\daemon\main.js'
    $trayEntry = Join-Path $resolvedRoot 'dist\tray\main.js'
    $launcherSource = Join-Path $resolvedRoot 'scripts\windows\TokeneloHiddenLauncher.cs'
    foreach ($file in @($daemonEntry, $trayEntry, $launcherSource)) {
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
            throw "Packaged service entrypoint or launcher source is missing: $file"
        }
    }

    $localRoot = [IO.Path]::GetFullPath($LocalAppData)
    $launcherRoot = [IO.Path]::GetFullPath((Join-Path $localRoot 'Tokenelo\launchers'))
    if (Test-TokeneloPathWithin -Path $launcherRoot -Parent $installRoot) {
        throw 'Packaged hidden launchers must be written outside the application directory.'
    }
    [pscustomobject]@{
        AppRoot = $resolvedRoot
        ElectronPath = $resolvedElectron
        DaemonEntry = $daemonEntry
        TrayEntry = $trayEntry
        LauncherRoot = $launcherRoot
        RuntimeMode = 'packaged'
    }
}

function Get-TokeneloLauncherPath {
    param([ValidateSet('daemon','tray')][string]$Role)
    Join-Path $LauncherRoot ('tokenelo-' + $Role + '-launcher.exe')
}

function Test-TokeneloPathWithin {
    param([string]$Path, [string]$Parent)
    $resolvedPath = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    $resolvedParent = [IO.Path]::GetFullPath($Parent).TrimEnd('\')
    if ($resolvedPath.Equals($resolvedParent, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    return $resolvedPath.StartsWith($resolvedParent + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Get-TokeneloTrayActionArguments {
    param([string]$HomeDirectory)
    if ($RuntimeMode -eq 'packaged') {
        $arguments = '"' + $BundledElectronPath + '" "--tokenelo-packaged-app"'
    } else {
        $electron = Join-Path $RepoRoot 'node_modules\electron\dist\electron.exe'
        $arguments = '"' + $electron + '" "' + $TrayEntry + '"'
    }
    if ($HomeDirectory) { $arguments += ' ' + (Quote-TokeneloPath $HomeDirectory) }
    return $arguments
}

function Get-TokeneloDaemonActionArguments {
    param([string]$RuntimeExecutable, [string]$Entry, [string]$HomeDirectory)
    $arguments = '"' + $RuntimeExecutable + '" "' + $Entry + '"'
    if ($HomeDirectory) { $arguments += ' ' + (Quote-TokeneloPath $HomeDirectory) }
    return $arguments
}

function Get-OwnedTokeneloTask {
    param([string]$Name)
    $task = Get-ScheduledTask -TaskPath '\' -ErrorAction Stop | Where-Object { $_.TaskName -ieq $Name }
    if (-not $task) {
        return $null
    }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    # Scheduler can canonicalize DOMAIN\user to a short account name. Resolve its SID
    # instead of guessing equivalence from spelling or rejecting our own registration.
    $principalSid = [string]$task.Principal.UserId
    if ($principalSid -notmatch '^S-1-') {
        try { $principalSid = ([Security.Principal.NTAccount]::new($principalSid)).Translate([Security.Principal.SecurityIdentifier]).Value }
        catch { $principalSid = $null }
    }
    if ($principalSid -ne $identity.User.Value) {
        throw "Task '$Name' belongs to another principal; this task was not changed."
    }
    if ([string]$task.Principal.LogonType -notin @('Interactive','InteractiveToken') -or
        [string]$task.Principal.RunLevel -notin @('Limited','LeastPrivilege')) {
        throw "Task '$Name' does not use the supported interactive, least-privilege principal; this task was not changed."
    }
    $actions = @($task.Actions)
    if ($actions.Count -ne 1) { throw "Task '$Name' has an unsupported action; this task was not changed." }
    $action = $actions[0]
    $match = [regex]::Match([string]$action.Arguments, '^"([^"\r\n]+)" "([^"\r\n]+)"(?: "([^"\r\n]+)")?$')
    if ($Name -eq $TaskName) {
        $expected = Get-TokeneloLauncherPath -Role 'daemon'
        $runtimeMatches = $false
        if ($match.Success -and [IO.Path]::IsPathRooted($match.Groups[1].Value)) {
            try {
                $runtimeMatches = if ($RuntimeMode -eq 'packaged') {
                    [IO.Path]::GetFullPath($match.Groups[1].Value) -ieq [IO.Path]::GetFullPath($BundledElectronPath)
                } else {
                    [IO.Path]::GetFileName($match.Groups[1].Value) -ieq 'node.exe'
                }
            } catch { $runtimeMatches = $false }
        }
        if (-not $match.Success -or -not [IO.Path]::IsPathRooted($match.Groups[1].Value) -or
            -not $runtimeMatches -or
            [IO.Path]::GetFullPath($match.Groups[2].Value) -ine [IO.Path]::GetFullPath($DaemonEntry) -or
            ($match.Groups[3].Success -and -not [IO.Path]::IsPathRooted($match.Groups[3].Value))) {
            throw "Task '$Name' is not the supported daemon action for this installation; this task was not changed."
        }
    } elseif ($Name -eq $TrayTaskName) {
        $expected = Get-TokeneloLauncherPath -Role 'tray'
        $electron = if ($RuntimeMode -eq 'packaged') { $BundledElectronPath } else { Join-Path $RepoRoot 'node_modules\electron\dist\electron.exe' }
        $entry = $TrayEntry
        $trayActionMatches = $false
        if ($match.Success -and [IO.Path]::IsPathRooted($match.Groups[1].Value)) {
            try {
                $runtimeMatches = [IO.Path]::GetFullPath($match.Groups[1].Value) -ieq [IO.Path]::GetFullPath($electron)
                $entryMatches = if ($RuntimeMode -eq 'packaged') {
                    $match.Groups[2].Value -ceq '--tokenelo-packaged-app'
                } else {
                    [IO.Path]::GetFullPath($match.Groups[2].Value) -ieq [IO.Path]::GetFullPath($entry)
                }
                $trayActionMatches = $runtimeMatches -and $entryMatches
            } catch { $trayActionMatches = $false }
        }
        if (-not $trayActionMatches -or
            ($match.Groups[3].Success -and -not [IO.Path]::IsPathRooted($match.Groups[3].Value))) {
            throw "Task '$Name' is not the tray action for this installation; this task was not changed."
        }
    } else { throw 'Unsupported Tokenelo task name.' }
    if (-not [IO.Path]::IsPathRooted([string]$action.Execute) -or
        [IO.Path]::GetFullPath([string]$action.Execute) -ine [IO.Path]::GetFullPath($expected)) {
        throw "Task '$Name' belongs to another or legacy installation; this task was not changed."
    }
    Assert-TokeneloSupportedTaskDefinition -Name $Name -Task $task -Identity $identity
    $childCommand = if ($Name -eq $TrayTaskName -and $RuntimeMode -eq 'packaged') {
        $null
    } else {
        '"' + $match.Groups[1].Value + '" "' + $match.Groups[2].Value + '"'
    }
    $taskHome = if ($match.Groups[3].Success) { [IO.Path]::GetFullPath($match.Groups[3].Value) } else { $null }
    [pscustomobject]@{ Name = $Name; Execute = [string]$action.Execute; Arguments = [string]$action.Arguments;
        Principal = [string]$task.Principal.UserId; ChildCommand = $childCommand; HomeDirectory = $taskHome;
        Enabled = [bool]$task.Settings.Enabled; State = [string]$task.State }
}

function Get-TokeneloTaskXml {
    param([string]$Name)
    $task = Get-ScheduledTask -TaskName $Name -TaskPath '\' -ErrorAction Stop
    $xml = [string](Export-ScheduledTask -InputObject $task -ErrorAction Stop)
    if (-not $xml) { throw "Task '$Name' did not export a task definition." }
    return $xml
}

function Get-TokeneloCanonicalTaskXml {
    param([string]$Xml)
    $textReader = $null; $xmlReader = $null
    $document = New-Object System.Xml.XmlDocument
    $document.PreserveWhitespace = $false
    $document.XmlResolver = $null
    $readerSettings = New-Object System.Xml.XmlReaderSettings
    $readerSettings.DtdProcessing = [System.Xml.DtdProcessing]::Prohibit
    $readerSettings.XmlResolver = $null
    try {
        $textReader = [IO.StringReader]::new($Xml)
        $xmlReader = [System.Xml.XmlReader]::Create($textReader,$readerSettings)
        $document.Load($xmlReader)
    } finally {
        if ($xmlReader) { $xmlReader.Dispose() }
        if ($textReader) { $textReader.Dispose() }
    }
    $settings = $document.SelectSingleNode("/*[local-name()='Task']/*[local-name()='Settings']")
    if (-not $settings) { throw 'Task XML has no Settings element.' }
    $enabled = $settings.SelectSingleNode("./*[local-name()='Enabled']")
    if (-not $enabled) {
        $enabled = $document.CreateElement('Enabled', $document.DocumentElement.NamespaceURI)
        $null = $settings.AppendChild($enabled)
    }
    $enabled.InnerText = '__TOKENELO_ENABLED_STATE__'
    return $document.OuterXml
}

function Resolve-TokeneloAccountSid {
    param([string]$Account)
    if (-not $Account) { return $null }
    if ($Account -match '^S-1-') { return $Account }
    try { return ([Security.Principal.NTAccount]::new($Account)).Translate([Security.Principal.SecurityIdentifier]).Value }
    catch { return $null }
}

function New-TokeneloTaskSettings {
    param([bool]$Enabled = $true)
    $settingsArguments = @{
        ExecutionTimeLimit = [TimeSpan]::Zero
        AllowStartIfOnBatteries = $true
        DontStopIfGoingOnBatteries = $true
        MultipleInstances = 'IgnoreNew'
    }
    if (-not $Enabled) { $settingsArguments.Disable = $true }
    $settings = New-ScheduledTaskSettingsSet @settingsArguments
    $settings.Priority = 4
    return $settings
}

function Remove-TokeneloSupportedRegistrationMetadata {
    param([System.Xml.XmlDocument]$Document,[string]$Name,[string]$IdentitySid,[switch]$Template)
    $registration = $Document.SelectSingleNode("/*[local-name()='Task']/*[local-name()='RegistrationInfo']")
    if (-not $registration) { return }
    $uriSeen = $false; $securityDescriptorSeen = $false
    foreach ($child in @($registration.ChildNodes)) {
        if ($child.NodeType -ne [System.Xml.XmlNodeType]::Element) {
            if ($child.Value -and $child.Value.Trim()) { throw "Task '$Name' has unsupported RegistrationInfo text." }
            continue
        }
        switch ($child.LocalName) {
            'URI' {
                if ($uriSeen -or ($child.InnerText -and $child.InnerText -cne ('\' + $Name))) {
                    throw "Task '$Name' has an unsupported RegistrationInfo URI."
                }
                $uriSeen = $true
            }
            'SecurityDescriptor' {
                if ($securityDescriptorSeen -or ($child.InnerText -and $child.InnerText.Trim())) {
                    throw "Task '$Name' has an explicit unrecognized task security descriptor."
                }
                $securityDescriptorSeen = $true
            }
            'Author' {
                if ($Template -or ($child.InnerText -and $child.InnerText.Trim() -and
                    (Resolve-TokeneloAccountSid $child.InnerText) -cne $IdentitySid)) {
                    throw "Task '$Name' has an unsupported RegistrationInfo author."
                }
            }
            'Date' {
                $parsedDate = [DateTime]::MinValue
                if ($Template -or ($child.InnerText -and $child.InnerText.Trim() -and -not [DateTime]::TryParse($child.InnerText,
                    [Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind,[ref]$parsedDate))) {
                    throw "Task '$Name' has an unsupported RegistrationInfo date."
                }
            }
            { $_ -in @('Description','Source','Version','Documentation') } {
                if ($Template -or ($child.InnerText -and $child.InnerText.Trim())) {
                    throw "Task '$Name' has customized RegistrationInfo metadata."
                }
            }
            default { throw "Task '$Name' has unsupported RegistrationInfo field '$($child.LocalName)'." }
        }
        $null = $registration.RemoveChild($child)
    }
    foreach ($attribute in @($registration.Attributes)) {
        if ($attribute.Prefix -ne 'xmlns' -and $attribute.Name -ne 'xmlns') {
            throw "Task '$Name' has unsupported RegistrationInfo attributes."
        }
    }
}

function Normalize-TokeneloSupportedIdentityNodes {
    param([System.Xml.XmlDocument]$Document,[string]$Name,[string]$IdentitySid)
    $triggerNodes = $Document.SelectNodes("/*[local-name()='Task']/*[local-name()='Triggers']/*")
    if ($triggerNodes.Count -ne 1 -or $triggerNodes[0].LocalName -ne 'LogonTrigger') {
        throw "Task '$Name' must have only the supported AtLogOn trigger."
    }
    $trigger = $triggerNodes[0]
    $triggerEnabled = $trigger.SelectSingleNode("./*[local-name()='Enabled']")
    if ($triggerEnabled -and $triggerEnabled.InnerText -cne 'true') {
        throw "Task '$Name' has a disabled or unsupported AtLogOn trigger."
    }
    $triggerUser = $trigger.SelectSingleNode("./*[local-name()='UserId']")
    if (-not $triggerUser -or (Resolve-TokeneloAccountSid $triggerUser.InnerText) -cne $IdentitySid) {
        throw "Task '$Name' AtLogOn trigger is not limited to the current user."
    }
    $principalNodes = $Document.SelectNodes("/*[local-name()='Task']/*[local-name()='Principals']/*[local-name()='Principal']")
    if ($principalNodes.Count -ne 1) { throw "Task '$Name' has an unsupported principal definition." }
    $principal = $principalNodes[0]
    $principalUser = $principal.SelectSingleNode("./*[local-name()='UserId']")
    $logonType = $principal.SelectSingleNode("./*[local-name()='LogonType']")
    $runLevel = $principal.SelectSingleNode("./*[local-name()='RunLevel']")
    if (-not $principalUser -or (Resolve-TokeneloAccountSid $principalUser.InnerText) -cne $IdentitySid -or
        -not $logonType -or $logonType.InnerText -notin @('Interactive','InteractiveToken') -or
        -not $runLevel -or $runLevel.InnerText -notin @('Limited','LeastPrivilege')) {
        throw "Task '$Name' principal is not the current user's interactive limited principal."
    }
    $triggerUser.InnerText = '__TOKENELO_CURRENT_USER__'
    $principalUser.InnerText = '__TOKENELO_CURRENT_USER__'
    $logonType.InnerText = 'InteractiveToken'
    $runLevel.InnerText = 'LeastPrivilege'
}

function Assert-TokeneloSupportedTaskDefinition {
    param([string]$Name,$Task,[Security.Principal.WindowsIdentity]$Identity)
    $identitySid = [string]$Identity.User.Value
    $actualXml = Get-TokeneloTaskXml -Name $Name
    $actualDocument = New-Object System.Xml.XmlDocument
    $actualDocument.PreserveWhitespace = $false
    $actualDocument.LoadXml($actualXml)
    Remove-TokeneloSupportedRegistrationMetadata -Document $actualDocument -Name $Name -IdentitySid $identitySid

    $expectedTrigger = New-ScheduledTaskTrigger -AtLogOn -User $Identity.Name
    $expectedPrincipal = New-ScheduledTaskPrincipal -UserId $Identity.Name -LogonType Interactive -RunLevel Limited
    $expectedSettings = New-TokeneloTaskSettings -Enabled ([bool]$Task.Settings.Enabled)
    $expectedTask = New-ScheduledTask -Action @($Task.Actions) -Trigger @($expectedTrigger) `
        -Principal $expectedPrincipal -Settings $expectedSettings
    $expectedXml = [string](Export-ScheduledTask -InputObject $expectedTask -ErrorAction Stop)
    if (-not $expectedXml) { throw "Could not create the supported task-definition template for '$Name'." }
    $expectedDocument = New-Object System.Xml.XmlDocument
    $expectedDocument.PreserveWhitespace = $false
    $expectedDocument.LoadXml($expectedXml)
    Remove-TokeneloSupportedRegistrationMetadata -Document $expectedDocument -Name $Name `
        -IdentitySid $identitySid -Template
    Normalize-TokeneloSupportedIdentityNodes -Document $actualDocument -Name $Name -IdentitySid $identitySid
    Normalize-TokeneloSupportedIdentityNodes -Document $expectedDocument -Name $Name -IdentitySid $identitySid
    if ((Get-TokeneloCanonicalTaskXml $actualDocument.OuterXml) -cne
        (Get-TokeneloCanonicalTaskXml $expectedDocument.OuterXml)) {
        throw "Task '$Name' has unsupported triggers, settings or registration metadata; this task was not changed."
    }
}

function Set-TokeneloTaskXmlEnabled {
    param([string]$Xml, [bool]$Enabled)
    $document = New-Object System.Xml.XmlDocument
    $document.PreserveWhitespace = $false
    $document.LoadXml($Xml)
    $settings = $document.SelectSingleNode("/*[local-name()='Task']/*[local-name()='Settings']")
    if (-not $settings) { throw 'Task XML has no Settings element.' }
    $node = $settings.SelectSingleNode("./*[local-name()='Enabled']")
    if (-not $node) {
        $node = $document.CreateElement('Enabled', $document.DocumentElement.NamespaceURI)
        $null = $settings.AppendChild($node)
    }
    $node.InnerText = if ($Enabled) { 'true' } else { 'false' }
    return $document.OuterXml
}

function Get-TokeneloSha256 {
    param([byte[]]$Bytes)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash($Bytes)).Replace('-', '').ToLowerInvariant() }
    finally { $algorithm.Dispose() }
}

function Assert-TokeneloNoReparseAncestors {
    param([string]$Path,[string]$Description = 'Tokenelo filesystem path')
    $current = [IO.Path]::GetFullPath($Path)
    $chain = [Collections.Generic.List[string]]::new()
    while ($current) {
        $chain.Add($current)
        $root = [IO.Path]::GetPathRoot($current)
        if (-not $root -or $current.TrimEnd('\') -ieq $root.TrimEnd('\')) { break }
        $parent = [IO.Path]::GetDirectoryName($current.TrimEnd('\'))
        if (-not $parent -or $parent -ieq $current) { break }
        $current = $parent
    }
    $chain.Reverse()
    foreach ($ancestor in $chain) {
        if (-not (Test-Path -LiteralPath $ancestor)) { break }
        try { $attributes = [IO.File]::GetAttributes($ancestor) }
        catch { throw "$Description could not be inspected without following a reparse point: $ancestor." }
        if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "$Description crosses a reparse point: $ancestor."
        }
    }
}

function Get-TokeneloRegularFileSha256 {
    param([string]$Path,[string]$Description = 'Tokenelo launcher')
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $attributes = [IO.File]::GetAttributes($Path)
    if (($attributes -band [IO.FileAttributes]::Directory) -ne 0 -or
        ($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
        -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Description is not a regular non-reparse file: $Path."
    }
    return Get-TokeneloSha256 ([IO.File]::ReadAllBytes($Path))
}

function Write-TokeneloDurableFile {
    param([string]$Path, [byte[]]$Bytes)
    Assert-TokeneloNoReparseAncestors -Path $Path -Description 'Transaction recovery file'
    $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($Bytes, 0, $Bytes.Length); $stream.Flush($true) }
    finally { $stream.Dispose() }
}

function Assert-TokeneloUninstallHeaderPropertySet {
    param($Object,[string[]]$ExpectedNames,[string]$Description)
    if ($null -eq $Object -or $null -eq $Object.PSObject) { throw "$Description is missing or has the wrong JSON type." }
    $actual = @($Object.PSObject.Properties | ForEach-Object { [string]$_.Name })
    if ($actual.Count -ne $ExpectedNames.Count) { throw "$Description has missing or unknown properties." }
    foreach ($name in $ExpectedNames) {
        if (-not ($actual -ccontains $name)) { throw "$Description has missing or unknown properties." }
    }
}

function ConvertFrom-TokeneloUninstallHeaderJson {
    param([Parameter(Mandatory=$true)][string]$Json,[string]$Description='Uninstall recovery JSON')
    $converter = Get-Command -Name 'ConvertFrom-Json' -ErrorAction Stop
    try {
        if ($converter.Parameters.ContainsKey('DateKind')) {
            return ConvertFrom-Json -InputObject $Json -DateKind String -ErrorAction Stop
        }
        return ConvertFrom-Json -InputObject $Json -ErrorAction Stop
    } catch { throw "$Description is malformed JSON." }
}

function Get-TokeneloUninstallRecoveryDirectoryMetadata {
    param([Parameter(Mandatory=$true)][string]$Path,[Parameter(Mandatory=$true)][string]$ExpectedOwnerSid)
    if (-not [IO.Path]::IsPathRooted($Path) -or $Path -match '["\r\n]' -or $Path.StartsWith('\\')) {
        throw 'Uninstall recovery directory must be a local absolute path.'
    }
    $fullPath = [IO.Path]::GetFullPath($Path)
    if ($fullPath -cne $Path) { throw 'Uninstall recovery directory is not canonical.' }
    Assert-TokeneloNoReparseAncestors -Path $fullPath -Description 'Uninstall recovery directory'
    $attributes = [IO.File]::GetAttributes($fullPath)
    if (($attributes -band [IO.FileAttributes]::Directory) -eq 0 -or
        ($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'Uninstall recovery path is not a regular directory.'
    }
    $acl = Get-TokeneloCoordinatorFileAcl -Path $fullPath
    $ownerSid = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($ownerSid -cne $ExpectedOwnerSid) { throw 'Uninstall recovery directory owner does not match the current account.' }
    $allowedWriteSids = @($ExpectedOwnerSid,'S-1-5-18','S-1-5-32-544')
    $writeMask = [int]([Security.AccessControl.FileSystemRights]::Write -bor
        [Security.AccessControl.FileSystemRights]::CreateFiles -bor
        [Security.AccessControl.FileSystemRights]::CreateDirectories -bor
        [Security.AccessControl.FileSystemRights]::Delete -bor
        [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
        [Security.AccessControl.FileSystemRights]::WriteAttributes -bor
        [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
        [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [Security.AccessControl.FileSystemRights]::TakeOwnership)
    foreach ($rule in @($acl.Access)) {
        if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { continue }
        try { $ruleSid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value }
        catch { throw 'Uninstall recovery directory ACL contains an unresolved principal.' }
        if ($allowedWriteSids -ccontains $ruleSid) { continue }
        if (([int]$rule.FileSystemRights -band $writeMask) -ne 0) {
            throw 'Uninstall recovery directory ACL grants write access to another principal.'
        }
    }
    $aclSddl = [string]$acl.Sddl
    $aclSha256 = Get-TokeneloSha256 ([Text.Encoding]::UTF8.GetBytes($aclSddl))
    $afterAttributes = [IO.File]::GetAttributes($fullPath)
    $afterAcl = Get-TokeneloCoordinatorFileAcl -Path $fullPath
    $afterOwnerSid = $afterAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ([int]$afterAttributes -ne [int]$attributes -or $afterOwnerSid -cne $ownerSid -or [string]$afterAcl.Sddl -cne $aclSddl) {
        throw 'Uninstall recovery directory attributes or ACL changed while inspected.'
    }
    return [pscustomobject]@{Path=$fullPath;OwnerSid=$ownerSid;Attributes=[int]$attributes;AclSha256=$aclSha256}
}

function New-TokeneloProtectedUninstallRecoveryDirectorySecurity {
    param([Parameter(Mandatory=$true)][string]$ExpectedOwnerSid)
    $currentSid = [string][Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if ($ExpectedOwnerSid -cne $currentSid -or $ExpectedOwnerSid -notmatch '^S-1-\d+(?:-\d+)+$') {
        throw 'Uninstall recovery directory account identity does not match the current Windows account.'
    }
    $security = [Security.AccessControl.DirectorySecurity]::new()
    $security.SetAccessRuleProtection($true,$false)
    $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
        [Security.AccessControl.InheritanceFlags]::ObjectInherit
    foreach ($sid in @($ExpectedOwnerSid,'S-1-5-18','S-1-5-32-544')) {
        $identity = [Security.Principal.SecurityIdentifier]::new([string]$sid)
        $rule = [Security.AccessControl.FileSystemAccessRule]::new($identity,
            [Security.AccessControl.FileSystemRights]::FullControl,$inheritance,
            [Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
        $security.AddAccessRule($rule)
    }
    return $security
}

function New-TokeneloUninstallRecoveryDirectoryWithSecurity {
    param([Parameter(Mandatory=$true)][string]$Path,
        [Parameter(Mandatory=$true)][Security.AccessControl.DirectorySecurity]$Security)
    $flags = [Reflection.BindingFlags]::Public -bor [Reflection.BindingFlags]::Static
    $directoryMethods = @([IO.Directory].GetMethods($flags) | Where-Object {
        if ($_.Name -cne 'CreateDirectory') { return $false }
        $parameters = $_.GetParameters()
        return $parameters.Length -eq 2 -and $parameters[0].ParameterType -eq [string] -and
            $parameters[1].ParameterType -eq [Security.AccessControl.DirectorySecurity]
    })
    if ($directoryMethods.Count -gt 1) { throw 'The runtime has ambiguous protected-directory creation APIs.' }
    if ($directoryMethods.Count -eq 1) {
        $null = $directoryMethods[0].Invoke($null,[object[]]@($Path,$Security))
        return
    }

    # .NET Core omits Directory.CreateDirectory(String, DirectorySecurity), but its
    # FileSystemAclExtensions exposes an equivalent Windows ACL-aware create operation.
    $aclAssembly = [Reflection.Assembly]::Load('System.IO.FileSystem.AccessControl')
    $extensionType = $aclAssembly.GetType('System.IO.FileSystemAclExtensions',$false)
    if (-not $extensionType) { throw 'The runtime has no ACL-aware protected-directory creation API.' }
    $extensionMethods = @($extensionType.GetMethods($flags) | Where-Object {
        if ($_.Name -cne 'CreateDirectory') { return $false }
        $parameters = $_.GetParameters()
        return $parameters.Length -eq 2 -and $parameters[0].ParameterType -eq [Security.AccessControl.DirectorySecurity] -and
            $parameters[1].ParameterType -eq [string]
    })
    if ($extensionMethods.Count -ne 1) { throw 'The runtime has no unique ACL-aware protected-directory creation API.' }
    $null = $extensionMethods[0].Invoke($null,[object[]]@($Security,$Path))
}

function Assert-TokeneloProtectedUninstallRecoveryDirectory {
    param([Parameter(Mandatory=$true)][string]$Path,[Parameter(Mandatory=$true)][string]$ExpectedOwnerSid)
    $metadata = Get-TokeneloUninstallRecoveryDirectoryMetadata -Path $Path -ExpectedOwnerSid $ExpectedOwnerSid
    $acl = Get-TokeneloCoordinatorFileAcl -Path $metadata.Path
    if (-not $acl.AreAccessRulesProtected -or
        $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $ExpectedOwnerSid) {
        throw 'New uninstall recovery directory does not have the expected protected owner and DACL.'
    }
    $expectedSids = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($sid in @($ExpectedOwnerSid,'S-1-5-18','S-1-5-32-544')) { $null = $expectedSids.Add([string]$sid) }
    $rules = @($acl.GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier]))
    $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
        [Security.AccessControl.InheritanceFlags]::ObjectInherit
    if ($rules.Count -ne 3) { throw 'New uninstall recovery directory DACL does not contain exactly the owner, SYSTEM and Administrators.' }
    foreach ($rule in $rules) {
        $ruleSid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
        if (-not $expectedSids.Remove($ruleSid) -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
            $rule.IsInherited -or [int]$rule.FileSystemRights -ne [int][Security.AccessControl.FileSystemRights]::FullControl -or
            $rule.InheritanceFlags -ne $inheritance -or
            $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) {
            throw 'New uninstall recovery directory DACL differs from the explicit owner, SYSTEM and Administrators policy.'
        }
    }
    if ($expectedSids.Count -ne 0) { throw 'New uninstall recovery directory DACL is missing an expected account.' }
    return $metadata
}

function Ensure-TokeneloUninstallRecoveryParentDirectory {
    param([Parameter(Mandatory=$true)][string]$Path,[Parameter(Mandatory=$true)][string]$ExpectedOwnerSid,
        [Parameter(Mandatory=$true)]$LifecycleLease)
    $fullPath = [IO.Path]::GetFullPath($Path)
    if ($fullPath -cne $Path -or -not [IO.Path]::IsPathRooted($Path) -or $Path -match '["\r\n]' -or $Path.StartsWith('\\')) {
        throw 'Uninstall recovery parent is not a canonical local path.'
    }
    Assert-TokeneloNoReparseAncestors -Path $fullPath -Description 'Uninstall recovery parent'
    if (Test-Path -LiteralPath $fullPath) {
        return Get-TokeneloUninstallRecoveryDirectoryMetadata -Path $fullPath -ExpectedOwnerSid $ExpectedOwnerSid
    }
    $parent = [IO.Path]::GetDirectoryName($fullPath)
    if (-not $parent -or -not (Test-Path -LiteralPath $parent -PathType Container)) {
        throw 'Uninstall recovery parent chain is missing or is not a directory.'
    }
    $null = Get-TokeneloUninstallRecoveryDirectoryMetadata -Path ([IO.Path]::GetFullPath($parent)) `
        -ExpectedOwnerSid $ExpectedOwnerSid
    Assert-TokeneloCoordinatorLifecycleLeaseAlive -Lease $LifecycleLease
    $security = New-TokeneloProtectedUninstallRecoveryDirectorySecurity -ExpectedOwnerSid $ExpectedOwnerSid
    try { New-TokeneloUninstallRecoveryDirectoryWithSecurity -Path $fullPath -Security $security }
    catch { throw 'Uninstall recovery parent could not be created with a protected DACL.' }
    Assert-TokeneloNoReparseAncestors -Path $fullPath -Description 'New uninstall recovery parent'
    $metadata = Assert-TokeneloProtectedUninstallRecoveryDirectory -Path $fullPath -ExpectedOwnerSid $ExpectedOwnerSid
    if (@(Get-ChildItem -LiteralPath $fullPath -Force -ErrorAction Stop).Count -ne 0) {
        throw 'New uninstall recovery parent is not empty; it was retained without mutation.'
    }
    Assert-TokeneloCoordinatorLifecycleLeaseAlive -Lease $LifecycleLease
    return $metadata
}

function New-TokeneloPrivateUninstallRecoveryDirectory {
    param([Parameter(Mandatory=$true)][string]$RecoveryBase,[Parameter(Mandatory=$true)][string]$RecoveryRoot,
        [Parameter(Mandatory=$true)][string]$ExpectedOwnerSid,[Parameter(Mandatory=$true)]$LifecycleLease)
    $currentSid = [string][Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if ($ExpectedOwnerSid -cne $currentSid -or -not $env:LOCALAPPDATA -or
        -not [IO.Path]::IsPathRooted($env:LOCALAPPDATA) -or $env:LOCALAPPDATA -match '["\r\n]' -or
        $env:LOCALAPPDATA.StartsWith('\\')) {
        throw 'Uninstall recovery account or LocalAppData identity is invalid.'
    }
    $localRoot = [IO.Path]::GetFullPath($env:LOCALAPPDATA)
    if ($localRoot -cne $env:LOCALAPPDATA) { throw 'Uninstall LocalAppData path is not canonical.' }
    $expectedBase = [IO.Path]::GetFullPath((Join-Path $localRoot 'Tokenelo\recovery'))
    $fullBase = [IO.Path]::GetFullPath($RecoveryBase)
    $fullRoot = [IO.Path]::GetFullPath($RecoveryRoot)
    if ($fullBase -cne $RecoveryBase -or $fullBase -ine $expectedBase -or
        $fullRoot -cne $RecoveryRoot -or [IO.Path]::GetDirectoryName($fullRoot) -ine $fullBase -or
        [IO.Path]::GetFileName($fullRoot) -cnotmatch '^[0-9a-f]{32}$') {
        throw 'Uninstall recovery root does not match its exact per-user transaction path.'
    }
    Assert-TokeneloNoReparseAncestors -Path $localRoot -Description 'Uninstall LocalAppData root'
    $null = Get-TokeneloUninstallRecoveryDirectoryMetadata -Path $localRoot -ExpectedOwnerSid $ExpectedOwnerSid
    if (Test-Path -LiteralPath $fullRoot) { throw 'Uninstall recovery path already exists; overwrite refused.' }

    $tokeneloRoot = Join-Path $localRoot 'Tokenelo'
    $null = Ensure-TokeneloUninstallRecoveryParentDirectory -Path $tokeneloRoot `
        -ExpectedOwnerSid $ExpectedOwnerSid -LifecycleLease $LifecycleLease
    $null = Ensure-TokeneloUninstallRecoveryParentDirectory -Path $fullBase `
        -ExpectedOwnerSid $ExpectedOwnerSid -LifecycleLease $LifecycleLease
    Assert-TokeneloNoIncompleteTransaction -RecoveryBase $fullBase
    Assert-TokeneloNoReparseAncestors -Path $fullRoot -Description 'New uninstall recovery root'
    if (Test-Path -LiteralPath $fullRoot) { throw 'Uninstall recovery path appeared during preflight; overwrite refused.' }

    Assert-TokeneloCoordinatorLifecycleLeaseAlive -Lease $LifecycleLease
    $security = New-TokeneloProtectedUninstallRecoveryDirectorySecurity -ExpectedOwnerSid $ExpectedOwnerSid
    # DirectorySecurity is supplied to the creation call. Immediate path, owner and DACL readback
    # narrows the race; this is not a handle-based guarantee against a hostile same-user writer.
    try { New-TokeneloUninstallRecoveryDirectoryWithSecurity -Path $fullRoot -Security $security }
    catch { throw 'Uninstall recovery root could not be created with a protected DACL.' }
    Assert-TokeneloNoReparseAncestors -Path $fullRoot -Description 'Created uninstall recovery root'
    $metadata = Assert-TokeneloProtectedUninstallRecoveryDirectory -Path $fullRoot -ExpectedOwnerSid $ExpectedOwnerSid
    if (@(Get-ChildItem -LiteralPath $fullRoot -Force -ErrorAction Stop).Count -ne 0) {
        throw 'New uninstall recovery root is not empty; it was retained without mutation.'
    }
    Assert-TokeneloCoordinatorLifecycleLeaseAlive -Lease $LifecycleLease
    return $metadata
}

function Assert-TokeneloUninstallRecoveryChildren {
    param([Parameter(Mandatory=$true)][string]$RecoveryRoot,[Parameter(Mandatory=$true)][string[]]$ExpectedNames)
    $actual = @(Get-ChildItem -LiteralPath $RecoveryRoot -Force)
    foreach ($child in $actual) {
        if ($child.PSIsContainer -or ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
            [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($child.FullName)).TrimEnd('\') -cne $RecoveryRoot.TrimEnd('\')) {
            throw 'Uninstall recovery contains an unexpected directory or reparse point.'
        }
    }
    $actualNames = @($actual | ForEach-Object { [string]$_.Name })
    if ($actualNames.Count -ne $ExpectedNames.Count) { throw 'Uninstall recovery contains missing or unknown entries.' }
    foreach ($name in $ExpectedNames) {
        if (-not ($actualNames -ccontains $name)) { throw 'Uninstall recovery contains missing or unknown entries.' }
    }
}

function Write-TokeneloUninstallRecoveryHeader {
    param($Transaction,[Parameter(Mandatory=$true)][string]$CurrentSid,
        [Parameter(Mandatory=$true)][string]$PackageIdentity,[Parameter(Mandatory=$true)][string]$InstallRoot,
        [Parameter(Mandatory=$true)][ValidateSet('checkout','packaged')][string]$RuntimeMode)
    $actualSid = [string][Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if ($CurrentSid -cne $actualSid -or $CurrentSid -notmatch '^S-1-\d+(?:-\d+)+$') {
        throw 'Uninstall header account identity does not match the current Windows account.'
    }
    if ($PackageIdentity -cne 'com.elostudios.tokenelo') { throw 'Uninstall header package identity is unsupported.' }
    $fullInstallRoot = [IO.Path]::GetFullPath($InstallRoot)
    if ($fullInstallRoot -cne $InstallRoot -or -not [IO.Path]::IsPathRooted($InstallRoot) -or
        $InstallRoot -match '["\r\n]' -or $InstallRoot.StartsWith('\\')) {
        throw 'Uninstall header install root is not a canonical local absolute path.'
    }
    $expectedInstallRoot = if ($RuntimeMode -eq 'packaged') {
        [IO.Path]::GetFullPath((Split-Path -Parent (Split-Path -Parent ([IO.Path]::GetFullPath($RepoRoot)))))
    } else { [IO.Path]::GetFullPath($RepoRoot) }
    if ($fullInstallRoot -ine $expectedInstallRoot) {
        throw 'Uninstall header paths do not match the current Tokenelo installation context.'
    }
    Assert-TokeneloNoReparseAncestors -Path $fullInstallRoot -Description 'Uninstall install root'
    $recoveryRoot = [IO.Path]::GetFullPath([string]$Transaction.RecoveryRoot)
    $recoveryBase = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Tokenelo\recovery'))
    if ($recoveryRoot -cne [string]$Transaction.RecoveryRoot -or
        [IO.Path]::GetDirectoryName($recoveryRoot).TrimEnd('\') -ine $recoveryBase.TrimEnd('\') -or
        [IO.Path]::GetFileName($recoveryRoot) -cnotmatch '^[0-9a-f]{32}$') {
        throw 'Uninstall recovery root is not the exact per-user transaction directory.'
    }
    if ((Test-TokeneloPathWithin -Path $recoveryRoot -Parent $fullInstallRoot) -or
        (Test-TokeneloPathWithin -Path $fullInstallRoot -Parent $recoveryRoot)) {
        throw 'Uninstall recovery and install roots overlap.'
    }
    Assert-TokeneloNoReparseAncestors -Path $recoveryRoot -Description 'Uninstall recovery root'
    $recoveryDirectory = Get-TokeneloUninstallRecoveryDirectoryMetadata -Path $recoveryRoot -ExpectedOwnerSid $CurrentSid
    $expectedLauncherRoot = if ($RuntimeMode -eq 'packaged') {
        [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Tokenelo\launchers'))
    } else { [IO.Path]::GetFullPath((Join-Path $fullInstallRoot 'scripts')) }
    if ([IO.Path]::GetFullPath($LauncherRoot) -ine $expectedLauncherRoot -or
        ($RuntimeMode -eq 'packaged' -and (Test-TokeneloPathWithin -Path $expectedLauncherRoot -Parent $fullInstallRoot))) {
        throw 'Uninstall launcher root does not match the expected current installation context.'
    }
    $expectedJournalPath = [IO.Path]::GetFullPath((Join-Path $recoveryRoot 'journal.jsonl'))
    if ($Transaction.Id -cne [IO.Path]::GetFileName($recoveryRoot) -or
        [IO.Path]::GetFullPath([string]$Transaction.JournalPath) -cne $expectedJournalPath -or @($Transaction.Plans).Count -ne 2) {
        throw 'Uninstall transaction identity or role count is invalid.'
    }
    $null = Get-TokeneloCoordinatorFileState -Path $expectedJournalPath -ExpectedOwnerSid $CurrentSid
    $expectedNames = @('journal.jsonl')
    $roleRecords = [Collections.Generic.List[object]]::new()
    foreach ($role in @('tray','daemon')) {
        $rolePlans = @($Transaction.Plans | Where-Object { $_.Role -ceq $role })
        if ($rolePlans.Count -ne 1) { throw "Uninstall transaction does not contain exactly one $role role." }
        $plan = $rolePlans[0]
        $expectedTaskName = if ($role -ceq 'tray') { $TrayTaskName } else { $TaskName }
        $expectedLauncherPath = [IO.Path]::GetFullPath((Join-Path $expectedLauncherRoot ('tokenelo-' + $role + '-launcher.exe')))
        if ($plan.Name -cne $expectedTaskName -or [IO.Path]::GetFullPath($plan.LauncherPath) -cne $expectedLauncherPath -or
            $plan.Snapshot.Name -cne $expectedTaskName -or $plan.Snapshot.Role -cne $role -or
            [bool]$plan.Snapshot.Present -ne [bool]$plan.Owned) {
            throw "Uninstall $role snapshot does not match its exact owned role contract."
        }
        $present = [bool]$plan.Snapshot.Present
        $enabled = [bool]$plan.Snapshot.Enabled
        $state = [string]$plan.Snapshot.State
        $ownedTask = $null; $dataHome = $null; $xmlBackup = $null; $launcherBackup = $null; $launcherSourceMetadata = $null
        if ($present) {
            if (-not $plan.Snapshot.Owned -or $plan.Snapshot.Owned.Name -cne $expectedTaskName -or
                $plan.Snapshot.Owned.Enabled -ne $enabled -or $plan.Snapshot.Owned.State -cne $state) {
                throw "Uninstall $role snapshot task metadata is inconsistent."
            }
            foreach ($property in @('Execute','Arguments','Principal')) {
                if ([string]$plan.Owned.$property -cne [string]$plan.Snapshot.Owned.$property) {
                    throw "Uninstall $role plan and snapshot task identity differ."
                }
            }
            $dataHome = $plan.Snapshot.Owned.HomeDirectory
            $planDataHome = $plan.Owned.HomeDirectory
            if (($null -eq $dataHome) -ne ($null -eq $planDataHome)) {
                throw "Uninstall $role plan and snapshot task home nullability differs."
            }
            foreach ($homeValue in @($dataHome,$planDataHome)) {
                if ($null -ne $homeValue -and ($homeValue -isnot [string] -or [string]::IsNullOrEmpty([string]$homeValue))) {
                    throw "Uninstall $role data home must be a non-empty string or null."
                }
            }
            if ($null -ne $dataHome) {
                if ($dataHome -cne $planDataHome -or -not [IO.Path]::IsPathRooted([string]$dataHome) -or
                    [IO.Path]::GetFullPath([string]$dataHome) -cne [string]$dataHome -or [string]$dataHome -match '["\r\n]') {
                    throw "Uninstall $role data home is not canonical or does not match its plan."
                }
            }
            $ownedTask = [ordered]@{name=[string]$plan.Snapshot.Owned.Name;execute=[string]$plan.Snapshot.Owned.Execute;
                arguments=[string]$plan.Snapshot.Owned.Arguments;principal=[string]$plan.Snapshot.Owned.Principal;
                childCommand=$plan.Snapshot.Owned.ChildCommand;homeDirectory=$dataHome;enabled=$enabled;state=$state}
            $xmlName = $role + '.task.xml'; $launcherName = $role + '.launcher.original.exe'
            $xmlPath = Join-Path $recoveryRoot $xmlName; $launcherBytesPath = Join-Path $recoveryRoot $launcherName
            if ([IO.Path]::GetFullPath($plan.Snapshot.XmlPath) -cne [IO.Path]::GetFullPath($xmlPath) -or
                [IO.Path]::GetFullPath($plan.Snapshot.LauncherBytesPath) -cne [IO.Path]::GetFullPath($launcherBytesPath) -or
                -not $plan.Snapshot.LauncherPresent -or -not $plan.Snapshot.Xml -or -not $plan.Snapshot.XmlCanonical) {
                throw "Uninstall $role snapshot backup paths or XML are incomplete."
            }
            $xmlBytes = [Text.UTF8Encoding]::new($false).GetBytes([string]$plan.Snapshot.Xml)
            $xmlHash = Get-TokeneloSha256 $xmlBytes
            $canonicalXml = Get-TokeneloCanonicalTaskXml -Xml ([string]$plan.Snapshot.Xml)
            $canonicalHash = Get-TokeneloSha256 ([Text.UTF8Encoding]::new($false).GetBytes($canonicalXml))
            if ($xmlHash -cne $plan.Snapshot.XmlSha256 -or $canonicalXml -cne $plan.Snapshot.XmlCanonical) {
                throw "Uninstall $role task XML does not match its captured snapshot."
            }
            $xmlState = Get-TokeneloCoordinatorFileState -Path $xmlPath -ExpectedOwnerSid $CurrentSid
            if ($xmlState.Sha256 -cne $xmlHash -or $xmlState.Length -ne $xmlBytes.Length) {
                throw "Uninstall $role task XML backup failed its content check."
            }
            $launcherState = Get-TokeneloCoordinatorFileState -Path $launcherBytesPath -ExpectedOwnerSid $CurrentSid
            if ($launcherState.Sha256 -cne $plan.Snapshot.LauncherSha256) {
                throw "Uninstall $role launcher backup failed its content check."
            }
            $launcherSourceState = Get-TokeneloCoordinatorFileState -Path $expectedLauncherPath -ExpectedOwnerSid $CurrentSid
            if ($launcherSourceState.Sha256 -cne $launcherState.Sha256 -or $launcherSourceState.Length -ne $launcherState.Length) {
                throw "Uninstall $role launcher source changed after its byte snapshot."
            }
            $xmlBackup = [ordered]@{relativePath=$xmlName;length=[long]$xmlState.Length;sha256=$xmlState.Sha256;
                ownerSid=$xmlState.OwnerSid;attributes=[int]$xmlState.Attributes;aclSha256=$xmlState.AclSha256;canonicalSha256=$canonicalHash}
            $launcherBackup = [ordered]@{relativePath=$launcherName;length=[long]$launcherState.Length;sha256=$launcherState.Sha256;
                ownerSid=$launcherState.OwnerSid;attributes=[int]$launcherState.Attributes;aclSha256=$launcherState.AclSha256}
            $launcherSourceMetadata = [ordered]@{length=[long]$launcherSourceState.Length;sha256=$launcherSourceState.Sha256;
                ownerSid=$launcherSourceState.OwnerSid;attributes=[int]$launcherSourceState.Attributes;
                aclSha256=$launcherSourceState.AclSha256;aclSddl=$launcherSourceState.AclSddl}
            $plan.Snapshot | Add-Member -MemberType NoteProperty -Name LauncherSourceMetadata `
                -Value ([pscustomobject]$launcherSourceMetadata) -Force
            $expectedNames += @($xmlName,$launcherName)
        } else {
            if ($enabled -or $state -cne 'Absent' -or $plan.Snapshot.Owned -or $plan.Snapshot.LauncherPresent -or
                $plan.Snapshot.XmlPath -or $plan.Snapshot.LauncherBytesPath -or $plan.Snapshot.LauncherSha256 -or
                (Test-Path -LiteralPath (Join-Path $recoveryRoot ($role + '.task.xml'))) -or
                (Test-Path -LiteralPath (Join-Path $recoveryRoot ($role + '.launcher.original.exe'))) -or
                (Test-Path -LiteralPath $expectedLauncherPath)) {
                throw "Uninstall absent $role snapshot contains owned state or backup files."
            }
        }
        $roleRecords.Add([ordered]@{role=$role;taskName=$expectedTaskName;present=$present;enabled=$enabled;state=$state;
            dataHomeDirectory=$dataHome;ownedTask=$ownedTask;launcherPath=$expectedLauncherPath;taskXmlBackup=$xmlBackup;
            launcherBackup=$launcherBackup;launcherSourceMetadata=$launcherSourceMetadata})
    }
    Assert-TokeneloUninstallRecoveryChildren -RecoveryRoot $recoveryRoot -ExpectedNames $expectedNames
    $headerPath = Join-Path $recoveryRoot 'transaction.header.json'
    if (Test-Path -LiteralPath $headerPath) { throw 'Uninstall transaction header already exists; overwrite refused.' }
    $header = [ordered]@{schemaVersion=1;transactionId=[string]$Transaction.Id;packageIdentity=$PackageIdentity;
        currentSid=$CurrentSid;installRoot=$fullInstallRoot;runtimeMode=$RuntimeMode;recoveryRoot=$recoveryRoot;
        recoveryDirectory=[ordered]@{ownerSid=$recoveryDirectory.OwnerSid;attributes=[int]$recoveryDirectory.Attributes;aclSha256=$recoveryDirectory.AclSha256};
        launcherRoot=$expectedLauncherRoot;createdAtUtc=[DateTime]::UtcNow.ToString('o');roles=@($roleRecords.ToArray())}
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($header | ConvertTo-Json -Compress -Depth 8))
    if ($bytes.Length -gt 262144) { throw 'Uninstall transaction header exceeds the bounded size limit.' }
    $sha256 = Get-TokeneloSha256 $bytes
    Assert-TokeneloCoordinatorLifecycleLeaseAlive -Lease $Transaction.LifecycleLease
    Write-TokeneloDurableFile -Path $headerPath -Bytes $bytes
    $headerState = Get-TokeneloCoordinatorFileState -Path $headerPath -ExpectedOwnerSid $CurrentSid
    if ($headerState.Sha256 -cne $sha256 -or $headerState.Length -ne $bytes.Length) {
        throw 'Uninstall transaction header failed durable readback verification.'
    }
    $Transaction.HeaderPath = $headerPath
    $Transaction.RecoveryHeaderSha256 = $sha256
    $Transaction.PackageIdentity = $PackageIdentity
    $Transaction.CurrentSid = $CurrentSid
    $Transaction.InstallRoot = $fullInstallRoot
    $Transaction.RuntimeMode = $RuntimeMode
    return [pscustomobject]@{Path=$headerPath;Sha256=$sha256;Header=$header;Length=[long]$bytes.Length}
}

function Get-TokeneloUninstallRecoveryBackupBytes {
    param($Metadata,[string]$RecoveryRoot,[string]$ExpectedRelativePath,[string]$ExpectedOwnerSid,[switch]$TaskXml)
    $metadataNames = if ($TaskXml) { @('relativePath','length','sha256','ownerSid','attributes','aclSha256','canonicalSha256') } `
        else { @('relativePath','length','sha256','ownerSid','attributes','aclSha256') }
    Assert-TokeneloUninstallHeaderPropertySet -Object $Metadata -ExpectedNames $metadataNames -Description 'Uninstall backup metadata'
    if (($Metadata.length -isnot [long] -and $Metadata.length -isnot [int]) -or
        ($Metadata.attributes -isnot [long] -and $Metadata.attributes -isnot [int]) -or
        $Metadata.relativePath -isnot [string] -or $Metadata.sha256 -isnot [string] -or
        $Metadata.ownerSid -isnot [string] -or $Metadata.aclSha256 -isnot [string] -or
        ($TaskXml -and $Metadata.canonicalSha256 -isnot [string])) {
        throw 'Uninstall backup metadata has an invalid JSON field type.'
    }
    if ($Metadata.relativePath -cne $ExpectedRelativePath -or [IO.Path]::GetFileName([string]$Metadata.relativePath) -cne $ExpectedRelativePath) {
        throw 'Uninstall backup path is not the exact role-owned filename.'
    }
    $path = [IO.Path]::GetFullPath((Join-Path $RecoveryRoot $ExpectedRelativePath))
    if ([IO.Path]::GetDirectoryName($path).TrimEnd('\') -cne $RecoveryRoot.TrimEnd('\')) {
        throw 'Uninstall backup path escaped its transaction directory.'
    }
    Assert-TokeneloNoReparseAncestors -Path $path -Description 'Uninstall snapshot backup'
    $maximumBytes = if ($TaskXml) { 1048576L } else { 16777216L }
    $expectedLength = [long]$Metadata.length
    if ($expectedLength -lt 1 -or $expectedLength -gt $maximumBytes -or
        [string]$Metadata.sha256 -cnotmatch '^[0-9a-f]{64}$' -or
        [string]$Metadata.ownerSid -cne $ExpectedOwnerSid -or
        [string]$Metadata.aclSha256 -cnotmatch '^[0-9a-f]{64}$') {
        throw 'Uninstall backup metadata has an invalid length, hash or owner.'
    }
    $stateBefore = Get-TokeneloCoordinatorFileState -Path $path -ExpectedOwnerSid $ExpectedOwnerSid
    if ($stateBefore.Length -ne $expectedLength -or $stateBefore.Sha256 -cne [string]$Metadata.sha256 -or
        $stateBefore.OwnerSid -cne [string]$Metadata.ownerSid -or $stateBefore.Attributes -ne [int]$Metadata.attributes -or
        $stateBefore.AclSha256 -cne [string]$Metadata.aclSha256) {
        throw 'Uninstall backup metadata does not match the immutable header.'
    }
    $bytes = [IO.File]::ReadAllBytes($path)
    $stateAfter = Get-TokeneloCoordinatorFileState -Path $path -ExpectedOwnerSid $ExpectedOwnerSid
    if ($bytes.Length -ne $expectedLength -or (Get-TokeneloSha256 $bytes) -cne [string]$Metadata.sha256 -or
        $stateAfter.Length -ne $stateBefore.Length -or $stateAfter.Sha256 -cne $stateBefore.Sha256 -or
        $stateAfter.Attributes -ne $stateBefore.Attributes -or $stateAfter.AclSha256 -cne $stateBefore.AclSha256) {
        throw 'Uninstall backup changed while it was read.'
    }
    return [pscustomobject]@{Path=$path;Bytes=$bytes;State=$stateAfter}
}

function Assert-TokeneloUninstallSnapshotLauncherState {
    param($Snapshot,[Parameter(Mandatory=$true)][string]$Path)
    if (-not $Snapshot -or -not $Snapshot.PSObject.Properties['LauncherSourceMetadata'] -or -not $Snapshot.LauncherSourceMetadata) {
        return
    }
    $metadata = $Snapshot.LauncherSourceMetadata
    $state = Get-TokeneloCoordinatorFileState -Path $Path -ExpectedOwnerSid ([string]$metadata.OwnerSid)
    if ($state.Length -ne [long]$metadata.Length -or $state.Sha256 -cne [string]$metadata.Sha256 -or
        $state.OwnerSid -cne [string]$metadata.OwnerSid -or $state.Attributes -ne [int]$metadata.Attributes -or
        $state.AclSha256 -cne [string]$metadata.AclSha256) {
        throw 'Owned uninstall launcher metadata changed from the captured snapshot.'
    }
}

function Read-TokeneloUninstallRecoveryJournal {
    param([string]$JournalPath,[string]$ExpectedOwnerSid,[string]$TransactionId,[string]$ExpectedHeaderSha256)
    $journalState = Get-TokeneloCoordinatorFileState -Path $JournalPath -ExpectedOwnerSid $ExpectedOwnerSid
    if ($journalState.Length -lt 1 -or $journalState.Length -gt 1048576) { throw 'Uninstall recovery journal has an invalid size.' }
    $journalBytes = [IO.File]::ReadAllBytes($JournalPath)
    $afterRead = Get-TokeneloCoordinatorFileState -Path $JournalPath -ExpectedOwnerSid $ExpectedOwnerSid
    if ($afterRead.Length -ne $journalState.Length -or $afterRead.Sha256 -cne $journalState.Sha256 -or
        $afterRead.AclSha256 -cne $journalState.AclSha256) { throw 'Uninstall recovery journal changed while it was read.' }
    try { $journalText = [Text.UTF8Encoding]::new($false,$true).GetString($journalBytes) }
    catch { throw 'Uninstall recovery journal is not strict UTF-8.' }
    if ($journalText.StartsWith([string][char]0xFEFF,[StringComparison]::Ordinal) -or -not $journalText.EndsWith("`n") -or $journalText.Contains("`r")) {
        throw 'Uninstall recovery journal is truncated or not in the expected JSONL format.'
    }
    $parts = $journalText.Split([char[]]@("`n"),[StringSplitOptions]::None)
    if ($parts.Count -lt 2 -or $parts[$parts.Count-1] -cne '') { throw 'Uninstall recovery journal is truncated.' }
    $lines = @($parts[0..($parts.Count-2)])
    foreach ($line in $lines) { if (-not $line) { throw 'Uninstall recovery journal has an empty or partial record.' } }
    $allowedPhases = @('preflight-complete','snapshot-saved','recovery-header-written','stop-requested','task-stopped',
        'cleanup-complete','unregister-requested','unregistered','launcher-remove-requested','launcher-removed','launcher-restored',
        'restore-task-already-present','restore-task-xml-requested','remove-new-task-requested','restore-enabled-requested',
        'restore-running-requested','restore-enable-compensation-started','restore-enable-compensation-complete',
        'restore-enable-compensation-incomplete','rollback-started','rollback-complete','failure','manual-recovery-required',
        'preparation-failed-unchanged','committed')
    $rolePhases = @('snapshot-saved','stop-requested','task-stopped','unregister-requested','unregistered',
        'launcher-remove-requested','launcher-removed','launcher-restored','restore-task-already-present',
        'restore-task-xml-requested','remove-new-task-requested','restore-enabled-requested','restore-running-requested')
    $records = [Collections.Generic.List[object]]::new()
    for ($index=0; $index -lt $lines.Count; $index++) {
        $record = ConvertFrom-TokeneloUninstallHeaderJson -Json $lines[$index] -Description 'Uninstall recovery journal record'
        Assert-TokeneloUninstallHeaderPropertySet -Object $record -ExpectedNames @('recordedAt','transactionId','phase','role','detail') `
            -Description 'Uninstall recovery journal record'
        $canonicalRecord = [ordered]@{recordedAt=[string]$record.recordedAt;transactionId=[string]$record.transactionId;
            phase=[string]$record.phase;role=[string]$record.role;detail=[string]$record.detail}
        if (($canonicalRecord | ConvertTo-Json -Compress -Depth 8) -cne $lines[$index]) {
            throw 'Uninstall recovery journal record is not canonical JSON.'
        }
        try { $null = [DateTime]::ParseExact([string]$record.recordedAt,'o',[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind) }
        catch { throw 'Uninstall recovery journal timestamp is invalid.' }
        if ([string]$record.transactionId -cne $TransactionId -or [string]$record.phase -cnotin $allowedPhases) {
            throw 'Uninstall recovery journal has a foreign transaction or unknown phase.'
        }
        if ([string]$record.phase -cin $rolePhases) {
            if ([string]$record.role -cnotin @('tray','daemon')) { throw 'Uninstall recovery journal has an unknown role.' }
        } elseif ([string]$record.role) { throw 'Uninstall recovery journal has a role on a non-role phase.' }
        $records.Add($record)
    }
    if ($records.Count -lt 4 -or $records[0].phase -cne 'preflight-complete' -or
        $records[1].phase -cne 'snapshot-saved' -or $records[1].role -cne 'tray' -or
        $records[2].phase -cne 'snapshot-saved' -or $records[2].role -cne 'daemon' -or
        $records[3].phase -cne 'recovery-header-written' -or $records[3].detail -cne $ExpectedHeaderSha256 -or
        @($records | Where-Object { $_.phase -ceq 'recovery-header-written' }).Count -ne 1) {
        throw 'Uninstall recovery journal does not bind the complete pre-mutation role snapshot to this header.'
    }
    if (@($records | Where-Object { $_.phase -cin @('preflight-complete','snapshot-saved') }).Count -ne 3) {
        throw 'Uninstall recovery journal repeats a pre-mutation snapshot record.'
    }
    $lastPhase = [string]$records[$records.Count-1].phase
    $terminalPhases = @('committed','rollback-complete','preparation-failed-unchanged')
    $terminalRecords = @($records | Where-Object { $_.phase -cin $terminalPhases })
    if (($terminalRecords.Count -gt 0 -and ($terminalRecords.Count -ne 1 -or $records[$records.Count-1].phase -cnotin $terminalPhases)) -or
        (@($records | Where-Object { $_.phase -ceq 'manual-recovery-required' }).Count -gt 0 -and $lastPhase -cne 'manual-recovery-required')) {
        throw 'Uninstall recovery journal has records after a terminal or manual-recovery phase.'
    }
    if ($lastPhase -cin $terminalPhases) {
        throw 'Uninstall recovery transaction is already terminal.'
    }
    $unregistered = @{}; $launcherRemoved = @(); $manualRecovery = $false
    foreach ($record in $records) {
        if ($record.phase -ceq 'unregister-requested') { $unregistered[[string]$record.role] = $true }
        if ($record.phase -ceq 'launcher-remove-requested') { $launcherRemoved += [string]$record.role }
        if ($record.phase -ceq 'manual-recovery-required') { $manualRecovery = $true }
    }
    return [pscustomobject]@{Records=@($records.ToArray());TaskMutationStarted=(@($records|Where-Object{$_.phase -cin @('stop-requested','task-stopped','unregister-requested','unregistered')}).Count -gt 0);
        FileMutationStarted=(@($records|Where-Object{$_.phase -cin @('launcher-remove-requested','launcher-removed')}).Count -gt 0);
        CleanupComplete=(@($records|Where-Object{$_.phase -ceq 'cleanup-complete'}).Count -gt 0);
        OwnershipUncertain=$manualRecovery;UnregisteredRoles=$unregistered;LauncherRemovalRequestedRoles=$launcherRemoved}
}

function Read-TokeneloUninstallRecoveryTransaction {
    param([Parameter(Mandatory=$true)][string]$RecoveryRoot,
        [Parameter(Mandatory=$true)][string]$ExpectedHeaderSha256,
        [Parameter(Mandatory=$true)][string]$ExpectedCurrentSid,
        [Parameter(Mandatory=$true)][string]$ExpectedPackageIdentity,
        [Parameter(Mandatory=$true)][string]$ExpectedInstallRoot,
        [Parameter(Mandatory=$true)][ValidateSet('checkout','packaged')][string]$ExpectedRuntimeMode,
        [Parameter(Mandatory=$true)][string]$ExpectedLauncherRoot,
        [Parameter(Mandatory=$true)][hashtable]$ExpectedDataHomeByRole)
    $actualSid = [string][Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if ($ExpectedCurrentSid -cne $actualSid -or $ExpectedCurrentSid -notmatch '^S-1-\d+(?:-\d+)+$') {
        throw 'Uninstall recovery header account identity does not match the current Windows account.'
    }
    if ($ExpectedPackageIdentity -cne 'com.elostudios.tokenelo') { throw 'Uninstall recovery package identity is unsupported.' }
    $fullInstallRoot = [IO.Path]::GetFullPath($ExpectedInstallRoot)
    if ($fullInstallRoot -cne $ExpectedInstallRoot -or -not [IO.Path]::IsPathRooted($ExpectedInstallRoot) -or
        $ExpectedInstallRoot -match '["\r\n]' -or $ExpectedInstallRoot.StartsWith('\\')) {
        throw 'Expected uninstall install root is not canonical.'
    }
    $fullLauncherRoot = [IO.Path]::GetFullPath($ExpectedLauncherRoot)
    if ($fullLauncherRoot -cne $ExpectedLauncherRoot -or -not [IO.Path]::IsPathRooted($ExpectedLauncherRoot) -or
        $ExpectedLauncherRoot -match '["\r\n]' -or $ExpectedLauncherRoot.StartsWith('\\')) {
        throw 'Expected uninstall launcher root is not canonical.'
    }
    $derivedLauncherRoot = if ($ExpectedRuntimeMode -eq 'packaged') {
        [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Tokenelo\launchers'))
    } else { [IO.Path]::GetFullPath((Join-Path $fullInstallRoot 'scripts')) }
    if ($fullLauncherRoot -ine $derivedLauncherRoot -or
        ($ExpectedRuntimeMode -eq 'packaged' -and (Test-TokeneloPathWithin -Path $fullLauncherRoot -Parent $fullInstallRoot))) {
        throw 'Expected uninstall launcher root does not match the current installation context.'
    }
    if ($ExpectedHeaderSha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'Independent uninstall header hash is invalid.' }
    $fullRecoveryRoot = [IO.Path]::GetFullPath($RecoveryRoot)
    if ($fullRecoveryRoot -cne $RecoveryRoot -or -not [IO.Path]::IsPathRooted($RecoveryRoot) -or
        $RecoveryRoot -match '["\r\n]' -or $RecoveryRoot.StartsWith('\\')) {
        throw 'Uninstall recovery root is not canonical.'
    }
    $recoveryBase = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Tokenelo\recovery'))
    if ([IO.Path]::GetDirectoryName($fullRecoveryRoot).TrimEnd('\') -ine $recoveryBase.TrimEnd('\') -or
        [IO.Path]::GetFileName($fullRecoveryRoot) -cnotmatch '^[0-9a-f]{32}$') {
        throw 'Uninstall recovery root is not the exact per-user transaction directory.'
    }
    $expectedHomeKeys = @($ExpectedDataHomeByRole.Keys | ForEach-Object { [string]$_ })
    if ($expectedHomeKeys.Count -ne 2 -or -not ($expectedHomeKeys -ccontains 'tray') -or
        -not ($expectedHomeKeys -ccontains 'daemon') -or
        @($expectedHomeKeys | Where-Object { $_ -cnotin @('tray','daemon') }).Count -gt 0) {
        throw 'Expected uninstall data home map must name exactly tray and daemon.'
    }
    foreach ($role in @('tray','daemon')) {
        $expectedHome = $ExpectedDataHomeByRole[$role]
        if ($null -ne $expectedHome -and ($expectedHome -isnot [string] -or [string]::IsNullOrEmpty([string]$expectedHome) -or
            -not [IO.Path]::IsPathRooted([string]$expectedHome) -or
            [IO.Path]::GetFullPath([string]$expectedHome) -cne [string]$expectedHome -or
            [string]$expectedHome -match '["\r\n]')) {
            throw "Expected uninstall $role data home is not a non-empty canonical absolute path or null."
        }
    }
    if ((Test-TokeneloPathWithin -Path $fullRecoveryRoot -Parent $fullInstallRoot) -or
        (Test-TokeneloPathWithin -Path $fullInstallRoot -Parent $fullRecoveryRoot)) {
        throw 'Uninstall recovery and install roots overlap.'
    }
    $ownerSid = $ExpectedCurrentSid
    $directoryState = Get-TokeneloUninstallRecoveryDirectoryMetadata -Path $fullRecoveryRoot -ExpectedOwnerSid $ownerSid
    $headerPath = Join-Path $fullRecoveryRoot 'transaction.header.json'
    $headerState = Get-TokeneloCoordinatorFileState -Path $headerPath -ExpectedOwnerSid $ownerSid
    if ($headerState.Length -lt 1 -or $headerState.Length -gt 262144 -or $headerState.Sha256 -cne $ExpectedHeaderSha256) {
        throw 'Uninstall transaction header does not match the independently supplied hash.'
    }
    $headerBytes = [IO.File]::ReadAllBytes($headerPath)
    $headerAfterRead = Get-TokeneloCoordinatorFileState -Path $headerPath -ExpectedOwnerSid $ownerSid
    if ($headerAfterRead.Length -ne $headerState.Length -or $headerAfterRead.Sha256 -cne $headerState.Sha256 -or
        $headerAfterRead.Attributes -ne $headerState.Attributes -or $headerAfterRead.AclSha256 -cne $headerState.AclSha256) {
        throw 'Uninstall transaction header changed while it was read.'
    }
    try { $headerJson = [Text.UTF8Encoding]::new($false,$true).GetString($headerBytes) }
    catch { throw 'Uninstall transaction header is not strict UTF-8.' }
    if ($headerJson.StartsWith([string][char]0xFEFF,[StringComparison]::Ordinal)) { throw 'Uninstall transaction header has a byte-order mark.' }
    $header = ConvertFrom-TokeneloUninstallHeaderJson -Json $headerJson -Description 'Uninstall transaction header'
    Assert-TokeneloUninstallHeaderPropertySet -Object $header -ExpectedNames @('schemaVersion','transactionId','packageIdentity',
        'currentSid','installRoot','runtimeMode','recoveryRoot','recoveryDirectory','launcherRoot','createdAtUtc','roles') `
        -Description 'Uninstall transaction header'
    $canonicalBytes = [Text.UTF8Encoding]::new($false).GetBytes(($header | ConvertTo-Json -Compress -Depth 8))
    if ((Get-TokeneloSha256 $canonicalBytes) -cne $ExpectedHeaderSha256 -or $canonicalBytes.Length -ne $headerBytes.Length) {
        throw 'Uninstall transaction header is not canonical JSON.'
    }
    if (($header.schemaVersion -isnot [long] -and $header.schemaVersion -isnot [int]) -or
        $header.transactionId -isnot [string] -or $header.roles -isnot [array] -or
        $header.packageIdentity -isnot [string] -or $header.currentSid -isnot [string] -or
        $header.installRoot -isnot [string] -or $header.runtimeMode -isnot [string] -or
        $header.recoveryRoot -isnot [string] -or $header.launcherRoot -isnot [string] -or $header.createdAtUtc -isnot [string] -or
        [int]$header.schemaVersion -ne 1 -or [string]$header.transactionId -cnotmatch '^[0-9a-f]{32}$' -or
        [string]$header.packageIdentity -cne $ExpectedPackageIdentity -or [string]$header.currentSid -cne $ExpectedCurrentSid -or
        [string]$header.installRoot -cne $fullInstallRoot -or [string]$header.runtimeMode -cne $ExpectedRuntimeMode -or
        [string]$header.recoveryRoot -cne $fullRecoveryRoot -or [string]$header.launcherRoot -cne $fullLauncherRoot -or
        [IO.Path]::GetFileName($fullRecoveryRoot) -cne [string]$header.transactionId) {
        throw 'Uninstall transaction header identity does not match the caller supplied context.'
    }
    try { $null = [DateTime]::ParseExact([string]$header.createdAtUtc,'o',[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind) }
    catch { throw 'Uninstall transaction header timestamp is invalid.' }
    Assert-TokeneloUninstallHeaderPropertySet -Object $header.recoveryDirectory -ExpectedNames @('ownerSid','attributes','aclSha256') `
        -Description 'Uninstall recovery directory metadata'
    if ($header.recoveryDirectory.ownerSid -isnot [string] -or
        ($header.recoveryDirectory.attributes -isnot [long] -and $header.recoveryDirectory.attributes -isnot [int]) -or
        $header.recoveryDirectory.aclSha256 -isnot [string]) {
        throw 'Uninstall recovery directory metadata has an invalid JSON field type.'
    }
    if ([string]$header.recoveryDirectory.ownerSid -cne $directoryState.OwnerSid -or
        [int]$header.recoveryDirectory.attributes -ne $directoryState.Attributes -or
        [string]$header.recoveryDirectory.aclSha256 -cne $directoryState.AclSha256) {
        throw 'Uninstall recovery directory metadata changed after the header was written.'
    }
    $roles = @($header.roles)
    if ($roles.Count -ne 2 -or [string]$roles[0].role -cne 'tray' -or [string]$roles[1].role -cne 'daemon') {
        throw 'Uninstall transaction header must contain exactly the tray and daemon roles in order.'
    }
    $journalPath = Join-Path $fullRecoveryRoot 'journal.jsonl'
    $journal = Read-TokeneloUninstallRecoveryJournal -JournalPath $journalPath -ExpectedOwnerSid $ownerSid `
        -TransactionId ([string]$header.transactionId) -ExpectedHeaderSha256 $ExpectedHeaderSha256
    $expectedNames = @('transaction.header.json','journal.jsonl')
    $plans = [Collections.Generic.List[object]]::new()
    foreach ($index in 0..1) {
        $role = if ($index -eq 0) { 'tray' } else { 'daemon' }
        $roleRecord = $roles[$index]
        Assert-TokeneloUninstallHeaderPropertySet -Object $roleRecord -ExpectedNames @('role','taskName','present','enabled','state',
            'dataHomeDirectory','ownedTask','launcherPath','taskXmlBackup','launcherBackup','launcherSourceMetadata') -Description "Uninstall $role role record"
        if ($null -eq $roleRecord.role -or $roleRecord.role.GetType().FullName -cne 'System.String' -or
            $null -eq $roleRecord.taskName -or $roleRecord.taskName.GetType().FullName -cne 'System.String' -or
            $null -eq $roleRecord.state -or $roleRecord.state.GetType().FullName -cne 'System.String' -or
            $null -eq $roleRecord.launcherPath -or $roleRecord.launcherPath.GetType().FullName -cne 'System.String' -or
            ($null -ne $roleRecord.dataHomeDirectory -and $roleRecord.dataHomeDirectory.GetType().FullName -cne 'System.String')) {
            throw "Uninstall $role role record has an invalid JSON field type."
        }
        if ($null -ne $roleRecord.dataHomeDirectory -and [string]::IsNullOrEmpty([string]$roleRecord.dataHomeDirectory)) {
            throw "Uninstall $role data home must be a non-empty string or null."
        }
        $expectedTaskName = if ($role -ceq 'tray') { $TrayTaskName } else { $TaskName }
        $expectedLauncherPath = [IO.Path]::GetFullPath((Join-Path $fullLauncherRoot ('tokenelo-' + $role + '-launcher.exe')))
        if ([string]$roleRecord.role -cne $role -or [string]$roleRecord.taskName -cne $expectedTaskName -or
            [string]$roleRecord.launcherPath -cne $expectedLauncherPath -or $roleRecord.present -isnot [bool] -or
            $roleRecord.enabled -isnot [bool] -or -not [string]$roleRecord.state -or [string]$roleRecord.state -match '["\r\n]' -or
            (-not [bool]$roleRecord.present -and ([string]$roleRecord.state -cne 'Absent' -or [bool]$roleRecord.enabled))) {
            throw "Uninstall $role role identity or typed presence state is invalid."
        }
        $recordDataHome = $roleRecord.dataHomeDirectory
        $expectedDataHome = $ExpectedDataHomeByRole[$role]
        if (($null -eq $recordDataHome) -ne ($null -eq $expectedDataHome) -or
            ($null -ne $recordDataHome -and [string]$recordDataHome -cne [string]$expectedDataHome)) {
            throw "Uninstall $role data home does not match the independently supplied role context."
        }
        $present = [bool]$roleRecord.present; $enabled = [bool]$roleRecord.enabled
        $ownedTask = $null; $xml = $null; $xmlCanonical = $null; $xmlSha256 = $null; $launcherSourceMetadata = $null
        $xmlPath = $null; $launcherBytesPath = $null; $launcherSha256 = $null
        if ($present) {
            if ([string]$roleRecord.state -ceq 'Absent') { throw "Present uninstall $role has absent state." }
            Assert-TokeneloUninstallHeaderPropertySet -Object $roleRecord.ownedTask -ExpectedNames @('name','execute','arguments','principal',
                'childCommand','homeDirectory','enabled','state') -Description "Uninstall $role owned task metadata"
            if ($roleRecord.ownedTask.name -isnot [string] -or $roleRecord.ownedTask.execute -isnot [string] -or
                $roleRecord.ownedTask.arguments -isnot [string] -or $roleRecord.ownedTask.principal -isnot [string] -or
                ($null -ne $roleRecord.ownedTask.childCommand -and $roleRecord.ownedTask.childCommand -isnot [string]) -or
                ($null -ne $roleRecord.ownedTask.homeDirectory -and $roleRecord.ownedTask.homeDirectory -isnot [string]) -or
                $roleRecord.ownedTask.enabled -isnot [bool] -or $roleRecord.ownedTask.state -isnot [string]) {
                throw "Uninstall $role owned task metadata has an invalid JSON field type."
            }
            if ([string]$roleRecord.ownedTask.name -cne $expectedTaskName -or
                [string]$roleRecord.ownedTask.execute -ine $expectedLauncherPath -or
                [string]::IsNullOrWhiteSpace([string]$roleRecord.ownedTask.principal) -or
                [string]$roleRecord.ownedTask.principal -match '["\r\n]' -or
                [string]::IsNullOrWhiteSpace([string]$roleRecord.ownedTask.arguments) -or
                [string]$roleRecord.ownedTask.arguments -match '[\r\n]' -or
                $roleRecord.ownedTask.enabled -isnot [bool] -or [bool]$roleRecord.ownedTask.enabled -ne $enabled -or
                [string]$roleRecord.ownedTask.state -cne [string]$roleRecord.state) {
                throw "Uninstall $role owned task metadata is inconsistent."
            }
            if (($null -eq $roleRecord.ownedTask.homeDirectory) -ne ($null -eq $roleRecord.dataHomeDirectory) -or
                ($null -ne $roleRecord.dataHomeDirectory -and
                    ([string]::IsNullOrEmpty([string]$roleRecord.ownedTask.homeDirectory) -or
                     [string]$roleRecord.ownedTask.homeDirectory -cne [string]$roleRecord.dataHomeDirectory))) {
                throw "Uninstall $role owned task home nullability or value is inconsistent."
            }
            if ($null -ne $roleRecord.dataHomeDirectory) {
                if (-not [IO.Path]::IsPathRooted([string]$roleRecord.dataHomeDirectory) -or
                    [IO.Path]::GetFullPath([string]$roleRecord.dataHomeDirectory) -cne [string]$roleRecord.dataHomeDirectory -or
                    [string]$roleRecord.dataHomeDirectory -match '["\r\n]') { throw "Uninstall $role data home is not canonical." }
            }
            $ownedTask = [pscustomobject]@{Name=[string]$roleRecord.ownedTask.name;Execute=[string]$roleRecord.ownedTask.execute;
                Arguments=[string]$roleRecord.ownedTask.arguments;Principal=[string]$roleRecord.ownedTask.principal;
                ChildCommand=$roleRecord.ownedTask.childCommand;HomeDirectory=$roleRecord.dataHomeDirectory;
                Enabled=$enabled;State=[string]$roleRecord.state}
            $xmlName = $role + '.task.xml'; $launcherName = $role + '.launcher.original.exe'
            $xmlPath = Join-Path $fullRecoveryRoot $xmlName; $launcherBytesPath = Join-Path $fullRecoveryRoot $launcherName
            $xml = Get-TokeneloUninstallRecoveryBackupBytes -Metadata $roleRecord.taskXmlBackup -RecoveryRoot $fullRecoveryRoot `
                -ExpectedRelativePath $xmlName -ExpectedOwnerSid $ownerSid -TaskXml
            $canonicalXml = Get-TokeneloCanonicalTaskXml -Xml ([Text.UTF8Encoding]::new($false,$true).GetString($xml.Bytes))
            $canonicalHash = Get-TokeneloSha256 ([Text.UTF8Encoding]::new($false).GetBytes($canonicalXml))
            if ($canonicalHash -cne [string]$roleRecord.taskXmlBackup.canonicalSha256) {
                throw "Uninstall $role task XML canonical hash does not match the header."
            }
            $xmlText = [Text.UTF8Encoding]::new($false,$true).GetString($xml.Bytes)
            if ($xmlText.StartsWith([string][char]0xFEFF,[StringComparison]::Ordinal)) { throw "Uninstall $role task XML backup has a byte-order mark." }
            $xmlCanonical = $canonicalXml; $xmlSha256 = [string]$roleRecord.taskXmlBackup.sha256
            $launcher = Get-TokeneloUninstallRecoveryBackupBytes -Metadata $roleRecord.launcherBackup -RecoveryRoot $fullRecoveryRoot `
                -ExpectedRelativePath $launcherName -ExpectedOwnerSid $ownerSid
            $launcherSha256 = [string]$roleRecord.launcherBackup.sha256
            Assert-TokeneloUninstallHeaderPropertySet -Object $roleRecord.launcherSourceMetadata `
                -ExpectedNames @('length','sha256','ownerSid','attributes','aclSha256','aclSddl') -Description "Uninstall $role source launcher metadata"
            $sourceMetadata = $roleRecord.launcherSourceMetadata
            if (($sourceMetadata.length -isnot [long] -and $sourceMetadata.length -isnot [int]) -or
                ($sourceMetadata.attributes -isnot [long] -and $sourceMetadata.attributes -isnot [int]) -or
                $sourceMetadata.sha256 -isnot [string] -or $sourceMetadata.ownerSid -isnot [string] -or
                $sourceMetadata.aclSha256 -isnot [string] -or $sourceMetadata.aclSddl -isnot [string] -or
                [string]$sourceMetadata.ownerSid -cne $ownerSid -or
                [long]$sourceMetadata.length -ne [long]$roleRecord.launcherBackup.length -or
                [string]$sourceMetadata.sha256 -cne [string]$roleRecord.launcherBackup.sha256 -or
                [string]$sourceMetadata.aclSha256 -cnotmatch '^[0-9a-f]{64}$' -or
                (Get-TokeneloSha256 ([Text.Encoding]::UTF8.GetBytes([string]$sourceMetadata.aclSddl))) -cne [string]$sourceMetadata.aclSha256) {
                throw "Uninstall $role source launcher metadata is invalid or differs from its byte backup."
            }
            $sourceSecurity = [Security.AccessControl.FileSecurity]::new()
            try { $sourceSecurity.SetSecurityDescriptorSddlForm([string]$sourceMetadata.aclSddl,[Security.AccessControl.AccessControlSections]::All) }
            catch { throw "Uninstall $role source launcher ACL metadata is malformed." }
            if ($sourceSecurity.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $ownerSid) {
                throw "Uninstall $role source launcher ACL owner does not match the current account."
            }
            $sourceAttributes = [int]$sourceMetadata.attributes
            $allowedLauncherAttributes = [int]([IO.FileAttributes]::Normal -bor [IO.FileAttributes]::Archive -bor
                [IO.FileAttributes]::Hidden -bor [IO.FileAttributes]::ReadOnly -bor [IO.FileAttributes]::System -bor
                [IO.FileAttributes]::NotContentIndexed -bor [IO.FileAttributes]::Temporary)
            if (($sourceAttributes -band (-bnot $allowedLauncherAttributes)) -ne 0) {
                throw "Uninstall $role source launcher metadata has unsupported attributes."
            }
            $launcherSourceMetadata = [pscustomobject]@{Length=[long]$sourceMetadata.length;Sha256=[string]$sourceMetadata.sha256;
                OwnerSid=[string]$sourceMetadata.ownerSid;Attributes=$sourceAttributes;AclSha256=[string]$sourceMetadata.aclSha256;
                AclSddl=[string]$sourceMetadata.aclSddl}
            $expectedNames += @($xmlName,$launcherName)
            $xml = $xmlText
        } else {
            if ($enabled -or [string]$roleRecord.state -cne 'Absent' -or $null -ne $roleRecord.dataHomeDirectory -or
                $roleRecord.ownedTask -or $roleRecord.taskXmlBackup -or $roleRecord.launcherBackup -or $roleRecord.launcherSourceMetadata) {
                throw "Uninstall absent $role role contains task or backup metadata."
            }
        }
        $snapshot = [pscustomobject]@{Name=$expectedTaskName;Role=$role;Present=$present;Enabled=$enabled;
            State=[string]$roleRecord.state;Owned=$ownedTask;Xml=$xml;XmlCanonical=$xmlCanonical;XmlSha256=$xmlSha256;
            XmlPath=$xmlPath;LauncherPath=$expectedLauncherPath;LauncherPresent=$present;
            LauncherBytesPath=$launcherBytesPath;LauncherSha256=$launcherSha256;LauncherSourceMetadata=$launcherSourceMetadata}
        $unregisterRequested = $journal.UnregisteredRoles.ContainsKey($role)
        $launcherRemovalRequested = $role -cin $journal.LauncherRemovalRequestedRoles
        $plans.Add([ordered]@{Name=$expectedTaskName;Role=$role;Owned=$ownedTask;LauncherPath=$expectedLauncherPath;
            Snapshot=$snapshot;StopReceipt=$null;UnregisterRequested=$unregisterRequested;
            LauncherRemovalRequested=$launcherRemovalRequested;NewLauncherSha256=$null})
    }
    Assert-TokeneloUninstallRecoveryChildren -RecoveryRoot $fullRecoveryRoot -ExpectedNames $expectedNames
    return [ordered]@{Id=[string]$header.transactionId;RecoveryRoot=$fullRecoveryRoot;StagingRoot=$null;JournalPath=$journalPath;
        Plans=@($plans.ToArray());TaskMutationStarted=[bool]$journal.TaskMutationStarted;FileMutationStarted=[bool]$journal.FileMutationStarted;
        CleanupComplete=[bool]$journal.CleanupComplete;RollbackComplete=$false;OwnershipUncertain=[bool]$journal.OwnershipUncertain;
        LifecycleLease=$null;RecoveryHeaderPath=$headerPath;RecoveryHeaderSha256=$ExpectedHeaderSha256;
        PackageIdentity=$ExpectedPackageIdentity;CurrentSid=$ExpectedCurrentSid;InstallRoot=$fullInstallRoot;
        RuntimeMode=$ExpectedRuntimeMode;ReconstructedFromRecoveryHeader=$true}
}

function Write-TokeneloTransactionJournal {
    param($Transaction, [string]$Phase, [string]$Role = '', [string]$Detail = '')
    Assert-TokeneloNoReparseAncestors -Path $Transaction.JournalPath -Description 'Transaction recovery journal'
    $record = [ordered]@{
        recordedAt = [DateTime]::UtcNow.ToString('o')
        transactionId = $Transaction.Id
        phase = $Phase
        role = $Role
        detail = $Detail
    }
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($record | ConvertTo-Json -Compress -Depth 8) + "`n")
    $stream = [IO.File]::Open($Transaction.JournalPath, [IO.FileMode]::Append, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) }
    finally { $stream.Dispose() }
}

function Assert-TokeneloNoIncompleteTransaction {
    param([string]$RecoveryBase)
    $base = [IO.Path]::GetFullPath($RecoveryBase)
    if (-not (Test-Path -LiteralPath $base)) { return }
    if (-not (Test-Path -LiteralPath $base -PathType Container)) { throw 'Transaction recovery path is not a directory.' }
    if (([IO.File]::GetAttributes($base) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'Transaction recovery path is a reparse point.'
    }
    $terminalPhases = @('committed','rollback-complete','preparation-failed-unchanged')
    foreach ($directory in @(Get-ChildItem -LiteralPath $base -Directory -Force)) {
        if (($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
            [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($directory.FullName)).TrimEnd('\') -ine $base) {
            throw "Transaction recovery entry is not a regular direct-child directory: $($directory.Name)."
        }
        $journalPath = Join-Path $directory.FullName 'journal.jsonl'
        if (-not (Test-Path -LiteralPath $journalPath -PathType Leaf) -or
            (([IO.File]::GetAttributes($journalPath) -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
            throw "Transaction recovery journal is missing or unsafe: $($directory.FullName)."
        }
        $lines = @([IO.File]::ReadAllLines($journalPath) | Where-Object { $_.Trim() })
        if ($lines.Count -eq 0) { throw "Transaction recovery journal is empty: $journalPath." }
        $last = $null
        foreach ($line in $lines) {
            try { $record = $line | ConvertFrom-Json -ErrorAction Stop }
            catch { throw "Transaction recovery journal is malformed: $journalPath." }
            if (-not $record.phase -or $record.transactionId -cne $directory.Name) {
                throw "Transaction recovery journal identity is invalid: $journalPath."
            }
            $last = [string]$record.phase
        }
        if ($last -notin $terminalPhases) {
            throw "An earlier Tokenelo install transaction is incomplete ($last); explicit recovery is required at $($directory.FullName)."
        }
    }
}

function Remove-TokeneloInstallStaging {
    param($Transaction)
    $launcherRoot = [IO.Path]::GetFullPath($LauncherRoot).TrimEnd('\')
    $stagingRoot = [IO.Path]::GetFullPath($Transaction.StagingRoot)
    $expectedRoot = [IO.Path]::GetFullPath((Join-Path $launcherRoot ('.tokenelo-stage-' + $Transaction.Id)))
    if ($stagingRoot -ine $expectedRoot -or
        [IO.Path]::GetDirectoryName($stagingRoot).TrimEnd('\') -ine $launcherRoot -or
        [IO.Path]::GetFileName($stagingRoot) -cne ('.tokenelo-stage-' + $Transaction.Id)) {
        throw 'Transaction staging path is not the exact owned child of the launcher directory.'
    }
    Assert-TokeneloNoReparseAncestors -Path $launcherRoot -Description 'Launcher directory'
    Assert-TokeneloNoReparseAncestors -Path $stagingRoot -Description 'Transaction staging directory'
    if (-not (Test-Path -LiteralPath $launcherRoot -PathType Container) -or
        (([IO.File]::GetAttributes($launcherRoot) -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
        throw 'Launcher directory is missing or is a reparse point; staging cleanup refused.'
    }
    if (-not (Test-Path -LiteralPath $stagingRoot)) { return }
    if (-not (Test-Path -LiteralPath $stagingRoot -PathType Container)) {
        throw 'Transaction staging root is not a directory.'
    }
    $rootAttributes = [IO.File]::GetAttributes($stagingRoot)
    if (($rootAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'Transaction staging root is a reparse point.'
    }

    $allowedHashes = @{}
    foreach ($plan in @($Transaction.Plans)) {
        if ($plan.StagedPath) { $allowedHashes[[IO.Path]::GetFileName($plan.StagedPath)] = $plan.NewLauncherSha256 }
        $snapshotPresent = $false; $snapshotLauncherHash = $null
        if ($plan.Snapshot) { $snapshotPresent = [bool]$plan.Snapshot.Present; $snapshotLauncherHash = $plan.Snapshot.LauncherSha256 }
        $allowedHashes[$plan.Role + '.published.previous.exe'] = if ($snapshotPresent) { $snapshotLauncherHash } else { $null }
        $allowedHashes[$plan.Role + '.restore.exe'] = if ($snapshotPresent) { $snapshotLauncherHash } else { $null }
        $allowedHashes[$plan.Role + '.rollback.previous.exe'] = $plan.NewLauncherSha256
    }
    $children = @(Get-ChildItem -LiteralPath $stagingRoot -Force)
    foreach ($child in $children) {
        if ($child.PSIsContainer -or ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
            [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($child.FullName)).TrimEnd('\') -ine $stagingRoot) {
            throw "Transaction staging contains an unexpected directory or reparse point: $($child.Name)."
        }
        $expectedHash = $allowedHashes[[IO.Path]::GetFileName($child.FullName)]
        if (-not $expectedHash) { throw "Transaction staging contains an unknown file: $($child.Name)." }
        $actualHash = Get-TokeneloSha256 ([IO.File]::ReadAllBytes($child.FullName))
        if ($actualHash -cne $expectedHash) { throw "Transaction staging file hash is not transaction-owned: $($child.Name)." }
    }
    foreach ($child in $children) {
        # Recheck each direct child immediately before deleting it; never follow links or recurse.
        $current = Get-Item -LiteralPath $child.FullName -Force
        if ($current.PSIsContainer -or ($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
            [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($current.FullName)).TrimEnd('\') -ine $stagingRoot) {
            throw "Transaction staging child changed before cleanup: $($child.Name)."
        }
        $expectedHash = $allowedHashes[[IO.Path]::GetFileName($current.FullName)]
        if (-not $expectedHash -or (Get-TokeneloSha256 ([IO.File]::ReadAllBytes($current.FullName))) -cne $expectedHash) {
            throw "Transaction staging child changed before cleanup: $($child.Name)."
        }
        Remove-Item -LiteralPath $current.FullName -Force
    }
    if (@(Get-ChildItem -LiteralPath $stagingRoot -Force).Count -ne 0) {
        throw 'Transaction staging changed during cleanup; unknown content was retained.'
    }
    Remove-Item -LiteralPath $stagingRoot -Force
}

function Get-TokeneloTaskSnapshot {
    param($Owned, [string]$Name, [string]$Role, [string]$LauncherPath, [string]$SnapshotRoot)
    $current = Get-OwnedTokeneloTask -Name $Name
    if ([bool]$Owned -ne [bool]$current) { throw "Task '$Name' presence changed before transaction snapshot." }
    if (-not $Owned) {
        if (Test-Path -LiteralPath $LauncherPath) { throw "Unowned launcher exists for absent task '$Name'; refusing to overwrite it." }
        return [pscustomobject]@{ Name=$Name; Role=$Role; Present=$false; Enabled=$false; State='Absent';
            Owned=$null; Xml=$null; XmlCanonical=$null; XmlSha256=$null; XmlPath=$null; LauncherPath=$LauncherPath;
            LauncherPresent=$false; LauncherBytesPath=$null; LauncherSha256=$null }
    }
    if ($current.Execute -ine $Owned.Execute -or $current.Arguments -ine $Owned.Arguments -or
        $current.Principal -ine $Owned.Principal -or $current.HomeDirectory -ine $Owned.HomeDirectory -or
        $current.Enabled -ne $Owned.Enabled) {
        throw "Task '$Name' changed before transaction snapshot."
    }
    Assert-TokeneloNoReparseAncestors -Path $LauncherPath -Description "Launcher for task '$Name'"
    if (-not (Test-Path -LiteralPath $LauncherPath -PathType Leaf)) { throw "Owned launcher is missing for task '$Name'." }
    $attributes = [IO.File]::GetAttributes($LauncherPath)
    if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Owned launcher for task '$Name' is a reparse point." }
    $bytes = [IO.File]::ReadAllBytes($LauncherPath)
    $xml = Get-TokeneloTaskXml -Name $Name
    $xmlBytes = [Text.UTF8Encoding]::new($false).GetBytes($xml)
    $xmlPath = Join-Path $SnapshotRoot ($Role + '.task.xml')
    $launcherBytesPath = Join-Path $SnapshotRoot ($Role + '.launcher.original.exe')
    Write-TokeneloDurableFile -Path $xmlPath -Bytes $xmlBytes
    Write-TokeneloDurableFile -Path $launcherBytesPath -Bytes $bytes
    $task = Get-ScheduledTask -TaskName $Name -TaskPath '\' -ErrorAction Stop
    [pscustomobject]@{ Name=$Name; Role=$Role; Present=$true; Enabled=[bool]$task.Settings.Enabled;
        State=[string]$task.State; Owned=$current; Xml=$xml; XmlCanonical=(Get-TokeneloCanonicalTaskXml $xml); XmlSha256=(Get-TokeneloSha256 $xmlBytes);
        XmlPath=$xmlPath; LauncherPath=$LauncherPath; LauncherPresent=$true;
        LauncherBytesPath=$launcherBytesPath; LauncherSha256=(Get-TokeneloSha256 $bytes) }
}

function Assert-TokeneloOriginalTask {
    param($Snapshot, [bool]$ExpectedEnabled)
    $current = Get-OwnedTokeneloTask -Name $Snapshot.Name
    if (-not $Snapshot.Present) {
        if ($current) { throw "Task '$($Snapshot.Name)' appeared after transaction preflight." }
        return
    }
    if (-not $current -or $current.Execute -ine $Snapshot.Owned.Execute -or
        $current.Arguments -ine $Snapshot.Owned.Arguments -or $current.Principal -ine $Snapshot.Owned.Principal -or
        $current.HomeDirectory -ine $Snapshot.Owned.HomeDirectory -or $current.Enabled -ne $ExpectedEnabled) {
        throw "Task '$($Snapshot.Name)' changed ownership, action or enabled state during transaction."
    }
    $xml = Get-TokeneloTaskXml -Name $Snapshot.Name
    if ((Get-TokeneloCanonicalTaskXml $xml) -cne $Snapshot.XmlCanonical) {
        throw "Task '$($Snapshot.Name)' XML changed during transaction."
    }
}

function Resolve-TokeneloDataDirectory {
    param([string]$Path)
    if (-not $Path) { return $null }
    if ($Path -match '["\r\n]' -or -not [IO.Path]::IsPathRooted($Path)) {
        throw 'HomeDirectory must be an absolute path without quotes or line breaks.'
    }
    return [IO.Path]::GetFullPath($Path)
}

function Quote-TokeneloPath {
    param([string]$Path)
    # Double trailing backslashes so the Windows argv parser retains the closing quote.
    return '"' + [regex]::Replace($Path, '(\\+)$', '$1$1') + '"'
}

function Get-TokeneloActionProcesses {
    param($Owned, $Processes)
    $quoted = '"' + $Owned.Execute + '" ' + $Owned.Arguments
    $unquoted = $Owned.Execute + ' ' + $Owned.Arguments
    @($Processes | Where-Object {
        $_.CommandLine -and ($_.CommandLine -ieq $quoted -or $_.CommandLine -ieq $unquoted -or
            ($Owned.ChildCommand -and $_.CommandLine -ieq $Owned.ChildCommand))
    })
}

function Get-TokeneloTaskProcessClosure {
    param($Owned, $Processes)
    $tracked = @(Get-TokeneloActionProcesses -Owned $Owned -Processes $Processes)
    do {
        $before = $tracked.Count
        $ids = @($tracked | ForEach-Object { $_.ProcessId })
        $tracked += @($Processes | Where-Object { $_.ParentProcessId -in $ids -and $_.ProcessId -notin $ids })
    } while ($tracked.Count -gt $before)
    return $tracked
}

function Assert-TokeneloOwnedTaskSnapshot {
    param($Expected, [string]$ExpectedXmlCanonical, [bool]$ExpectedEnabled)
    $current = Get-OwnedTokeneloTask -Name $Expected.Name
    if (-not $current -or $current.Execute -ine $Expected.Execute -or $current.Arguments -cne $Expected.Arguments -or
        $current.Principal -ine $Expected.Principal -or $current.HomeDirectory -ine $Expected.HomeDirectory -or
        $current.Enabled -ne $ExpectedEnabled) {
        throw "Task '$($Expected.Name)' ownership, action or enabled state changed before mutation."
    }
    $xml = Get-TokeneloTaskXml -Name $Expected.Name
    if ((Get-TokeneloCanonicalTaskXml $xml) -cne $ExpectedXmlCanonical) {
        throw "Task '$($Expected.Name)' XML changed before mutation."
    }
    return $current
}

function Assert-TokeneloTaskQuiescent {
    param($Owned)
    if (-not $Owned) { return }
    $current = Get-OwnedTokeneloTask -Name $Owned.Name
    if (-not $current -or $current.Execute -ine $Owned.Execute -or $current.Arguments -cne $Owned.Arguments -or
        $current.Principal -ine $Owned.Principal) { throw "Task '$($Owned.Name)' changed before a transaction mutation." }
    $task = Get-ScheduledTask -TaskName $Owned.Name -TaskPath '\' -ErrorAction Stop
    if ($task.Settings.Enabled -or $task.State -in @('Running','Queued')) { throw "Task '$($Owned.Name)' is not disabled and quiescent." }
    $processes = @(Get-CimInstance Win32_Process -ErrorAction Stop)
    if (@(Get-TokeneloTaskProcessClosure -Owned $Owned -Processes $processes).Count -gt 0) {
        throw "Task '$($Owned.Name)' still has an owned process or descendant."
    }
}

function Stop-TokeneloTask {
    param($Owned, [ValidateRange(0.05,25)][double]$CleanupTimeoutSeconds = 25, [string]$ExpectedXmlCanonical, $LifecycleLease)
    if (-not $Owned) { return }
    $observedXmlCanonical = Get-TokeneloCanonicalTaskXml (Get-TokeneloTaskXml -Name $Owned.Name)
    if ($ExpectedXmlCanonical -and $observedXmlCanonical -cne $ExpectedXmlCanonical) {
        throw "Task '$($Owned.Name)' XML changed between transaction validation and stop."
    }
    $originalXmlCanonical = if ($ExpectedXmlCanonical) { $ExpectedXmlCanonical } else { $observedXmlCanonical }
    $null = Assert-TokeneloOwnedTaskSnapshot -Expected $Owned -ExpectedXmlCanonical $originalXmlCanonical -ExpectedEnabled ([bool]$Owned.Enabled)
    $processes = @(Get-CimInstance Win32_Process -ErrorAction Stop)
    $tracked = @(Get-TokeneloTaskProcessClosure -Owned $Owned -Processes $processes)
    # Prevent queued/logon/retry triggers from racing the stop and later removal.
    $null = Assert-TokeneloOwnedTaskSnapshot -Expected $Owned -ExpectedXmlCanonical $originalXmlCanonical -ExpectedEnabled ([bool]$Owned.Enabled)
    Assert-TokeneloCoordinatorLifecycleLeaseAlive -Lease $LifecycleLease
    Disable-ScheduledTask -TaskName $Owned.Name -TaskPath '\' -ErrorAction Stop | Out-Null
    $disabled = Get-OwnedTokeneloTask -Name $Owned.Name
    if (-not $disabled -or $disabled.Execute -ine $Owned.Execute -or $disabled.Arguments -cne $Owned.Arguments -or
        $disabled.Principal -ine $Owned.Principal -or $disabled.HomeDirectory -ine $Owned.HomeDirectory -or $disabled.Enabled) {
        throw "Task '$($Owned.Name)' changed after disable; stop was not issued."
    }
    $disabledXml = Get-TokeneloTaskXml -Name $Owned.Name
    if ((Get-TokeneloCanonicalTaskXml $disabledXml) -cne $originalXmlCanonical) { throw "Task '$($Owned.Name)' XML changed after disable." }
    $null = Assert-TokeneloOwnedTaskSnapshot -Expected $disabled -ExpectedXmlCanonical $originalXmlCanonical -ExpectedEnabled $false
    Assert-TokeneloCoordinatorLifecycleLeaseAlive -Lease $LifecycleLease
    Stop-ScheduledTask -TaskName $Owned.Name -TaskPath '\' -ErrorAction Stop
    $until = [DateTime]::UtcNow.AddSeconds($CleanupTimeoutSeconds)
    do {
        $remaining = @(Get-CimInstance Win32_Process -ErrorAction Stop)
        $stillOwned = @(Get-TokeneloActionProcesses -Owned $Owned -Processes $remaining)
        $descendants = @($remaining | Where-Object {
            $candidate = $_
            @($tracked | Where-Object { $_.ProcessId -eq $candidate.ProcessId -and $_.CreationDate -eq $candidate.CreationDate }).Count -gt 0
        })
        $state = (Get-ScheduledTask -TaskName $Owned.Name -TaskPath '\' -ErrorAction Stop).State
        if ($state -notin @('Running','Queued') -and $stillOwned.Count -eq 0 -and $descendants.Count -eq 0) {
            Write-Host "Stopped owned task '$($Owned.Name)' and verified process cleanup."
            return [pscustomobject]@{ Owned = $Owned; ProcessCleanupVerified = $true; TrackedProcesses = $tracked;
                TaskXmlCanonical = $originalXmlCanonical; InitialEnabled=[bool]$Owned.Enabled; InitialState=[string]$Owned.State }
        }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $until)
    throw "Task '$($Owned.Name)' did not finish process cleanup; registration was retained."
}

function Uninstall-TokeneloTask {
    param($Owned, [string]$Name, $StopReceipt, $LifecycleLease)
    if ($Owned) {
        if (-not $StopReceipt -or -not $StopReceipt.ProcessCleanupVerified -or
            -not [object]::ReferenceEquals($StopReceipt.Owned, $Owned)) {
            throw "Task '$Name' has no verified stop receipt; registration retained."
        }
        # Revalidate ownership after stop and before unregistering.
        $current = Get-OwnedTokeneloTask -Name $Name
        if (-not $current -or $current.Execute -ine $Owned.Execute -or $current.Arguments -ine $Owned.Arguments -or
            $current.Principal -ine $Owned.Principal) { throw "Task '$Name' changed before removal; registration retained." }
        $currentXml=Get-TokeneloTaskXml -Name $Name
        if ((Get-TokeneloCanonicalTaskXml $currentXml) -cne $StopReceipt.TaskXmlCanonical) { throw "Task '$Name' XML changed before removal; registration retained." }
        $task = Get-ScheduledTask -TaskName $Name -TaskPath '\' -ErrorAction Stop
        $processes = @(Get-CimInstance Win32_Process -ErrorAction Stop)
        $ownedProcesses = @(Get-TokeneloActionProcesses -Owned $Owned -Processes $processes)
        $trackedProcesses = @($processes | Where-Object {
            $candidate = $_
            @($StopReceipt.TrackedProcesses | Where-Object {
                $_.ProcessId -eq $candidate.ProcessId -and $_.CreationDate -eq $candidate.CreationDate
            }).Count -gt 0
        })
        if ($task.Settings.Enabled -or $task.State -in @('Running','Queued') -or
            $ownedProcesses.Count -gt 0 -or $trackedProcesses.Count -gt 0) {
            throw "Task '$Name' resumed before removal; registration retained."
        }
        $null=Assert-TokeneloOwnedTaskSnapshot -Expected $current -ExpectedXmlCanonical $StopReceipt.TaskXmlCanonical -ExpectedEnabled $false
        Assert-TokeneloCoordinatorLifecycleLeaseAlive -Lease $LifecycleLease
        Unregister-ScheduledTask -TaskName $Name -TaskPath '\' -Confirm:$false -ErrorAction Stop
        Write-Host "Removed scheduled task '$Name'. Usage data and logs were retained."
    } else { Write-Host "Scheduled task '$Name' was not installed; nothing to remove." }
}

function Register-TokeneloTaskAction {
    param([string]$Name, [string]$Executable, [string]$Arguments, [switch]$Disabled)
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    # Keep Execute and Arguments separate. PowerShell's legacy native argument conversion
    # can strip nested /TR quotes and break Program Files paths passed to schtasks.exe.
    $action = New-ScheduledTaskAction -Execute $Executable -Argument $Arguments
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $settings = New-TokeneloTaskSettings -Enabled (-not [bool]$Disabled)
    # Normal scheduling for on-demand reports and interactive tray use. This does not
    # raise privileges, create a console or change the existing request deadlines.
    # Task priority4 selects ordinary CPU/I/O/memory policy; omitted priority defaults
    # to the scheduler's background policy. See TaskSettings.Priority (Microsoft Learn).
    Register-ScheduledTask -TaskName $Name -TaskPath '\' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force -ErrorAction Stop | Out-Null
}

function Build-TokeneloLauncher {
    param([ValidateSet('daemon','tray')][string]$Role, [Parameter(Mandatory=$true)][string]$OutputPath)
    $source = Join-Path $RepoRoot 'scripts\windows\TokeneloHiddenLauncher.cs'
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Launcher source not found: $source" }
    $compiler = @(
        (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
        (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
    ) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    if (-not $compiler) { throw 'The Windows .NET Framework compiler is unavailable. Install the Windows .NET Framework before registering Tokenelo.' }
    if (-not [IO.Path]::IsPathRooted($LauncherRoot) -or -not [IO.Path]::IsPathRooted($OutputPath)) { throw 'The hidden launcher output root and staged path must be absolute.' }
    Assert-TokeneloNoReparseAncestors -Path $LauncherRoot -Description 'Launcher root'
    Assert-TokeneloNoReparseAncestors -Path $OutputPath -Description 'Staged launcher output'
    Assert-TokeneloNoReparseAncestors -Path $source -Description 'Hidden launcher source'
    if ($RuntimeMode -eq 'packaged') {
        $installRoot = Split-Path -Parent (Split-Path -Parent ([IO.Path]::GetFullPath($RepoRoot)))
        if (Test-TokeneloPathWithin -Path $LauncherRoot -Parent $installRoot) {
            throw 'Packaged hidden launchers must be written outside the application directory.'
        }
    }
    $candidate = [IO.Path]::GetFullPath($OutputPath)
    if (Test-Path -LiteralPath $candidate) { throw "Staged launcher path already exists: $candidate" }
    $null = New-Item -ItemType Directory -Path (Split-Path -Parent $candidate) -Force
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = $compiler
    $start.Arguments = '/nologo /target:winexe /optimize+ "/out:' + $candidate + '" "' + $source + '"'
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $start
    $compiled = $false
    try {
        if (-not $process.Start()) { throw 'Could not start the hidden launcher compiler.' }
        $output = $process.StandardOutput.ReadToEndAsync()
        $errors = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(30000)) { $process.Kill(); $process.WaitForExit(); throw 'The launcher compiler exceeded its build budget.' }
        $diagnostics = $output.Result + $errors.Result
        if ($process.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) { throw "Launcher build failed: $diagnostics" }
        $compiled = $true
        return $candidate
    } finally {
        $process.Dispose()
        if (-not $compiled -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { Remove-Item -LiteralPath $candidate }
    }
}

function Publish-TokeneloLauncher {
    param($Transaction, $Plan)
    foreach ($candidatePlan in @($Transaction.Plans)) {
        Assert-TokeneloOriginalTask -Snapshot $candidatePlan.Snapshot -ExpectedEnabled $false
        if ($candidatePlan.Snapshot.Present) { Assert-TokeneloTaskQuiescent -Owned $candidatePlan.Snapshot.Owned }
    }
    $currentPath = $Plan.LauncherPath
    $backupPath = Join-Path $Transaction.StagingRoot ($Plan.Role + '.published.previous.exe')
    Assert-TokeneloNoReparseAncestors -Path $currentPath -Description "Published $($Plan.Role) launcher"
    Assert-TokeneloNoReparseAncestors -Path $Plan.StagedPath -Description "Staged $($Plan.Role) launcher"
    Assert-TokeneloNoReparseAncestors -Path $backupPath -Description "Publisher backup for $($Plan.Role)"
    if (Test-Path -LiteralPath $backupPath) { throw "Publisher backup already exists for $($Plan.Role)." }
    $stagedHash = Get-TokeneloRegularFileSha256 -Path $Plan.StagedPath -Description "Staged $($Plan.Role) launcher"
    if ($stagedHash -cne $Plan.NewLauncherSha256) { throw "Staged launcher hash changed for $($Plan.Role); publish refused." }
    if (Test-Path -LiteralPath $currentPath) {
        try { $currentHash = Get-TokeneloRegularFileSha256 -Path $currentPath -Description "Launcher for $($Plan.Role)" }
        catch { $Transaction.OwnershipUncertain = $true; throw }
        if (-not $currentHash) {
            $Transaction.OwnershipUncertain = $true
            throw "Launcher path for $($Plan.Role) is not a regular file; publish refused."
        }
        if (-not $Plan.Snapshot.Present) { throw "Unowned launcher appeared for $($Plan.Name)." }
        if ($currentHash -cne $Plan.Snapshot.LauncherSha256) {
            $Transaction.OwnershipUncertain = $true
            throw "Launcher $($Plan.Role) changed after snapshot; publish refused."
        }
        Assert-TokeneloNoReparseAncestors -Path $currentPath -Description "Launcher for $($Plan.Role)"
        $immediateHash = Get-TokeneloRegularFileSha256 -Path $currentPath -Description "Launcher for $($Plan.Role)"
        if ($immediateHash -cne $Plan.Snapshot.LauncherSha256) {
            $Transaction.OwnershipUncertain = $true
            throw "Launcher $($Plan.Role) changed immediately before publish; publish refused."
        }
        [IO.File]::Replace($Plan.StagedPath, $currentPath, $backupPath)
        $Plan.Published = $true
        $publishedBackupHash = Get-TokeneloSha256 ([IO.File]::ReadAllBytes($backupPath))
        if ($publishedBackupHash -cne $Plan.Snapshot.LauncherSha256) {
            $Transaction.OwnershipUncertain = $true
            throw "Launcher $($Plan.Role) changed between snapshot and publish."
        }
    } else {
        if ($Plan.Snapshot.Present) { throw "Owned launcher disappeared before publish for $($Plan.Name)." }
        if (Test-Path -LiteralPath $currentPath) { throw "Unowned launcher appeared for $($Plan.Name); publish refused." }
        $stagedHash = Get-TokeneloRegularFileSha256 -Path $Plan.StagedPath -Description "Staged $($Plan.Role) launcher"
        if ($stagedHash -cne $Plan.NewLauncherSha256) { throw "Staged launcher changed immediately before publish for $($Plan.Role)." }
        [IO.File]::Move($Plan.StagedPath, $currentPath)
        $Plan.Published = $true
    }
    $actualHash = Get-TokeneloRegularFileSha256 -Path $currentPath -Description "Published $($Plan.Role) launcher"
    if ($actualHash -cne $Plan.NewLauncherSha256) { throw "Published launcher hash mismatch for $($Plan.Role)." }
    $Plan.PublisherBackupPath = if (Test-Path -LiteralPath $backupPath -PathType Leaf) { $backupPath } else { $null }
}

function Get-TokeneloUninstallLauncherRestoreSecurity {
    param($Snapshot,[Parameter(Mandatory=$true)][long]$ExpectedLength,
        [Parameter(Mandatory=$true)][string]$ExpectedSha256)
    if (-not $Snapshot -or -not $Snapshot.PSObject.Properties['LauncherSourceMetadata'] -or -not $Snapshot.LauncherSourceMetadata) {
        throw 'The original launcher ACL and attribute snapshot is missing; restore refused.'
    }
    $metadata = $Snapshot.LauncherSourceMetadata
    $currentSid = [string][Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if (($metadata.Length -isnot [long] -and $metadata.Length -isnot [int]) -or
        $metadata.Sha256 -isnot [string] -or $metadata.OwnerSid -isnot [string] -or
        ($metadata.Attributes -isnot [long] -and $metadata.Attributes -isnot [int]) -or
        $metadata.AclSha256 -isnot [string] -or $metadata.AclSddl -isnot [string] -or
        [long]$metadata.Length -ne $ExpectedLength -or [string]$metadata.Sha256 -cne $ExpectedSha256 -or
        [string]$metadata.OwnerSid -cne $currentSid -or
        [string]$metadata.AclSha256 -cnotmatch '^[0-9a-f]{64}$' -or
        [string]::IsNullOrEmpty([string]$metadata.AclSddl) -or [string]$metadata.AclSddl.Length -gt 65536 -or
        (Get-TokeneloSha256 ([Text.Encoding]::UTF8.GetBytes([string]$metadata.AclSddl))) -cne [string]$metadata.AclSha256) {
        throw 'The original launcher ACL or attribute snapshot is invalid or does not match the current account and byte backup.'
    }
    $allowedAttributes = [int]([IO.FileAttributes]::Normal -bor [IO.FileAttributes]::Archive -bor
        [IO.FileAttributes]::Hidden -bor [IO.FileAttributes]::ReadOnly -bor [IO.FileAttributes]::System -bor
        [IO.FileAttributes]::NotContentIndexed -bor [IO.FileAttributes]::Temporary)
    $sourceAttributes = [int]$metadata.Attributes
    if (($sourceAttributes -band (-bnot $allowedAttributes)) -ne 0) {
        throw 'The original launcher has unsupported attributes; restore refused.'
    }
    $security = [Security.AccessControl.FileSecurity]::new()
    $sections = [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Access
    try { $security.SetSecurityDescriptorSddlForm([string]$metadata.AclSddl,$sections) }
    catch { throw 'The original launcher owner or DACL could not be parsed; restore refused.' }
    if ($security.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $currentSid) {
        throw 'The original launcher owner cannot be safely preserved as the current account; restore refused.'
    }
    return [pscustomobject]@{Security=$security;Metadata=$metadata;Attributes=$sourceAttributes}
}

function Restore-TokeneloLaunchers {
    param($Transaction, [switch]$AllowMissingOriginalTasks, [switch]$AllowMissingOriginalLaunchers, $LifecycleLease)
    foreach ($plan in @($Transaction.Plans)) {
        $ownedNow = Assert-TokeneloRollbackTaskAllowed -Transaction $Transaction -Plan $plan `
            -AllowMissingOriginalTask:$AllowMissingOriginalTasks
        if ($ownedNow) { Assert-TokeneloTaskQuiescent -Owned $ownedNow }
        $target = $plan.LauncherPath
        $restoreRoot = $Transaction.StagingRoot
        Assert-TokeneloNoReparseAncestors -Path $target -Description "Rollback target for $($plan.Role)"
        if ($restoreRoot) { Assert-TokeneloNoReparseAncestors -Path $restoreRoot -Description 'Rollback staging directory' }
        elseif (-not $AllowMissingOriginalLaunchers) { throw 'Rollback staging directory is missing.' }
        $targetHash = Get-TokeneloRegularFileSha256 -Path $target -Description "Rollback target for $($plan.Role)"
        $targetExists = $null -ne $targetHash
        if ($plan.Snapshot.Present) {
            Assert-TokeneloNoReparseAncestors -Path $plan.Snapshot.LauncherBytesPath -Description "Original backup for $($plan.Role)"
            $backupHash = Get-TokeneloRegularFileSha256 -Path $plan.Snapshot.LauncherBytesPath -Description "Original backup for $($plan.Role)"
            if ($backupHash -cne $plan.Snapshot.LauncherSha256) { throw "Original launcher backup hash mismatch for $($plan.Role)." }
            if ($targetExists) {
                if ($targetHash -ceq $plan.Snapshot.LauncherSha256) {
                    Assert-TokeneloUninstallSnapshotLauncherState -Snapshot $plan.Snapshot -Path $target
                    continue
                }
                if ($targetHash -cne $plan.NewLauncherSha256) { throw "Launcher $($plan.Role) has an unknown hash; restore refused." }
                $restoreCandidate = Join-Path $Transaction.StagingRoot ($plan.Role + '.restore.exe')
                $restoreBackup = Join-Path $Transaction.StagingRoot ($plan.Role + '.rollback.previous.exe')
                Assert-TokeneloNoReparseAncestors -Path $restoreCandidate -Description "Restore candidate for $($plan.Role)"
                Assert-TokeneloNoReparseAncestors -Path $restoreBackup -Description "Rollback backup for $($plan.Role)"
                if ((Test-Path -LiteralPath $restoreCandidate) -or (Test-Path -LiteralPath $restoreBackup)) {
                    throw "Rollback staging path already exists for $($plan.Role)."
                }
                $immediateBackupHash = Get-TokeneloRegularFileSha256 -Path $plan.Snapshot.LauncherBytesPath `
                    -Description "Original backup for $($plan.Role)"
                if ($immediateBackupHash -cne $plan.Snapshot.LauncherSha256) {
                    throw "Original launcher backup changed immediately before restore for $($plan.Role)."
                }
                Assert-TokeneloCoordinatorLifecycleLeaseAlive -Lease $LifecycleLease
                [IO.File]::Copy($plan.Snapshot.LauncherBytesPath, $restoreCandidate, $false)
                $candidateHash = Get-TokeneloRegularFileSha256 -Path $restoreCandidate -Description "Restore candidate for $($plan.Role)"
                if ($candidateHash -cne $plan.Snapshot.LauncherSha256) { throw "Restore candidate hash mismatch for $($plan.Role)." }
                Assert-TokeneloNoReparseAncestors -Path $target -Description "Rollback target for $($plan.Role)"
                $immediateTargetHash = Get-TokeneloRegularFileSha256 -Path $target -Description "Rollback target for $($plan.Role)"
                if ($immediateTargetHash -cne $plan.NewLauncherSha256) {
                    throw "Launcher $($plan.Role) changed immediately before restore; restore refused."
                }
                Assert-TokeneloCoordinatorLifecycleLeaseAlive -Lease $LifecycleLease
                [IO.File]::Replace($restoreCandidate, $target, $restoreBackup)
                $replacedHash = Get-TokeneloRegularFileSha256 -Path $restoreBackup -Description "Replaced launcher for $($plan.Role)"
                if ($replacedHash -cne $plan.NewLauncherSha256) { throw "Launcher $($plan.Role) changed during restore; previous bytes were retained." }
            } elseif ($AllowMissingOriginalLaunchers -and $plan.LauncherRemovalRequested) {
                $originalBytes = [IO.File]::ReadAllBytes($plan.Snapshot.LauncherBytesPath)
                $originalHash = Get-TokeneloSha256 $originalBytes
                if ($originalHash -cne $plan.Snapshot.LauncherSha256) {
                    throw "Original launcher backup changed immediately before restore for $($plan.Role)."
                }
                $restoreSecurity = Get-TokeneloUninstallLauncherRestoreSecurity -Snapshot $plan.Snapshot `
                    -ExpectedLength $originalBytes.LongLength -ExpectedSha256 $originalHash
                Assert-TokeneloNoReparseAncestors -Path $target -Description "Rollback target for $($plan.Role)"
                if (Test-Path -LiteralPath $target) { throw "Launcher path for $($plan.Role) appeared before restore." }
                Assert-TokeneloCoordinatorLifecycleLeaseAlive -Lease $LifecycleLease
                $stream = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
                try { $stream.Write($originalBytes, 0, $originalBytes.Length); $stream.Flush($true) }
                finally { $stream.Dispose() }
                Assert-TokeneloNoReparseAncestors -Path $target -Description "New rollback launcher for $($plan.Role)"
                $createdState = Get-TokeneloCoordinatorFileState -Path $target -ExpectedOwnerSid $restoreSecurity.Metadata.OwnerSid
                if ($createdState.Length -ne $originalBytes.LongLength -or $createdState.Sha256 -cne $originalHash -or
                    $createdState.OwnerSid -cne $restoreSecurity.Metadata.OwnerSid) {
                    throw "New rollback launcher bytes or owner changed before metadata restore for $($plan.Role)."
                }
                Assert-TokeneloCoordinatorLifecycleLeaseAlive -Lease $LifecycleLease
                Set-TokeneloCoordinatorFileAcl -Path $target -AclObject $restoreSecurity.Security
                $aclState = Get-TokeneloCoordinatorFileState -Path $target -ExpectedOwnerSid $restoreSecurity.Metadata.OwnerSid
                if ($aclState.Length -ne $originalBytes.LongLength -or $aclState.Sha256 -cne $originalHash -or
                    $aclState.OwnerSid -cne $restoreSecurity.Metadata.OwnerSid -or
                    $aclState.AclSha256 -cne [string]$restoreSecurity.Metadata.AclSha256) {
                    throw "Restored launcher DACL or owner differs from the captured metadata for $($plan.Role)."
                }
                Assert-TokeneloCoordinatorLifecycleLeaseAlive -Lease $LifecycleLease
                [IO.File]::SetAttributes($target,[IO.FileAttributes]$restoreSecurity.Attributes)
                $restoredState = Get-TokeneloCoordinatorFileState -Path $target -ExpectedOwnerSid $restoreSecurity.Metadata.OwnerSid
                if ($restoredState.Length -ne $originalBytes.LongLength -or $restoredState.Sha256 -cne $originalHash -or
                    $restoredState.OwnerSid -cne $restoreSecurity.Metadata.OwnerSid -or
                    $restoredState.Attributes -ne $restoreSecurity.Attributes -or
                    $restoredState.AclSha256 -cne [string]$restoreSecurity.Metadata.AclSha256) {
                    throw "Restored launcher bytes or metadata differ from the captured snapshot for $($plan.Role)."
                }
            } else { throw "Owned launcher disappeared before restore for $($plan.Role)." }
            $restoredHash = Get-TokeneloRegularFileSha256 -Path $target -Description "Restored launcher for $($plan.Role)"
            if ($restoredHash -cne $plan.Snapshot.LauncherSha256) { throw "Restored launcher hash mismatch for $($plan.Role)." }
        } elseif ($targetExists) {
            if ($targetHash -cne $plan.NewLauncherSha256) { throw "Unowned launcher appeared for $($plan.Role); removal refused." }
            Assert-TokeneloNoReparseAncestors -Path $target -Description "New launcher removal target for $($plan.Role)"
            $immediateTargetHash = Get-TokeneloRegularFileSha256 -Path $target -Description "New launcher removal target for $($plan.Role)"
            if ($immediateTargetHash -cne $plan.NewLauncherSha256) {
                throw "Launcher $($plan.Role) changed immediately before removal; removal refused."
            }
            Assert-TokeneloCoordinatorLifecycleLeaseAlive -Lease $LifecycleLease
            [IO.File]::Delete($target)
            if (Test-Path -LiteralPath $target) { throw "Transaction-created launcher for $($plan.Role) remains after removal." }
        }
        Write-TokeneloTransactionJournal -Transaction $Transaction -Phase 'launcher-restored' -Role $plan.Role
    }
}

function Assert-TokeneloNewTask {
    param($Plan, [bool]$ExpectedEnabled, [switch]$CheckXml)
    $current = Get-OwnedTokeneloTask -Name $Plan.Name
    if (-not $current -or $current.Execute -ine $Plan.LauncherPath -or $current.Arguments -cne $Plan.Arguments -or
        $current.HomeDirectory -ine $Plan.HomeDirectory -or $current.Enabled -ne $ExpectedEnabled) {
        throw "New task '$($Plan.Name)' does not match its transaction action, home or enabled state."
    }
    $task = Get-ScheduledTask -TaskName $Plan.Name -TaskPath '\' -ErrorAction Stop
    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $principalSid = [string]$task.Principal.UserId
    if ($principalSid -notmatch '^S-1-') {
        try { $principalSid = ([Security.Principal.NTAccount]::new($principalSid)).Translate([Security.Principal.SecurityIdentifier]).Value }
        catch { $principalSid = $null }
    }
    if ($principalSid -ne $currentSid -or $task.Principal.LogonType -ne 'Interactive' -or $task.Principal.RunLevel -ne 'Limited') {
        throw "New task '$($Plan.Name)' has an unexpected principal."
    }
    if ($CheckXml -and $Plan.NewXmlCanonical) {
        $xml = Get-TokeneloTaskXml -Name $Plan.Name
        if ((Get-TokeneloCanonicalTaskXml $xml) -cne $Plan.NewXmlCanonical) {
            throw "New task '$($Plan.Name)' XML changed during transaction."
        }
    }
}

function Assert-TokeneloRollbackTaskAllowed {
    param($Transaction, $Plan, [switch]$AllowMissingOriginalTask)
    $current = Get-OwnedTokeneloTask -Name $Plan.Name
    if (-not $current) {
        if ($Plan.Snapshot.Present -and -not ($AllowMissingOriginalTask -and $Plan.UnregisterRequested)) {
            throw "Owned task '$($Plan.Name)' disappeared; restore refused."
        }
        return $null
    }
    $xml = Get-TokeneloTaskXml -Name $Plan.Name
    $canonical = Get-TokeneloCanonicalTaskXml $xml
    if (($Plan.Snapshot.Present -and $canonical -ceq $Plan.Snapshot.XmlCanonical) -or
        ($Plan.NewXmlCanonical -and $canonical -ceq $Plan.NewXmlCanonical)) {
        $current | Add-Member -NotePropertyName TransactionXmlCanonical -NotePropertyValue $canonical -Force
        return $current
    }
    throw "Task '$($Plan.Name)' XML is not one of the transaction-owned definitions; restore refused."
}

function Restore-TokeneloTaskDefinitions {
    param($Transaction, [switch]$AllowMissingOriginalTasks, $LifecycleLease)
    foreach ($plan in @($Transaction.Plans | Sort-Object @{ Expression = { if ($_.Role -eq 'tray') { 0 } else { 1 } } })) {
        $current = Assert-TokeneloRollbackTaskAllowed -Transaction $Transaction -Plan $plan `
            -AllowMissingOriginalTask:$AllowMissingOriginalTasks
        if ($current) { Assert-TokeneloTaskQuiescent -Owned $current }
        if ($plan.Snapshot.Present) {
            if ($AllowMissingOriginalTasks -and $current) {
                if ($current.Enabled) { throw "Original task '$($plan.Name)' was enabled before uninstall rollback." }
                $currentXml = Get-TokeneloTaskXml -Name $plan.Name
                if ((Get-TokeneloCanonicalTaskXml $currentXml) -cne $plan.Snapshot.XmlCanonical) {
                    throw "Original task '$($plan.Name)' changed before uninstall rollback."
                }
                Write-TokeneloTransactionJournal -Transaction $Transaction -Phase 'restore-task-already-present' -Role $plan.Role
                continue
            }
            $disabledXml = Set-TokeneloTaskXmlEnabled -Xml $plan.Snapshot.Xml -Enabled $false
            Write-TokeneloTransactionJournal -Transaction $Transaction -Phase 'restore-task-xml-requested' -Role $plan.Role
            Assert-TokeneloCoordinatorLifecycleLeaseAlive -Lease $LifecycleLease
            Register-ScheduledTask -TaskName $plan.Name -TaskPath '\' -Xml $disabledXml -Force -ErrorAction Stop | Out-Null
            $restored = Get-OwnedTokeneloTask -Name $plan.Name
            if (-not $restored -or $restored.Execute -ine $plan.Snapshot.Owned.Execute -or
                $restored.Arguments -cne $plan.Snapshot.Owned.Arguments -or
                $restored.HomeDirectory -ine $plan.Snapshot.Owned.HomeDirectory -or $restored.Enabled) {
                throw "Restored task '$($plan.Name)' failed its disabled owner/action check."
            }
            $restoredXml = Get-TokeneloTaskXml -Name $plan.Name
            if ((Get-TokeneloCanonicalTaskXml $restoredXml) -cne $plan.Snapshot.XmlCanonical) {
                throw "Restored task '$($plan.Name)' XML does not match its snapshot."
            }
        } elseif ($current) {
            if ($current.Enabled) { throw "New task '$($plan.Name)' was enabled before uninstall rollback." }
            Assert-TokeneloTaskQuiescent -Owned $current
            Write-TokeneloTransactionJournal -Transaction $Transaction -Phase 'remove-new-task-requested' -Role $plan.Role
            Assert-TokeneloCoordinatorLifecycleLeaseAlive -Lease $LifecycleLease
            Unregister-ScheduledTask -TaskName $plan.Name -TaskPath '\' -Confirm:$false -ErrorAction Stop
            if (Get-OwnedTokeneloTask -Name $plan.Name) { throw "New task '$($plan.Name)' remains registered after rollback." }
        }
    }
}

function Restore-TokeneloEnabledState {
    param($Transaction, $LifecycleLease)
    foreach ($plan in @($Transaction.Plans)) {
        if (-not $plan.Snapshot.Present) { continue }
        Assert-TokeneloOriginalTask -Snapshot $plan.Snapshot -ExpectedEnabled $false
        Assert-TokeneloTaskQuiescent -Owned $plan.Snapshot.Owned
    }
    try {
        foreach ($plan in @($Transaction.Plans | Sort-Object @{ Expression = { if ($_.Role -eq 'daemon') { 0 } else { 1 } } })) {
            if (-not $plan.Snapshot.Present) { continue }
            Assert-TokeneloOriginalTask -Snapshot $plan.Snapshot -ExpectedEnabled $false
            Assert-TokeneloTaskQuiescent -Owned $plan.Snapshot.Owned
            if ($plan.Snapshot.Enabled) {
                Write-TokeneloTransactionJournal -Transaction $Transaction -Phase 'restore-enabled-requested' -Role $plan.Role
                Assert-TokeneloCoordinatorLifecycleLeaseAlive -Lease $LifecycleLease
                Enable-ScheduledTask -TaskName $plan.Name -TaskPath '\' -ErrorAction Stop | Out-Null
                Assert-TokeneloOriginalTask -Snapshot $plan.Snapshot -ExpectedEnabled $true
            }
        }
        foreach ($plan in @($Transaction.Plans)) {
            if (-not $plan.Snapshot.Present) { continue }
            Assert-TokeneloOriginalTask -Snapshot $plan.Snapshot -ExpectedEnabled ([bool]$plan.Snapshot.Enabled)
        }
        foreach ($plan in @($Transaction.Plans | Sort-Object @{ Expression = { if ($_.Role -eq 'daemon') { 0 } else { 1 } } })) {
            if (-not $plan.Snapshot.Present -or -not $plan.Snapshot.Enabled -or $plan.Snapshot.State -ne 'Running') { continue }
            Assert-TokeneloOriginalTask -Snapshot $plan.Snapshot -ExpectedEnabled $true
            $restoredTask = Get-ScheduledTask -TaskName $plan.Name -TaskPath '\' -ErrorAction Stop
            if ($restoredTask.State -in @('Running','Queued')) { continue }
            Write-TokeneloTransactionJournal -Transaction $Transaction -Phase 'restore-running-requested' -Role $plan.Role
            Assert-TokeneloCoordinatorLifecycleLeaseAlive -Lease $LifecycleLease
            Start-ScheduledTask -TaskName $plan.Name -TaskPath '\' -ErrorAction Stop
            Assert-TokeneloOriginalTask -Snapshot $plan.Snapshot -ExpectedEnabled $true
            $startedTask = Get-ScheduledTask -TaskName $plan.Name -TaskPath '\' -ErrorAction Stop
            if ($startedTask.State -notin @('Running','Queued')) { throw "Prior running state was not restored for '$($plan.Name)'." }
        }
    } catch {
        $restoreFailure = $_.Exception.Message
        try { Disable-TokeneloRestoredTasks -Transaction $Transaction -Failure $restoreFailure -LifecycleLease $LifecycleLease }
        catch { throw "Prior task state restoration failed and compensation was uncertain; no further tasks were started. Restore error: $restoreFailure. Compensation errors: $($_.Exception.Message)" }
        throw "Prior task state restoration failed; independently verified owned tasks were left disabled. No further tasks were started. Cause: $restoreFailure"
    }
}

function Disable-TokeneloRestoredTasks {
    param($Transaction,[string]$Failure,$LifecycleLease)
    Write-TokeneloTransactionJournal -Transaction $Transaction -Phase 'restore-enable-compensation-started' -Detail $Failure
    $failures = [Collections.Generic.List[string]]::new()
    foreach($plan in @($Transaction.Plans|Sort-Object @{Expression={if($_.Role -eq 'tray'){0}else{1}}})){
        if(-not $plan.Snapshot.Present){continue}
        try {
            $current=Get-OwnedTokeneloTask -Name $plan.Name
            if(-not $current){throw "Original task '$($plan.Name)' disappeared or changed ownership during enable compensation."}
            $null=Assert-TokeneloOwnedTaskSnapshot -Expected $plan.Snapshot.Owned `
                -ExpectedXmlCanonical $plan.Snapshot.XmlCanonical -ExpectedEnabled ([bool]$current.Enabled)
            $task=Get-ScheduledTask -TaskName $plan.Name -TaskPath '\' -ErrorAction Stop
            if($current.Enabled -or $task.State -in @('Running','Queued')){
                $receipt=Stop-TokeneloTask -Owned $current -CleanupTimeoutSeconds 25 `
                    -ExpectedXmlCanonical $plan.Snapshot.XmlCanonical -LifecycleLease $LifecycleLease
                if(-not $receipt.ProcessCleanupVerified){throw "Compensating cleanup was not verified for '$($plan.Name)'."}
            } else { Assert-TokeneloTaskQuiescent -Owned $current }
            Assert-TokeneloOriginalTask -Snapshot $plan.Snapshot -ExpectedEnabled $false
            Assert-TokeneloTaskQuiescent -Owned $plan.Snapshot.Owned
        } catch {
            $failures.Add(($plan.Name + ': ' + $_.Exception.Message))
        }
    }
    if ($failures.Count) {
        $detail = $failures -join ' | '
        Write-TokeneloTransactionJournal -Transaction $Transaction -Phase 'restore-enable-compensation-incomplete' -Detail $detail
        throw $detail
    }
    Write-TokeneloTransactionJournal -Transaction $Transaction -Phase 'restore-enable-compensation-complete'
}

function Invoke-TokeneloInstallRollback {
    param($Transaction, [string]$Failure)
    Write-TokeneloTransactionJournal -Transaction $Transaction -Phase 'rollback-started' -Detail $Failure
    foreach ($plan in @($Transaction.Plans | Sort-Object @{ Expression = { if ($_.Role -eq 'tray') { 0 } else { 1 } } })) {
        $current = Assert-TokeneloRollbackTaskAllowed -Transaction $Transaction -Plan $plan
        if (-not $current) { continue }
        $task = Get-ScheduledTask -TaskName $plan.Name -TaskPath '\' -ErrorAction Stop
        if ($current.Enabled -or $task.State -in @('Running','Queued')) {
            $receipt = Stop-TokeneloTask -Owned $current -CleanupTimeoutSeconds 25 `
                -ExpectedXmlCanonical $current.TransactionXmlCanonical
            if (-not $receipt.ProcessCleanupVerified) { throw "Rollback cleanup was not verified for '$($plan.Name)'." }
        } else {
            $processes = @(Get-CimInstance Win32_Process -ErrorAction Stop)
            if (@(Get-TokeneloActionProcesses -Owned $current -Processes $processes).Count -gt 0) {
                $receipt = Stop-TokeneloTask -Owned $current -CleanupTimeoutSeconds 25 `
                    -ExpectedXmlCanonical $current.TransactionXmlCanonical
                if (-not $receipt.ProcessCleanupVerified) { throw "Rollback cleanup was not verified for '$($plan.Name)'." }
            }
        }
    }
    Restore-TokeneloLaunchers -Transaction $Transaction
    Restore-TokeneloTaskDefinitions -Transaction $Transaction
    Restore-TokeneloEnabledState -Transaction $Transaction
    Write-TokeneloTransactionJournal -Transaction $Transaction -Phase 'rollback-complete'
}

function Get-TokeneloLifecycleMutexName {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $sid = if ($identity -and $identity.User) { [string]$identity.User.Value } else { $null }
    if (-not $sid -or $sid -notmatch '^S-1-\d+(?:-\d+)+$') {
        throw 'The current Windows account SID could not be validated; lifecycle serialization refused.'
    }
    return ('Global\Tokenelo-ServiceLifecycle-' + $sid)
}

function New-TokeneloLifecycleMutex {
    param([Parameter(Mandatory=$true)][string]$Name)
    # Global is required so the same SID serializes across SSH, desktop and RDP sessions.
    # A global mutex does not need SeCreateGlobalPrivilege; that privilege is for global
    # file-mapping and symbolic-link objects. Keep the token's default object security.
    return [Threading.Mutex]::new($false, $Name)
}

function Enter-TokeneloLifecycleMutex {
    $coordinatorProcessId = Get-Variable -Name LifecycleCoordinatorProcessId -ValueOnly -Scope 1 -ErrorAction SilentlyContinue
    $coordinatorExecutablePath = Get-Variable -Name LifecycleCoordinatorExecutablePath -ValueOnly -Scope 1 -ErrorAction SilentlyContinue
    $coordinatorInstalledExecutablePath = Get-Variable -Name LifecycleCoordinatorInstalledExecutablePath -ValueOnly -Scope 1 -ErrorAction SilentlyContinue
    if ($coordinatorProcessId -or $coordinatorExecutablePath -or $coordinatorInstalledExecutablePath) {
        return New-TokeneloCoordinatorLifecycleLease -ProcessId $coordinatorProcessId `
            -ExecutablePath $coordinatorExecutablePath -InstalledExecutablePath $coordinatorInstalledExecutablePath
    }
    $name = Get-TokeneloLifecycleMutexName
    $mutex = New-TokeneloLifecycleMutex -Name $name
    if (-not $mutex) { throw 'Could not create or open the per-user lifecycle mutex; no transaction was started.' }
    $owned = $false
    $abandoned = $false
    try {
        try { $owned = [bool]$mutex.WaitOne(0) }
        catch {
            $exception = $_.Exception
            while ($exception -and $exception -isnot [Threading.AbandonedMutexException]) {
                $exception = $exception.InnerException
            }
            if ($exception -isnot [Threading.AbandonedMutexException]) { throw }
            # WaitOne reports abandonment after granting ownership; retain the lease so the
            # caller can reject the operation and release only the ownership it just gained.
            $owned = $true
            $abandoned = $true
        }
    } catch {
        $mutex.Dispose()
        throw
    }
    if (-not $owned) {
        $mutex.Dispose()
        throw 'A Tokenelo install, stop or uninstall transaction is already running for this Windows account.'
    }
    return [pscustomobject]@{ Name=$name; Mutex=$mutex; Owned=$true; Abandoned=$abandoned }
}

function Exit-TokeneloLifecycleMutex {
    param($Lease)
    if (-not $Lease) { return }
    # NSIS owns this same-thread Global mutex across the entire uninstall. The child helper
    # validates that coordinator and must never release or dispose the parent's lease.
    if ($Lease.PSObject.Properties['Coordinator'] -and $Lease.Coordinator) { return }
    try {
        if ($Lease.Owned) {
            $Lease.Mutex.ReleaseMutex()
            $Lease.Owned = $false
        }
    } finally {
        if ($Lease.Mutex) { $Lease.Mutex.Dispose() }
    }
}

function Open-TokeneloLifecycleMutexForCoordinator {
    param([Parameter(Mandatory=$true)][string]$Name)
    return [Threading.Mutex]::OpenExisting($Name)
}

function Get-TokeneloCoordinatorTempRoot {
    return [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
}

function Get-TokeneloCoordinatorFileAcl {
    param([Parameter(Mandatory=$true)][string]$Path)
    $null = Import-TokeneloNativeSecurityModule
    return Get-Acl -LiteralPath $Path -ErrorAction Stop
}

function Set-TokeneloCoordinatorFileAcl {
    param([Parameter(Mandatory=$true)][string]$Path,
        [Parameter(Mandatory=$true)][Security.AccessControl.FileSecurity]$AclObject)
    $manifestPath = [IO.Path]::GetFullPath((Import-TokeneloNativeSecurityModule))
    $modules = @(Get-Module -Name 'Microsoft.PowerShell.Security')
    if ($modules.Count -ne 1 -or [IO.Path]::GetFullPath([string]$modules[0].Path) -ine $manifestPath) {
        throw 'The native Microsoft.PowerShell.Security module is not uniquely loaded for ACL restoration.'
    }
    $setAclCommand = Get-Command -Name 'Set-Acl' -Module 'Microsoft.PowerShell.Security' -ErrorAction Stop
    if ($setAclCommand.CommandType -ne [Management.Automation.CommandTypes]::Cmdlet -or
        $setAclCommand.Name -cne 'Set-Acl' -or $setAclCommand.Source -cne 'Microsoft.PowerShell.Security' -or
        $setAclCommand.ModuleName -cne 'Microsoft.PowerShell.Security' -or
        [IO.Path]::GetFullPath([string]$setAclCommand.Module.Path) -ine $manifestPath) {
        throw 'Set-Acl did not resolve to the native Microsoft.PowerShell.Security cmdlet.'
    }
    & $setAclCommand -LiteralPath $Path -AclObject $AclObject -ErrorAction Stop
}

function Get-TokeneloCoordinatorFileState {
    param([Parameter(Mandatory=$true)][string]$Path,[Parameter(Mandatory=$true)][string]$ExpectedOwnerSid)
    if (-not [IO.Path]::IsPathRooted($Path) -or $Path -match '["\r\n]' -or $Path.StartsWith('\\')) {
        throw 'Coordinator executable paths must be local absolute paths.'
    }
    try { $fullPath = [IO.Path]::GetFullPath($Path) }
    catch { throw 'Coordinator executable path could not be canonicalized.' }
    if (-not [string]::Equals($Path,$fullPath,[StringComparison]::OrdinalIgnoreCase)) {
        throw 'Coordinator executable path is not canonical.'
    }
    Assert-TokeneloNoReparseAncestors -Path $fullPath -Description 'NSIS coordinator executable'
    $driveRoot = [IO.Path]::GetPathRoot($fullPath)
    if (-not $driveRoot -or [IO.DriveInfo]::new($driveRoot).DriveType -ne [IO.DriveType]::Fixed) {
        throw 'NSIS coordinator executables must be on a fixed local volume.'
    }
    $attributes = [IO.File]::GetAttributes($fullPath)
    if (($attributes -band [IO.FileAttributes]::Directory) -ne 0 -or
        ($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
        ($attributes -band [IO.FileAttributes]::Device) -ne 0 -or
        -not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
        throw 'NSIS coordinator path is not a regular file.'
    }
    $allowedAttributes = [int]([IO.FileAttributes]::Normal -bor [IO.FileAttributes]::Archive -bor
        [IO.FileAttributes]::Hidden -bor [IO.FileAttributes]::ReadOnly -bor [IO.FileAttributes]::System -bor
        [IO.FileAttributes]::NotContentIndexed -bor [IO.FileAttributes]::Temporary)
    if (([int]$attributes -band (-bnot $allowedAttributes)) -ne 0) {
        throw 'NSIS coordinator file has unsupported attributes.'
    }

    $acl = Get-TokeneloCoordinatorFileAcl -Path $fullPath
    $ownerSid = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($ownerSid -cne $ExpectedOwnerSid) { throw 'NSIS coordinator file owner does not match the current account.' }
    $allowedWriteSids = @($ExpectedOwnerSid,'S-1-5-18','S-1-5-32-544')
    $writeMask = [int]([Security.AccessControl.FileSystemRights]::Write -bor
        [Security.AccessControl.FileSystemRights]::CreateFiles -bor
        [Security.AccessControl.FileSystemRights]::CreateDirectories -bor
        [Security.AccessControl.FileSystemRights]::Delete -bor
        [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
        [Security.AccessControl.FileSystemRights]::WriteAttributes -bor
        [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
        [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [Security.AccessControl.FileSystemRights]::TakeOwnership)
    foreach ($rule in @($acl.Access)) {
        if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { continue }
        try { $ruleSid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value }
        catch { throw 'NSIS coordinator file ACL contains an unresolved principal.' }
        if ($allowedWriteSids -ccontains $ruleSid) { continue }
        if (([int]$rule.FileSystemRights -band $writeMask) -ne 0) {
            throw 'NSIS coordinator file ACL grants write access to another principal.'
        }
    }
    $aclSddl = [string]$acl.Sddl
    $aclSha256 = Get-TokeneloSha256 ([Text.Encoding]::UTF8.GetBytes($aclSddl))

    $streams = @(Get-Item -LiteralPath $fullPath -Stream '*' -ErrorAction Stop)
    foreach ($stream in $streams) {
        if ([string]$stream.Stream -cne ':$DATA') { throw 'NSIS coordinator file has an alternate data stream.' }
    }
    $fileStream = $null; $sha = $null
    try {
        $fileStream = [IO.FileStream]::new($fullPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read,
            65536,[IO.FileOptions]::SequentialScan)
        $length = [long]$fileStream.Length
        $sha = [Security.Cryptography.SHA256]::Create()
        $fileSha256 = [BitConverter]::ToString($sha.ComputeHash($fileStream)).Replace('-','').ToLowerInvariant()
    } catch { throw 'NSIS coordinator file could not be opened read-only.' }
    finally { if ($sha) { $sha.Dispose() }; if ($fileStream) { $fileStream.Dispose() } }

    $afterAttributes = [IO.File]::GetAttributes($fullPath)
    $afterAcl = Get-TokeneloCoordinatorFileAcl -Path $fullPath
    $afterOwnerSid = $afterAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    $afterSddl = [string]$afterAcl.Sddl
    if ([int]$afterAttributes -ne [int]$attributes -or $afterOwnerSid -cne $ownerSid -or $afterSddl -cne $aclSddl) {
        throw 'NSIS coordinator file attributes or ACL changed while it was read.'
    }
    return [pscustomobject]@{Path=$fullPath;Length=$length;Sha256=$fileSha256;OwnerSid=$ownerSid;
        Attributes=[int]$attributes;AclSddl=$aclSddl;AclSha256=$aclSha256}
}

function Get-TokeneloCoordinatorProcessIdentity {
    param([Parameter(Mandatory=$true)][int]$ProcessId)
    $child = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = ' + $PID) -ErrorAction Stop
    if (-not $child -or [int]$child.ParentProcessId -ne $ProcessId) {
        throw 'The NSIS lifecycle coordinator is not the direct parent of this helper.'
    }
    $parent = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = ' + $ProcessId) -ErrorAction Stop
    if (-not $parent -or -not $parent.ExecutablePath -or -not $parent.CreationDate) {
        throw 'The NSIS lifecycle coordinator process identity is unavailable.'
    }
    try { $parentPath = [IO.Path]::GetFullPath([string]$parent.ExecutablePath) }
    catch { throw 'The NSIS lifecycle coordinator executable path is invalid.' }
    $creationDate = $parent.CreationDate
    if ($creationDate -isnot [DateTime]) {
        try { $creationDate = [Management.ManagementDateTimeConverter]::ToDateTime([string]$creationDate) }
        catch { throw 'The NSIS lifecycle coordinator creation time is invalid.' }
    }
    return [pscustomobject]@{ProcessId=$ProcessId;ChildProcessId=[int]$PID;ExecutablePath=$parentPath;
        CreationUtcTicks=$creationDate.ToUniversalTime().Ticks}
}

function Assert-TokeneloCoordinatorLifecycleLeaseAlive {
    param($Lease)
    if (-not $Lease -or -not $Lease.PSObject.Properties['Coordinator'] -or -not $Lease.Coordinator) { return }
    $process = Get-TokeneloCoordinatorProcessIdentity -ProcessId $Lease.CoordinatorProcessId
    if ($process.ProcessId -ne $Lease.CoordinatorProcessId -or $process.ChildProcessId -ne $Lease.CoordinatorChildProcessId -or
        $process.CreationUtcTicks -ne $Lease.CoordinatorCreationUtcTicks -or
        $process.ExecutablePath -ine $Lease.CoordinatorExecutablePath) {
        throw 'The NSIS lifecycle coordinator exited or changed identity; no further task or launcher mutation is allowed.'
    }
    $source = Get-TokeneloCoordinatorFileState -Path $Lease.InstalledExecutablePath -ExpectedOwnerSid $Lease.CoordinatorOwnerSid
    $clone = Get-TokeneloCoordinatorFileState -Path $Lease.CoordinatorExecutablePath -ExpectedOwnerSid $Lease.CoordinatorOwnerSid
    foreach ($current in @($source,$clone)) {
        $expected = if ($current.Path -ieq $Lease.InstalledExecutablePath) { $Lease.InstalledExecutableState } else { $Lease.CoordinatorExecutableState }
        if ($current.Length -ne $expected.Length -or $current.Sha256 -cne $expected.Sha256 -or
            $current.OwnerSid -cne $expected.OwnerSid -or $current.Attributes -ne $expected.Attributes -or
            $current.AclSha256 -cne $expected.AclSha256) {
            throw 'The installed NSIS uninstaller or its temporary clone changed; no further mutation is allowed.'
        }
    }
    $mutex = Open-TokeneloLifecycleMutexForCoordinator -Name $Lease.Name
    if (-not $mutex) { throw 'The NSIS lifecycle mutex disappeared; no further mutation is allowed.' }
    $acquiredByHelper = $false; $abandoned = $false
    try {
        try { $acquiredByHelper = [bool]$mutex.WaitOne(0) }
        catch {
            $exception = $_.Exception
            while ($exception -and $exception -isnot [Threading.AbandonedMutexException]) { $exception = $exception.InnerException }
            if ($exception -isnot [Threading.AbandonedMutexException]) { throw }
            $acquiredByHelper = $true; $abandoned = $true
        }
        if ($acquiredByHelper) {
            $mutex.ReleaseMutex(); $acquiredByHelper = $false
            if ($abandoned) { throw 'The NSIS lifecycle mutex was abandoned; no further mutation is allowed.' }
            throw 'The NSIS lifecycle mutex is no longer held by the NSIS parent; no further mutation is allowed.'
        }
    } finally {
        if ($acquiredByHelper) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}

function New-TokeneloCoordinatorLifecycleLease {
    param([int]$ProcessId, [string]$ExecutablePath, [string]$InstalledExecutablePath)
    if (-not $Uninstall -or $Stop -or $WithTray -or $NodePath -or $HomeDirectory -or
        -not $PackagedAppRoot -or -not $PackagedElectronPath -or $ProcessId -le 0 -or -not $ExecutablePath -or -not $InstalledExecutablePath) {
        throw 'The NSIS lifecycle coordinator is accepted only for a packaged uninstall with complete process identity.'
    }

    $context = Resolve-TokeneloPackagedContext -AppRoot $PackagedAppRoot `
        -ElectronPath $PackagedElectronPath -HelperScriptRoot $TokeneloHelperScriptRoot `
        -LocalAppData $env:LOCALAPPDATA -CheckoutNodePath $NodePath
    $installRoot = [IO.Path]::GetFullPath((Split-Path -Parent (Split-Path -Parent $context.AppRoot)))
    $coordinatorPath = [IO.Path]::GetFullPath($ExecutablePath)
    $installedPath = [IO.Path]::GetFullPath($InstalledExecutablePath)
    $expectedInstalledPath = [IO.Path]::GetFullPath((Join-Path $installRoot 'Uninstall Tokenelo.exe'))
    $tempRoot = [IO.Path]::GetFullPath((Get-TokeneloCoordinatorTempRoot).TrimEnd('\'))
    $isInstalledImage = $coordinatorPath -ieq $installedPath
    $isTempClone = (Test-TokeneloPathWithin -Path $coordinatorPath -Parent $tempRoot) -and $coordinatorPath -ine $tempRoot
    if ([IO.Path]::GetExtension($coordinatorPath) -ine '.exe' -or
        (-not $isInstalledImage -and -not $isTempClone) -or $installedPath -ine $expectedInstalledPath) {
        throw 'The uninstaller parent must be this exact installed Tokenelo uninstaller or its NSIS temporary clone.'
    }
    $ownerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    Assert-TokeneloNoReparseAncestors -Path $installedPath -Description 'Installed NSIS uninstaller'
    Assert-TokeneloNoReparseAncestors -Path $coordinatorPath -Description 'NSIS temporary uninstaller clone'
    $installedState = Get-TokeneloCoordinatorFileState -Path $installedPath -ExpectedOwnerSid $ownerSid
    $coordinatorState = Get-TokeneloCoordinatorFileState -Path $coordinatorPath -ExpectedOwnerSid $ownerSid
    $identityMismatch = $coordinatorState.Sha256 -cne $installedState.Sha256 -or
        $coordinatorState.Length -ne $installedState.Length
    if ($isInstalledImage) {
        $identityMismatch = $identityMismatch -or $coordinatorState.OwnerSid -cne $installedState.OwnerSid -or
            $coordinatorState.Attributes -ne $installedState.Attributes -or $coordinatorState.AclSha256 -cne $installedState.AclSha256
    }
    if ($identityMismatch) {
        throw 'The NSIS uninstaller coordinator does not match the expected installed Tokenelo uninstaller identity.'
    }
    $process = Get-TokeneloCoordinatorProcessIdentity -ProcessId $ProcessId
    if ($process.ExecutablePath -ine $coordinatorPath) {
        throw 'The direct parent process is not the verified installed uninstaller or its NSIS temporary clone.'
    }
    $mutexName = Get-TokeneloLifecycleMutexName
    $lease = [pscustomobject]@{Name=$mutexName;Mutex=$null;Owned=$true;Abandoned=$false;Coordinator=$true;
        CoordinatorProcessId=$ProcessId;CoordinatorChildProcessId=[int]$PID;CoordinatorCreationUtcTicks=$process.CreationUtcTicks;
        CoordinatorExecutablePath=$coordinatorPath;InstalledExecutablePath=$installedPath;TempRoot=$tempRoot;
        CoordinatorOwnerSid=$ownerSid;CoordinatorExecutableState=$coordinatorState;InstalledExecutableState=$installedState}
    Assert-TokeneloCoordinatorLifecycleLeaseAlive -Lease $lease
    return $lease
}

function Assert-TokeneloUninstallExpectedTask {
    param([string]$Name, $Expected)
    $current = Get-OwnedTokeneloTask -Name $Name
    if ([bool]$current -ne [bool]$Expected) { throw "Task '$Name' changed after uninstall preflight." }
    if ($current -and ($current.Execute -ine $Expected.Execute -or $current.Arguments -cne $Expected.Arguments -or
        $current.Principal -ine $Expected.Principal -or $current.HomeDirectory -ine $Expected.HomeDirectory -or
        $current.Enabled -ne $Expected.Enabled)) {
        throw "Task '$Name' changed after uninstall preflight."
    }
    return $current
}

function Remove-TokeneloUninstallLauncher {
    param($Transaction, $Plan)
    if (-not $Plan.Snapshot.LauncherPresent) { return }
    Assert-TokeneloNoReparseAncestors -Path $Plan.LauncherPath -Description "Uninstall launcher for $($Plan.Role)"
    $currentHash = Get-TokeneloRegularFileSha256 -Path $Plan.LauncherPath -Description "Uninstall launcher for $($Plan.Role)"
    if ($currentHash -cne $Plan.Snapshot.LauncherSha256) {
        $Transaction.OwnershipUncertain = $true
        throw "Launcher $($Plan.Role) changed after snapshot; removal refused."
    }
    Assert-TokeneloUninstallSnapshotLauncherState -Snapshot $Plan.Snapshot -Path $Plan.LauncherPath
    $currentTask = Get-OwnedTokeneloTask -Name $Plan.Name
    if ($currentTask) { throw "Task '$($Plan.Name)' is still registered; launcher removal refused." }
    $Plan.LauncherRemovalRequested = $true
    $Transaction.FileMutationStarted = $true
    Write-TokeneloTransactionJournal -Transaction $Transaction -Phase 'launcher-remove-requested' -Role $Plan.Role
    Assert-TokeneloNoReparseAncestors -Path $Plan.LauncherPath -Description "Uninstall launcher for $($Plan.Role)"
    $immediateHash = Get-TokeneloRegularFileSha256 -Path $Plan.LauncherPath -Description "Uninstall launcher for $($Plan.Role)"
    if ($immediateHash -cne $Plan.Snapshot.LauncherSha256) {
        $Transaction.OwnershipUncertain = $true
        throw "Launcher $($Plan.Role) changed immediately before removal."
    }
    Assert-TokeneloUninstallSnapshotLauncherState -Snapshot $Plan.Snapshot -Path $Plan.LauncherPath
    Assert-TokeneloCoordinatorLifecycleLeaseAlive -Lease $Transaction.LifecycleLease
    [IO.File]::Delete($Plan.LauncherPath)
    if (Test-Path -LiteralPath $Plan.LauncherPath) { throw "Launcher $($Plan.Role) remains after removal." }
    Write-TokeneloTransactionJournal -Transaction $Transaction -Phase 'launcher-removed' -Role $Plan.Role
}

function Assert-TokeneloUninstallRollbackReady {
    param($Transaction)
    # Preflight every task and launcher before rollback writes any role. Path checks remain
    # subject to same-user races; immediate checks narrow that window but do not claim
    # handle-based atomic protection against a hostile process running as this same user.
    foreach ($plan in @($Transaction.Plans)) {
        $current = Get-OwnedTokeneloTask -Name $plan.Name
        if ($plan.Snapshot.Present) {
            if ($current) {
                if ($current.Execute -ine $plan.Snapshot.Owned.Execute -or
                    $current.Arguments -cne $plan.Snapshot.Owned.Arguments -or
                    $current.Principal -ine $plan.Snapshot.Owned.Principal -or
                    $current.HomeDirectory -ine $plan.Snapshot.Owned.HomeDirectory -or $current.Enabled) {
                    throw "Task '$($plan.Name)' changed before uninstall rollback."
                }
                $currentXml = Get-TokeneloTaskXml -Name $plan.Name
                if ((Get-TokeneloCanonicalTaskXml $currentXml) -cne $plan.Snapshot.XmlCanonical) {
                    throw "Task '$($plan.Name)' XML changed before uninstall rollback."
                }
                Assert-TokeneloTaskQuiescent -Owned $current
            } elseif (-not $plan.UnregisterRequested) {
                throw "Task '$($plan.Name)' disappeared outside the uninstall transaction."
            } else {
                $processes = @(Get-CimInstance Win32_Process -ErrorAction Stop)
                if (@(Get-TokeneloTaskProcessClosure -Owned $plan.Snapshot.Owned -Processes $processes).Count -gt 0) {
                    throw "Task '$($plan.Name)' has a process or descendant after unregister; rollback would risk duplicate startup."
                }
            }
        } elseif ($current) {
            throw "Unowned task '$($plan.Name)' appeared before uninstall rollback."
        }

        Assert-TokeneloNoReparseAncestors -Path $plan.LauncherPath -Description "Rollback launcher for $($plan.Role)"
        $targetHash = Get-TokeneloRegularFileSha256 -Path $plan.LauncherPath -Description "Rollback launcher for $($plan.Role)"
        if ($plan.Snapshot.LauncherPresent) {
            Assert-TokeneloNoReparseAncestors -Path $plan.Snapshot.LauncherBytesPath -Description "Original backup for $($plan.Role)"
            $backupHash = Get-TokeneloRegularFileSha256 -Path $plan.Snapshot.LauncherBytesPath -Description "Original backup for $($plan.Role)"
            if ($backupHash -cne $plan.Snapshot.LauncherSha256) { throw "Original launcher backup hash mismatch for $($plan.Role)." }
            if ($targetHash) { Assert-TokeneloUninstallSnapshotLauncherState -Snapshot $plan.Snapshot -Path $plan.LauncherPath }
            if ($targetHash -cne $plan.Snapshot.LauncherSha256 -and
                -not (-not $targetHash -and $plan.LauncherRemovalRequested)) {
                throw "Launcher $($plan.Role) changed outside the uninstall transaction; rollback refused."
            }
        } elseif ($targetHash) {
            throw "Unowned launcher appeared for $($plan.Role); rollback refused."
        }
    }
}

function Assert-TokeneloUninstallRollbackLease {
    param($Transaction)
    $lease = $Transaction.LifecycleLease
    $expectedName = Get-TokeneloLifecycleMutexName
    if (-not $lease -or -not $lease.Owned -or $lease.Abandoned -or $lease.Name -cne $expectedName) {
        throw 'A fresh owned per-account lifecycle lease is required before uninstall rollback.'
    }
    if ($Transaction.ReconstructedFromRecoveryHeader -and -not $lease.Coordinator) {
        throw 'Reconstructed uninstall rollback requires the current NSIS coordinator lease.'
    }
    Assert-TokeneloCoordinatorLifecycleLeaseAlive -Lease $lease
    if ($Transaction.ReconstructedFromRecoveryHeader) {
        if (-not $Transaction.RecoveryHeaderPath -or -not $Transaction.RecoveryHeaderSha256 -or -not $Transaction.CurrentSid) {
            throw 'Reconstructed uninstall transaction has no independently pinned recovery header.'
        }
        $headerState = Get-TokeneloCoordinatorFileState -Path $Transaction.RecoveryHeaderPath -ExpectedOwnerSid $Transaction.CurrentSid
        if ($headerState.Sha256 -cne $Transaction.RecoveryHeaderSha256) {
            throw 'Uninstall recovery header changed after reconstruction; rollback refused.'
        }
        $null = Read-TokeneloUninstallRecoveryJournal -JournalPath $Transaction.JournalPath `
            -ExpectedOwnerSid $Transaction.CurrentSid -TransactionId $Transaction.Id `
            -ExpectedHeaderSha256 $Transaction.RecoveryHeaderSha256
    }
}

function Invoke-TokeneloUninstallRollback {
    param($Transaction, [string]$Failure)
    Assert-TokeneloUninstallRollbackLease -Transaction $Transaction
    if ($Transaction.OwnershipUncertain) { throw 'Uninstall ownership is uncertain; automatic rollback refused.' }
    if (-not $Transaction.CleanupComplete) { throw 'Task cleanup of every owned role was not verified; automatic rollback refused.' }
    Write-TokeneloTransactionJournal -Transaction $Transaction -Phase 'rollback-started' -Detail $Failure
    Assert-TokeneloUninstallRollbackReady -Transaction $Transaction
    Restore-TokeneloLaunchers -Transaction $Transaction -AllowMissingOriginalTasks -AllowMissingOriginalLaunchers `
        -LifecycleLease $Transaction.LifecycleLease
    Restore-TokeneloTaskDefinitions -Transaction $Transaction -AllowMissingOriginalTasks -LifecycleLease $Transaction.LifecycleLease
    Restore-TokeneloEnabledState -Transaction $Transaction -LifecycleLease $Transaction.LifecycleLease
    foreach ($plan in @($Transaction.Plans)) {
        Assert-TokeneloOriginalTask -Snapshot $plan.Snapshot -ExpectedEnabled ([bool]$plan.Snapshot.Enabled)
        if ($plan.Snapshot.LauncherPresent) {
            $restoredHash = Get-TokeneloRegularFileSha256 -Path $plan.LauncherPath -Description "Restored launcher for $($plan.Role)"
            if ($restoredHash -cne $plan.Snapshot.LauncherSha256) { throw "Restored launcher hash mismatch for $($plan.Role)." }
        }
    }
    Write-TokeneloTransactionJournal -Transaction $Transaction -Phase 'rollback-complete'
}

function Invoke-TokeneloUninstallTransactionLocked {
    param($ExpectedDaemon, $ExpectedTray, $LifecycleLease)
    Assert-TokeneloCoordinatorLifecycleLeaseAlive -Lease $LifecycleLease
    $daemon = Assert-TokeneloUninstallExpectedTask -Name $TaskName -Expected $ExpectedDaemon
    $tray = Assert-TokeneloUninstallExpectedTask -Name $TrayTaskName -Expected $ExpectedTray
    $plans = [Collections.Generic.List[object]]::new()
    foreach ($spec in @(@{Name=$TrayTaskName;Role='tray';Owned=$tray},@{Name=$TaskName;Role='daemon';Owned=$daemon})) {
        $plans.Add([ordered]@{Name=$spec.Name;Role=$spec.Role;Owned=$spec.Owned;LauncherPath=(Get-TokeneloLauncherPath -Role $spec.Role);
            Snapshot=$null;StopReceipt=$null;UnregisterRequested=$false;LauncherRemovalRequested=$false})
    }

    $localRoot = [IO.Path]::GetFullPath($env:LOCALAPPDATA)
    $recoveryBase = [IO.Path]::GetFullPath((Join-Path $localRoot 'Tokenelo\recovery'))
    $id = [Guid]::NewGuid().ToString('N')
    $recoveryRoot = Join-Path $recoveryBase $id
    $installRoot = if ($RuntimeMode -eq 'packaged') {
        Split-Path -Parent (Split-Path -Parent ([IO.Path]::GetFullPath($RepoRoot)))
    } else { [IO.Path]::GetFullPath($RepoRoot) }
    foreach ($path in @($localRoot,$recoveryBase,$recoveryRoot,$LauncherRoot)) {
        Assert-TokeneloNoReparseAncestors -Path ([IO.Path]::GetFullPath($path)) -Description 'Uninstall, launcher or recovery path'
    }
    if ($RuntimeMode -eq 'packaged') {
        if (Test-TokeneloPathWithin -Path $recoveryRoot -Parent $installRoot) {
            throw 'Uninstall recovery must be outside the application directory.'
        }
    }
    Assert-TokeneloNoIncompleteTransaction -RecoveryBase $recoveryBase
    if (-not $daemon -and -not $tray) {
        foreach ($plan in @($plans)) {
            if (Test-Path -LiteralPath $plan.LauncherPath) { throw "Unowned launcher exists for absent task '$($plan.Name)'; refusing removal." }
        }
        return [pscustomobject]@{Changed=$false;RecoveryRoot=$null;Tasks=@()}
    }
    if (Test-Path -LiteralPath $recoveryRoot) { throw 'Uninstall recovery path already exists.' }
    $currentSid = [string][Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $null = New-TokeneloPrivateUninstallRecoveryDirectory -RecoveryBase $recoveryBase -RecoveryRoot $recoveryRoot `
        -ExpectedOwnerSid $currentSid -LifecycleLease $LifecycleLease
    $transaction = [ordered]@{Id=$id;RecoveryRoot=$recoveryRoot;StagingRoot=$null;JournalPath=(Join-Path $recoveryRoot 'journal.jsonl');
        Plans=@($plans.ToArray());TaskMutationStarted=$false;FileMutationStarted=$false;CleanupComplete=$false;
        RollbackComplete=$false;OwnershipUncertain=$false;LifecycleLease=$LifecycleLease}
    try {
        Write-TokeneloTransactionJournal -Transaction $transaction -Phase 'preflight-complete'
        foreach ($plan in @($transaction.Plans)) {
            $plan.Snapshot = Get-TokeneloTaskSnapshot -Owned $plan.Owned -Name $plan.Name -Role $plan.Role `
                -LauncherPath $plan.LauncherPath -SnapshotRoot $recoveryRoot
            Write-TokeneloTransactionJournal -Transaction $transaction -Phase 'snapshot-saved' -Role $plan.Role
        }
        $header = Write-TokeneloUninstallRecoveryHeader -Transaction $transaction -CurrentSid $currentSid `
            -PackageIdentity 'com.elostudios.tokenelo' -InstallRoot ([IO.Path]::GetFullPath($installRoot)) -RuntimeMode $RuntimeMode
        Write-TokeneloTransactionJournal -Transaction $transaction -Phase 'recovery-header-written' -Detail $header.Sha256
        # Revalidate both roles and exact launcher bytes after saving durable snapshots.
        Assert-TokeneloCoordinatorLifecycleLeaseAlive -Lease $LifecycleLease
        foreach ($plan in @($transaction.Plans)) {
            $current = Assert-TokeneloUninstallExpectedTask -Name $plan.Name -Expected $plan.Owned
            if ([bool]$current -ne [bool]$plan.Snapshot.Present) { throw "Task '$($plan.Name)' changed before uninstall mutation." }
            if ($plan.Snapshot.LauncherPresent) {
                $hash = Get-TokeneloRegularFileSha256 -Path $plan.LauncherPath -Description "Uninstall launcher for $($plan.Role)"
                if ($hash -cne $plan.Snapshot.LauncherSha256) { throw "Launcher $($plan.Role) changed before uninstall mutation." }
            }
        }

        foreach ($plan in @($transaction.Plans)) {
            if (-not $plan.Snapshot.Present) { continue }
            Assert-TokeneloCoordinatorLifecycleLeaseAlive -Lease $LifecycleLease
            $transaction.TaskMutationStarted = $true
            Write-TokeneloTransactionJournal -Transaction $transaction -Phase 'stop-requested' -Role $plan.Role
            $plan.StopReceipt = Stop-TokeneloTask -Owned $plan.Snapshot.Owned `
                -ExpectedXmlCanonical $plan.Snapshot.XmlCanonical -LifecycleLease $LifecycleLease
            if (-not $plan.StopReceipt -or -not $plan.StopReceipt.ProcessCleanupVerified) {
                throw "Task '$($plan.Name)' cleanup was not verified."
            }
            Write-TokeneloTransactionJournal -Transaction $transaction -Phase 'task-stopped' -Role $plan.Role
        }
        $transaction.CleanupComplete = $true
        Write-TokeneloTransactionJournal -Transaction $transaction -Phase 'cleanup-complete'

        foreach ($plan in @($transaction.Plans)) {
            if (-not $plan.Snapshot.Present) { continue }
            Assert-TokeneloCoordinatorLifecycleLeaseAlive -Lease $LifecycleLease
            $current = Get-OwnedTokeneloTask -Name $plan.Name
            if (-not $current -or $current.Enabled) { throw "Task '$($plan.Name)' changed before unregister." }
            $currentXml = Get-TokeneloTaskXml -Name $plan.Name
            if ((Get-TokeneloCanonicalTaskXml $currentXml) -cne $plan.Snapshot.XmlCanonical) {
                throw "Task '$($plan.Name)' XML changed before unregister."
            }
            $plan.UnregisterRequested = $true
            Write-TokeneloTransactionJournal -Transaction $transaction -Phase 'unregister-requested' -Role $plan.Role
            Uninstall-TokeneloTask -Owned $plan.Snapshot.Owned -Name $plan.Name `
                -StopReceipt $plan.StopReceipt -LifecycleLease $LifecycleLease
            if (Get-OwnedTokeneloTask -Name $plan.Name) { throw "Task '$($plan.Name)' remains after unregister." }
            Write-TokeneloTransactionJournal -Transaction $transaction -Phase 'unregistered' -Role $plan.Role
        }
        foreach ($plan in @($transaction.Plans)) {
            if (-not $plan.Snapshot.Present) { continue }
            Assert-TokeneloCoordinatorLifecycleLeaseAlive -Lease $LifecycleLease
            Remove-TokeneloUninstallLauncher -Transaction $transaction -Plan $plan
        }
        foreach ($plan in @($transaction.Plans)) {
            if (Get-OwnedTokeneloTask -Name $plan.Name) { throw "Task '$($plan.Name)' reappeared during uninstall." }
            if (Test-Path -LiteralPath $plan.LauncherPath) { throw "Launcher '$($plan.Role)' reappeared during uninstall." }
        }
        Write-TokeneloTransactionJournal -Transaction $transaction -Phase 'committed'
        return [pscustomobject]@{Changed=$true;RecoveryRoot=$recoveryRoot;RecoveryHeaderPath=$transaction.HeaderPath;
            RecoveryHeaderSha256=$transaction.RecoveryHeaderSha256;
            Tasks=@($transaction.Plans | Where-Object { $_.Snapshot.Present } | ForEach-Object { $_.Name })}
    } catch {
        $failure = $_.Exception.Message
        try { Write-TokeneloTransactionJournal -Transaction $transaction -Phase 'failure' -Detail $failure } catch { }
        if (-not $transaction.TaskMutationStarted -and -not $transaction.FileMutationStarted) {
            try { Write-TokeneloTransactionJournal -Transaction $transaction -Phase 'preparation-failed-unchanged' -Detail $failure } catch { }
            throw "Uninstall preparation failed before task or launcher mutation; state is unchanged. Recovery record: $recoveryRoot. Cause: $failure"
        }
        if (-not $transaction.CleanupComplete) {
            try { Write-TokeneloTransactionJournal -Transaction $transaction -Phase 'manual-recovery-required' `
                -Detail 'Cleanup of every owned task was not verified; tasks were left disabled where their stop completed.' } catch { }
            throw "Uninstall stopped without verifying cleanup of every role; recovery data: $recoveryRoot. Cause: $failure"
        }
        if ($transaction.OwnershipUncertain) {
            try { Write-TokeneloTransactionJournal -Transaction $transaction -Phase 'manual-recovery-required' -Detail 'Task or launcher ownership changed; automatic restore was refused.' } catch { }
            throw "Uninstall detected ownership drift; no task was re-enabled. Recovery data: $recoveryRoot. Cause: $failure"
        }
        try {
            Assert-TokeneloCoordinatorLifecycleLeaseAlive -Lease $LifecycleLease
            Invoke-TokeneloUninstallRollback -Transaction $transaction -Failure $failure
            $transaction.RollbackComplete = $true
            throw "Uninstall failed; original task definitions, enabled/running state and launcher bytes were restored. Recovery data: $recoveryRoot. Cause: $failure"
        } catch {
            if ($transaction.RollbackComplete) { throw }
            try { Write-TokeneloTransactionJournal -Transaction $transaction -Phase 'manual-recovery-required' -Detail $_.Exception.Message } catch { }
            throw "Uninstall failed and rollback could not be proven; no task was re-enabled after uncertainty. Recovery data: $recoveryRoot. Cause: $($_.Exception.Message)"
        }
    }
}

function Invoke-TokeneloUninstallTransaction {
    param($LifecycleLease)
    $lease = $LifecycleLease
    $acquiredHere = $false
    if (-not $lease) { $lease = Enter-TokeneloLifecycleMutex; $acquiredHere = $true }
    try {
        if (-not $lease.Owned -or $lease.Name -cne (Get-TokeneloLifecycleMutexName)) {
            throw 'Lifecycle mutex lease does not belong to this per-user transaction.'
        }
        if ($lease.Abandoned) {
            throw 'A previous lifecycle transaction abandoned the mutex; inspect retained recovery journals before retrying.'
        }
        Assert-TokeneloCoordinatorLifecycleLeaseAlive -Lease $lease
        # Both role queries, the prior-journal check, snapshots, mutation and rollback run
        # while this same per-SID cross-session lease is held.
        $daemon = Get-OwnedTokeneloTask -Name $TaskName
        $tray = Get-OwnedTokeneloTask -Name $TrayTaskName
        return Invoke-TokeneloUninstallTransactionLocked -ExpectedDaemon $daemon -ExpectedTray $tray -LifecycleLease $lease
    } finally { if ($acquiredHere) { Exit-TokeneloLifecycleMutex -Lease $lease } }
}

function Invoke-TokeneloInstallTransactionUnlocked {
    param(
        [string]$RuntimeExecutable,
        [string]$HomeDirectory,
        [switch]$InstallTray,
        $ExpectedDaemon,
        $ExpectedTray
    )
    $plans = [Collections.Generic.List[object]]::new()
    $daemon = Get-OwnedTokeneloTask -Name $TaskName
    $tray = Get-OwnedTokeneloTask -Name $TrayTaskName
    foreach ($pair in @(@{ Current=$daemon; Expected=$ExpectedDaemon; Name=$TaskName }, @{ Current=$tray; Expected=$ExpectedTray; Name=$TrayTaskName })) {
        if ([bool]$pair.Current -ne [bool]$pair.Expected) { throw "Task '$($pair.Name)' changed after install preflight." }
        if ($pair.Current -and ($pair.Current.Execute -ine $pair.Expected.Execute -or $pair.Current.Arguments -cne $pair.Expected.Arguments -or
            $pair.Current.Principal -ine $pair.Expected.Principal -or $pair.Current.HomeDirectory -ine $pair.Expected.HomeDirectory)) {
            throw "Task '$($pair.Name)' changed after install preflight."
        }
    }
    $daemonArguments = Get-TokeneloDaemonActionArguments -RuntimeExecutable $RuntimeExecutable -Entry $DaemonEntry -HomeDirectory $HomeDirectory
    $plans.Add([ordered]@{ Name=$TaskName; Role='daemon'; Owned=$daemon; RuntimeExecutable=$RuntimeExecutable;
        Entry=$DaemonEntry; Arguments=$daemonArguments; HomeDirectory=$HomeDirectory; LauncherPath=(Get-TokeneloLauncherPath -Role 'daemon');
        Snapshot=$null; DesiredEnabled=$true; StagedPath=$null; NewLauncherSha256=$null; NewXmlCanonical=$null;
        Published=$false; PublishBackupPath=$null; CleanupReceipt=$null })
    if ($InstallTray) {
        $trayArguments = Get-TokeneloTrayActionArguments -HomeDirectory $HomeDirectory
        $plans.Add([ordered]@{ Name=$TrayTaskName; Role='tray'; Owned=$tray; RuntimeExecutable=$null;
            Entry=$null; Arguments=$trayArguments; HomeDirectory=$HomeDirectory; LauncherPath=(Get-TokeneloLauncherPath -Role 'tray');
            Snapshot=$null; DesiredEnabled=$true; StagedPath=$null; NewLauncherSha256=$null; NewXmlCanonical=$null;
            Published=$false; PublishBackupPath=$null; CleanupReceipt=$null })
    }

    $id = [Guid]::NewGuid().ToString('N')
    $localRoot = [IO.Path]::GetFullPath($env:LOCALAPPDATA)
    $recoveryBase = [IO.Path]::GetFullPath((Join-Path $localRoot 'Tokenelo\recovery'))
    $recoveryRoot = Join-Path $recoveryBase $id
    $stagingRoot = Join-Path $LauncherRoot ('.tokenelo-stage-' + $id)
    $pathsToValidate = [Collections.Generic.List[string]]::new()
    foreach ($path in @($localRoot,$LauncherRoot,$RepoRoot,$recoveryBase,$recoveryRoot,$stagingRoot)) {
        $pathsToValidate.Add([IO.Path]::GetFullPath($path))
    }
    if ($RuntimeMode -eq 'packaged') {
        $installRoot = Split-Path -Parent (Split-Path -Parent ([IO.Path]::GetFullPath($RepoRoot)))
        if (Test-TokeneloPathWithin -Path $recoveryRoot -Parent $installRoot) { throw 'Transaction recovery must be outside the application directory.' }
        $pathsToValidate.Add([IO.Path]::GetFullPath($installRoot))
    }
    foreach ($path in $pathsToValidate) {
        Assert-TokeneloNoReparseAncestors -Path $path -Description 'Install, launcher, recovery or staging path'
    }
    Assert-TokeneloNoIncompleteTransaction -RecoveryBase $recoveryBase
    if ((Test-Path -LiteralPath $recoveryRoot) -or (Test-Path -LiteralPath $stagingRoot)) { throw 'Transaction staging path already exists.' }
    foreach ($path in $pathsToValidate) {
        Assert-TokeneloNoReparseAncestors -Path $path -Description 'Install, launcher, recovery or staging path before creation'
    }
    $null = New-Item -ItemType Directory -Path $recoveryRoot -Force
    $null = New-Item -ItemType Directory -Path $stagingRoot -Force
    $transaction = [ordered]@{ Id=$id; RecoveryRoot=$recoveryRoot; StagingRoot=$stagingRoot;
        JournalPath=(Join-Path $recoveryRoot 'journal.jsonl'); Plans=@($plans.ToArray()); TaskMutationStarted=$false;
        FileMutationStarted=$false; CleanupComplete=$false; RollbackComplete=$false; OwnershipUncertain=$false }
    try {
        Write-TokeneloTransactionJournal -Transaction $transaction -Phase 'preflight-complete'
        foreach ($plan in @($transaction.Plans)) {
            $plan.Snapshot = Get-TokeneloTaskSnapshot -Owned $plan.Owned -Name $plan.Name -Role $plan.Role `
                -LauncherPath $plan.LauncherPath -SnapshotRoot $recoveryRoot
            if ($plan.Snapshot.Present) { $plan.DesiredEnabled = [bool]$plan.Snapshot.Enabled }
            $snapshotDetail = 'present=' + [string]$plan.Snapshot.Present + ';enabled=' + [string]$plan.Snapshot.Enabled +
                ';state=' + $plan.Snapshot.State + ';xmlSha256=' + $plan.Snapshot.XmlSha256 +
                ';launcherSha256=' + $plan.Snapshot.LauncherSha256
            Write-TokeneloTransactionJournal -Transaction $transaction -Phase 'snapshot-saved' -Role $plan.Role -Detail $snapshotDetail
        }
        foreach ($plan in @($transaction.Plans)) {
            $plan.StagedPath = Join-Path $stagingRoot ($plan.Role + '.launcher.candidate.exe')
            $null = Build-TokeneloLauncher -Role $plan.Role -OutputPath $plan.StagedPath
            if (-not (Test-Path -LiteralPath $plan.StagedPath -PathType Leaf)) { throw "Staged launcher is missing for $($plan.Role)." }
            $plan.NewLauncherSha256 = Get-TokeneloSha256 ([IO.File]::ReadAllBytes($plan.StagedPath))
            Write-TokeneloTransactionJournal -Transaction $transaction -Phase 'launcher-staged' -Role $plan.Role -Detail $plan.NewLauncherSha256
        }
        foreach ($plan in @($transaction.Plans)) {
            Assert-TokeneloOriginalTask -Snapshot $plan.Snapshot -ExpectedEnabled ([bool]$plan.Snapshot.Enabled)
        }
        foreach ($plan in @($transaction.Plans | Sort-Object @{ Expression = { if ($_.Role -eq 'tray') { 0 } else { 1 } } })) {
            if (-not $plan.Snapshot.Present) { continue }
            Assert-TokeneloOriginalTask -Snapshot $plan.Snapshot -ExpectedEnabled ([bool]$plan.Snapshot.Enabled)
            Write-TokeneloTransactionJournal -Transaction $transaction -Phase 'stop-requested' -Role $plan.Role
            $transaction.TaskMutationStarted = $true
            $plan.CleanupReceipt = Stop-TokeneloTask -Owned $plan.Snapshot.Owned -CleanupTimeoutSeconds 25 `
                -ExpectedXmlCanonical $plan.Snapshot.XmlCanonical
            if (-not $plan.CleanupReceipt.ProcessCleanupVerified) { throw "Process cleanup was not verified for '$($plan.Name)'." }
            Assert-TokeneloOriginalTask -Snapshot $plan.Snapshot -ExpectedEnabled $false
            Write-TokeneloTransactionJournal -Transaction $transaction -Phase 'stop-verified' -Role $plan.Role
        }
        $transaction.CleanupComplete = $true
        foreach ($plan in @($transaction.Plans)) {
            Assert-TokeneloOriginalTask -Snapshot $plan.Snapshot -ExpectedEnabled $false
        }
        foreach ($plan in @($transaction.Plans)) {
            Write-TokeneloTransactionJournal -Transaction $transaction -Phase 'publish-requested' -Role $plan.Role
            $transaction.FileMutationStarted = $true
            Publish-TokeneloLauncher -Transaction $transaction -Plan $plan
            Write-TokeneloTransactionJournal -Transaction $transaction -Phase 'launcher-published' -Role $plan.Role -Detail $plan.NewLauncherSha256
        }
        foreach ($plan in @($transaction.Plans)) {
            Assert-TokeneloOriginalTask -Snapshot $plan.Snapshot -ExpectedEnabled $false
            if ($plan.Snapshot.Present) { Assert-TokeneloTaskQuiescent -Owned $plan.Snapshot.Owned }
            Write-TokeneloTransactionJournal -Transaction $transaction -Phase 'registration-requested' -Role $plan.Role
            $transaction.TaskMutationStarted = $true
            Register-TokeneloTaskAction -Name $plan.Name -Executable $plan.LauncherPath -Arguments $plan.Arguments -Disabled
            Assert-TokeneloNewTask -Plan $plan -ExpectedEnabled $false
            $plan.NewXmlCanonical = Get-TokeneloCanonicalTaskXml (Get-TokeneloTaskXml -Name $plan.Name)
            Write-TokeneloTransactionJournal -Transaction $transaction -Phase 'registered-disabled' -Role $plan.Role
        }
        foreach ($plan in @($transaction.Plans)) {
            Assert-TokeneloNewTask -Plan $plan -ExpectedEnabled $false -CheckXml
        }
        foreach ($plan in @($transaction.Plans | Sort-Object @{ Expression = { if ($_.Role -eq 'daemon') { 0 } else { 1 } } })) {
            if (-not $plan.DesiredEnabled) { continue }
            Assert-TokeneloNewTask -Plan $plan -ExpectedEnabled $false -CheckXml
            Assert-TokeneloTaskQuiescent -Owned (Get-OwnedTokeneloTask -Name $plan.Name)
            Write-TokeneloTransactionJournal -Transaction $transaction -Phase 'enable-requested' -Role $plan.Role
            Enable-ScheduledTask -TaskName $plan.Name -TaskPath '\' -ErrorAction Stop | Out-Null
            Assert-TokeneloNewTask -Plan $plan -ExpectedEnabled $true -CheckXml
            Write-TokeneloTransactionJournal -Transaction $transaction -Phase 'enabled' -Role $plan.Role
        }
        foreach ($plan in @($transaction.Plans)) {
            Assert-TokeneloNewTask -Plan $plan -ExpectedEnabled ([bool]$plan.DesiredEnabled) -CheckXml
        }
        Write-TokeneloTransactionJournal -Transaction $transaction -Phase 'committed'
        try { Remove-TokeneloInstallStaging -Transaction $transaction }
        catch { Write-TokeneloTransactionJournal -Transaction $transaction -Phase 'staging-cleanup-pending' -Detail $_.Exception.Message }
        return [pscustomobject]@{ TransactionId=$id; RecoveryRoot=$recoveryRoot; Tasks=@($transaction.Plans | ForEach-Object { $_.Name });
            EnabledTasks=@($transaction.Plans | Where-Object { $_.DesiredEnabled } | ForEach-Object { $_.Name }) }
    } catch {
        $failure = $_.Exception.Message
        try { Write-TokeneloTransactionJournal -Transaction $transaction -Phase 'failure' -Detail $failure } catch { }
        if (-not $transaction.TaskMutationStarted -and -not $transaction.FileMutationStarted) {
            $stageCleanupFailure = $null
            try { Remove-TokeneloInstallStaging -Transaction $transaction }
            catch { $stageCleanupFailure = $_.Exception.Message }
            if ($stageCleanupFailure) {
                try { Write-TokeneloTransactionJournal -Transaction $transaction -Phase 'manual-recovery-required' `
                    -Detail ('Task/file state is unchanged, but staging cleanup could not be proven: ' + $stageCleanupFailure) } catch { }
            } else {
                try { Write-TokeneloTransactionJournal -Transaction $transaction -Phase 'preparation-failed-unchanged' -Detail $failure } catch { }
            }
            throw "Install preparation failed before task mutation; existing state is unchanged. Recovery record: $recoveryRoot. Cause: $failure"
        }
        if (-not $transaction.CleanupComplete) {
            try { Write-TokeneloTransactionJournal -Transaction $transaction -Phase 'manual-recovery-required' -Detail 'Task cleanup/ownership was not fully verified; no restore, enable, start, publish follow-up or unregister was attempted.' } catch { }
            throw "Install transaction stopped without proving cleanup; tasks were left disabled where the stop completed. Recovery data: $recoveryRoot. Cause: $failure"
        }
        if ($transaction.OwnershipUncertain) {
            try { Write-TokeneloTransactionJournal -Transaction $transaction -Phase 'manual-recovery-required' -Detail 'Launcher file ownership changed after snapshot; automatic byte restore was refused.' } catch { }
            throw "Install transaction detected an unowned launcher change; task definitions were not re-enabled or restarted. Recovery data: $recoveryRoot. Cause: $failure"
        }
        try {
            Invoke-TokeneloInstallRollback -Transaction $transaction -Failure $failure
            $transaction.RollbackComplete = $true
            try { Remove-TokeneloInstallStaging -Transaction $transaction }
            catch { Write-TokeneloTransactionJournal -Transaction $transaction -Phase 'staging-cleanup-pending' -Detail $_.Exception.Message }
            throw "Install transaction failed; original task definitions, enabled state and launcher bytes were restored. Recovery data: $recoveryRoot. Cause: $failure"
        } catch {
            if ($transaction.RollbackComplete) { throw }
            try { Write-TokeneloTransactionJournal -Transaction $transaction -Phase 'manual-recovery-required' -Detail $_.Exception.Message } catch { }
            throw "Install transaction failed and rollback could not be proven; no task was re-enabled or restarted after uncertainty. Recovery data: $recoveryRoot. Cause: $($_.Exception.Message)"
        }
    }
}

function Invoke-TokeneloInstallTransaction {
    param(
        [string]$RuntimeExecutable,
        [string]$HomeDirectory,
        [switch]$InstallTray,
        $ExpectedDaemon,
        $ExpectedTray,
        $LifecycleLease
    )
    $lease = $LifecycleLease
    $acquiredHere = $false
    if (-not $lease) { $lease = Enter-TokeneloLifecycleMutex; $acquiredHere = $true }
    try {
        if (-not $lease.Owned -or $lease.Name -cne (Get-TokeneloLifecycleMutexName)) {
            throw 'Lifecycle mutex lease does not belong to this per-user transaction.'
        }
        if ($lease.Abandoned) {
            throw 'A previous lifecycle transaction abandoned the mutex; inspect retained recovery journals before retrying.'
        }
        return Invoke-TokeneloInstallTransactionUnlocked -RuntimeExecutable $RuntimeExecutable `
            -HomeDirectory $HomeDirectory -InstallTray:$InstallTray `
            -ExpectedDaemon $ExpectedDaemon -ExpectedTray $ExpectedTray
    } finally { if ($acquiredHere) { Exit-TokeneloLifecycleMutex -Lease $lease } }
}

$entryLease = Enter-TokeneloLifecycleMutex
$exitAfterLifecycle = $false
try {
if ($entryLease.Abandoned) { throw 'A previous lifecycle transaction abandoned the mutex; inspect retained recovery journals before retrying.' }
if ($PackagedAppRoot -or $PackagedElectronPath) {
    $packagedContext = Resolve-TokeneloPackagedContext -AppRoot $PackagedAppRoot `
        -ElectronPath $PackagedElectronPath -HelperScriptRoot $PSScriptRoot `
        -LocalAppData $env:LOCALAPPDATA -CheckoutNodePath $NodePath
    $RepoRoot = $packagedContext.AppRoot
    $DaemonEntry = $packagedContext.DaemonEntry
    $TrayEntry = $packagedContext.TrayEntry
    $BundledElectronPath = $packagedContext.ElectronPath
    $LauncherRoot = $packagedContext.LauncherRoot
    $RuntimeMode = $packagedContext.RuntimeMode
}

if ($Uninstall -or $Stop) {
    if ($Uninstall) {
        $uninstallResult = Invoke-TokeneloUninstallTransaction -LifecycleLease $entryLease
        if ($uninstallResult.Changed) {
            Write-Host "Removed owned task registrations and launcher files; immutable recovery snapshots remain at $($uninstallResult.RecoveryRoot)."
        } else { Write-Host 'No owned task registrations or launcher files required removal.' }
        $exitAfterLifecycle = $true
    } else {
    # Stop leaves registrations and launcher files intact.
    $daemon = Get-OwnedTokeneloTask -Name $TaskName
    $tray = Get-OwnedTokeneloTask -Name $TrayTaskName
    $trayStop = Stop-TokeneloTask -Owned $tray
    $daemonStop = Stop-TokeneloTask -Owned $daemon
    $exitAfterLifecycle = $true
    }
}

if (-not $exitAfterLifecycle) {
$resolvedRuntime = if ($RuntimeMode -eq 'packaged') { $BundledElectronPath } else { Resolve-NodePath -Explicit $NodePath }
# Refuse foreign/legacy registrations before /F can overwrite them. An owned upgrade stops
# the prior actors before replacing their launcher, and retains an already installed tray.
$existingDaemon = Get-OwnedTokeneloTask -Name $TaskName
$existingTray = Get-OwnedTokeneloTask -Name $TrayTaskName
if ($existingDaemon -and $existingTray -and $existingDaemon.HomeDirectory -ine $existingTray.HomeDirectory) {
    throw 'Existing daemon and tray use different homes; tasks were not changed.'
}
if (-not $PSBoundParameters.ContainsKey('HomeDirectory')) {
    if ($existingDaemon) { $HomeDirectory = $existingDaemon.HomeDirectory }
    elseif ($existingTray) { $HomeDirectory = $existingTray.HomeDirectory }
    else { $HomeDirectory = $env:TOKENELO_HOME }
}
$resolvedHomeDirectory = Resolve-TokeneloDataDirectory $HomeDirectory
$installTray = $WithTray -or $null -ne $existingTray
if ($installTray) {
    $electron = if ($RuntimeMode -eq 'packaged') { $BundledElectronPath } else { Join-Path $RepoRoot 'node_modules\electron\dist\electron.exe' }
    $trayEntry = $TrayEntry
    if (-not (Test-Path -LiteralPath $electron -PathType Leaf)) { throw "$electron not found - install Tokenelo dependencies first." }
    if (-not (Test-Path -LiteralPath $trayEntry -PathType Leaf)) { throw "$trayEntry not found - build Tokenelo before installing its tasks." }
}
if (-not (Test-Path -LiteralPath $resolvedRuntime -PathType Leaf) -or
    -not (Test-Path -LiteralPath $DaemonEntry -PathType Leaf)) { throw 'Node or daemon build is missing; existing tasks were not stopped.' }
if ($RuntimeMode -eq 'checkout' -and [IO.Path]::GetFileName($resolvedRuntime) -ine 'node.exe') { throw 'NodePath must point to node.exe; existing tasks were not stopped.' }
$transactionResult = Invoke-TokeneloInstallTransaction -RuntimeExecutable $resolvedRuntime `
    -HomeDirectory $resolvedHomeDirectory -InstallTray:$installTray `
    -ExpectedDaemon $existingDaemon -ExpectedTray $existingTray -LifecycleLease $entryLease
Write-Host "Installed scheduled task '$TaskName' (runs at logon, interactive session)."
if ($installTray) { Write-Host "Installed scheduled task '$TrayTaskName' (tray at logon, interactive session)." }
Write-Host "Transaction $($transactionResult.TransactionId) committed; prior task/launcher snapshots are retained at $($transactionResult.RecoveryRoot)."
$logHome = if ($resolvedHomeDirectory) { $resolvedHomeDirectory } else { Join-Path $env:LOCALAPPDATA 'Tokenelo' }
Write-Host "Daemon stderr: $logHome\logs\daemon.stderr.log (startup rotation threshold 5 MiB; keeps one prior log)"
}
} finally { Exit-TokeneloLifecycleMutex -Lease $entryLease }
if ($exitAfterLifecycle) { exit 0 }
