!include "LogicLib.nsh"
!include "nsDialogs.nsh"

!ifndef BUILD_UNINSTALLER
Var PasswordPageDialog
Var PasswordPageInput

!macro customPageAfterChangeDir
  Page custom PasswordPageCreate PasswordPageLeave
!macroend

Function PasswordPageCreate
  nsDialogs::Create 1018
  Pop $PasswordPageDialog
  ${If} $PasswordPageDialog == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 24u "Enter the installer password to continue."
  Pop $0
  ${NSD_CreateLabel} 0 18u 100% 18u "OpenClaw Pro setup will continue only after the password is verified."
  Pop $0
  ${NSD_CreatePassword} 0 42u 100% 14u ""
  Pop $PasswordPageInput

  nsDialogs::Show
FunctionEnd

Function PasswordPageLeave
  ${NSD_GetText} $PasswordPageInput $0
  ${If} $0 != "96996"
    MessageBox MB_ICONSTOP|MB_OK "Incorrect installer password. Setup cannot continue."
    Abort
  ${EndIf}
FunctionEnd
!endif

!macro customInstall
  StrCpy $0 "--disable-gpu --disable-gpu-compositing --in-process-gpu"

  Delete "$newStartMenuLink"
  CreateShortCut "$newStartMenuLink" "$appExe" "$0" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
  ClearErrors
  WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"

  ${ifNot} ${isNoDesktopShortcut}
    Delete "$newDesktopLink"
    CreateShortCut "$newDesktopLink" "$appExe" "$0" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
  ${endIf}
!macroend
