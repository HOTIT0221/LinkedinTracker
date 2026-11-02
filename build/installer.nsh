; Included by electron-builder's NSIS installer.
; On a real uninstall (not when installing a newer version over this one), remove the
; "Run when Windows starts" entry so Windows doesn't try to launch a missing program.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "LinkedIn Tracker"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "LinkedIn Tracker"
  ${endIf}
!macroend
