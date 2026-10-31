# Harmless native launcher fixture. Compiles the real launcher and a fake GUI runtime,
# then records only environment, argv, current directory, exit and launcher-owned logs.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$EvidenceRoot,
    [switch]$TrayCasesOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-That($Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Invoke-BoundedProcess {
    param(
        [string]$FileName,
        [string]$Arguments,
        [string]$WorkingDirectory,
        [int]$TimeoutMilliseconds = 20000,
        [switch]$SeedElectronRunAsNode
    )
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = $FileName
    $start.Arguments = $Arguments
    $start.WorkingDirectory = $WorkingDirectory
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $null = $start.EnvironmentVariables.Remove('TOKENELO_HOME')
    if ($SeedElectronRunAsNode) { $start.EnvironmentVariables['ELECTRON_RUN_AS_NODE'] = '1' }
    else { $null = $start.EnvironmentVariables.Remove('ELECTRON_RUN_AS_NODE') }

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $start
    try {
        if (-not $process.Start()) { throw "Could not start owned fixture process: $FileName" }
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        $finished = $process.WaitForExit($TimeoutMilliseconds)
        if (-not $finished) {
            $process.Kill()
            $process.WaitForExit()
        }
        [pscustomobject]@{
            FileName = $FileName
            Arguments = $Arguments
            Finished = $finished
            ExitCode = if ($finished) { $process.ExitCode } else { $null }
            Stdout = $stdout.Result
            Stderr = $stderr.Result
        }
    } finally { $process.Dispose() }
}

function Get-Sha256([string]$Path) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        $stream = [IO.File]::OpenRead($Path)
        try { [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
        finally { $stream.Dispose() }
    } finally { $algorithm.Dispose() }
}

$tempPrefix = [IO.Path]::GetFullPath('C:\Temp').TrimEnd('\') + '\'
$root = [IO.Path]::GetFullPath($EvidenceRoot)
if (-not $root.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'EvidenceRoot must be a new directory under C:\Temp.'
}
if (Test-Path -LiteralPath $root) { throw 'EvidenceRoot already exists; refusing to overwrite it.' }
$null = New-Item -ItemType Directory -Path $root
$fixture = Join-Path $root 'fixture with spaces'
$build = Join-Path $fixture 'build'
$launchers = Join-Path $fixture 'launchers'
$homeRoot = Join-Path $fixture 'isolated homes'
$installRoot = Join-Path $fixture 'packaged install\Tokenelo'
$appRoot = Join-Path $installRoot 'resources\app'
$checkoutRoot = Join-Path $fixture 'checkout tree'
$checkoutRuntime = Join-Path $checkoutRoot 'node_modules\electron\dist\electron.exe'
$checkoutTrayEntry = Join-Path $checkoutRoot 'dist\tray\main.js'
$daemonEntry = Join-Path $appRoot 'dist\daemon\main.js'
$packagedTrayEntry = Join-Path $appRoot 'dist\tray\main.js'
$launcherSource = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'scripts\windows\TokeneloHiddenLauncher.cs'
$fakeSource = Join-Path $build 'FixtureGuiRuntime.cs'
$fakeExe = Join-Path $build 'FixtureGuiRuntime.exe'
$launcherExe = Join-Path $build 'TokeneloHiddenLauncher.exe'
$receiptPath = Join-Path $root 'receipt.json'
$probes = [Collections.Generic.List[object]]::new()
$failure = $null
$compiler = @(
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1

try {
    if (-not $compiler) { throw 'The .NET Framework C# compiler is unavailable.' }
    foreach ($directory in @($build, $launchers, $homeRoot, (Split-Path -Parent $appRoot),
        (Split-Path -Parent $daemonEntry), (Split-Path -Parent $packagedTrayEntry),
        (Split-Path -Parent $checkoutTrayEntry), (Split-Path -Parent $checkoutRuntime))) {
        $null = New-Item -ItemType Directory -Path $directory -Force
    }
    [IO.File]::WriteAllText((Join-Path $appRoot 'package.json'),
        '{"private":true,"type":"module","main":"dist/tray/main.js"}', [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($daemonEntry, '// fake daemon entry', [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($packagedTrayEntry, '// fake tray entry', [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($checkoutTrayEntry, '// fake checkout tray entry', [Text.UTF8Encoding]::new($false))

    $fakeCode = @'
using System;
using System.IO;
using System.Text;

internal static class FixtureGuiRuntime
{
    private static string JsonString(string value)
    {
        if (value == null) return "null";
        return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"")
            .Replace("\r", "\\r").Replace("\n", "\\n").Replace("\t", "\\t") + "\"";
    }

    private static int Main(string[] args)
    {
        string home = Environment.GetEnvironmentVariable("TOKENELO_HOME");
        if (String.IsNullOrEmpty(home)) return 89;
        Directory.CreateDirectory(home);
        StringBuilder json = new StringBuilder();
        json.Append("{\"pid\":").Append(System.Diagnostics.Process.GetCurrentProcess().Id)
            .Append(",\"tokeneloHome\":").Append(JsonString(home))
            .Append(",\"electronRunAsNode\":").Append(JsonString(Environment.GetEnvironmentVariable("ELECTRON_RUN_AS_NODE")))
            .Append(",\"currentDirectory\":").Append(JsonString(Environment.CurrentDirectory))
            .Append(",\"arguments\":[");
        for (int index = 0; index < args.Length; index++)
        {
            if (index > 0) json.Append(',');
            json.Append(JsonString(args[index]));
        }
        json.Append("]}");
        File.WriteAllText(Path.Combine(home, "child-receipt.json"), json.ToString(), new UTF8Encoding(false));
        return 0;
    }
}
'@
    [IO.File]::WriteAllText($fakeSource, $fakeCode, [Text.UTF8Encoding]::new($false))

    $fakeCompile = Invoke-BoundedProcess -FileName $compiler `
        -Arguments ('/nologo /target:winexe /optimize+ "/out:' + $fakeExe + '" "' + $fakeSource + '"') `
        -WorkingDirectory $build -TimeoutMilliseconds 30000
    Assert-That ($fakeCompile.Finished -and $fakeCompile.ExitCode -eq 0 -and
        (Test-Path -LiteralPath $fakeExe -PathType Leaf)) ('Fake runtime compile failed: ' + $fakeCompile.Stderr + $fakeCompile.Stdout)
    Copy-Item -LiteralPath $fakeExe -Destination (Join-Path $installRoot 'Tokenelo.exe')
    Copy-Item -LiteralPath $fakeExe -Destination $checkoutRuntime

    $launcherCompile = Invoke-BoundedProcess -FileName $compiler `
        -Arguments ('/nologo /target:winexe /optimize+ "/out:' + $launcherExe + '" "' + $launcherSource + '"') `
        -WorkingDirectory $build -TimeoutMilliseconds 30000
    Assert-That ($launcherCompile.Finished -and $launcherCompile.ExitCode -eq 0 -and
        (Test-Path -LiteralPath $launcherExe -PathType Leaf)) ('Hidden launcher compile failed: ' + $launcherCompile.Stderr + $launcherCompile.Stdout)
    $daemonLauncher = Join-Path $launchers 'tokenelo-daemon-launcher.exe'
    $trayLauncher = Join-Path $launchers 'tokenelo-tray-launcher.exe'
    Copy-Item -LiteralPath $launcherExe -Destination $daemonLauncher
    Copy-Item -LiteralPath $launcherExe -Destination $trayLauncher

    $cases = @(
        [pscustomobject]@{
            Name='packaged-daemon'; Launcher=$daemonLauncher; Runtime=(Join-Path $installRoot 'Tokenelo.exe')
            Entry=$daemonEntry; Home=(Join-Path $homeRoot 'packaged daemon home')
            ExpectedMode='1'; ExpectedCwd=$appRoot; ExpectedArgs=@($daemonEntry)
        },
        [pscustomobject]@{
            Name='packaged-tray'; Launcher=$trayLauncher; Runtime=(Join-Path $installRoot 'Tokenelo.exe')
            Entry='--tokenelo-packaged-app'; Home=(Join-Path $homeRoot 'packaged tray home')
            ExpectedMode=$null; ExpectedCwd=$installRoot; ExpectedArgs=@()
        },
        [pscustomobject]@{
            Name='checkout-tray'; Launcher=$trayLauncher; Runtime=$checkoutRuntime
            Entry=$checkoutTrayEntry; Home=(Join-Path $homeRoot 'checkout tray home')
            ExpectedMode=$null; ExpectedCwd=$checkoutRoot; ExpectedArgs=@($checkoutTrayEntry)
        }
    )
    if ($TrayCasesOnly) { $cases = @($cases | Where-Object { $_.Name -in @('packaged-tray','checkout-tray') }) }
    foreach ($case in $cases) {
        $null = New-Item -ItemType Directory -Path $case.Home
        $childArguments = '"' + $case.Runtime + '" "' + $case.Entry + '" "' + $case.Home + '"'
        $launch = Invoke-BoundedProcess -FileName $case.Launcher -Arguments $childArguments `
            -WorkingDirectory $fixture -TimeoutMilliseconds 15000 -SeedElectronRunAsNode
        Assert-That ($launch.Finished -and $launch.ExitCode -eq 0) ($case.Name + ' launcher did not exit cleanly: ' + $launch.Stderr)

        $childReceiptPath = Join-Path $case.Home 'child-receipt.json'
        $role = if ($case.Name -eq 'packaged-daemon') { 'daemon' } else { 'tray' }
        $lastExitPath = Join-Path $case.Home ('logs\' + $role + '.last-exit.json')
        $stdoutPath = Join-Path $case.Home ('logs\' + $role + '.stdout.log')
        $stderrPath = Join-Path $case.Home ('logs\' + $role + '.stderr.log')
        Assert-That (Test-Path -LiteralPath $childReceiptPath -PathType Leaf) ($case.Name + ' child receipt is missing')
        Assert-That ((Test-Path -LiteralPath $lastExitPath -PathType Leaf) -and
            (Test-Path -LiteralPath $stdoutPath -PathType Leaf) -and (Test-Path -LiteralPath $stderrPath -PathType Leaf)) `
            ($case.Name + ' launcher exit/log receipts are missing')
        $child = Get-Content -LiteralPath $childReceiptPath -Raw | ConvertFrom-Json
        $lastExit = Get-Content -LiteralPath $lastExitPath -Raw | ConvertFrom-Json
        $actualArgs = @($child.arguments | ForEach-Object { [string]$_ })
        Assert-That ($child.tokeneloHome -ieq $case.Home) ($case.Name + ' did not receive its isolated TOKENELO_HOME')
        Assert-That ($child.electronRunAsNode -ceq $case.ExpectedMode) ($case.Name + ' inherited an unexpected ELECTRON_RUN_AS_NODE value')
        Assert-That ($child.currentDirectory -ieq $case.ExpectedCwd) ($case.Name + ' received the wrong working directory')
        Assert-That ($actualArgs.Count -eq $case.ExpectedArgs.Count) ($case.Name + ' received the wrong number of entry arguments')
        for ($index = 0; $index -lt $actualArgs.Count; $index++) {
            Assert-That ($actualArgs[$index] -ieq $case.ExpectedArgs[$index]) ($case.Name + ' received an unexpected entry argument')
        }
        Assert-That ([int]$lastExit.exitCode -eq 0 -and [int]$lastExit.pid -eq [int]$child.pid) `
            ($case.Name + ' child exit receipt did not match the launched child')

        $probes.Add([pscustomobject]@{
            name=$case.Name; launcherExitCode=$launch.ExitCode; childExitCode=[int]$lastExit.exitCode
            childPid=[int]$child.pid; tokeneloHome=$child.tokeneloHome; electronRunAsNode=$child.electronRunAsNode
            currentDirectory=$child.currentDirectory; arguments=@($actualArgs)
            childReceiptSha256=(Get-Sha256 $childReceiptPath); lastExitSha256=(Get-Sha256 $lastExitPath)
            stdoutSha256=(Get-Sha256 $stdoutPath); stderrSha256=(Get-Sha256 $stderrPath)
            stdoutBytes=(Get-Item -LiteralPath $stdoutPath).Length; stderrBytes=(Get-Item -LiteralPath $stderrPath).Length
        })
    }
} catch { $failure = $_.ToString() }

$receipt = [pscustomobject]@{
    recordedAt=[DateTime]::UtcNow.ToString('o')
    scope='Native hidden-launcher fixture with fake GUI runtimes; no Electron app, service, task, database, or user profile was used.'
    failed=($null -ne $failure); error=$failure
    launcherSourceSha256=if(Test-Path -LiteralPath $launcherSource -PathType Leaf){Get-Sha256 $launcherSource}else{$null}
    fakeRuntimeSourceSha256=if(Test-Path -LiteralPath $fakeSource -PathType Leaf){Get-Sha256 $fakeSource}else{$null}
    launcherBinarySha256=if(Test-Path -LiteralPath $launcherExe -PathType Leaf){Get-Sha256 $launcherExe}else{$null}
    fakeRuntimeBinarySha256=if(Test-Path -LiteralPath $fakeExe -PathType Leaf){Get-Sha256 $fakeExe}else{$null}
    probes=@($probes.ToArray())
    evidenceRoot=$root
}
[IO.File]::WriteAllText($receiptPath, ($receipt | ConvertTo-Json -Depth 8) + "`n", [Text.UTF8Encoding]::new($false))
$receipt | ConvertTo-Json -Depth 8
if ($failure) { throw $failure }
