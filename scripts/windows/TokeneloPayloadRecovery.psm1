Set-StrictMode -Version Latest

$script:TokeneloPayloadApplicationExe = 'Tokenelo.exe'
$script:TokeneloPayloadUninstallerExe = 'Uninstall Tokenelo.exe'
$script:TokeneloPayloadResourcesRoot = 'resources'
$script:TokeneloPayloadMetadataFile = 'payload-recovery.json'
$script:TokeneloPayloadPackageIdentity = 'com.elostudios.tokenelo'
$script:TokeneloPayloadApplicationPackageName = 'tokenelo'
$script:TokeneloPayloadApplicationPackagePath = 'resources/app/package.json'
$script:TokeneloPayloadApplicationMainPath = 'resources/app/dist/tray/main.js'
$script:TokeneloPayloadTemplateRelativePath = 'resources/app/windows-payload-manifest.template.json'
$script:TokeneloPayloadTemplateKind = 'tokenelo-windows-nsis-payload-template'
$script:TokeneloPayloadInventoryKind = 'tokenelo-windows-payload-expected-inventory'
$script:TokeneloPayloadNativeSecurityModulePath = $null
$script:TokeneloPayloadPrivateSids = @('S-1-5-18', 'S-1-5-32-544')
# A resource-only list cannot describe a runnable Electron installation. These runtime sentinels
# are required in addition to the caller's trusted complete install-root manifest.
$script:TokeneloPayloadRequiredRuntimeFiles = @('icudtl.dat','resources.pak',
    'v8_context_snapshot.bin','locales/en-US.pak')

if (-not ('TokeneloPayloadNativeDirectory' -as [type])) {
    Add-Type -ErrorAction Stop -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TokeneloPayloadNativeDirectory {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateDirectoryW")]
    private static extern bool CreateDirectoryW(string path, IntPtr securityAttributes);
    public static int CreateExclusive(string path) {
        if (CreateDirectoryW(path, IntPtr.Zero)) return 0;
        return Marshal.GetLastWin32Error();
    }
}
'@
}

function New-TokeneloPayloadError {
    param([Parameter(Mandatory=$true)][string]$Code)
    $exception = [InvalidOperationException]::new($Code)
    $exception.Data['TokeneloPayloadCode'] = $Code
    return $exception
}

function Stop-TokeneloPayload {
    param([Parameter(Mandatory=$true)][string]$Code)
    throw (New-TokeneloPayloadError -Code $Code)
}

function Get-TokeneloPayloadSha256Bytes {
    param([Parameter(Mandatory=$true)][byte[]]$Bytes)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($sha.ComputeHash($Bytes)).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

function Assert-TokeneloPayloadNativeSecurityManifestAvailable {
    param([Parameter(Mandatory=$true)][string]$ManifestPath)
    if (-not [IO.File]::Exists($ManifestPath)) {
        Stop-TokeneloPayload 'payload_acl_native_security_module_unavailable'
    }
}

function Import-TokeneloPayloadNativeSecurityModule {
    try {
        $manifestPath = [IO.Path]::GetFullPath((Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'))
    } catch {
        Stop-TokeneloPayload 'payload_acl_native_security_module_unavailable'
    }
    Assert-TokeneloPayloadNativeSecurityManifestAvailable -ManifestPath $manifestPath
    $loaded = @(Get-Module -Name 'Microsoft.PowerShell.Security')
    if ($script:TokeneloPayloadNativeSecurityModulePath -ceq $manifestPath -and $loaded.Count -eq 1 -and [IO.Path]::GetFullPath($loaded[0].Path) -ieq $manifestPath) {
        return $manifestPath
    }
    if ($loaded.Count -gt 1) { Stop-TokeneloPayload 'payload_acl_native_security_module_identity_reject' }
    if ($loaded.Count -eq 1 -and [IO.Path]::GetFullPath($loaded[0].Path) -ine $manifestPath) {
        Stop-TokeneloPayload 'payload_acl_native_security_module_identity_reject'
    }
    if ($loaded.Count -eq 0) {
        try { Import-Module -Name $manifestPath -ErrorAction Stop }
        catch { Stop-TokeneloPayload 'payload_acl_native_security_module_unavailable' }
    }
    $loaded = @(Get-Module -Name 'Microsoft.PowerShell.Security')
    if ($loaded.Count -ne 1 -or [IO.Path]::GetFullPath($loaded[0].Path) -ine $manifestPath) {
        Stop-TokeneloPayload 'payload_acl_native_security_module_identity_reject'
    }
    foreach ($commandName in @('Get-Acl','Set-Acl')) {
        try { $aclCommand = Get-Command -Name $commandName -Module 'Microsoft.PowerShell.Security' -ErrorAction Stop }
        catch { Stop-TokeneloPayload 'payload_acl_native_security_command_unavailable' }
        $commandModulePath = if ($aclCommand.Module -and $aclCommand.Module.Path) {
            [IO.Path]::GetFullPath($aclCommand.Module.Path)
        } else { '' }
        if ($aclCommand.Source -cne 'Microsoft.PowerShell.Security' -or
            $aclCommand.CommandType -ne [Management.Automation.CommandTypes]::Cmdlet -or
            $commandModulePath -ine $manifestPath) {
            Stop-TokeneloPayload 'payload_acl_native_security_command_unavailable'
        }
    }
    $script:TokeneloPayloadNativeSecurityModulePath = $manifestPath
    return $manifestPath
}

function Get-TokeneloPayloadNativeSecurityCommand {
    param([Parameter(Mandatory=$true)][ValidateSet('Get-Acl','Set-Acl')][string]$Name)
    $nativeManifest = Import-TokeneloPayloadNativeSecurityModule
    try { $command = Get-Command -Name $Name -Module 'Microsoft.PowerShell.Security' -ErrorAction Stop }
    catch { Stop-TokeneloPayload 'payload_acl_native_security_command_unavailable' }
    $commandModulePath = if ($command.Module -and $command.Module.Path) { [IO.Path]::GetFullPath($command.Module.Path) } else { '' }
    if ($command.Source -cne 'Microsoft.PowerShell.Security' -or $command.CommandType -ne [Management.Automation.CommandTypes]::Cmdlet -or $commandModulePath -ine $nativeManifest) {
        Stop-TokeneloPayload 'payload_acl_native_security_command_unavailable'
    }
    return $command
}

function Get-TokeneloPayloadAcl {
    param([Parameter(Mandatory=$true)][string]$Path,[switch]$Directory)
    if ($Directory) {
        $method = [IO.Directory].GetMethod('GetAccessControl',[type[]]@([string]))
        if ($null -ne $method) { return $method.Invoke($null,@($Path)) }
    } else {
        $method = [IO.File].GetMethod('GetAccessControl',[type[]]@([string]))
        if ($null -ne $method) { return $method.Invoke($null,@($Path)) }
    }
    $getAclCommand = Get-TokeneloPayloadNativeSecurityCommand -Name 'Get-Acl'
    return & $getAclCommand -LiteralPath $Path -ErrorAction Stop
}

function Get-TokeneloPayloadDriveType {
    param([Parameter(Mandatory=$true)][string]$Root)
    try {
        $drive = [IO.DriveInfo]::new($Root)
        return $drive.DriveType
    } catch {
        if ($_.Exception.Data.Contains('TokeneloPayloadCode')) { throw }
        Stop-TokeneloPayload 'payload_path_volume_reject'
    }
}

function Get-TokeneloPayloadFileState {
    param(
        [Parameter(Mandatory=$true)][string]$Path,
        [Parameter(Mandatory=$true)][string]$ExpectedUserSid,
        [switch]$AllowDirectory,
        [switch]$RequirePrivateAcl
    )

    try { $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop }
    catch { Stop-TokeneloPayload 'payload_path_missing' }
    $attributes = [IO.FileAttributes]$item.Attributes
    if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Stop-TokeneloPayload 'payload_reparse_reject' }
    if ($AllowDirectory) {
        if (-not $item.PSIsContainer) { Stop-TokeneloPayload 'payload_directory_reject' }
    } else {
        if ($item.PSIsContainer -or (($attributes -band [IO.FileAttributes]::Device) -ne 0)) {
            Stop-TokeneloPayload 'payload_file_reject'
        }
    }

    try {
        $acl = Get-TokeneloPayloadAcl -Path $Path -Directory:$AllowDirectory
        $ownerSid = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    } catch { Stop-TokeneloPayload 'payload_acl_read_reject' }
    if ($ownerSid -cne $ExpectedUserSid) { Stop-TokeneloPayload 'payload_owner_reject' }
    Assert-TokeneloNoForeignWriteAccess -Acl $acl -UserSid $ExpectedUserSid
    if ($RequirePrivateAcl) { Assert-TokeneloPrivateAcl -Acl $acl -UserSid $ExpectedUserSid }
    $sddl = [string]$acl.Sddl
    $sddlHash = Get-TokeneloPayloadSha256Bytes -Bytes ([Text.Encoding]::UTF8.GetBytes($sddl))

    if ($AllowDirectory) {
        Assert-TokeneloNoAlternateStreams -Path $Path
        return [pscustomobject]@{
            Path = $Path; Attributes = [int]$attributes; AclSddl = $sddl; AclSha256 = $sddlHash
            OwnerSid = $ownerSid; IsDirectory = $true
        }
    }

    Assert-TokeneloNoAlternateStreams -Path $Path
    $allowedAttributes = [int]([IO.FileAttributes]::Normal -bor [IO.FileAttributes]::Archive -bor
        [IO.FileAttributes]::Hidden -bor [IO.FileAttributes]::ReadOnly -bor [IO.FileAttributes]::System -bor
        [IO.FileAttributes]::NotContentIndexed -bor [IO.FileAttributes]::Temporary)
    if (([int]$attributes -band (-bnot $allowedAttributes)) -ne 0) { Stop-TokeneloPayload 'payload_file_mode_reject' }
    $stream = $null; $sha = $null; $isSqlite = $false
    try {
        $stream = [IO.FileStream]::new($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read,
            65536, [IO.FileOptions]::SequentialScan)
        $length = [long]$stream.Length
        if ($length -ge 16) {
            $header = New-Object byte[] 16
            $headerRead = $stream.Read($header, 0, $header.Length)
            if ($headerRead -eq 16 -and [Text.Encoding]::ASCII.GetString($header) -ceq ("SQLite format 3`0")) { $isSqlite = $true }
            $stream.Position = 0
        }
        $sha = [Security.Cryptography.SHA256]::Create()
        $hash = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
    } catch { Stop-TokeneloPayload 'payload_file_read_reject' }
    finally { if ($sha) { $sha.Dispose() }; if ($stream) { $stream.Dispose() } }
    if ($isSqlite) { Stop-TokeneloPayload 'payload_database_header_reject' }
    return [pscustomobject]@{
        Path = $Path; Attributes = [int]$attributes; AclSddl = $sddl; AclSha256 = $sddlHash
        OwnerSid = $ownerSid; SizeBytes = $length; Sha256 = $hash; IsDirectory = $false
    }
}

function Assert-TokeneloNoForeignWriteAccess {
    param([Parameter(Mandatory=$true)]$Acl,[Parameter(Mandatory=$true)][string]$UserSid)
    $allowed = @($UserSid) + @($script:TokeneloPayloadPrivateSids)
    # Use only write-capable constituent bits. Modify and FullControl are composites that
    # also overlap ReadAndExecute/Synchronize bits in a raw mask test.
    $writeMask = [int]([Security.AccessControl.FileSystemRights]::Write -bor
        [Security.AccessControl.FileSystemRights]::CreateFiles -bor
        [Security.AccessControl.FileSystemRights]::CreateDirectories -bor
        [Security.AccessControl.FileSystemRights]::Delete -bor
        [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
        [Security.AccessControl.FileSystemRights]::WriteAttributes -bor
        [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
        [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [Security.AccessControl.FileSystemRights]::TakeOwnership)
    foreach ($rule in @($Acl.Access)) {
        if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { continue }
        try { $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value }
        catch { Stop-TokeneloPayload 'payload_acl_identity_reject' }
        if ($allowed -ccontains $sid) { continue }
        if (([int]$rule.FileSystemRights -band $writeMask) -ne 0) { Stop-TokeneloPayload 'payload_foreign_write_reject' }
    }
}

function Assert-TokeneloNoAlternateStreams {
    param([Parameter(Mandatory=$true)][string]$Path)
    try { $streams = @(Get-Item -LiteralPath $Path -Stream '*' -ErrorAction Stop) }
    catch { Stop-TokeneloPayload 'payload_stream_enumeration_reject' }
    foreach ($stream in $streams) {
        $name = [string]$stream.Stream
        if ($name -cne ':$DATA') { Stop-TokeneloPayload 'payload_ads_reject' }
    }
}

function Assert-TokeneloPhysicalPath {
    param([Parameter(Mandatory=$true)][string]$Path,[switch]$MustBeDirectory)
    if (-not [IO.Path]::IsPathRooted($Path) -or $Path -match '["\r\n]' -or $Path.StartsWith('\\')) {
        Stop-TokeneloPayload 'payload_path_reject'
    }
    try { $full = [IO.Path]::GetFullPath($Path) }
    catch { Stop-TokeneloPayload 'payload_path_reject' }
    if (-not [string]::Equals($full, $Path, [StringComparison]::OrdinalIgnoreCase)) { Stop-TokeneloPayload 'payload_path_not_canonical' }
    $volume = [IO.Path]::GetPathRoot($full)
    if (-not $volume -or $full.Length -le $volume.Length) { Stop-TokeneloPayload 'payload_path_reject' }
    if ((Get-TokeneloPayloadDriveType -Root $volume) -ne [IO.DriveType]::Fixed) { Stop-TokeneloPayload 'payload_path_local_fixed_volume_required' }
    $current = $volume
    $parts = @($full.Substring($volume.Length).Split([char[]]@('\'), [StringSplitOptions]::RemoveEmptyEntries))
    for ($index = 0; $index -lt $parts.Count; $index++) {
        if ($parts[$index].Contains(':') -or $parts[$index].EndsWith('.') -or $parts[$index].EndsWith(' ')) {
            Stop-TokeneloPayload 'payload_path_reject'
        }
        $current = Join-Path $current $parts[$index]
        try { $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop }
        catch { Stop-TokeneloPayload 'payload_path_missing' }
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Stop-TokeneloPayload 'payload_reparse_reject' }
        if ($index -lt ($parts.Count - 1) -and -not $item.PSIsContainer) { Stop-TokeneloPayload 'payload_path_component_reject' }
    }
    if ($MustBeDirectory) {
        try { $last = Get-Item -LiteralPath $full -Force -ErrorAction Stop }
        catch { Stop-TokeneloPayload 'payload_path_missing' }
        if (-not $last.PSIsContainer) { Stop-TokeneloPayload 'payload_directory_reject' }
    }
    return $full
}

function Test-TokeneloPathWithin {
    param([Parameter(Mandatory=$true)][string]$Path,[Parameter(Mandatory=$true)][string]$Parent)
    $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    $fullParent = [IO.Path]::GetFullPath($Parent).TrimEnd('\')
    if ([string]::Equals($fullPath, $fullParent, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    return $fullPath.StartsWith($fullParent + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Assert-TokeneloPrivateDirectory {
    param([Parameter(Mandatory=$true)][string]$Path,[Parameter(Mandatory=$true)][string]$UserSid,
        [switch]$RequireProtected,[switch]$RequireChildInheritance)
    try { $acl = Get-TokeneloPayloadAcl -Path $Path -Directory; $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value }
    catch { Stop-TokeneloPayload 'payload_recovery_acl_reject' }
    if ($owner -cne $UserSid) { Stop-TokeneloPayload 'payload_recovery_owner_reject' }
    if ($RequireProtected -and -not $acl.AreAccessRulesProtected) { Stop-TokeneloPayload 'payload_recovery_acl_inheritance_reject' }
    Assert-TokeneloPrivateAcl -Acl $acl -UserSid $UserSid
    if ($RequireChildInheritance) {
        $requiredInheritance = [int]([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
            [Security.AccessControl.InheritanceFlags]::ObjectInherit)
        foreach ($rule in @($acl.Access)) {
            if (([int]$rule.InheritanceFlags -band $requiredInheritance) -ne $requiredInheritance) {
                Stop-TokeneloPayload 'payload_recovery_acl_inheritance_reject'
            }
        }
    }
}

function Assert-TokeneloPrivateAcl {
    param([Parameter(Mandatory=$true)]$Acl,[Parameter(Mandatory=$true)][string]$UserSid)
    $allowed = @($UserSid) + @($script:TokeneloPayloadPrivateSids)
    $seen = @{}
    foreach ($rule in @($acl.Access)) {
        if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { Stop-TokeneloPayload 'payload_recovery_acl_reject' }
        try { $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value }
        catch { Stop-TokeneloPayload 'payload_recovery_acl_reject' }
        if ($allowed -cnotcontains $sid) { Stop-TokeneloPayload 'payload_recovery_acl_reject' }
        $fullControl = [int][Security.AccessControl.FileSystemRights]::FullControl
        if (([int]$rule.FileSystemRights -band $fullControl) -ne $fullControl) {
            Stop-TokeneloPayload 'payload_recovery_acl_reject'
        }
        $seen[$sid] = $true
    }
    foreach ($sid in $allowed) { if (-not $seen.ContainsKey($sid)) { Stop-TokeneloPayload 'payload_recovery_acl_reject' } }
}

function New-TokeneloPrivateDirectory {
    param([Parameter(Mandatory=$true)][string]$Path,[Parameter(Mandatory=$true)][string]$UserSid,[switch]$RequireProtectedParent)
    $parent = [IO.Path]::GetDirectoryName($Path)
    if (-not $parent) { Stop-TokeneloPayload 'payload_recovery_path_reject' }
    Assert-TokeneloPhysicalPath -Path $parent -MustBeDirectory | Out-Null
    Assert-TokeneloPrivateDirectory -Path $parent -UserSid $UserSid -RequireChildInheritance -RequireProtected:$RequireProtectedParent
    # CreateDirectoryW is atomic for a single directory and returns ERROR_ALREADY_EXISTS
    # instead of adopting or changing the ACL on a racing/pre-existing entry. The new child
    # inherits the already-validated private parent DACL at creation time.
    $nativePath = '\\?\' + [IO.Path]::GetFullPath($Path)
    try { $nativeError = [TokeneloPayloadNativeDirectory]::CreateExclusive($nativePath) }
    catch { Stop-TokeneloPayload 'payload_recovery_root_create_failed' }
    if ($nativeError -in @(80,183)) { Stop-TokeneloPayload 'payload_recovery_root_exists' }
    if ($nativeError -ne 0) { Stop-TokeneloPayload 'payload_recovery_root_create_failed' }
    Assert-TokeneloPrivateDirectory -Path $Path -UserSid $UserSid -RequireChildInheritance
}

function Assert-TokeneloRecoveryManifest {
    param([Parameter(Mandatory=$true)][byte[]]$ManifestBytes,[Parameter(Mandatory=$true)][string]$ManifestSha256,
        [Parameter(Mandatory=$true)][string]$InstallRoot,[Parameter(Mandatory=$true)][string]$UserSid,
        [Parameter(Mandatory=$true)][string]$PackageIdentity)
    if ($ManifestSha256 -cnotmatch '^[a-f0-9]{64}$' -or
        (Get-TokeneloPayloadSha256Bytes -Bytes $ManifestBytes) -cne $ManifestSha256) { Stop-TokeneloPayload 'payload_manifest_hash_mismatch' }
    try { $manifest = [Text.Encoding]::UTF8.GetString($ManifestBytes) | ConvertFrom-Json -ErrorAction Stop }
    catch { Stop-TokeneloPayload 'payload_manifest_json_reject' }
    # The caller must bind these exact bytes/hash to a separately trusted package manifest.
    # Schema 2 means every regular file in the complete install root, not a selected resources subset.
    # The path/header checks below reject known private-data artifacts; they cannot identify every secret.
    $manifestKeys = @('schemaVersion','manifestScope','packageIdentity','installRoot','userSid','applicationExe','uninstallerExe','resourcesRoot','files')
    if ($null -eq $manifest -or @($manifest.PSObject.Properties.Name).Count -ne $manifestKeys.Count -or
        @($manifest.PSObject.Properties.Name | Where-Object { $manifestKeys -cnotcontains $_ }).Count -ne 0) {
        Stop-TokeneloPayload 'payload_manifest_contract_reject'
    }
    if ((($manifest.schemaVersion -isnot [int]) -and ($manifest.schemaVersion -isnot [long])) -or
        $manifest.manifestScope -isnot [string] -or
        $manifest.packageIdentity -isnot [string] -or $manifest.installRoot -isnot [string] -or
        $manifest.userSid -isnot [string] -or $manifest.applicationExe -isnot [string] -or
        $manifest.uninstallerExe -isnot [string] -or $manifest.resourcesRoot -isnot [string] -or
        $manifest.files -isnot [array]) { Stop-TokeneloPayload 'payload_manifest_contract_reject' }
    if ($manifest.schemaVersion -ne 2 -or $manifest.manifestScope -cne 'full-install-root' -or
        $manifest.packageIdentity -cne $PackageIdentity -or
        $manifest.applicationExe -cne $script:TokeneloPayloadApplicationExe -or
        $manifest.uninstallerExe -cne $script:TokeneloPayloadUninstallerExe -or
        $manifest.resourcesRoot -cne $script:TokeneloPayloadResourcesRoot -or
        $manifest.userSid -cne $UserSid -or
        -not [string]::Equals([string]$manifest.installRoot, $InstallRoot, [StringComparison]::OrdinalIgnoreCase)) {
        Stop-TokeneloPayload 'payload_manifest_identity_reject'
    }
    $files = @($manifest.files)
    if ($files.Count -lt 3) { Stop-TokeneloPayload 'payload_manifest_files_reject' }
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    $roles = @{ application = 0; uninstaller = 0; resources = 0; runtimeSiblings = 0 }
    $manifestFileByPath = @{}
    $total = [long]0
    foreach ($entry in $files) {
        $keys = @('relativePath','sizeBytes','sha256','attributes')
        if ($null -eq $entry -or @($entry.PSObject.Properties.Name).Count -ne $keys.Count -or
            @($entry.PSObject.Properties.Name | Where-Object { $keys -cnotcontains $_ }).Count -ne 0 -or
            $entry.relativePath -isnot [string]) {
            Stop-TokeneloPayload 'payload_manifest_file_contract_reject'
        }
        $relative = [string]$entry.relativePath
        if (-not $relative -or $relative.StartsWith('/') -or $relative.Contains('\') -or $relative.Contains(':')) {
            Stop-TokeneloPayload 'payload_manifest_path_reject'
        }
        $segments = @($relative.Split('/'))
        foreach ($segment in $segments) {
            if (-not $segment -or $segment -in @('.','..') -or $segment.EndsWith('.') -or $segment.EndsWith(' ') -or
                $segment.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0) { Stop-TokeneloPayload 'payload_manifest_path_reject' }
            $baseName = $segment.Split('.')[0].ToUpperInvariant()
            if ($baseName -in @('CON','PRN','AUX','NUL','COM1','COM2','COM3','COM4','COM5','COM6','COM7','COM8','COM9',
                'LPT1','LPT2','LPT3','LPT4','LPT5','LPT6','LPT7','LPT8','LPT9')) { Stop-TokeneloPayload 'payload_manifest_path_reject' }
        }
        Assert-TokeneloSafePayloadPath -RelativePath $relative
        if (-not $seen.Add($relative)) { Stop-TokeneloPayload 'payload_manifest_case_collision' }
        $manifestFileByPath[$relative] = $entry
        if ([string]$entry.sha256 -cnotmatch '^[a-f0-9]{64}$' -or
            (($entry.sizeBytes -isnot [int]) -and ($entry.sizeBytes -isnot [long])) -or [long]$entry.sizeBytes -lt 0 -or
            (($entry.attributes -isnot [int]) -and ($entry.attributes -isnot [long])) -or [long]$entry.attributes -lt 0 -or
            [long]$entry.attributes -gt [int]::MaxValue) {
            Stop-TokeneloPayload 'payload_manifest_file_contract_reject'
        }
        $attrs = [int]$entry.attributes
        if (($attrs -band ([int][IO.FileAttributes]::Directory -bor [int][IO.FileAttributes]::ReparsePoint -bor [int][IO.FileAttributes]::Device)) -ne 0) {
            Stop-TokeneloPayload 'payload_manifest_mode_reject'
        }
        if ($relative -ceq $manifest.applicationExe) { $roles.application++ }
        elseif ($relative -ceq $manifest.uninstallerExe) { $roles.uninstaller++ }
        elseif ($relative.StartsWith($manifest.resourcesRoot + '/', [StringComparison]::Ordinal)) { $roles.resources++ }
        else { $roles.runtimeSiblings++ }
        if ($total -gt ([long]::MaxValue - [long]$entry.sizeBytes)) { Stop-TokeneloPayload 'payload_manifest_files_reject' }
        $total += [long]$entry.sizeBytes
    }
    if ($roles.application -ne 1 -or $roles.uninstaller -ne 1 -or $roles.resources -lt 1) {
        Stop-TokeneloPayload 'payload_manifest_files_reject'
    }
    foreach ($requiredRuntimeFile in $script:TokeneloPayloadRequiredRuntimeFiles) {
        if (-not $manifestFileByPath.ContainsKey($requiredRuntimeFile) -or
            -not [string]::Equals([string]$manifestFileByPath[$requiredRuntimeFile].relativePath,
                $requiredRuntimeFile, [StringComparison]::Ordinal)) {
            Stop-TokeneloPayload 'payload_manifest_runtime_incomplete'
        }
    }
    foreach ($entry in $files) {
        $segments = @(([string]$entry.relativePath).Split('/'))
        for ($index = 1; $index -lt $segments.Count; $index++) {
            $parent = $segments[0..($index - 1)] -join '/'
            if ($seen.Contains($parent)) { Stop-TokeneloPayload 'payload_manifest_path_collision' }
        }
    }
    return [pscustomobject]@{ Manifest = $manifest; Files = $files; TotalBytes = $total; Sha256 = $ManifestSha256 }
}

function Get-TokeneloPayloadSourceInventory {
    param([Parameter(Mandatory=$true)][string]$InstallRoot,[Parameter(Mandatory=$true)]$ValidatedManifest,
        [Parameter(Mandatory=$true)][string]$UserSid)
    $expected = @{}; foreach ($entry in $ValidatedManifest.Files) { $expected[[string]$entry.relativePath] = $entry }
    $actualFiles = New-Object 'System.Collections.Generic.List[object]'
    $actualDirectories = New-Object 'System.Collections.Generic.List[object]'
    $pending = New-Object 'System.Collections.Generic.Stack[string]'
    $pending.Push($InstallRoot)
    while ($pending.Count -gt 0) {
        $directory = $pending.Pop()
        try { $children = @(Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop) }
        catch { Stop-TokeneloPayload 'payload_directory_read_reject' }
        foreach ($child in $children) {
            if (($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Stop-TokeneloPayload 'payload_reparse_reject' }
            $relative = $child.FullName.Substring($InstallRoot.Length).TrimStart('\').Replace('\','/')
            Assert-TokeneloSafePayloadPath -RelativePath $relative
            if ($child.PSIsContainer) {
                $state = Get-TokeneloPayloadFileState -Path $child.FullName -ExpectedUserSid $UserSid -AllowDirectory
                $actualDirectories.Add([pscustomobject]@{ RelativePath = $relative; FullPath = $child.FullName; State = $state })
                $pending.Push($child.FullName)
            } else {
                $state = Get-TokeneloPayloadFileState -Path $child.FullName -ExpectedUserSid $UserSid
                if (-not $expected.ContainsKey($relative)) { Stop-TokeneloPayload 'payload_unexpected_source_element' }
                $entry = $expected[$relative]
                if (-not [string]::Equals($relative, [string]$entry.relativePath, [StringComparison]::Ordinal) -or
                    $state.SizeBytes -ne [long]$entry.sizeBytes -or $state.Sha256 -cne [string]$entry.sha256 -or
                    $state.Attributes -ne [int]$entry.attributes) { Stop-TokeneloPayload 'payload_source_manifest_mismatch' }
                $actualFiles.Add([pscustomobject]@{ RelativePath = $relative; FullPath = $child.FullName; State = $state })
            }
        }
    }
    $actualSet = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($file in $actualFiles) {
        if (-not $actualSet.Add($file.RelativePath)) { Stop-TokeneloPayload 'payload_source_case_collision' }
    }
    if ($actualFiles.Count -ne $ValidatedManifest.Files.Count) { Stop-TokeneloPayload 'payload_source_fileset_mismatch' }
    foreach ($entry in $ValidatedManifest.Files) { if (-not $actualSet.Contains([string]$entry.relativePath)) { Stop-TokeneloPayload 'payload_source_fileset_mismatch' } }
    $dirSet = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($directory in $actualDirectories) { if (-not $dirSet.Add($directory.RelativePath)) { Stop-TokeneloPayload 'payload_source_case_collision' } }
    $expectedDirectoryArray = @(Get-TokeneloPayloadExpectedDirectories -Files $ValidatedManifest.Files)
    $expectedDirectories = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($relative in $expectedDirectoryArray) { $null = $expectedDirectories.Add($relative) }
    if ($dirSet.Count -ne $expectedDirectories.Count) { Stop-TokeneloPayload 'payload_source_directories_mismatch' }
    foreach ($relative in $dirSet) {
        if (-not $expectedDirectories.Contains($relative) -or $expectedDirectoryArray -cnotcontains $relative) {
            Stop-TokeneloPayload 'payload_source_directories_mismatch'
        }
    }
    return [pscustomobject]@{ Files = @($actualFiles | Sort-Object RelativePath); Directories = @($actualDirectories | Sort-Object RelativePath) }
}

function Copy-TokeneloPayloadFileDurable {
    param([Parameter(Mandatory=$true)][string]$Source,[Parameter(Mandatory=$true)][string]$Destination)
    $input = $null; $output = $null
    try {
        $input = [IO.FileStream]::new($Source, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read,
            65536, [IO.FileOptions]::SequentialScan)
        $output = [IO.FileStream]::new($Destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None,
            65536, [IO.FileOptions]::WriteThrough)
        $buffer = New-Object byte[] 65536
        while (($read = $input.Read($buffer, 0, $buffer.Length)) -gt 0) { $output.Write($buffer, 0, $read) }
        $output.Flush($true)
    } catch { Stop-TokeneloPayload 'payload_copy_failed' }
    finally { if ($output) { $output.Dispose() }; if ($input) { $input.Dispose() } }
}

function Write-TokeneloPayloadBytesDurable {
    param([Parameter(Mandatory=$true)][string]$Path,[Parameter(Mandatory=$true)][byte[]]$Bytes)
    $stream = $null
    try {
        $stream = [IO.FileStream]::new($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None,
            4096, [IO.FileOptions]::WriteThrough)
        $stream.Write($Bytes, 0, $Bytes.Length)
        $stream.Flush($true)
    } catch { Stop-TokeneloPayload 'payload_metadata_write_failed' }
    finally { if ($stream) { $stream.Dispose() } }
}

function Get-TokeneloPayloadExpectedDirectories {
    param([Parameter(Mandatory=$true)]$Files)
    $set = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    $null = $set.Add($script:TokeneloPayloadResourcesRoot)
    foreach ($file in $Files) {
        $parts = @(([string]$file.relativePath).Split('/'))
        $current = ''
        for ($index = 0; $index -lt ($parts.Count - 1); $index++) {
            $current = if ($current) { $current + '/' + $parts[$index] } else { $parts[$index] }
            $null = $set.Add($current)
        }
    }
    return @($set | Sort-Object)
}

function Assert-TokeneloManifestRoot {
    param([string]$RecoveryRoot,[string]$RecoveryParent,[string]$UserSid)
    $root = Assert-TokeneloPhysicalPath -Path $RecoveryRoot -MustBeDirectory
    $parent = [IO.Path]::GetDirectoryName($root)
    if (-not [string]::Equals($parent, [IO.Path]::GetFullPath($RecoveryParent), [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($root) -cnotmatch '^[a-f0-9]{32}$') { Stop-TokeneloPayload 'payload_recovery_path_reject' }
    Assert-TokeneloPrivateDirectory -Path $root -UserSid $UserSid -RequireChildInheritance
}

function Assert-TokeneloSafePayloadPath {
    param([Parameter(Mandatory=$true)][string]$RelativePath)
    $parts = @($RelativePath.Split('/'))
    $blockedSegments = @('data','userdata','user-data','user_data','logs','log','config','configs','configuration',
        'ledger','ledgers','credentials','credential','secrets','secret','tokens','token','auth','authentication','private-keys')
    foreach ($part in $parts) {
        $lower = $part.ToLowerInvariant()
        if ($blockedSegments -ccontains $lower) { Stop-TokeneloPayload 'payload_sensitive_path_reject' }
        if ($lower -eq '.env' -or $lower.StartsWith('.env.') -or
            $lower -match '^(config|configuration|settings|credentials?|auth|secrets?|fleet-token)(\.|-|_).*$' -or
            $lower -match '^(ledger|ledgers|credentials?|token|fleet-token|auth|secret|secrets)(\.|-|_).*$' -or
            $lower -match '\.log(?:\.[^.]+)*$' -or
            $lower -match '\.(db|sqlite|sqlite3|wal|shm)(-(wal|shm))?$') {
            Stop-TokeneloPayload 'payload_sensitive_path_reject'
        }
        if ($lower -ceq $script:TokeneloPayloadMetadataFile.ToLowerInvariant()) { Stop-TokeneloPayload 'payload_manifest_path_reject' }
    }
}

function Assert-TokeneloPayloadCallerAssertions {
    param([bool]$ActorsQuiesced,[bool]$LeaseHeld,[string]$LeaseName,[string]$UserSid)
    if (-not $ActorsQuiesced -or -not $LeaseHeld) { Stop-TokeneloPayload 'payload_prerequisite_attestation_missing' }
    $currentSid = [string][Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if ($UserSid -cne $currentSid -or $LeaseName -cne ('Global\Tokenelo-ServiceLifecycle-' + $UserSid)) {
        Stop-TokeneloPayload 'payload_prerequisite_identity_reject'
    }
}

function ConvertFrom-TokeneloPayloadAclSddl {
    param([Parameter(Mandatory=$true)][string]$Sddl,[switch]$Directory)
    try {
        $acl = if ($Directory) { [Security.AccessControl.DirectorySecurity]::new() } else { [Security.AccessControl.FileSecurity]::new() }
        $acl.SetSecurityDescriptorSddlForm($Sddl,[Security.AccessControl.AccessControlSections]::All)
        return $acl
    } catch { Stop-TokeneloPayload 'payload_source_acl_metadata_reject' }
}

function Assert-TokeneloPayloadSourceAclMetadata {
    param([string]$Sddl,[string]$Sha256,[string]$UserSid,[switch]$Directory)
    if (-not $Sddl -or $Sha256 -cnotmatch '^[a-f0-9]{64}$' -or
        (Get-TokeneloPayloadSha256Bytes -Bytes ([Text.Encoding]::UTF8.GetBytes($Sddl))) -cne $Sha256) {
        Stop-TokeneloPayload 'payload_source_acl_metadata_reject'
    }
    $acl = ConvertFrom-TokeneloPayloadAclSddl -Sddl $Sddl -Directory:$Directory
    try { $ownerSid = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value }
    catch { Stop-TokeneloPayload 'payload_source_acl_metadata_reject' }
    if ($ownerSid -cne $UserSid) { Stop-TokeneloPayload 'payload_owner_reject' }
    Assert-TokeneloNoForeignWriteAccess -Acl $acl -UserSid $UserSid
    return $ownerSid
}

function Assert-TokeneloPayloadSourceAttributes {
    param([long]$Attributes,[switch]$Directory)
    $allowed = if ($Directory) {
        [int]([IO.FileAttributes]::Directory -bor [IO.FileAttributes]::Archive -bor [IO.FileAttributes]::Hidden -bor
            [IO.FileAttributes]::ReadOnly -bor [IO.FileAttributes]::System -bor [IO.FileAttributes]::NotContentIndexed -bor
            [IO.FileAttributes]::Temporary)
    } else {
        [int]([IO.FileAttributes]::Normal -bor [IO.FileAttributes]::Archive -bor [IO.FileAttributes]::Hidden -bor
            [IO.FileAttributes]::ReadOnly -bor [IO.FileAttributes]::System -bor [IO.FileAttributes]::NotContentIndexed -bor
            [IO.FileAttributes]::Temporary)
    }
    if (([int]$Attributes -band (-bnot $allowed)) -ne 0 -or
        ($Directory -and (([int]$Attributes -band [int][IO.FileAttributes]::Directory) -eq 0)) -or
        (-not $Directory -and (([int]$Attributes -band [int][IO.FileAttributes]::Directory) -ne 0))) {
        Stop-TokeneloPayload 'payload_source_attributes_reject'
    }
}

function Assert-TokeneloPayloadArchiveInstallPath {
    param([Parameter(Mandatory=$true)][string]$Path)
    if (-not [IO.Path]::IsPathRooted($Path) -or $Path -match '["\r\n]' -or $Path.StartsWith('\\')) {
        Stop-TokeneloPayload 'payload_path_reject'
    }
    try { $full = [IO.Path]::GetFullPath($Path) }
    catch { Stop-TokeneloPayload 'payload_path_reject' }
    if (-not [string]::Equals($full,$Path,[StringComparison]::OrdinalIgnoreCase)) { Stop-TokeneloPayload 'payload_path_not_canonical' }
    $volume = [IO.Path]::GetPathRoot($full)
    if (-not $volume -or $full.Length -le $volume.Length -or
        (Get-TokeneloPayloadDriveType -Root $volume) -ne [IO.DriveType]::Fixed) { Stop-TokeneloPayload 'payload_path_local_fixed_volume_required' }
    $parent = [IO.Path]::GetDirectoryName($full)
    if (-not $parent) { Stop-TokeneloPayload 'payload_path_reject' }
    Assert-TokeneloPhysicalPath -Path $parent -MustBeDirectory | Out-Null
    $entry = $null
    try { $entry = Get-Item -LiteralPath $full -Force -ErrorAction Stop }
    catch {
        if ($_.CategoryInfo.Category -ne [Management.Automation.ErrorCategory]::ObjectNotFound) {
            Stop-TokeneloPayload 'payload_path_read_reject'
        }
    }
    if ($entry) {
        if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Stop-TokeneloPayload 'payload_reparse_reject' }
        if (-not $entry.PSIsContainer) { Stop-TokeneloPayload 'payload_directory_reject' }
        Assert-TokeneloPhysicalPath -Path $full -MustBeDirectory | Out-Null
    }
    return $full
}

function Assert-TokeneloPayloadRestorePathAbsent {
    param([Parameter(Mandatory=$true)][string]$Path)
    try { $entry = Get-Item -LiteralPath $Path -Force -ErrorAction Stop }
    catch {
        if ($_.CategoryInfo.Category -eq [Management.Automation.ErrorCategory]::ObjectNotFound) { return }
        Stop-TokeneloPayload 'payload_restore_path_read_reject'
    }
    if ($entry) { Stop-TokeneloPayload 'payload_restore_destination_exists' }
}

function Test-TokeneloPayloadRestorePathExists {
    param([Parameter(Mandatory=$true)][string]$Path)
    try { $null = Get-Item -LiteralPath $Path -Force -ErrorAction Stop; return $true }
    catch {
        if ($_.CategoryInfo.Category -eq [Management.Automation.ErrorCategory]::ObjectNotFound) { return $false }
        return $true
    }
}

function Test-TokeneloPayloadRecoverySnapshot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$RecoveryRoot,
        [Parameter(Mandatory=$true)][string]$RecoveryParent,
        [Parameter(Mandatory=$true)][string]$PackageIdentity,
        [Parameter(Mandatory=$true)][string]$InstallRoot,
        [Parameter(Mandatory=$true)][string]$UserSid,
        [Parameter(Mandatory=$true)][byte[]]$ExpectedManifestBytes,
        [Parameter(Mandatory=$true)][string]$ExpectedManifestSha256,
        [switch]$ArchiveOnly,
        [string]$ExpectedSnapshotMetadataSha256
    )
    if ($ArchiveOnly -and $ExpectedSnapshotMetadataSha256 -cnotmatch '^[a-f0-9]{64}$') {
        Stop-TokeneloPayload 'payload_snapshot_external_hash_required'
    }
    $install = if ($ArchiveOnly) {
        Assert-TokeneloPayloadArchiveInstallPath -Path $InstallRoot
    } else {
        Assert-TokeneloPhysicalPath -Path $InstallRoot -MustBeDirectory
    }
    $recoveryParentFull = Assert-TokeneloPhysicalPath -Path $RecoveryParent -MustBeDirectory
    if ((Test-TokeneloPathWithin -Path $install -Parent $recoveryParentFull) -or
        (Test-TokeneloPathWithin -Path $recoveryParentFull -Parent $install)) { Stop-TokeneloPayload 'payload_recovery_overlap_reject' }
    Assert-TokeneloPrivateDirectory -Path $recoveryParentFull -UserSid $UserSid -RequireProtected -RequireChildInheritance
    $validated = Assert-TokeneloRecoveryManifest -ManifestBytes $ExpectedManifestBytes -ManifestSha256 $ExpectedManifestSha256 `
        -InstallRoot $install -UserSid $UserSid -PackageIdentity $PackageIdentity
    $sourceRootState = $null; $sourceInventory = $null
    if (-not $ArchiveOnly) {
        $sourceRootState = Get-TokeneloPayloadFileState -Path $install -ExpectedUserSid $UserSid -AllowDirectory
        $sourceInventory = Get-TokeneloPayloadSourceInventory -InstallRoot $install -ValidatedManifest $validated -UserSid $UserSid
    }
    Assert-TokeneloManifestRoot -RecoveryRoot $RecoveryRoot -RecoveryParent $recoveryParentFull -UserSid $UserSid
    $manifestPath = Join-Path $RecoveryRoot $script:TokeneloPayloadMetadataFile
    $manifestState = Get-TokeneloPayloadFileState -Path $manifestPath -ExpectedUserSid $UserSid -RequirePrivateAcl
    try { $snapshotBytes = [IO.File]::ReadAllBytes($manifestPath) }
    catch { Stop-TokeneloPayload 'payload_snapshot_manifest_reject' }
    $snapshotMetadataSha256 = Get-TokeneloPayloadSha256Bytes -Bytes $snapshotBytes
    if (($ArchiveOnly -or $ExpectedSnapshotMetadataSha256) -and
        ($ExpectedSnapshotMetadataSha256 -cnotmatch '^[a-f0-9]{64}$' -or $snapshotMetadataSha256 -cne $ExpectedSnapshotMetadataSha256)) {
        Stop-TokeneloPayload 'payload_snapshot_external_hash_mismatch'
    }
    try { $snapshotEnvelope = [Text.Encoding]::UTF8.GetString($snapshotBytes) | ConvertFrom-Json -ErrorAction Stop }
    catch { Stop-TokeneloPayload 'payload_snapshot_manifest_reject' }
    $envelopeKeys = @('schemaVersion','payloadBase64','payloadSha256')
    if (@($snapshotEnvelope.PSObject.Properties.Name).Count -ne $envelopeKeys.Count -or
        @($snapshotEnvelope.PSObject.Properties.Name | Where-Object { $envelopeKeys -cnotcontains $_ }).Count -ne 0 -or
        (($snapshotEnvelope.schemaVersion -isnot [int]) -and ($snapshotEnvelope.schemaVersion -isnot [long])) -or
        $snapshotEnvelope.payloadBase64 -isnot [string] -or $snapshotEnvelope.schemaVersion -notin @(1,2) -or
        [string]$snapshotEnvelope.payloadSha256 -cnotmatch '^[a-f0-9]{64}$') {
        Stop-TokeneloPayload 'payload_snapshot_manifest_contract_reject'
    }
    try {
        $payloadBytes = [Convert]::FromBase64String([string]$snapshotEnvelope.payloadBase64)
        $snapshot = [Text.Encoding]::UTF8.GetString($payloadBytes) | ConvertFrom-Json -ErrorAction Stop
    } catch { Stop-TokeneloPayload 'payload_snapshot_manifest_reject' }
    if ((Get-TokeneloPayloadSha256Bytes -Bytes $payloadBytes) -cne [string]$snapshotEnvelope.payloadSha256) {
        Stop-TokeneloPayload 'payload_snapshot_manifest_hash_mismatch'
    }
    $payloadKeys = @('schemaVersion','packageIdentity','installRoot','recoveryRoot','userSid','expectedManifestSha256','callerAssertions','files','directories')
    if ($snapshotEnvelope.schemaVersion -eq 2) { $payloadKeys += 'installRootState' }
    if (@($snapshot.PSObject.Properties.Name).Count -ne $payloadKeys.Count -or
        @($snapshot.PSObject.Properties.Name | Where-Object { $payloadKeys -cnotcontains $_ }).Count -ne 0) {
        Stop-TokeneloPayload 'payload_snapshot_manifest_contract_reject'
    }
    if ((($snapshot.schemaVersion -isnot [int]) -and ($snapshot.schemaVersion -isnot [long])) -or
        $snapshot.schemaVersion -ne $snapshotEnvelope.schemaVersion -or $snapshot.schemaVersion -notin @(1,2)) {
        Stop-TokeneloPayload 'payload_snapshot_schema_reject'
    }
    if ($snapshot.packageIdentity -cne $PackageIdentity) { Stop-TokeneloPayload 'payload_snapshot_package_mismatch' }
    if (-not [string]::Equals([string]$snapshot.installRoot, $install, [StringComparison]::OrdinalIgnoreCase)) {
        Stop-TokeneloPayload 'payload_snapshot_install_root_mismatch'
    }
    if (-not [string]::Equals([string]$snapshot.recoveryRoot, [IO.Path]::GetFullPath($RecoveryRoot), [StringComparison]::OrdinalIgnoreCase)) {
        Stop-TokeneloPayload 'payload_snapshot_recovery_root_mismatch'
    }
    if ($snapshot.userSid -cne $UserSid) { Stop-TokeneloPayload 'payload_snapshot_user_mismatch' }
    if ($snapshot.expectedManifestSha256 -cne $validated.Sha256) { Stop-TokeneloPayload 'payload_snapshot_expected_manifest_mismatch' }
    $rootMetadataRestorable = $snapshot.schemaVersion -eq 2
    if ($rootMetadataRestorable) {
        $rootState = $snapshot.installRootState
        $rootKeys = @('ownerSid','sourceAttributes','sourceAclSddl','sourceAclSha256')
        if ($null -eq $rootState -or @($rootState.PSObject.Properties.Name).Count -ne $rootKeys.Count -or
            @($rootState.PSObject.Properties.Name | Where-Object { $rootKeys -cnotcontains $_ }).Count -ne 0 -or
            $rootState.ownerSid -isnot [string] -or
            (($rootState.sourceAttributes -isnot [int]) -and ($rootState.sourceAttributes -isnot [long])) -or
            $rootState.sourceAclSddl -isnot [string] -or $rootState.sourceAclSha256 -isnot [string]) {
            Stop-TokeneloPayload 'payload_snapshot_root_metadata_reject'
        }
        Assert-TokeneloPayloadSourceAttributes -Attributes ([long]$rootState.sourceAttributes) -Directory
        $rootOwner = Assert-TokeneloPayloadSourceAclMetadata -Sddl ([string]$rootState.sourceAclSddl) `
            -Sha256 ([string]$rootState.sourceAclSha256) -UserSid $UserSid -Directory
        if ($rootState.ownerSid -cne $rootOwner) { Stop-TokeneloPayload 'payload_snapshot_root_metadata_reject' }
        if (-not $ArchiveOnly -and ($sourceRootState.OwnerSid -cne $rootState.ownerSid -or
            $sourceRootState.Attributes -ne [int]$rootState.sourceAttributes -or
            -not (Test-TokeneloPayloadAclsEquivalent -LeftSddl $sourceRootState.AclSddl -RightSddl ([string]$rootState.sourceAclSddl)))) {
            Stop-TokeneloPayload 'payload_snapshot_root_metadata_reject'
        }
    }
    $assertionKeys = @('actorsQuiesced','leaseHeld','leaseName','moduleVerifiedLease')
    if (@($snapshot.callerAssertions.PSObject.Properties.Name).Count -ne $assertionKeys.Count -or
        @($snapshot.callerAssertions.PSObject.Properties.Name | Where-Object { $assertionKeys -cnotcontains $_ }).Count -ne 0) {
        Stop-TokeneloPayload 'payload_snapshot_claims_reject'
    }
    if ($snapshot.callerAssertions.actorsQuiesced -isnot [bool] -or $snapshot.callerAssertions.leaseHeld -isnot [bool] -or
        $snapshot.callerAssertions.moduleVerifiedLease -isnot [bool] -or $snapshot.callerAssertions.actorsQuiesced -ne $true -or
        $snapshot.callerAssertions.leaseHeld -ne $true -or $snapshot.callerAssertions.moduleVerifiedLease -ne $false -or
        $snapshot.callerAssertions.leaseName -isnot [string] -or
        $snapshot.callerAssertions.leaseName -cne ('Global\Tokenelo-ServiceLifecycle-' + $UserSid)) {
        Stop-TokeneloPayload 'payload_snapshot_claims_reject'
    }
    $expectedFiles = @{}; foreach ($entry in $validated.Files) { $expectedFiles[[string]$entry.relativePath] = $entry }
    $currentSourceFiles = @{}
    if (-not $ArchiveOnly) { foreach ($file in $sourceInventory.Files) { $currentSourceFiles[$file.RelativePath] = $file.State } }
    $recordFiles = @($snapshot.files)
    if ($recordFiles.Count -ne $validated.Files.Count) { Stop-TokeneloPayload 'payload_snapshot_fileset_reject' }
    $recordSet = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($record in $recordFiles) {
        $recordKeys = @('relativePath','sizeBytes','sha256','sourceAttributes','sourceAclSddl','sourceAclSha256','backupAttributes','backupAclSha256')
        if (@($record.PSObject.Properties.Name).Count -ne $recordKeys.Count -or
            @($record.PSObject.Properties.Name | Where-Object { $recordKeys -cnotcontains $_ }).Count -ne 0) {
            Stop-TokeneloPayload 'payload_snapshot_metadata_reject'
        }
        $rel = [string]$record.relativePath
        if (-not $recordSet.Add($rel) -or -not $expectedFiles.ContainsKey($rel)) { Stop-TokeneloPayload 'payload_snapshot_fileset_reject' }
        $expected = $expectedFiles[$rel]
        if (-not $ArchiveOnly -and -not $currentSourceFiles.ContainsKey($rel)) { Stop-TokeneloPayload 'payload_snapshot_fileset_reject' }
        Assert-TokeneloPayloadSourceAttributes -Attributes ([long]$record.sourceAttributes)
        $null = Assert-TokeneloPayloadSourceAclMetadata -Sddl ([string]$record.sourceAclSddl) `
            -Sha256 ([string]$record.sourceAclSha256) -UserSid $UserSid
        if ($record.sizeBytes -ne [long]$expected.sizeBytes -or $record.sha256 -cne [string]$expected.sha256 -or
            $record.sourceAttributes -ne [int]$expected.attributes) {
            Stop-TokeneloPayload 'payload_snapshot_metadata_reject'
        }
        if (-not $ArchiveOnly) {
            $currentSource = $currentSourceFiles[$rel]
            if ($record.sourceAttributes -ne $currentSource.Attributes -or
                -not (Test-TokeneloPayloadAclsEquivalent -LeftSddl $currentSource.AclSddl -RightSddl ([string]$record.sourceAclSddl))) {
                Stop-TokeneloPayload 'payload_snapshot_metadata_reject'
            }
        }
        $file = Join-Path $RecoveryRoot ($rel.Replace('/','\'))
        $state = Get-TokeneloPayloadFileState -Path $file -ExpectedUserSid $UserSid -RequirePrivateAcl
        if ($state.SizeBytes -ne [long]$record.sizeBytes -or $state.Sha256 -cne [string]$record.sha256 -or
            $state.Attributes -ne [int]$record.backupAttributes -or $state.AclSha256 -cne [string]$record.backupAclSha256) {
            Stop-TokeneloPayload 'payload_snapshot_file_mismatch'
        }
    }
    $actualFiles = New-Object 'System.Collections.Generic.List[string]'
    $actualDirectories = New-Object 'System.Collections.Generic.List[string]'
    $pending = New-Object 'System.Collections.Generic.Stack[string]'; $pending.Push([IO.Path]::GetFullPath($RecoveryRoot))
    while ($pending.Count -gt 0) {
        $directory = $pending.Pop()
        try { $children = @(Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop) }
        catch { Stop-TokeneloPayload 'payload_snapshot_read_reject' }
        foreach ($child in $children) {
            if (($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Stop-TokeneloPayload 'payload_snapshot_reparse_reject' }
            if ($child.PSIsContainer) {
                if ([string]::Equals($child.FullName, $RecoveryRoot, [StringComparison]::OrdinalIgnoreCase)) { continue }
                $actualDirectories.Add($child.FullName.Substring($RecoveryRoot.Length).TrimStart('\').Replace('\','/'))
                Assert-TokeneloPrivateDirectory -Path $child.FullName -UserSid $UserSid
                $pending.Push($child.FullName)
            } else {
                $actualFiles.Add($child.FullName.Substring($RecoveryRoot.Length).TrimStart('\').Replace('\','/'))
            }
        }
    }
    $recordDirectories = @($snapshot.directories)
    $expectedDirectoryArray = @(Get-TokeneloPayloadExpectedDirectories -Files $validated.Files)
    if ($recordDirectories.Count -ne $expectedDirectoryArray.Count) { Stop-TokeneloPayload 'payload_snapshot_directories_reject' }
    $currentSourceDirectories = @()
    $sourceDirectoryMap = @{}
    if (-not $ArchiveOnly) {
        $currentSourceDirectories = @($sourceInventory.Directories | Sort-Object RelativePath)
        foreach ($directory in $currentSourceDirectories) { $sourceDirectoryMap[$directory.RelativePath] = $directory.State }
    }
    $expectedDirectorySet = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($relative in $expectedDirectoryArray) { $null = $expectedDirectorySet.Add($relative) }
    $recordDirectorySet = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($record in $recordDirectories) {
        $directoryKeys = @('relativePath','sourceAttributes','sourceAclSddl','sourceAclSha256','backupAttributes','backupAclSha256')
        if (@($record.PSObject.Properties.Name).Count -ne $directoryKeys.Count -or
            @($record.PSObject.Properties.Name | Where-Object { $directoryKeys -cnotcontains $_ }).Count -ne 0 -or
            -not $recordDirectorySet.Add([string]$record.relativePath) -or
            -not $expectedDirectorySet.Contains([string]$record.relativePath) -or
            $expectedDirectoryArray -cnotcontains [string]$record.relativePath) {
            Stop-TokeneloPayload 'payload_snapshot_directories_reject'
        }
        Assert-TokeneloPayloadSourceAttributes -Attributes ([long]$record.sourceAttributes) -Directory
        $null = Assert-TokeneloPayloadSourceAclMetadata -Sddl ([string]$record.sourceAclSddl) `
            -Sha256 ([string]$record.sourceAclSha256) -UserSid $UserSid -Directory
        if (-not $ArchiveOnly) {
            if (-not $sourceDirectoryMap.ContainsKey([string]$record.relativePath)) { Stop-TokeneloPayload 'payload_snapshot_directories_reject' }
            $sourceState = $sourceDirectoryMap[[string]$record.relativePath]
            if ($record.sourceAttributes -ne $sourceState.Attributes -or
                -not (Test-TokeneloPayloadAclsEquivalent -LeftSddl $sourceState.AclSddl -RightSddl ([string]$record.sourceAclSddl))) {
                Stop-TokeneloPayload 'payload_snapshot_directories_reject'
            }
        }
        $backupDirectoryPath = Join-Path $RecoveryRoot ([string]$record.relativePath -replace '/', '\')
        $backupDirectoryState = Get-TokeneloPayloadFileState -Path $backupDirectoryPath -ExpectedUserSid $UserSid -AllowDirectory -RequirePrivateAcl
        if ($backupDirectoryState.Attributes -ne [int]$record.backupAttributes -or
            $backupDirectoryState.AclSha256 -cne [string]$record.backupAclSha256) { Stop-TokeneloPayload 'payload_snapshot_directories_reject' }
    }
    if ($recordDirectorySet.Count -ne $expectedDirectorySet.Count -or
        (-not $ArchiveOnly -and $recordDirectorySet.Count -ne $sourceDirectoryMap.Count)) {
        Stop-TokeneloPayload 'payload_snapshot_directories_reject'
    }
    $expectedOutputFiles = @($validated.Files | ForEach-Object { [string]$_.relativePath }) + @($script:TokeneloPayloadMetadataFile)
    $expectedOutputDirs = @(Get-TokeneloPayloadExpectedDirectories -Files $validated.Files)
    if ($actualFiles.Count -ne $expectedOutputFiles.Count -or $actualDirectories.Count -ne $expectedOutputDirs.Count) {
        Stop-TokeneloPayload 'payload_snapshot_unexpected_element'
    }
    foreach ($path in $expectedOutputFiles) { if (@($actualFiles | Where-Object { $_ -ceq $path }).Count -ne 1) { Stop-TokeneloPayload 'payload_snapshot_unexpected_element' } }
    foreach ($path in $expectedOutputDirs) { if (@($actualDirectories | Where-Object { $_ -ceq $path }).Count -ne 1) { Stop-TokeneloPayload 'payload_snapshot_unexpected_element' } }
    return [pscustomobject]@{ Verified = $true; PackageIdentity = $PackageIdentity; FileCount = $validated.Files.Count;
        TotalBytes = [long]$validated.TotalBytes; ManifestSha256 = [string]$snapshotEnvelope.payloadSha256;
        SchemaVersion = [int]$snapshot.schemaVersion; SnapshotMetadataSha256 = $snapshotMetadataSha256;
        RootMetadataRestorable = [bool]$rootMetadataRestorable }
}

function Test-TokeneloPayloadRecoveryArchive {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$RecoveryRoot,
        [Parameter(Mandatory=$true)][string]$RecoveryParent,
        [Parameter(Mandatory=$true)][string]$PackageIdentity,
        [Parameter(Mandatory=$true)][string]$InstallRoot,
        [Parameter(Mandatory=$true)][string]$UserSid,
        [Parameter(Mandatory=$true)][byte[]]$ExpectedManifestBytes,
        [Parameter(Mandatory=$true)][string]$ExpectedManifestSha256,
        [Parameter(Mandatory=$true)][string]$ExpectedSnapshotMetadataSha256
    )
    return Test-TokeneloPayloadRecoverySnapshot -RecoveryRoot $RecoveryRoot -RecoveryParent $RecoveryParent `
        -PackageIdentity $PackageIdentity -InstallRoot $InstallRoot -UserSid $UserSid `
        -ExpectedManifestBytes $ExpectedManifestBytes -ExpectedManifestSha256 $ExpectedManifestSha256 `
        -ArchiveOnly -ExpectedSnapshotMetadataSha256 $ExpectedSnapshotMetadataSha256
}

function New-TokeneloPayloadRecoverySnapshot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$InstallRoot,
        [Parameter(Mandatory=$true)][string]$ExpectedInstallRoot,
        [Parameter(Mandatory=$true)][string]$RecoveryParent,
        [Parameter(Mandatory=$true)][string]$RecoveryRoot,
        [Parameter(Mandatory=$true)][string]$PackageIdentity,
        [Parameter(Mandatory=$true)][string]$UserSid,
        [Parameter(Mandatory=$true)][byte[]]$ExpectedManifestBytes,
        [Parameter(Mandatory=$true)][string]$ExpectedManifestSha256,
        [Parameter(Mandatory=$true)][bool]$CallerActorsQuiesced,
        [Parameter(Mandatory=$true)][bool]$CallerLeaseHeld,
        [Parameter(Mandatory=$true)][string]$CallerLeaseName
    )
    Assert-TokeneloPayloadCallerAssertions -ActorsQuiesced $CallerActorsQuiesced -LeaseHeld $CallerLeaseHeld `
        -LeaseName $CallerLeaseName -UserSid $UserSid
    $install = Assert-TokeneloPhysicalPath -Path $InstallRoot -MustBeDirectory
    $expectedInstall = Assert-TokeneloPhysicalPath -Path $ExpectedInstallRoot -MustBeDirectory
    if (-not [string]::Equals($install, $expectedInstall, [StringComparison]::OrdinalIgnoreCase)) { Stop-TokeneloPayload 'payload_install_root_mismatch' }
    $recoveryParentFull = Assert-TokeneloPhysicalPath -Path $RecoveryParent -MustBeDirectory
    if ((Test-TokeneloPathWithin -Path $install -Parent $recoveryParentFull) -or
        (Test-TokeneloPathWithin -Path $recoveryParentFull -Parent $install)) { Stop-TokeneloPayload 'payload_recovery_overlap_reject' }
    Assert-TokeneloPrivateDirectory -Path $install -UserSid $UserSid
    Assert-TokeneloPrivateDirectory -Path $recoveryParentFull -UserSid $UserSid -RequireProtected -RequireChildInheritance
    $validated = Assert-TokeneloRecoveryManifest -ManifestBytes $ExpectedManifestBytes -ManifestSha256 $ExpectedManifestSha256 `
        -InstallRoot $install -UserSid $UserSid -PackageIdentity $PackageIdentity
    $recoveryFull = [IO.Path]::GetFullPath($RecoveryRoot)
    if (-not [IO.Path]::IsPathRooted($RecoveryRoot) -or -not [string]::Equals($recoveryFull, $RecoveryRoot, [StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals([IO.Path]::GetDirectoryName($recoveryFull), $recoveryParentFull, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($recoveryFull) -cnotmatch '^[a-f0-9]{32}$') { Stop-TokeneloPayload 'payload_recovery_path_reject' }
    if ((Test-TokeneloPathWithin -Path $recoveryFull -Parent $install) -or
        (Test-TokeneloPathWithin -Path $install -Parent $recoveryFull)) {
        Stop-TokeneloPayload 'payload_recovery_overlap_reject'
    }
    if (Test-Path -LiteralPath $recoveryFull) { Stop-TokeneloPayload 'payload_recovery_root_exists' }
    $sourceRootState = Get-TokeneloPayloadFileState -Path $install -ExpectedUserSid $UserSid -AllowDirectory
    $inventory = Get-TokeneloPayloadSourceInventory -InstallRoot $install -ValidatedManifest $validated -UserSid $UserSid
    foreach ($directory in $inventory.Directories) { Assert-TokeneloPhysicalPath -Path $directory.FullPath -MustBeDirectory | Out-Null }
    $drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($recoveryParentFull))
    $requiredBytes = [long]($validated.TotalBytes + 1048576)
    if ($drive.AvailableFreeSpace -lt $requiredBytes) { Stop-TokeneloPayload 'payload_recovery_space_reject' }

    New-TokeneloPrivateDirectory -Path $recoveryFull -UserSid $UserSid -RequireProtectedParent
    $sourceDirectoryRecords = New-Object 'System.Collections.Generic.List[object]'
    foreach ($directory in $inventory.Directories) {
        $sourceDirectoryRecords.Add([pscustomobject]@{ relativePath = $directory.RelativePath; attributes = $directory.State.Attributes;
            aclSddl = $directory.State.AclSddl; aclSha256 = $directory.State.AclSha256 })
        $targetDirectory = Join-Path $recoveryFull ($directory.RelativePath.Replace('/','\'))
        if (Test-Path -LiteralPath $targetDirectory) { Stop-TokeneloPayload 'payload_recovery_output_exists' }
        New-TokeneloPrivateDirectory -Path $targetDirectory -UserSid $UserSid
        $backupDirectory = Get-TokeneloPayloadFileState -Path $targetDirectory -ExpectedUserSid $UserSid -AllowDirectory -RequirePrivateAcl
        $sourceDirectoryRecords[$sourceDirectoryRecords.Count - 1] = [pscustomobject]@{
            relativePath = $directory.RelativePath; sourceAttributes = $directory.State.Attributes
            sourceAclSddl = $directory.State.AclSddl; sourceAclSha256 = $directory.State.AclSha256
            backupAttributes = $backupDirectory.Attributes; backupAclSha256 = $backupDirectory.AclSha256
        }
    }
    $fileRecords = New-Object 'System.Collections.Generic.List[object]'
    foreach ($file in $inventory.Files) {
        $target = Join-Path $recoveryFull ($file.RelativePath.Replace('/','\'))
        $targetParent = [IO.Path]::GetDirectoryName($target)
        if (-not (Test-Path -LiteralPath $targetParent)) { Stop-TokeneloPayload 'payload_recovery_output_parent_missing' }
        if (Test-Path -LiteralPath $target) { Stop-TokeneloPayload 'payload_recovery_output_exists' }
        Copy-TokeneloPayloadFileDurable -Source $file.FullPath -Destination $target
        try { [IO.File]::SetAttributes($target, [IO.FileAttributes]$file.State.Attributes) }
        catch { Stop-TokeneloPayload 'payload_recovery_mode_write_failed' }
        $backupState = Get-TokeneloPayloadFileState -Path $target -ExpectedUserSid $UserSid -RequirePrivateAcl
        $sourceAfter = Get-TokeneloPayloadFileState -Path $file.FullPath -ExpectedUserSid $UserSid
        $expected = $null
        foreach ($candidate in $validated.Files) { if ([string]$candidate.relativePath -ceq $file.RelativePath) { $expected = $candidate; break } }
        if ($null -eq $expected -or $backupState.SizeBytes -ne [long]$expected.sizeBytes -or $backupState.Sha256 -cne [string]$expected.sha256 -or
            $backupState.Attributes -ne [int]$expected.attributes -or $sourceAfter.SizeBytes -ne [long]$expected.sizeBytes -or
            $sourceAfter.Sha256 -cne [string]$expected.sha256 -or $sourceAfter.Attributes -ne [int]$expected.attributes -or
            $sourceAfter.AclSha256 -cne $file.State.AclSha256) {
            Stop-TokeneloPayload 'payload_copy_readback_mismatch'
        }
        $fileRecords.Add([pscustomobject]@{ relativePath = $file.RelativePath; sizeBytes = [long]$expected.sizeBytes; sha256 = [string]$expected.sha256;
            sourceAttributes = [int]$file.State.Attributes; sourceAclSddl = $file.State.AclSddl; sourceAclSha256 = $file.State.AclSha256;
            backupAttributes = [int]$backupState.Attributes; backupAclSha256 = $backupState.AclSha256 })
    }
    $afterInventory = Get-TokeneloPayloadSourceInventory -InstallRoot $install -ValidatedManifest $validated -UserSid $UserSid
    if ($afterInventory.Files.Count -ne $inventory.Files.Count -or $afterInventory.Directories.Count -ne $inventory.Directories.Count) {
        Stop-TokeneloPayload 'payload_source_changed_during_copy'
    }
    for ($index = 0; $index -lt $inventory.Files.Count; $index++) {
        $before = $inventory.Files[$index]
        $after = $afterInventory.Files[$index]
        if ($before.RelativePath -cne $after.RelativePath -or $before.State.Attributes -ne $after.State.Attributes -or
            $before.State.AclSha256 -cne $after.State.AclSha256) { Stop-TokeneloPayload 'payload_source_changed_during_copy' }
    }
    for ($index = 0; $index -lt $inventory.Directories.Count; $index++) {
        $before = $inventory.Directories[$index]
        $after = $afterInventory.Directories[$index]
        if ($before.RelativePath -cne $after.RelativePath -or $before.State.Attributes -ne $after.State.Attributes -or
            $before.State.AclSha256 -cne $after.State.AclSha256) { Stop-TokeneloPayload 'payload_source_changed_during_copy' }
    }
    $sourceRootAfter = Get-TokeneloPayloadFileState -Path $install -ExpectedUserSid $UserSid -AllowDirectory
    if ($sourceRootAfter.OwnerSid -cne $sourceRootState.OwnerSid -or
        $sourceRootAfter.Attributes -ne $sourceRootState.Attributes -or
        $sourceRootAfter.AclSddl -cne $sourceRootState.AclSddl -or
        $sourceRootAfter.AclSha256 -cne $sourceRootState.AclSha256) {
        Stop-TokeneloPayload 'payload_source_root_changed_during_copy'
    }
    Assert-TokeneloPayloadCallerAssertions -ActorsQuiesced $CallerActorsQuiesced -LeaseHeld $CallerLeaseHeld `
        -LeaseName $CallerLeaseName -UserSid $UserSid
    $snapshot = [ordered]@{
        schemaVersion = 2; packageIdentity = $PackageIdentity; installRoot = $install; recoveryRoot = $recoveryFull; userSid = $UserSid
        expectedManifestSha256 = $validated.Sha256; callerAssertions = [ordered]@{ actorsQuiesced = $true; leaseHeld = $true;
            leaseName = $CallerLeaseName; moduleVerifiedLease = $false }
        installRootState = [ordered]@{ ownerSid = $sourceRootState.OwnerSid; sourceAttributes = $sourceRootState.Attributes;
            sourceAclSddl = $sourceRootState.AclSddl; sourceAclSha256 = $sourceRootState.AclSha256 }
        files = @($fileRecords.ToArray()); directories = @($sourceDirectoryRecords.ToArray())
    }
    $payloadBytes = [Text.UTF8Encoding]::new($false).GetBytes(($snapshot | ConvertTo-Json -Depth 10 -Compress))
    $snapshotEnvelope = [ordered]@{ schemaVersion = 2; payloadBase64 = [Convert]::ToBase64String($payloadBytes);
        payloadSha256 = Get-TokeneloPayloadSha256Bytes -Bytes $payloadBytes }
    $snapshotBytes = [Text.UTF8Encoding]::new($false).GetBytes(($snapshotEnvelope | ConvertTo-Json -Depth 4 -Compress))
    $snapshotPath = Join-Path $recoveryFull $script:TokeneloPayloadMetadataFile
    Write-TokeneloPayloadBytesDurable -Path $snapshotPath -Bytes $snapshotBytes
    $readback = [IO.File]::ReadAllBytes($snapshotPath)
    if ((Get-TokeneloPayloadSha256Bytes -Bytes $readback) -cne (Get-TokeneloPayloadSha256Bytes -Bytes $snapshotBytes)) {
        Stop-TokeneloPayload 'payload_metadata_readback_mismatch'
    }
    $snapshotMetadataSha256 = Get-TokeneloPayloadSha256Bytes -Bytes $readback
    $verification = Test-TokeneloPayloadRecoverySnapshot -RecoveryRoot $recoveryFull -RecoveryParent $recoveryParentFull `
        -PackageIdentity $PackageIdentity -InstallRoot $install -UserSid $UserSid -ExpectedManifestBytes $ExpectedManifestBytes `
        -ExpectedManifestSha256 $validated.Sha256 -ExpectedSnapshotMetadataSha256 $snapshotMetadataSha256
    return [pscustomobject]@{ RecoveryRoot = $recoveryFull; SnapshotManifestPath = $snapshotPath;
        SnapshotManifestSha256 = $snapshotMetadataSha256; FileCount = $verification.FileCount;
        TotalBytes = $verification.TotalBytes; SchemaVersion = 2; RootMetadataRestorable = $true;
        CallerQuiesced = $true; CallerLeaseClaimed = $true; LeaseVerifiedByModule = $false }
}

function Assert-TokeneloPayloadRestoreGuard {
    param([Parameter(Mandatory=$true)]$Guard,[Parameter(Mandatory=$true)][string]$UserSid,
        [Parameter(Mandatory=$true)][string]$Boundary,[Parameter(Mandatory=$true)][ref]$InvocationCount)
    $guardKeys=@('schemaVersion','leaseName','userSid','transactionId','actorsQuiesced','validate')
    if($Guard -isnot [pscustomobject] -or @($Guard.PSObject.Properties.Name).Count -ne $guardKeys.Count -or
        @($Guard.PSObject.Properties.Name|Where-Object{$guardKeys -cnotcontains $_}).Count -ne 0 -or
        (($Guard.schemaVersion -isnot [int]) -and ($Guard.schemaVersion -isnot [long])) -or $Guard.schemaVersion -ne 1 -or
        $Guard.leaseName -isnot [string] -or $Guard.userSid -isnot [string] -or
        $Guard.transactionId -isnot [string] -or $Guard.transactionId -cnotmatch '^[a-f0-9]{32}$' -or
        $Guard.actorsQuiesced -isnot [bool] -or $Guard.actorsQuiesced -ne $true -or $Guard.validate -isnot [scriptblock]) {
        Stop-TokeneloPayload 'payload_restore_guard_contract_reject'
    }
    $currentSid=[string][Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if($Guard.userSid -cne $UserSid -or $UserSid -cne $currentSid -or
        $Guard.leaseName -cne ('Global\Tokenelo-ServiceLifecycle-'+$UserSid)) {
        Stop-TokeneloPayload 'payload_restore_guard_identity_reject'
    }
    $InvocationCount.Value=[int]$InvocationCount.Value+1
    $validator=$Guard.validate
    try{$accepted=@(& $validator -Boundary $Boundary -TransactionId $Guard.transactionId -LeaseName $Guard.leaseName -UserSid $Guard.userSid)}
    catch{Stop-TokeneloPayload 'payload_restore_guard_reject'}
    if($accepted.Count -ne 1 -or $accepted[0] -isnot [bool] -or $accepted[0] -ne $true){
        Stop-TokeneloPayload 'payload_restore_guard_reject'
    }
}

function Get-TokeneloPayloadRestoreFailureCode {
    param([Parameter(Mandatory=$true)]$ErrorRecord)
    $exception=$ErrorRecord.Exception
    while($exception){
        if($exception.Data.Contains('TokeneloPayloadCode')){return [string]$exception.Data['TokeneloPayloadCode']}
        $exception=$exception.InnerException
    }
    return 'payload_restore_operation_failed'
}

function Get-TokeneloPayloadAclComparisonKey {
    param([Parameter(Mandatory=$true)][string]$Sddl)
    try{$descriptor=[Security.AccessControl.RawSecurityDescriptor]::new($Sddl)}
    catch{Stop-TokeneloPayload 'payload_restore_acl_readback_mismatch'}
    $normalizeAcl={
        param($Acl)
        if($null -eq $Acl){return '<null>'}
        $groups=New-Object 'System.Collections.Generic.List[object]';$current=$null
        foreach($ace in $Acl){
            $class=([int]$ace.AceType).ToString()+':'+([int]$ace.AceFlags).ToString()
            if($null -eq $current -or $current.Class -cne $class){
                $current=[pscustomobject]@{Class=$class;Entries=(New-Object 'System.Collections.Generic.List[string]')}
                $groups.Add($current)
            }
            $binary=New-Object byte[] $ace.BinaryLength;$ace.GetBinaryForm($binary,0)
            $current.Entries.Add([BitConverter]::ToString($binary).Replace('-',''))
        }
        return (($groups|ForEach-Object{$_.Class+'='+(@($_.Entries.ToArray()|Sort-Object -CaseSensitive) -join ',')}) -join ';')
    }
    $daclKey=& $normalizeAcl $descriptor.DiscretionaryAcl
    $saclKey=& $normalizeAcl $descriptor.SystemAcl
    return [string]::Join('|',@(
        [string][int]$descriptor.ControlFlags,
        $(if($descriptor.Owner){$descriptor.Owner.Value}else{''}),
        $(if($descriptor.Group){$descriptor.Group.Value}else{''}),
        [string]$descriptor.ResourceManagerControl,$daclKey,$saclKey))
}

function Test-TokeneloPayloadAclsEquivalent {
    param([Parameter(Mandatory=$true)][string]$LeftSddl,[Parameter(Mandatory=$true)][string]$RightSddl)
    return (Get-TokeneloPayloadAclComparisonKey -Sddl $LeftSddl) -ceq (Get-TokeneloPayloadAclComparisonKey -Sddl $RightSddl)
}

function Set-TokeneloPayloadRestoreAcl {
    param([string]$Path,[string]$Sddl,[string]$UserSid,[switch]$Directory)
    $acl=ConvertFrom-TokeneloPayloadAclSddl -Sddl $Sddl -Directory:$Directory
    $setAclCommand = Get-TokeneloPayloadNativeSecurityCommand -Name 'Set-Acl'
    try { & $setAclCommand -LiteralPath $Path -AclObject $acl -ErrorAction Stop }
    catch { Stop-TokeneloPayload 'payload_restore_acl_write_failed' }
    $state=Get-TokeneloPayloadFileState -Path $Path -ExpectedUserSid $UserSid -AllowDirectory:$Directory
    if($state.OwnerSid -cne $UserSid -or -not (Test-TokeneloPayloadAclsEquivalent -LeftSddl $state.AclSddl -RightSddl $Sddl)){
        Stop-TokeneloPayload 'payload_restore_acl_readback_mismatch'
    }
}

function Set-TokeneloPayloadRestoreAttributes {
    param([Parameter(Mandatory=$true)][string]$Path,[Parameter(Mandatory=$true)][int]$Attributes)
    try{[IO.File]::SetAttributes($Path,[IO.FileAttributes]$Attributes)}catch{Stop-TokeneloPayload 'payload_restore_attributes_write_failed'}
}

function Move-TokeneloPayloadDirectory {
    param([Parameter(Mandatory=$true)][string]$Source,[Parameter(Mandatory=$true)][string]$Destination)
    try{Assert-TokeneloPhysicalPath -Path $Source -MustBeDirectory|Out-Null}catch{Stop-TokeneloPayload 'payload_restore_move_source_reject'}
    Assert-TokeneloPayloadRestorePathAbsent -Path $Destination
    if(-not [IO.Directory]::Exists($Source)){Stop-TokeneloPayload 'payload_restore_move_path_reject'}
    try{[IO.Directory]::Move($Source,$Destination)}catch{Stop-TokeneloPayload 'payload_restore_move_failed'}
}

function Write-TokeneloPayloadRestorePhase {
    param(
        [Parameter(Mandatory=$true)][string]$TransactionRoot,[Parameter(Mandatory=$true)][int]$Sequence,
        [Parameter(Mandatory=$true)][string]$Phase,[Parameter(Mandatory=$true)][string]$OperationId,
        [Parameter(Mandatory=$true)][string]$PackageIdentity,[Parameter(Mandatory=$true)][string]$UserSid,
        [Parameter(Mandatory=$true)][string]$InstallRoot,[Parameter(Mandatory=$true)][string]$RecoveryRoot,
        [Parameter(Mandatory=$true)][string]$StageRoot,[Parameter(Mandatory=$true)][string]$RetainedCurrentRoot,
        [Parameter(Mandatory=$true)][string]$ManifestSha256,[Parameter(Mandatory=$true)][string]$SnapshotMetadataSha256,
        [Parameter(Mandatory=$true)][int]$FileCount,[Parameter(Mandatory=$true)][long]$TotalBytes,
        [Parameter(Mandatory=$true)][bool]$PriorInstallRootPresent,[Parameter(Mandatory=$true)]$Guard,
        [Parameter(Mandatory=$true)][ref]$GuardInvocationCount,[string]$FailureCode
    )
    $path=Join-Path $TransactionRoot ('restore-phase-{0:D4}.json' -f $Sequence)
    Assert-TokeneloPayloadRestorePathAbsent -Path $path
    $status=if($Phase -eq 'restore-complete'){'restored'}elseif($Phase -eq 'failed-retained'){'failedRetained'}
        elseif($Phase -eq 'manual-recovery-required'){'manualRecoveryRequired'}else{'inProgress'}
    $record=[ordered]@{
        schemaVersion=1;recordType='TokeneloPayloadRestorePhase';sequence=$Sequence;operation='payload-restore';operationId=$OperationId
        phase=$Phase;status=$status;packageIdentity=$PackageIdentity;userSid=$UserSid
        installRoot=$InstallRoot;recoveryRoot=$RecoveryRoot;transactionRoot=$TransactionRoot
        stageRoot=$StageRoot;retainedCurrentRoot=$RetainedCurrentRoot
        manifestSha256=$ManifestSha256;snapshotMetadataSha256=$SnapshotMetadataSha256
        fileCount=$FileCount;totalBytes=$TotalBytes;priorInstallRootPresent=$PriorInstallRootPresent
        leaseName=$Guard.leaseName;callerActorsQuiescedAssertion=$true
        leaseIndependentlyVerifiedByModule=$false;actorsIndependentlyVerifiedByModule=$false;recoveryArchiveMutated=$false
        failureCode=$FailureCode;recordedAtUtc=[DateTime]::UtcNow.ToString('o',[Globalization.CultureInfo]::InvariantCulture)
    }
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($record|ConvertTo-Json -Depth 6 -Compress))
    Assert-TokeneloPayloadRestoreGuard -Guard $Guard -UserSid $UserSid -Boundary ("journal:${Phase}:$Sequence") `
        -InvocationCount $GuardInvocationCount
    Write-TokeneloPayloadBytesDurable -Path $path -Bytes $bytes
    $readback=[IO.File]::ReadAllBytes($path);$expectedSha=Get-TokeneloPayloadSha256Bytes -Bytes $bytes
    if((Get-TokeneloPayloadSha256Bytes -Bytes $readback) -cne $expectedSha){Stop-TokeneloPayload 'payload_restore_journal_readback_mismatch'}
    $state=Get-TokeneloPayloadFileState -Path $path -ExpectedUserSid $UserSid -RequirePrivateAcl
    if($state.SizeBytes -ne $bytes.Length -or $state.Sha256 -cne $expectedSha){Stop-TokeneloPayload 'payload_restore_journal_state_mismatch'}
    return [pscustomobject]@{Path=$path;Sequence=$Sequence;Phase=$Phase;Sha256=$expectedSha}
}

function Get-TokeneloPayloadRestoreTreeInventory {
    param([Parameter(Mandatory=$true)][string]$TreeRoot,[Parameter(Mandatory=$true)]$ValidatedManifest,
        [Parameter(Mandatory=$true)]$Snapshot,[Parameter(Mandatory=$true)][string]$UserSid,[switch]$AllowPartial)
    $root=Assert-TokeneloPhysicalPath -Path $TreeRoot -MustBeDirectory
    $rootState=Get-TokeneloPayloadFileState -Path $root -ExpectedUserSid $UserSid -AllowDirectory
    $savedRoot=$Snapshot.installRootState
    if($rootState.OwnerSid -cne [string]$savedRoot.ownerSid -or $rootState.Attributes -ne [int]$savedRoot.sourceAttributes -or
        -not (Test-TokeneloPayloadAclsEquivalent -LeftSddl $rootState.AclSddl -RightSddl ([string]$savedRoot.sourceAclSddl))){
        Stop-TokeneloPayload 'payload_restore_root_state_mismatch'
    }
    $expectedFiles=@{};foreach($entry in $ValidatedManifest.Files){$expectedFiles[[string]$entry.relativePath]=$entry}
    $savedFiles=@{};foreach($entry in @($Snapshot.files)){$savedFiles[[string]$entry.relativePath]=$entry}
    $expectedDirectories=@(Get-TokeneloPayloadExpectedDirectories -Files $ValidatedManifest.Files)
    $expectedDirectorySet=New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach($relative in $expectedDirectories){$null=$expectedDirectorySet.Add([string]$relative)}
    $savedDirectories=@{};foreach($entry in @($Snapshot.directories)){$savedDirectories[[string]$entry.relativePath]=$entry}
    $files=New-Object 'System.Collections.Generic.List[object]';$directories=New-Object 'System.Collections.Generic.List[object]'
    $fileSet=New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    $directorySet=New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    $pending=New-Object 'System.Collections.Generic.Stack[string]';$pending.Push($root)
    while($pending.Count -gt 0){
        $directory=$pending.Pop();try{$children=@(Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop)}catch{Stop-TokeneloPayload 'payload_restore_tree_read_reject'}
        foreach($child in $children){
            if(($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){Stop-TokeneloPayload 'payload_restore_reparse_reject'}
            $relative=$child.FullName.Substring($root.Length).TrimStart('\').Replace('\','/')
            Assert-TokeneloSafePayloadPath -RelativePath $relative
            if($child.PSIsContainer){
                if(-not $directorySet.Add($relative) -or -not $expectedDirectorySet.Contains($relative) -or
                    $expectedDirectories -cnotcontains $relative -or -not $savedDirectories.ContainsKey($relative)){
                    Stop-TokeneloPayload 'payload_restore_unexpected_current_directory'
                }
                $state=Get-TokeneloPayloadFileState -Path $child.FullName -ExpectedUserSid $UserSid -AllowDirectory
                $saved=$savedDirectories[$relative]
                if($state.Attributes -ne [int]$saved.sourceAttributes -or
                    -not (Test-TokeneloPayloadAclsEquivalent -LeftSddl $state.AclSddl -RightSddl ([string]$saved.sourceAclSddl))){
                    Stop-TokeneloPayload 'payload_restore_current_directory_mismatch'
                }
                $directories.Add([pscustomobject]@{RelativePath=$relative;FullPath=$child.FullName;State=$state});$pending.Push($child.FullName)
            }else{
                if(-not $fileSet.Add($relative) -or -not $expectedFiles.ContainsKey($relative) -or
                    -not [string]::Equals($relative,[string]$expectedFiles[$relative].relativePath,[StringComparison]::Ordinal) -or
                    -not $savedFiles.ContainsKey($relative)){Stop-TokeneloPayload 'payload_restore_unexpected_current_file'}
                $state=Get-TokeneloPayloadFileState -Path $child.FullName -ExpectedUserSid $UserSid
                $expected=$expectedFiles[$relative];$saved=$savedFiles[$relative]
                if($state.SizeBytes -ne [long]$expected.sizeBytes -or $state.Sha256 -cne [string]$expected.sha256 -or
                    $state.Attributes -ne [int]$expected.attributes -or $state.SizeBytes -ne [long]$saved.sizeBytes -or
                    $state.Sha256 -cne [string]$saved.sha256 -or $state.Attributes -ne [int]$saved.sourceAttributes -or
                    -not (Test-TokeneloPayloadAclsEquivalent -LeftSddl $state.AclSddl -RightSddl ([string]$saved.sourceAclSddl))){
                    Stop-TokeneloPayload 'payload_restore_current_file_mismatch'
                }
                $files.Add([pscustomobject]@{RelativePath=$relative;FullPath=$child.FullName;State=$state})
            }
        }
    }
    if(-not $AllowPartial -and ($files.Count -ne $ValidatedManifest.Files.Count -or $directories.Count -ne $expectedDirectories.Count)){
        Stop-TokeneloPayload 'payload_restore_tree_fileset_mismatch'
    }
    return [pscustomobject]@{Present=$true;RootPath=$root;RootState=$rootState;
        Files=@($files.ToArray()|Sort-Object RelativePath);Directories=@($directories.ToArray()|Sort-Object RelativePath)}
}

function Get-TokeneloPayloadRestoreCurrentInventory {
    param([string]$InstallRoot,$ValidatedManifest,$Snapshot,[string]$UserSid)
    $full=Assert-TokeneloPayloadArchiveInstallPath -Path $InstallRoot
    if(-not [IO.Directory]::Exists($full)){return [pscustomobject]@{Present=$false;RootPath=$full;RootState=$null;Files=@();Directories=@()}}
    return Get-TokeneloPayloadRestoreTreeInventory -TreeRoot $full -ValidatedManifest $ValidatedManifest `
        -Snapshot $Snapshot -UserSid $UserSid -AllowPartial
}

function Assert-TokeneloPayloadRestoreInventoriesEqual {
    param($Expected,$Actual)
    if([bool]$Expected.Present -ne [bool]$Actual.Present){Stop-TokeneloPayload 'payload_restore_current_tree_changed'}
    if(-not $Expected.Present){return}
    $before=$Expected.RootState;$after=$Actual.RootState
    if($before.OwnerSid -cne $after.OwnerSid -or $before.Attributes -ne $after.Attributes -or
        $before.AclSha256 -cne $after.AclSha256){Stop-TokeneloPayload 'payload_restore_current_tree_changed'}
    foreach($kind in @('Files','Directories')){
        $beforeItems=@($Expected.$kind);$afterItems=@($Actual.$kind)
        if($beforeItems.Count -ne $afterItems.Count){Stop-TokeneloPayload 'payload_restore_current_tree_changed'}
        $afterMap=@{};foreach($item in $afterItems){$afterMap[[string]$item.RelativePath]=$item}
        foreach($item in $beforeItems){
            if(-not $afterMap.ContainsKey([string]$item.RelativePath)){Stop-TokeneloPayload 'payload_restore_current_tree_changed'}
            $other=$afterMap[[string]$item.RelativePath];$a=$item.State;$b=$other.State
            $changed=$item.RelativePath -cne $other.RelativePath -or $a.OwnerSid -cne $b.OwnerSid -or
                $a.Attributes -ne $b.Attributes -or $a.AclSddl -cne $b.AclSddl -or $a.AclSha256 -cne $b.AclSha256
            if($kind -eq 'Files'){$changed=$changed -or $a.SizeBytes -ne $b.SizeBytes -or $a.Sha256 -cne $b.Sha256}
            if($changed){
                Stop-TokeneloPayload 'payload_restore_current_tree_changed'
            }
        }
    }
}

function New-TokeneloPayloadRestoreResult {
    param([string]$Status,[string]$Phase,[string]$OperationId,[string]$PackageIdentity,[string]$UserSid,
        [string]$InstallRoot,[string]$RecoveryRoot,[string]$TransactionRoot,[string]$StageRoot,[string]$RetainedCurrentRoot,
        [string]$ManifestSha256,[string]$SnapshotMetadataSha256,[int]$FileCount,[long]$TotalBytes,
        [bool]$PriorInstallRootPresent,[bool]$PriorInstallRootRestored,[string[]]$JournalPaths,
        [int]$GuardInvocationCount,[string]$FailureCode,[bool]$JournalComplete)
    return [pscustomobject]@{
        schemaVersion=1;operation='payload-restore';status=$Status;phase=$Phase;operationId=$OperationId
        packageIdentity=$PackageIdentity;userSid=$UserSid;installRoot=$InstallRoot;recoveryRoot=$RecoveryRoot
        transactionRoot=$TransactionRoot;stageRoot=$StageRoot;retainedCurrentRoot=$RetainedCurrentRoot
        manifestSha256=$ManifestSha256;snapshotMetadataSha256=$SnapshotMetadataSha256
        fileCount=$FileCount;totalBytes=$TotalBytes;priorInstallRootPresent=$PriorInstallRootPresent
        priorInstallRootRestored=$PriorInstallRootRestored;journalPaths=@($JournalPaths)
        callerGuardInvocations=$GuardInvocationCount;initialGuardAccepted=$true
        leaseVerifiedByModule=$false;quiescenceVerifiedByModule=$false;recoveryArchiveMutated=$false
        retentionPolicy='retain-all';failureCode=$FailureCode;journalComplete=$JournalComplete
    }
}

function Restore-TokeneloPayloadRecoverySnapshot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$InstallRoot,
        [Parameter(Mandatory=$true)][string]$ExpectedInstallRoot,
        [Parameter(Mandatory=$true)][string]$RecoveryParent,
        [Parameter(Mandatory=$true)][string]$RecoveryRoot,
        [Parameter(Mandatory=$true)][string]$PackageIdentity,
        [Parameter(Mandatory=$true)][string]$UserSid,
        [Parameter(Mandatory=$true)][byte[]]$ExpectedManifestBytes,
        [Parameter(Mandatory=$true)][string]$ExpectedManifestSha256,
        [Parameter(Mandatory=$true)][string]$ExpectedSnapshotMetadataSha256,
        [Parameter(Mandatory=$true)]$LifecycleGuard
    )
    $guardInvocationCount=0
    $install=Assert-TokeneloPayloadArchiveInstallPath -Path $InstallRoot
    $expectedInstall=Assert-TokeneloPayloadArchiveInstallPath -Path $ExpectedInstallRoot
    if(-not [string]::Equals($install,$expectedInstall,[StringComparison]::OrdinalIgnoreCase)){
        Stop-TokeneloPayload 'payload_install_root_mismatch'
    }
    $installParent=Assert-TokeneloPhysicalPath -Path ([IO.Path]::GetDirectoryName($install)) -MustBeDirectory
    $recoveryParentFull=Assert-TokeneloPhysicalPath -Path $RecoveryParent -MustBeDirectory
    if((Test-TokeneloPathWithin -Path $install -Parent $recoveryParentFull) -or
        (Test-TokeneloPathWithin -Path $recoveryParentFull -Parent $install) -or
        (Test-TokeneloPathWithin -Path $installParent -Parent $recoveryParentFull) -or
        (Test-TokeneloPathWithin -Path $recoveryParentFull -Parent $installParent)){
        Stop-TokeneloPayload 'payload_restore_overlap_reject'
    }
    Assert-TokeneloPayloadRestoreGuard -Guard $LifecycleGuard -UserSid $UserSid -Boundary 'preflight' `
        -InvocationCount ([ref]$guardInvocationCount)
    $archive=Test-TokeneloPayloadRecoveryArchive -RecoveryRoot $RecoveryRoot -RecoveryParent $recoveryParentFull `
        -PackageIdentity $PackageIdentity -InstallRoot $install -UserSid $UserSid `
        -ExpectedManifestBytes $ExpectedManifestBytes -ExpectedManifestSha256 $ExpectedManifestSha256 `
        -ExpectedSnapshotMetadataSha256 $ExpectedSnapshotMetadataSha256
    if($archive.SchemaVersion -ne 2 -or -not $archive.RootMetadataRestorable){Stop-TokeneloPayload 'payload_restore_v2_required'}
    $validated=Assert-TokeneloRecoveryManifest -ManifestBytes $ExpectedManifestBytes -ManifestSha256 $ExpectedManifestSha256 `
        -InstallRoot $install -UserSid $UserSid -PackageIdentity $PackageIdentity
    try{$metadataBytes=[IO.File]::ReadAllBytes((Join-Path $RecoveryRoot $script:TokeneloPayloadMetadataFile))}
    catch{Stop-TokeneloPayload 'payload_restore_metadata_read_reject'}
    if((Get-TokeneloPayloadSha256Bytes -Bytes $metadataBytes) -cne $ExpectedSnapshotMetadataSha256){
        Stop-TokeneloPayload 'payload_snapshot_external_hash_mismatch'
    }
    try{
        $envelope=[Text.Encoding]::UTF8.GetString($metadataBytes)|ConvertFrom-Json -ErrorAction Stop
        $payloadBytes=[Convert]::FromBase64String([string]$envelope.payloadBase64)
        $snapshot=[Text.Encoding]::UTF8.GetString($payloadBytes)|ConvertFrom-Json -ErrorAction Stop
    }catch{Stop-TokeneloPayload 'payload_restore_metadata_read_reject'}
    if($envelope.schemaVersion -ne 2 -or $snapshot.schemaVersion -ne 2 -or
        (Get-TokeneloPayloadSha256Bytes -Bytes $payloadBytes) -cne [string]$envelope.payloadSha256 -or
        $snapshot.packageIdentity -cne $PackageIdentity -or $snapshot.userSid -cne $UserSid -or
        $snapshot.expectedManifestSha256 -cne $validated.Sha256 -or
        -not [string]::Equals([string]$snapshot.installRoot,$install,[StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals([string]$snapshot.recoveryRoot,[IO.Path]::GetFullPath($RecoveryRoot),[StringComparison]::OrdinalIgnoreCase)){
        Stop-TokeneloPayload 'payload_restore_metadata_identity_reject'
    }
    $initialInventory=Get-TokeneloPayloadRestoreCurrentInventory -InstallRoot $install -ValidatedManifest $validated `
        -Snapshot $snapshot -UserSid $UserSid
    $requiredBytes=[long]($validated.TotalBytes + 1048576)
    $drive=[IO.DriveInfo]::new([IO.Path]::GetPathRoot($installParent))
    if($drive.DriveType -ne [IO.DriveType]::Fixed -or $drive.AvailableFreeSpace -lt $requiredBytes){
        Stop-TokeneloPayload 'payload_restore_space_or_volume_reject'
    }

    $operationId=[string]$LifecycleGuard.transactionId
    $transactionRoot=Join-Path $installParent ('TokeneloPayloadRestore-'+$operationId)
    if((Test-TokeneloPathWithin -Path $transactionRoot -Parent $RecoveryRoot) -or
        (Test-TokeneloPathWithin -Path $RecoveryRoot -Parent $transactionRoot) -or
        (Test-TokeneloPathWithin -Path $transactionRoot -Parent $recoveryParentFull) -or
        (Test-TokeneloPathWithin -Path $recoveryParentFull -Parent $transactionRoot)){
        Stop-TokeneloPayload 'payload_restore_overlap_reject'
    }
    $stageRoot=Join-Path $transactionRoot 'generation'
    $retainedCurrentRoot=Join-Path $transactionRoot 'retained-current'
    $journalPaths=New-Object 'System.Collections.Generic.List[string]'
    $sequence=0;$transactionRootCreated=$false;$stagePublished=$false
    $journalComplete=$true;$phase='preflight-complete';$failureCode=$null
    $priorPresent=[bool]$initialInventory.Present
    $journalArguments=@{
        TransactionRoot=$transactionRoot;OperationId=$operationId;PackageIdentity=$PackageIdentity;UserSid=$UserSid
        InstallRoot=$install;RecoveryRoot=$RecoveryRoot;StageRoot=$stageRoot;RetainedCurrentRoot=$retainedCurrentRoot
        ManifestSha256=$validated.Sha256;SnapshotMetadataSha256=$ExpectedSnapshotMetadataSha256
        FileCount=$validated.Files.Count;TotalBytes=[long]$validated.TotalBytes;PriorInstallRootPresent=$priorPresent
        Guard=$LifecycleGuard;GuardInvocationCount=([ref]$guardInvocationCount)
    }
    try{
        Assert-TokeneloPayloadRestoreGuard -Guard $LifecycleGuard -UserSid $UserSid -Boundary 'create-transaction-root' `
            -InvocationCount ([ref]$guardInvocationCount)
        New-TokeneloPrivateDirectory -Path $transactionRoot -UserSid $UserSid
        $transactionRootCreated=$true;$phase='transaction-root-created'
        $entry=Write-TokeneloPayloadRestorePhase @journalArguments -Sequence (++$sequence) -Phase $phase
        $journalPaths.Add($entry.Path)

        Assert-TokeneloPayloadRestoreGuard -Guard $LifecycleGuard -UserSid $UserSid -Boundary 'create-stage-root' `
            -InvocationCount ([ref]$guardInvocationCount)
        New-TokeneloPrivateDirectory -Path $stageRoot -UserSid $UserSid
        $phase='stage-root-created'
        $entry=Write-TokeneloPayloadRestorePhase @journalArguments -Sequence (++$sequence) -Phase $phase
        $journalPaths.Add($entry.Path)

        $expectedDirectories=@(Get-TokeneloPayloadExpectedDirectories -Files $validated.Files |
            Sort-Object @{Expression={([string]$_).Split('/').Count}},@{Expression={$_}})
        foreach($relative in $expectedDirectories){
            $directoryPath=Join-Path $stageRoot ([string]$relative -replace '/','\')
            Assert-TokeneloPayloadRestorePathAbsent -Path $directoryPath
            Assert-TokeneloPayloadRestoreGuard -Guard $LifecycleGuard -UserSid $UserSid `
                -Boundary ('create-stage-directory:'+$relative) -InvocationCount ([ref]$guardInvocationCount)
            New-TokeneloPrivateDirectory -Path $directoryPath -UserSid $UserSid
        }
        $phase='stage-directories-created'
        $entry=Write-TokeneloPayloadRestorePhase @journalArguments -Sequence (++$sequence) -Phase $phase
        $journalPaths.Add($entry.Path)

        foreach($record in @($snapshot.files|Sort-Object relativePath)){
            $relative=[string]$record.relativePath
            $source=Join-Path $RecoveryRoot ($relative -replace '/','\')
            $destination=Join-Path $stageRoot ($relative -replace '/','\')
            Assert-TokeneloPayloadRestorePathAbsent -Path $destination
            Assert-TokeneloPayloadRestoreGuard -Guard $LifecycleGuard -UserSid $UserSid `
                -Boundary ('copy-stage-file:'+$relative) -InvocationCount ([ref]$guardInvocationCount)
            Copy-TokeneloPayloadFileDurable -Source $source -Destination $destination
        }
        $null=Get-TokeneloPayloadSourceInventory -InstallRoot $stageRoot -ValidatedManifest $validated -UserSid $UserSid
        $phase='stage-bytes-copied'
        $entry=Write-TokeneloPayloadRestorePhase @journalArguments -Sequence (++$sequence) -Phase $phase
        $journalPaths.Add($entry.Path)

        Assert-TokeneloPayloadRestoreGuard -Guard $LifecycleGuard -UserSid $UserSid -Boundary 'apply-stage-root-acl' `
            -InvocationCount ([ref]$guardInvocationCount)
        Set-TokeneloPayloadRestoreAcl -Path $stageRoot -Sddl ([string]$snapshot.installRootState.sourceAclSddl) -UserSid $UserSid -Directory
        $directoryRecords=@($snapshot.directories|Sort-Object @{Expression={([string]$_.relativePath).Split('/').Count}},@{Expression={$_.relativePath}})
        foreach($record in $directoryRecords){
            $relative=[string]$record.relativePath;$path=Join-Path $stageRoot ($relative -replace '/','\')
            Assert-TokeneloPayloadRestoreGuard -Guard $LifecycleGuard -UserSid $UserSid `
                -Boundary ('apply-stage-directory-acl:'+$relative) -InvocationCount ([ref]$guardInvocationCount)
            Set-TokeneloPayloadRestoreAcl -Path $path -Sddl ([string]$record.sourceAclSddl) -UserSid $UserSid -Directory
        }
        foreach($record in @($snapshot.files|Sort-Object relativePath)){
            $relative=[string]$record.relativePath;$path=Join-Path $stageRoot ($relative -replace '/','\')
            Assert-TokeneloPayloadRestoreGuard -Guard $LifecycleGuard -UserSid $UserSid `
                -Boundary ('apply-stage-file-acl:'+$relative) -InvocationCount ([ref]$guardInvocationCount)
            Set-TokeneloPayloadRestoreAcl -Path $path -Sddl ([string]$record.sourceAclSddl) -UserSid $UserSid
        }
        foreach($record in @($snapshot.files|Sort-Object relativePath)){
            $relative=[string]$record.relativePath;$path=Join-Path $stageRoot ($relative -replace '/','\')
            Assert-TokeneloPayloadRestoreGuard -Guard $LifecycleGuard -UserSid $UserSid `
                -Boundary ('apply-stage-file-attributes:'+$relative) -InvocationCount ([ref]$guardInvocationCount)
            Set-TokeneloPayloadRestoreAttributes -Path $path -Attributes ([int]$record.sourceAttributes)
        }
        foreach($record in @($directoryRecords|Sort-Object @{Expression={([string]$_.relativePath).Split('/').Count};Descending=$true},@{Expression={$_.relativePath}})){
            $relative=[string]$record.relativePath;$path=Join-Path $stageRoot ($relative -replace '/','\')
            Assert-TokeneloPayloadRestoreGuard -Guard $LifecycleGuard -UserSid $UserSid `
                -Boundary ('apply-stage-directory-attributes:'+$relative) -InvocationCount ([ref]$guardInvocationCount)
            Set-TokeneloPayloadRestoreAttributes -Path $path -Attributes ([int]$record.sourceAttributes)
        }
        Assert-TokeneloPayloadRestoreGuard -Guard $LifecycleGuard -UserSid $UserSid -Boundary 'apply-stage-root-attributes' `
            -InvocationCount ([ref]$guardInvocationCount)
        Set-TokeneloPayloadRestoreAttributes -Path $stageRoot -Attributes ([int]$snapshot.installRootState.sourceAttributes)
        $stageInventory=Get-TokeneloPayloadRestoreTreeInventory -TreeRoot $stageRoot -ValidatedManifest $validated -Snapshot $snapshot -UserSid $UserSid
        $phase='stage-verified'
        $entry=Write-TokeneloPayloadRestorePhase @journalArguments -Sequence (++$sequence) -Phase $phase
        $journalPaths.Add($entry.Path)

        $archiveRecheck=Test-TokeneloPayloadRecoveryArchive -RecoveryRoot $RecoveryRoot -RecoveryParent $recoveryParentFull `
            -PackageIdentity $PackageIdentity -InstallRoot $install -UserSid $UserSid `
            -ExpectedManifestBytes $ExpectedManifestBytes -ExpectedManifestSha256 $validated.Sha256 `
            -ExpectedSnapshotMetadataSha256 $ExpectedSnapshotMetadataSha256
        if($archiveRecheck.SchemaVersion -ne 2 -or -not $archiveRecheck.RootMetadataRestorable){Stop-TokeneloPayload 'payload_restore_archive_changed'}
        $currentNow=Get-TokeneloPayloadRestoreCurrentInventory -InstallRoot $install -ValidatedManifest $validated -Snapshot $snapshot -UserSid $UserSid
        Assert-TokeneloPayloadRestoreInventoriesEqual -Expected $initialInventory -Actual $currentNow
        if($initialInventory.Present){
            Assert-TokeneloPayloadRestorePathAbsent -Path $retainedCurrentRoot
            $phase='retain-current-requested'
            $entry=Write-TokeneloPayloadRestorePhase @journalArguments -Sequence (++$sequence) -Phase $phase
            $journalPaths.Add($entry.Path)
            Assert-TokeneloPayloadRestoreGuard -Guard $LifecycleGuard -UserSid $UserSid -Boundary 'retain-current-root' `
                -InvocationCount ([ref]$guardInvocationCount)
            Move-TokeneloPayloadDirectory -Source $install -Destination $retainedCurrentRoot
            $currentRootMoved=$true
            $retainedInventory=Get-TokeneloPayloadRestoreTreeInventory -TreeRoot $retainedCurrentRoot `
                -ValidatedManifest $validated -Snapshot $snapshot -UserSid $UserSid -AllowPartial
            Assert-TokeneloPayloadRestoreInventoriesEqual -Expected $initialInventory -Actual $retainedInventory
            $phase='current-root-retained'
            $entry=Write-TokeneloPayloadRestorePhase @journalArguments -Sequence (++$sequence) -Phase $phase
            $journalPaths.Add($entry.Path)
        }else{
            $phase='current-root-absent'
            $entry=Write-TokeneloPayloadRestorePhase @journalArguments -Sequence (++$sequence) -Phase $phase
            $journalPaths.Add($entry.Path)
        }

        Assert-TokeneloPayloadRestorePathAbsent -Path $install
        $phase='publish-stage-requested'
        $entry=Write-TokeneloPayloadRestorePhase @journalArguments -Sequence (++$sequence) -Phase $phase
        $journalPaths.Add($entry.Path)
        Assert-TokeneloPayloadRestoreGuard -Guard $LifecycleGuard -UserSid $UserSid -Boundary 'publish-stage' `
            -InvocationCount ([ref]$guardInvocationCount)
        $archiveBeforePublish=Test-TokeneloPayloadRecoveryArchive -RecoveryRoot $RecoveryRoot -RecoveryParent $recoveryParentFull `
            -PackageIdentity $PackageIdentity -InstallRoot $install -UserSid $UserSid `
            -ExpectedManifestBytes $ExpectedManifestBytes -ExpectedManifestSha256 $validated.Sha256 `
            -ExpectedSnapshotMetadataSha256 $ExpectedSnapshotMetadataSha256
        if($archiveBeforePublish.SchemaVersion -ne 2 -or -not $archiveBeforePublish.RootMetadataRestorable){
            Stop-TokeneloPayload 'payload_restore_archive_changed'
        }
        $stageBeforePublish=Get-TokeneloPayloadRestoreTreeInventory -TreeRoot $stageRoot -ValidatedManifest $validated `
            -Snapshot $snapshot -UserSid $UserSid
        Assert-TokeneloPayloadRestoreInventoriesEqual -Expected $stageInventory -Actual $stageBeforePublish
        Assert-TokeneloPayloadRestoreGuard -Guard $LifecycleGuard -UserSid $UserSid -Boundary 'publish-stage-immediate' `
            -InvocationCount ([ref]$guardInvocationCount)
        Move-TokeneloPayloadDirectory -Source $stageRoot -Destination $install
        $stagePublished=$true
        $finalInventory=Get-TokeneloPayloadRestoreTreeInventory -TreeRoot $install -ValidatedManifest $validated -Snapshot $snapshot -UserSid $UserSid
        Assert-TokeneloPayloadRestoreInventoriesEqual -Expected $stageInventory -Actual $finalInventory
        $phase='restore-complete'
        $entry=Write-TokeneloPayloadRestorePhase @journalArguments -Sequence (++$sequence) -Phase $phase
        $journalPaths.Add($entry.Path)
        return New-TokeneloPayloadRestoreResult -Status 'restored' -Phase $phase -OperationId $operationId `
            -PackageIdentity $PackageIdentity -UserSid $UserSid -InstallRoot $install -RecoveryRoot $RecoveryRoot `
            -TransactionRoot $transactionRoot -StageRoot $stageRoot `
            -RetainedCurrentRoot $(if(Test-TokeneloPayloadRestorePathExists -Path $retainedCurrentRoot){$retainedCurrentRoot}else{$null}) `
            -ManifestSha256 $validated.Sha256 -SnapshotMetadataSha256 $ExpectedSnapshotMetadataSha256 `
            -FileCount $validated.Files.Count -TotalBytes $validated.TotalBytes -PriorInstallRootPresent $priorPresent `
            -PriorInstallRootRestored $false -JournalPaths @($journalPaths.ToArray()) `
            -GuardInvocationCount $guardInvocationCount -FailureCode $null -JournalComplete $true
    }catch{
        if(-not $transactionRootCreated){throw}
        $failureCode=Get-TokeneloPayloadRestoreFailureCode -ErrorRecord $_
        $priorRootRestored=$false;$status='failedRetained';$journalComplete=$true
        try{$phase='operation-failed';$entry=Write-TokeneloPayloadRestorePhase @journalArguments -Sequence (++$sequence) `
                -Phase $phase -FailureCode $failureCode;$journalPaths.Add($entry.Path)}catch{$journalComplete=$false}
        $installExists=Test-TokeneloPayloadRestorePathExists -Path $install
        $retainedExists=Test-TokeneloPayloadRestorePathExists -Path $retainedCurrentRoot
        $stageExists=Test-TokeneloPayloadRestorePathExists -Path $stageRoot
        if($stagePublished -or ($retainedExists -and $installExists) -or (-not $stageExists -and $installExists)){
            $status='manualRecoveryRequired'
        }elseif($retainedExists -and $priorPresent -and -not $installExists -and $journalComplete -and $stageExists){
            try{
                $retainedInventory=Get-TokeneloPayloadRestoreTreeInventory -TreeRoot $retainedCurrentRoot `
                    -ValidatedManifest $validated -Snapshot $snapshot -UserSid $UserSid -AllowPartial
                Assert-TokeneloPayloadRestoreInventoriesEqual -Expected $initialInventory -Actual $retainedInventory
                $null=Get-TokeneloPayloadRestoreTreeInventory -TreeRoot $stageRoot -ValidatedManifest $validated -Snapshot $snapshot -UserSid $UserSid
                Assert-TokeneloPayloadRestorePathAbsent -Path $install
                $phase='rename-back-requested'
                $entry=Write-TokeneloPayloadRestorePhase @journalArguments -Sequence (++$sequence) -Phase $phase -FailureCode $failureCode
                $journalPaths.Add($entry.Path)
                Assert-TokeneloPayloadRestoreGuard -Guard $LifecycleGuard -UserSid $UserSid -Boundary 'rename-back-retained-current' `
                    -InvocationCount ([ref]$guardInvocationCount)
                Assert-TokeneloPayloadRestorePathAbsent -Path $install
                Move-TokeneloPayloadDirectory -Source $retainedCurrentRoot -Destination $install
                $restoredInventory=Get-TokeneloPayloadRestoreTreeInventory -TreeRoot $install -ValidatedManifest $validated `
                    -Snapshot $snapshot -UserSid $UserSid -AllowPartial
                Assert-TokeneloPayloadRestoreInventoriesEqual -Expected $initialInventory -Actual $restoredInventory
                $priorRootRestored=$true;$phase='rename-back-complete'
                $entry=Write-TokeneloPayloadRestorePhase @journalArguments -Sequence (++$sequence) -Phase $phase -FailureCode $failureCode
                $journalPaths.Add($entry.Path)
            }catch{$status='manualRecoveryRequired'}
        }elseif($priorPresent -and $installExists -and -not $retainedExists){
            try{
                $atInstall=Get-TokeneloPayloadRestoreTreeInventory -TreeRoot $install -ValidatedManifest $validated `
                    -Snapshot $snapshot -UserSid $UserSid -AllowPartial
                Assert-TokeneloPayloadRestoreInventoriesEqual -Expected $initialInventory -Actual $atInstall
                $priorRootRestored=$true
            }catch{$status='manualRecoveryRequired'}
        }elseif(-not $priorPresent -and $installExists){$status='manualRecoveryRequired'}
        if(-not $journalComplete){$status='manualRecoveryRequired'}
        $finalPhase=if($status -eq 'manualRecoveryRequired'){'manual-recovery-required'}else{'failed-retained'}
        try{$entry=Write-TokeneloPayloadRestorePhase @journalArguments -Sequence (++$sequence) -Phase $finalPhase `
                -FailureCode $failureCode;$journalPaths.Add($entry.Path)}catch{$journalComplete=$false;$status='manualRecoveryRequired';$finalPhase='manual-recovery-required'}
        return New-TokeneloPayloadRestoreResult -Status $status -Phase $finalPhase -OperationId $operationId `
            -PackageIdentity $PackageIdentity -UserSid $UserSid -InstallRoot $install -RecoveryRoot $RecoveryRoot `
            -TransactionRoot $transactionRoot -StageRoot $stageRoot `
            -RetainedCurrentRoot $(if(Test-TokeneloPayloadRestorePathExists -Path $retainedCurrentRoot){$retainedCurrentRoot}else{$null}) `
            -ManifestSha256 $validated.Sha256 -SnapshotMetadataSha256 $ExpectedSnapshotMetadataSha256 `
            -FileCount $validated.Files.Count -TotalBytes $validated.TotalBytes -PriorInstallRootPresent $priorPresent `
            -PriorInstallRootRestored $priorRootRestored -JournalPaths @($journalPaths.ToArray()) `
            -GuardInvocationCount $guardInvocationCount -FailureCode $failureCode -JournalComplete $journalComplete
    }
}

function New-TokeneloPayloadExpectedManifestFile {
    param([Parameter(Mandatory=$true)][string]$InstallRoot,[Parameter(Mandatory=$true)][string]$RelativePath,
        [Parameter(Mandatory=$true)][long]$ExpectedSizeBytes,[Parameter(Mandatory=$true)][string]$ExpectedSha256,
        [Parameter(Mandatory=$true)][string]$UserSid)
    Assert-TokeneloSafePayloadPath -RelativePath $RelativePath
    if ($ExpectedSizeBytes -lt 0 -or $ExpectedSha256 -cnotmatch '^[a-f0-9]{64}$') {
        Stop-TokeneloPayload 'payload_template_file_contract_reject'
    }
    $path = Join-Path $InstallRoot ($RelativePath.Replace('/','\'))
    $fullPath = Assert-TokeneloPhysicalPath -Path $path
    $before = Get-TokeneloPayloadFileState -Path $fullPath -ExpectedUserSid $UserSid
    if ($before.SizeBytes -ne $ExpectedSizeBytes -or $before.Sha256 -cne $ExpectedSha256) {
        Stop-TokeneloPayload 'payload_template_file_mismatch'
    }
    # Only bind live Windows attributes/ACL after the trusted content identity matched. Read and
    # compare the state again so a metadata or byte change during assembly fails closed.
    $after = Get-TokeneloPayloadFileState -Path $fullPath -ExpectedUserSid $UserSid
    if ($after.SizeBytes -ne $ExpectedSizeBytes -or $after.Sha256 -cne $ExpectedSha256 -or
        $after.Attributes -ne $before.Attributes -or $after.OwnerSid -cne $before.OwnerSid -or
        $after.AclSddl -cne $before.AclSddl -or $after.AclSha256 -cne $before.AclSha256) {
        Stop-TokeneloPayload 'payload_template_file_changed_during_validation'
    }
    return [ordered]@{ relativePath = $RelativePath; sizeBytes = $ExpectedSizeBytes;
        sha256 = $ExpectedSha256; attributes = [int]$after.Attributes }
}

function New-TokeneloPayloadManifestFromTemplate {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$InstallRoot,
        [Parameter(Mandatory=$true)][string]$ExpectedInstallRoot,
        [Parameter(Mandatory=$true)][string]$PackageIdentity,
        [Parameter(Mandatory=$true)][string]$UserSid,
        [Parameter(Mandatory=$true)][string]$CompiledTemplateSha256,
        [Parameter(Mandatory=$true)][byte[]]$TrustedInventoryBytes,
        [Parameter(Mandatory=$true)][string]$TrustedInventorySha256,
        [Parameter(Mandatory=$true)]$UninstallerBindingReceipt,
        [Parameter(Mandatory=$true)]$LifecycleGuard
    )

    $guardInvocationCount = 0
    $install = Assert-TokeneloPhysicalPath -Path $InstallRoot -MustBeDirectory
    $expectedInstall = Assert-TokeneloPhysicalPath -Path $ExpectedInstallRoot -MustBeDirectory
    if (-not [string]::Equals($install, $expectedInstall, [StringComparison]::OrdinalIgnoreCase)) {
        Stop-TokeneloPayload 'payload_install_root_mismatch'
    }
    $currentSid = [string][Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if ($PackageIdentity -cne $script:TokeneloPayloadPackageIdentity -or $UserSid -cne $currentSid) {
        Stop-TokeneloPayload 'payload_manifest_identity_reject'
    }
    Assert-TokeneloPayloadRestoreGuard -Guard $LifecycleGuard -UserSid $UserSid -Boundary 'manifest-preflight' `
        -InvocationCount ([ref]$guardInvocationCount)
    # The caller's strict guard is the only source of lease, actor-quiescence, and process-birth
    # liveness proof. This read-only factory never acquires a lease or queries/signals a process.

    if ($CompiledTemplateSha256 -cnotmatch '^[a-f0-9]{64}$' -or
        $TrustedInventorySha256 -cnotmatch '^[a-f0-9]{64}$' -or
        $null -eq $TrustedInventoryBytes -or $TrustedInventoryBytes.Length -eq 0 -or
        $TrustedInventoryBytes.Length -gt 4194304) {
        Stop-TokeneloPayload 'payload_template_pin_contract_reject'
    }

    $inventorySha256 = Get-TokeneloPayloadSha256Bytes -Bytes $TrustedInventoryBytes
    if ($inventorySha256 -cne $TrustedInventorySha256) { Stop-TokeneloPayload 'payload_inventory_hash_mismatch' }
    try {
        $inventoryText = [Text.UTF8Encoding]::new($false, $true).GetString($TrustedInventoryBytes)
        $inventoryBytesReadback = [Text.UTF8Encoding]::new($false).GetBytes($inventoryText)
    } catch { Stop-TokeneloPayload 'payload_inventory_encoding_reject' }
    if ($TrustedInventoryBytes.Length -ne $inventoryBytesReadback.Length -or
        (Get-TokeneloPayloadSha256Bytes -Bytes $TrustedInventoryBytes) -cne
        (Get-TokeneloPayloadSha256Bytes -Bytes $inventoryBytesReadback) -or
        ($inventoryText.Length -gt 0 -and $inventoryText[0] -eq [char]0xFEFF)) { Stop-TokeneloPayload 'payload_inventory_encoding_reject' }
    try { $inventory = $inventoryText | ConvertFrom-Json -ErrorAction Stop }
    catch { Stop-TokeneloPayload 'payload_inventory_json_reject' }
    $inventoryKeys = @('schemaVersion','kind','packageIdentity','applicationPackageName','files')
    if ($inventory -isnot [pscustomobject] -or @($inventory.PSObject.Properties.Name).Count -ne $inventoryKeys.Count -or
        @($inventory.PSObject.Properties.Name | Where-Object { $inventoryKeys -cnotcontains $_ }).Count -ne 0 -or
        (($inventory.schemaVersion -isnot [int]) -and ($inventory.schemaVersion -isnot [long])) -or
        $inventory.schemaVersion -ne 1 -or $inventory.kind -isnot [string] -or
        $inventory.packageIdentity -isnot [string] -or $inventory.applicationPackageName -isnot [string] -or
        $inventory.files -isnot [array] -or $inventory.files.Count -eq 0) {
        Stop-TokeneloPayload 'payload_inventory_contract_reject'
    }
    if ($inventory.kind -cne $script:TokeneloPayloadInventoryKind -or
        $inventory.packageIdentity -cne $PackageIdentity -or
        $inventory.applicationPackageName -cne $script:TokeneloPayloadApplicationPackageName) {
        Stop-TokeneloPayload 'payload_inventory_identity_reject'
    }
    $inventoryFiles = [Collections.Generic.List[string]]::new()
    $inventorySeen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($relative in $inventory.files) {
        if ($relative -isnot [string] -or -not $relative -or $relative.Contains('\') -or
            $relative.Contains(':') -or $relative.StartsWith('/') -or $relative.EndsWith('/')) {
            Stop-TokeneloPayload 'payload_inventory_path_reject'
        }
        Assert-TokeneloSafePayloadPath -RelativePath $relative
        $segments = @($relative.Split('/'))
        foreach ($segment in $segments) {
            if (-not $segment -or $segment -in @('.','..') -or $segment.EndsWith('.') -or $segment.EndsWith(' ') -or
                $segment.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0) {
                Stop-TokeneloPayload 'payload_inventory_path_reject'
            }
        }
        if ($relative -ieq $script:TokeneloPayloadTemplateRelativePath -or
            $relative -ieq $script:TokeneloPayloadUninstallerExe -or -not $inventorySeen.Add($relative)) {
            Stop-TokeneloPayload 'payload_inventory_path_collision'
        }
        $inventoryFiles.Add($relative)
    }
    $sortedInventoryFiles = [string[]]$inventoryFiles.ToArray()
    [Array]::Sort($sortedInventoryFiles, [StringComparer]::Ordinal)
    for ($index = 0; $index -lt $sortedInventoryFiles.Length; $index++) {
        if ($sortedInventoryFiles[$index] -cne $inventoryFiles[$index]) {
            Stop-TokeneloPayload 'payload_inventory_order_reject'
        }
    }
    $canonicalInventory = [ordered]@{
        schemaVersion = 1; kind = $script:TokeneloPayloadInventoryKind; packageIdentity = $PackageIdentity
        applicationPackageName = $script:TokeneloPayloadApplicationPackageName; files = @($inventoryFiles.ToArray())
    }
    $canonicalInventoryBytes = [Text.UTF8Encoding]::new($false).GetBytes((($canonicalInventory | ConvertTo-Json -Depth 4 -Compress) + "`n"))
    if ((Get-TokeneloPayloadSha256Bytes -Bytes $canonicalInventoryBytes) -cne $TrustedInventorySha256) {
        Stop-TokeneloPayload 'payload_inventory_canonical_encoding_reject'
    }

    $templatePath = Join-Path $install ($script:TokeneloPayloadTemplateRelativePath.Replace('/','\'))
    $templateFullPath = Assert-TokeneloPhysicalPath -Path $templatePath
    try { $templateItem = Get-Item -LiteralPath $templateFullPath -Force -ErrorAction Stop }
    catch { Stop-TokeneloPayload 'payload_template_read_reject' }
    if ($templateItem.Length -lt 0 -or $templateItem.Length -gt 16777216) { Stop-TokeneloPayload 'payload_template_size_reject' }
    $templateStateBefore = Get-TokeneloPayloadFileState -Path $templateFullPath -ExpectedUserSid $UserSid
    try { $templateBytes = [IO.File]::ReadAllBytes($templateFullPath) }
    catch { Stop-TokeneloPayload 'payload_template_read_reject' }
    if ((Get-TokeneloPayloadSha256Bytes -Bytes $templateBytes) -cne $CompiledTemplateSha256 -or
        $templateStateBefore.SizeBytes -ne $templateBytes.Length -or
        $templateStateBefore.Sha256 -cne $CompiledTemplateSha256) {
        Stop-TokeneloPayload 'payload_template_pin_mismatch'
    }
    try {
        $templateText = [Text.UTF8Encoding]::new($false, $true).GetString($templateBytes)
        $templateBytesReadback = [Text.UTF8Encoding]::new($false).GetBytes($templateText)
    } catch { Stop-TokeneloPayload 'payload_template_encoding_reject' }
    if ($templateBytes.Length -ne $templateBytesReadback.Length -or
        (Get-TokeneloPayloadSha256Bytes -Bytes $templateBytes) -cne (Get-TokeneloPayloadSha256Bytes -Bytes $templateBytesReadback) -or
        ($templateText.Length -gt 0 -and $templateText[0] -eq [char]0xFEFF)) { Stop-TokeneloPayload 'payload_template_encoding_reject' }
    try { $template = $templateText | ConvertFrom-Json -ErrorAction Stop }
    catch { Stop-TokeneloPayload 'payload_template_json_reject' }

    $templateKeys = @('schemaVersion','kind','manifestScope','packageIdentity','fullInstallRoot','fullRootReady',
        'restoreInputAllowed','trustedExpectedFileSetSha256','expectedFileSetProvenance','applicationExe',
        'applicationPackagePath','generatedUninstallerPath','templateRelativePath','files','runtimeBindingContract')
    if ($template -isnot [pscustomobject] -or @($template.PSObject.Properties.Name).Count -ne $templateKeys.Count -or
        @($template.PSObject.Properties.Name | Where-Object { $templateKeys -cnotcontains $_ }).Count -ne 0 -or
        (($template.schemaVersion -isnot [int]) -and ($template.schemaVersion -isnot [long])) -or
        $template.schemaVersion -ne 1 -or $template.files -isnot [array]) {
        Stop-TokeneloPayload 'payload_template_contract_reject'
    }
    foreach ($key in @('kind','manifestScope','packageIdentity','trustedExpectedFileSetSha256','expectedFileSetProvenance',
        'applicationExe','applicationPackagePath','generatedUninstallerPath','templateRelativePath')) {
        if ($template.$key -isnot [string]) { Stop-TokeneloPayload 'payload_template_contract_reject' }
    }
    foreach ($key in @('fullInstallRoot','fullRootReady','restoreInputAllowed')) {
        if ($template.$key -isnot [bool] -or $template.$key -ne $false) { Stop-TokeneloPayload 'payload_template_restore_scope_reject' }
    }
    if ($template.kind -cne $script:TokeneloPayloadTemplateKind -or $template.manifestScope -cne 'unpacked-install-template' -or
        $template.packageIdentity -cne $PackageIdentity -or
        $template.trustedExpectedFileSetSha256 -cne $TrustedInventorySha256 -or
        $template.expectedFileSetProvenance -cne 'caller-supplied; this producer does not authenticate its origin' -or
        $template.applicationExe -cne $script:TokeneloPayloadApplicationExe -or
        $template.applicationPackagePath -cne $script:TokeneloPayloadApplicationPackagePath -or
        $template.generatedUninstallerPath -cne $script:TokeneloPayloadUninstallerExe -or
        $template.templateRelativePath -cne $script:TokeneloPayloadTemplateRelativePath -or
        $template.files.Count -ne $inventoryFiles.Count) {
        Stop-TokeneloPayload 'payload_template_identity_reject'
    }

    $bindingKeys = @('templateSelfIncluded','generatedUninstallerIncluded','compiledNsisMustPinTemplateSha256',
        'runtimeAssemblerMustAddTemplateAndVerifiedUninstaller','runtimeAssemblerMustVerifyEveryFileSizeAndSha256',
        'windowsFileAttributesOwnerAndAcl','windowsReparsePoints','ntfsAlternateStreams',
        'pathBasedChecksDoNotProveHostileConcurrentWriterSafety','signedPackageOrPackageAuthenticityAttested')
    $binding = $template.runtimeBindingContract
    if ($binding -isnot [pscustomobject] -or @($binding.PSObject.Properties.Name).Count -ne $bindingKeys.Count -or
        @($binding.PSObject.Properties.Name | Where-Object { $bindingKeys -cnotcontains $_ }).Count -ne 0 -or
        $binding.templateSelfIncluded -isnot [bool] -or $binding.templateSelfIncluded -ne $false -or
        $binding.generatedUninstallerIncluded -isnot [bool] -or $binding.generatedUninstallerIncluded -ne $false -or
        $binding.compiledNsisMustPinTemplateSha256 -isnot [bool] -or $binding.compiledNsisMustPinTemplateSha256 -ne $true -or
        $binding.runtimeAssemblerMustAddTemplateAndVerifiedUninstaller -isnot [bool] -or $binding.runtimeAssemblerMustAddTemplateAndVerifiedUninstaller -ne $true -or
        $binding.runtimeAssemblerMustVerifyEveryFileSizeAndSha256 -isnot [bool] -or $binding.runtimeAssemblerMustVerifyEveryFileSizeAndSha256 -ne $true -or
        $binding.windowsFileAttributesOwnerAndAcl -isnot [string] -or $binding.windowsFileAttributesOwnerAndAcl -cne 'runtime-bound-after-content-match' -or
        $binding.windowsReparsePoints -isnot [string] -or $binding.windowsReparsePoints -cne 'must-be-rejected-by-windows-runtime-assembler' -or
        $binding.ntfsAlternateStreams -isnot [string] -or $binding.ntfsAlternateStreams -cne 'must-be-rejected-by-windows-runtime-assembler' -or
        $binding.pathBasedChecksDoNotProveHostileConcurrentWriterSafety -isnot [bool] -or
        $binding.pathBasedChecksDoNotProveHostileConcurrentWriterSafety -ne $true -or
        $binding.signedPackageOrPackageAuthenticityAttested -isnot [bool] -or
        $binding.signedPackageOrPackageAuthenticityAttested -ne $false) {
        Stop-TokeneloPayload 'payload_template_binding_contract_reject'
    }

    $templateFileEntries = [Collections.Generic.List[object]]::new()
    for ($index = 0; $index -lt $template.files.Count; $index++) {
        $entry = $template.files[$index]
        $entryKeys = @('relativePath','sizeBytes','sha256')
        if ($entry -isnot [pscustomobject] -or @($entry.PSObject.Properties.Name).Count -ne $entryKeys.Count -or
            @($entry.PSObject.Properties.Name | Where-Object { $entryKeys -cnotcontains $_ }).Count -ne 0 -or
            $entry.relativePath -isnot [string] -or (($entry.sizeBytes -isnot [int]) -and ($entry.sizeBytes -isnot [long])) -or
            [long]$entry.sizeBytes -lt 0 -or $entry.sha256 -isnot [string] -or $entry.sha256 -cnotmatch '^[a-f0-9]{64}$') {
            Stop-TokeneloPayload 'payload_template_file_contract_reject'
        }
        if ([string]$entry.relativePath -cne $inventoryFiles[$index]) { Stop-TokeneloPayload 'payload_template_inventory_path_mismatch' }
        $templateFileEntries.Add($entry)
    }
    if ($inventoryFiles -cnotcontains $script:TokeneloPayloadApplicationPackagePath -or
        $inventoryFiles -cnotcontains $script:TokeneloPayloadApplicationMainPath) {
        Stop-TokeneloPayload 'payload_template_application_entry_missing'
    }
    $packageTemplateEntry = @($templateFileEntries | Where-Object { $_.relativePath -ceq $script:TokeneloPayloadApplicationPackagePath })
    if ($packageTemplateEntry.Count -ne 1) { Stop-TokeneloPayload 'payload_template_application_entry_missing' }
    $packageFile = New-TokeneloPayloadExpectedManifestFile -InstallRoot $install `
        -RelativePath $script:TokeneloPayloadApplicationPackagePath -ExpectedSizeBytes ([long]$packageTemplateEntry[0].sizeBytes) `
        -ExpectedSha256 ([string]$packageTemplateEntry[0].sha256) -UserSid $UserSid
    $packagePath = Join-Path $install ($script:TokeneloPayloadApplicationPackagePath.Replace('/','\'))
    try {
        $packageBytes = [IO.File]::ReadAllBytes($packagePath)
        $packageJson = [Text.UTF8Encoding]::new($false, $true).GetString($packageBytes) | ConvertFrom-Json -ErrorAction Stop
    } catch { Stop-TokeneloPayload 'payload_template_package_json_reject' }
    if ($packageBytes.Length -ne [long]$packageTemplateEntry[0].sizeBytes -or
        (Get-TokeneloPayloadSha256Bytes -Bytes $packageBytes) -cne [string]$packageTemplateEntry[0].sha256 -or
        $packageJson -isnot [pscustomobject] -or $packageJson.name -isnot [string] -or
        $packageJson.name -cne $script:TokeneloPayloadApplicationPackageName -or
        $packageJson.private -isnot [bool] -or $packageJson.private -ne $true -or
        $packageJson.type -isnot [string] -or $packageJson.type -cne 'module' -or
        $packageJson.main -isnot [string] -or $packageJson.main -cne 'dist/tray/main.js') {
        Stop-TokeneloPayload 'payload_template_package_identity_reject'
    }
    $packageFileAfter = Get-TokeneloPayloadFileState -Path $packagePath -ExpectedUserSid $UserSid
    if ($packageFileAfter.SizeBytes -ne [long]$packageTemplateEntry[0].sizeBytes -or
        $packageFileAfter.Sha256 -cne [string]$packageTemplateEntry[0].sha256 -or
        $packageFileAfter.Attributes -ne [int]$packageFile.attributes -or
        $packageFileAfter.OwnerSid -cne $UserSid) {
        Stop-TokeneloPayload 'payload_template_package_changed_during_validation'
    }
    Assert-TokeneloPayloadRestoreGuard -Guard $LifecycleGuard -UserSid $UserSid -Boundary 'manifest-template-validated' `
        -InvocationCount ([ref]$guardInvocationCount)

    $receiptKeys = @('schemaVersion','kind','packageIdentity','installRoot','userSid','leaseName','transactionId',
        'executionMode','uninstallerRelativePath','installedSizeBytes','installedSha256','runningImagePath',
        'runningImageSizeBytes','runningImageSha256','coordinatorProcessId','coordinatorProcessStartUtcTicks')
    $receipt = $UninstallerBindingReceipt
    if ($receipt -isnot [pscustomobject] -or @($receipt.PSObject.Properties.Name).Count -ne $receiptKeys.Count -or
        @($receipt.PSObject.Properties.Name | Where-Object { $receiptKeys -cnotcontains $_ }).Count -ne 0 -or
        (($receipt.schemaVersion -isnot [int]) -and ($receipt.schemaVersion -isnot [long])) -or $receipt.schemaVersion -ne 1) {
        Stop-TokeneloPayload 'payload_uninstaller_receipt_contract_reject'
    }
    foreach ($key in @('kind','packageIdentity','installRoot','userSid','leaseName','transactionId','executionMode',
        'uninstallerRelativePath','installedSha256','runningImagePath','runningImageSha256','coordinatorProcessStartUtcTicks')) {
        if ($receipt.$key -isnot [string]) { Stop-TokeneloPayload 'payload_uninstaller_receipt_contract_reject' }
    }
    foreach ($key in @('installedSizeBytes','runningImageSizeBytes','coordinatorProcessId')) {
        if (($receipt.$key -isnot [int]) -and ($receipt.$key -isnot [long])) { Stop-TokeneloPayload 'payload_uninstaller_receipt_contract_reject' }
    }
    $coordinatorStartTicks = [long]0
    if ($receipt.kind -cne 'tokenelo-windows-uninstaller-binding' -or
        $receipt.packageIdentity -cne $PackageIdentity -or
        -not [string]::Equals([string]$receipt.installRoot, $install, [StringComparison]::OrdinalIgnoreCase) -or
        $receipt.userSid -cne $UserSid -or
        $receipt.leaseName -cne $LifecycleGuard.leaseName -or
        $receipt.transactionId -cne $LifecycleGuard.transactionId -or
        $receipt.uninstallerRelativePath -cne $script:TokeneloPayloadUninstallerExe -or
        $receipt.executionMode -cnotin @('installed-image','byte-matching-temp-clone') -or
        $receipt.installedSizeBytes -lt 0 -or $receipt.runningImageSizeBytes -lt 0 -or
        $receipt.coordinatorProcessId -le 0 -or
        $receipt.installedSha256 -cnotmatch '^[a-f0-9]{64}$' -or
        $receipt.runningImageSha256 -cnotmatch '^[a-f0-9]{64}$' -or
        $receipt.installedSha256 -cne $receipt.runningImageSha256 -or
        $receipt.installedSizeBytes -ne $receipt.runningImageSizeBytes -or
        $receipt.coordinatorProcessStartUtcTicks -cnotmatch '^(0|[1-9][0-9]*)$' -or
        -not [long]::TryParse([string]$receipt.coordinatorProcessStartUtcTicks, [Globalization.NumberStyles]::None,
            [Globalization.CultureInfo]::InvariantCulture, [ref]$coordinatorStartTicks) -or
        $coordinatorStartTicks -le 0 -or $coordinatorStartTicks -gt [DateTime]::MaxValue.Ticks) {
        Stop-TokeneloPayload 'payload_uninstaller_receipt_identity_reject'
    }
    if ($receipt.executionMode -ceq 'installed-image' -and
        -not [string]::Equals([string]$receipt.runningImagePath,
            (Join-Path $install $script:TokeneloPayloadUninstallerExe), [StringComparison]::OrdinalIgnoreCase)) {
        Stop-TokeneloPayload 'payload_uninstaller_receipt_path_reject'
    }
    $installedUninstallerPath = Join-Path $install $script:TokeneloPayloadUninstallerExe
    $installedUninstaller = New-TokeneloPayloadExpectedManifestFile -InstallRoot $install `
        -RelativePath $script:TokeneloPayloadUninstallerExe -ExpectedSizeBytes ([long]$receipt.installedSizeBytes) `
        -ExpectedSha256 ([string]$receipt.installedSha256) -UserSid $UserSid
    $runningImageFullPath = Assert-TokeneloPhysicalPath -Path ([string]$receipt.runningImagePath)
    if ($receipt.executionMode -ceq 'byte-matching-temp-clone' -and
        ((Test-TokeneloPathWithin -Path $runningImageFullPath -Parent $install) -or
        (Test-TokeneloPathWithin -Path $install -Parent $runningImageFullPath))) {
        Stop-TokeneloPayload 'payload_uninstaller_receipt_path_reject'
    }
    $runningImageState = Get-TokeneloPayloadFileState -Path $runningImageFullPath -ExpectedUserSid $UserSid
    if ($runningImageState.SizeBytes -ne [long]$receipt.runningImageSizeBytes -or
        $runningImageState.Sha256 -cne [string]$receipt.runningImageSha256) {
        Stop-TokeneloPayload 'payload_uninstaller_runtime_image_mismatch'
    }
    if ($receipt.executionMode -ceq 'installed-image' -and
        -not [string]::Equals($runningImageFullPath, $installedUninstallerPath, [StringComparison]::OrdinalIgnoreCase)) {
        Stop-TokeneloPayload 'payload_uninstaller_receipt_path_reject'
    }
    $manifestFiles = [Collections.Generic.List[object]]::new()
    foreach ($entry in $templateFileEntries) {
        $manifestFiles.Add((New-TokeneloPayloadExpectedManifestFile -InstallRoot $install `
            -RelativePath ([string]$entry.relativePath) -ExpectedSizeBytes ([long]$entry.sizeBytes) `
            -ExpectedSha256 ([string]$entry.sha256) -UserSid $UserSid))
    }
    $templateSelf = New-TokeneloPayloadExpectedManifestFile -InstallRoot $install `
        -RelativePath $script:TokeneloPayloadTemplateRelativePath -ExpectedSizeBytes ([long]$templateBytes.Length) `
        -ExpectedSha256 $CompiledTemplateSha256 -UserSid $UserSid
    $manifestFiles.Add($templateSelf)
    $manifestFiles.Add($installedUninstaller)
    $manifestFileArray = @($manifestFiles.ToArray())
    $manifest = [ordered]@{
        schemaVersion = 2; manifestScope = 'full-install-root'; packageIdentity = $PackageIdentity
        installRoot = $install; userSid = $UserSid; applicationExe = $script:TokeneloPayloadApplicationExe
        uninstallerExe = $script:TokeneloPayloadUninstallerExe; resourcesRoot = $script:TokeneloPayloadResourcesRoot
        files = $manifestFileArray
    }
    $manifestBytes = [Text.UTF8Encoding]::new($false).GetBytes(($manifest | ConvertTo-Json -Depth 8 -Compress))
    $manifestSha256 = Get-TokeneloPayloadSha256Bytes -Bytes $manifestBytes
    $validated = Assert-TokeneloRecoveryManifest -ManifestBytes $manifestBytes -ManifestSha256 $manifestSha256 `
        -InstallRoot $install -UserSid $UserSid -PackageIdentity $PackageIdentity

    Assert-TokeneloPayloadRestoreGuard -Guard $LifecycleGuard -UserSid $UserSid -Boundary 'manifest-before-full-root-scan' `
        -InvocationCount ([ref]$guardInvocationCount)
    $rootStateBefore = Get-TokeneloPayloadFileState -Path $install -ExpectedUserSid $UserSid -AllowDirectory
    $sourceInventory = Get-TokeneloPayloadSourceInventory -InstallRoot $install -ValidatedManifest $validated -UserSid $UserSid
    if ($sourceInventory.Files.Count -ne $validated.Files.Count) { Stop-TokeneloPayload 'payload_manifest_source_fileset_mismatch' }
    $rootStateAfter = Get-TokeneloPayloadFileState -Path $install -ExpectedUserSid $UserSid -AllowDirectory
    if ($rootStateAfter.OwnerSid -cne $rootStateBefore.OwnerSid -or
        $rootStateAfter.Attributes -ne $rootStateBefore.Attributes -or
        $rootStateAfter.AclSddl -cne $rootStateBefore.AclSddl -or
        $rootStateAfter.AclSha256 -cne $rootStateBefore.AclSha256) {
        Stop-TokeneloPayload 'payload_manifest_source_root_changed'
    }
    $templateStateAfter = Get-TokeneloPayloadFileState -Path $templateFullPath -ExpectedUserSid $UserSid
    if ($templateStateAfter.SizeBytes -ne $templateStateBefore.SizeBytes -or
        $templateStateAfter.Sha256 -cne $templateStateBefore.Sha256 -or
        $templateStateAfter.Attributes -ne $templateStateBefore.Attributes -or
        $templateStateAfter.OwnerSid -cne $templateStateBefore.OwnerSid -or
        $templateStateAfter.AclSddl -cne $templateStateBefore.AclSddl -or
        $templateStateAfter.AclSha256 -cne $templateStateBefore.AclSha256) {
        Stop-TokeneloPayload 'payload_template_changed_during_validation'
    }
    $runningImageStateAfter = Get-TokeneloPayloadFileState -Path $runningImageFullPath -ExpectedUserSid $UserSid
    if ($runningImageStateAfter.SizeBytes -ne [long]$receipt.runningImageSizeBytes -or
        $runningImageStateAfter.Sha256 -cne [string]$receipt.runningImageSha256 -or
        $runningImageStateAfter.Attributes -ne $runningImageState.Attributes -or
        $runningImageStateAfter.OwnerSid -cne $runningImageState.OwnerSid -or
        $runningImageStateAfter.AclSddl -cne $runningImageState.AclSddl -or
        $runningImageStateAfter.AclSha256 -cne $runningImageState.AclSha256) {
        Stop-TokeneloPayload 'payload_uninstaller_runtime_image_changed'
    }
    Assert-TokeneloPayloadRestoreGuard -Guard $LifecycleGuard -UserSid $UserSid -Boundary 'manifest-before-return' `
        -InvocationCount ([ref]$guardInvocationCount)
    return [pscustomobject]@{
        ExpectedManifestBytes = $manifestBytes; ExpectedManifestSha256 = $manifestSha256
        FileCount = $validated.Files.Count; TotalBytes = [long]$validated.TotalBytes
        TemplateSha256 = $CompiledTemplateSha256; TrustedInventorySha256 = $TrustedInventorySha256
        UninstallerSha256 = [string]$receipt.installedSha256; LifecycleGuardInvocations = $guardInvocationCount
        UninstallerExecutionMode = [string]$receipt.executionMode
        CoordinatorProcessId = [long]$receipt.coordinatorProcessId
        CoordinatorProcessStartUtcTicks = [string]$receipt.coordinatorProcessStartUtcTicks
        LeaseVerifiedByModule = $false
    }
}

Export-ModuleMember -Function New-TokeneloPayloadRecoverySnapshot, Test-TokeneloPayloadRecoverySnapshot, `
    Test-TokeneloPayloadRecoveryArchive, Restore-TokeneloPayloadRecoverySnapshot, New-TokeneloPayloadManifestFromTemplate
