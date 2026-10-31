; Task retirement for per-user NSIS uninstall. This process owns the same Global per-SID
; mutex used by install-service-windows.ps1 and keeps it until the uninstaller process exits.
; The helper is called before the template's file-removal instructions and must succeed.

!include "FileFunc.nsh"

Var TokeneloLifecycleMutexHandle
Var TokeneloLifecycleMutexName
Var TokeneloLifecycleCoordinatorProcessId
Var TokeneloLifecycleRetireResult

; productName is Tokenelo and locked app-builder-lib 26.18 derives
; UNINSTALL_FILENAME as "Uninstall ${PRODUCT_FILENAME}.exe" in common.nsh.
!define TOKENELO_INSTALLED_UNINSTALLER_FILENAME "Uninstall Tokenelo.exe"

!macro TokeneloCheckExistingProduct ROOT_KEY KEY_NAME
  ClearErrors
  ReadRegStr $R0 ${ROOT_KEY} "${KEY_NAME}" "DisplayName"
  StrCmp $R0 "" +2
    Goto TokeneloInstallerUpgradeRefused
  ClearErrors
  ReadRegStr $R0 ${ROOT_KEY} "${KEY_NAME}" "UninstallString"
  StrCmp $R0 "" +2
    Goto TokeneloInstallerUpgradeRefused
  ClearErrors
  ReadRegStr $R0 ${ROOT_KEY} "${KEY_NAME}" "InstallLocation"
  StrCmp $R0 "" +2
    Goto TokeneloInstallerUpgradeRefused
!macroend

; Runs after electron-builder's initMultiUser and before installSection.nsh invokes
; uninstallOldVersion. This also blocks old installed versions whose uninstaller lacks
; the customUnInstall refusal below.
!macro customInit
  !insertmacro TokeneloCheckExistingProduct SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}"
  !insertmacro TokeneloCheckExistingProduct HKCU "${UNINSTALL_REGISTRY_KEY}"
  !insertmacro TokeneloCheckExistingProduct HKLM "${UNINSTALL_REGISTRY_KEY}"
  !ifdef UNINSTALL_REGISTRY_KEY_2
    !insertmacro TokeneloCheckExistingProduct SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY_2}"
    !insertmacro TokeneloCheckExistingProduct HKCU "${UNINSTALL_REGISTRY_KEY_2}"
  !endif
  IfFileExists "$INSTDIR\${UNINSTALL_FILENAME}" TokeneloInstallerUpgradeRefused 0
  IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" TokeneloInstallerUpgradeRefused 0
  IfFileExists "$INSTDIR\resources\app\package.json" TokeneloInstallerUpgradeRefused 0
  Goto TokeneloInstallerPreflightComplete

TokeneloInstallerUpgradeRefused:
  SetErrorLevel 1
  MessageBox MB_ICONSTOP|MB_OK "Tokenelo cannot replace an existing installation until its lifecycle coordinator is available. No old uninstaller was run and no application files were changed."
  Abort

TokeneloInstallerPreflightComplete:
!macroend

!macro customUnInit
  Call un.TokeneloAcquireLifecycleLease
!macroend

!macro customUnInstall
  ; A package upgrade must be coordinated by the installer across the old uninstaller and
  ; new file publication. No such installer lease is wired yet, so --updated fails closed.
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "--updated" $1
  IfErrors un.TokeneloRetireUserRequest
  SetErrorLevel 1
  MessageBox MB_ICONSTOP|MB_OK "Tokenelo cannot upgrade while its background tasks may be running. The installer lifecycle coordinator is not available; no application files were removed."
  Abort

un.TokeneloRetireUserRequest:
  Call un.TokeneloRetireServiceTasks
  StrCmp $TokeneloLifecycleRetireResult "0" +2
    Abort
!macroend

Function un.TokeneloAcquireLifecycleLease
  StrCpy $TokeneloLifecycleMutexHandle 0
  StrCpy $TokeneloLifecycleCoordinatorProcessId 0
  StrCpy $0 0
  StrCpy $1 0
  StrCpy $3 0
  StrCpy $5 0
  StrCpy $8 0
  StrCpy $2 ""

  System::Call 'kernel32::GetCurrentProcess() p .r0'
  System::Call 'advapi32::OpenProcessToken(p r0, i 0x0008, *p .r1) i .r2'
  StrCmp $2 1 0 un.TokeneloAcquireCleanup

  ; First call obtains the TOKEN_USER buffer size. The expected failure is insufficient buffer.
  System::Call 'advapi32::GetTokenInformation(p r1, i 1, p 0, i 0, *i .r2) i .r4'
  System::Call 'kernel32::GetLastError() i .r6'
  StrCmp $4 0 0 un.TokeneloAcquireCleanup
  StrCmp $6 122 0 un.TokeneloAcquireCleanup
  IntCmp $2 0 un.TokeneloAcquireCleanup un.TokeneloAcquireCleanup +1
  IntCmp $2 4096 +1 +1 un.TokeneloAcquireCleanup
  System::Alloc $2
  Pop $3
  StrCmp $3 0 un.TokeneloAcquireCleanup

  System::Call 'advapi32::GetTokenInformation(p r1, i 1, p r3, i r2, *i .r4) i .r5'
  StrCmp $5 1 0 un.TokeneloAcquireCleanup
  System::Call '*$3(p .r4)'
  StrCmp $4 0 un.TokeneloAcquireCleanup
  StrCpy $5 0
  System::Call 'advapi32::ConvertSidToStringSidW(p r4, *p .r5) i .r6'
  StrCmp $6 1 0 un.TokeneloAcquireCleanup
  StrCmp $5 0 un.TokeneloAcquireCleanup
  System::Call 'kernel32::lstrcpynW(w .r7, p r5, i 184) p .r6'
  StrCmp $6 0 un.TokeneloAcquireCleanup
  StrCpy $6 $7 4
  StrCmp $6 "S-1-" 0 un.TokeneloAcquireCleanup
  StrCpy $TokeneloLifecycleMutexName "Global\Tokenelo-ServiceLifecycle-$7"

  System::Call 'kernel32::CreateMutexW(p 0, i 0, w "$TokeneloLifecycleMutexName") p .r8'
  StrCmp $8 0 un.TokeneloAcquireCleanup
  System::Call 'kernel32::WaitForSingleObject(p r8, i 0) i .r9'
  IntCmp $9 0 un.TokeneloAcquireOwned
  IntCmp $9 128 un.TokeneloAcquireAbandoned
  Goto un.TokeneloAcquireCleanup

un.TokeneloAcquireAbandoned:
  ; WAIT_ABANDONED grants ownership, but retained transaction state must be inspected first.
  System::Call 'kernel32::ReleaseMutex(p r8) i .r6'
  Goto un.TokeneloAcquireCleanup

un.TokeneloAcquireOwned:
  StrCpy $TokeneloLifecycleMutexHandle $8
  StrCpy $8 0
  System::Call 'kernel32::GetCurrentProcessId() i .r6'
  StrCpy $TokeneloLifecycleCoordinatorProcessId $6
  StrCpy $2 "owned"

un.TokeneloAcquireCleanup:
  StrCmp $5 0 +2
    System::Call 'kernel32::LocalFree(p r5) p .r6'
  StrCmp $3 0 +2
    System::Free $3
  StrCmp $1 0 +2
    System::Call 'kernel32::CloseHandle(p r1) i .r6'
  StrCmp $8 0 +2
    System::Call 'kernel32::CloseHandle(p r8) i .r6'
  StrCmp $2 "owned" un.TokeneloAcquireDone
  SetErrorLevel 1
  MessageBox MB_ICONSTOP|MB_OK "Tokenelo could not safely acquire its per-user lifecycle lock. No tasks or application files were changed."
  Abort

un.TokeneloAcquireDone:
  ; Keep the owned handle open for the whole NSIS process. Windows releases the mutex only
  ; when this uninstaller exits, including after either successful removal or a refusal.
FunctionEnd

Function un.TokeneloRetireServiceTasks
  StrCpy $TokeneloLifecycleRetireResult "1"
  StrCmp $TokeneloLifecycleMutexHandle "0" un.TokeneloRetireRefused
  IfFileExists "$INSTDIR\resources\app\scripts\install-service-windows.ps1" 0 un.TokeneloRetireRefused
  System::Call 'kernel32::GetCurrentProcessId() i .r0'
  StrCpy $TokeneloLifecycleCoordinatorProcessId $0
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\app\scripts\install-service-windows.ps1" -Uninstall -PackagedAppRoot "$INSTDIR\resources\app" -PackagedElectronPath "$INSTDIR\Tokenelo.exe" -LifecycleCoordinatorProcessId $TokeneloLifecycleCoordinatorProcessId -LifecycleCoordinatorExecutablePath "$EXEPATH" -LifecycleCoordinatorInstalledExecutablePath "$INSTDIR\${TOKENELO_INSTALLED_UNINSTALLER_FILENAME}"'
  Pop $0
  StrCmp $0 "0" un.TokeneloRetireComplete

un.TokeneloRetireRefused:
  SetErrorLevel 1
  MessageBox MB_ICONSTOP|MB_OK "Tokenelo could not verify and retire its owned background tasks. The uninstall has stopped before application files are removed."
  Return

un.TokeneloRetireComplete:
  StrCpy $TokeneloLifecycleRetireResult "0"
FunctionEnd
