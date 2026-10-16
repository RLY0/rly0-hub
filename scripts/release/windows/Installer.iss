[Setup]
AppId={{B6760EFC-A68E-4309-BDA8-BC379D64E5FC}
AppName=RLY0 Hub
AppVersion={#ProductVersion}
AppPublisher=RLY0 Hub
DefaultDirName={localappdata}\Programs\rly0-hub
DefaultGroupName=RLY0 Hub
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir={#OutputDir}
OutputBaseFilename={#OutputBaseFilename}
Compression=lzma
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName=RLY0 Hub
SetupIconFile=..\..\..\crates\launcher\assets\codexhost.ico
UninstallDisplayIcon={app}\bin\rly0-hub.exe

#if Architecture == "x64"
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
#else
ArchitecturesAllowed=arm64
ArchitecturesInstallIn64BitMode=arm64
#endif

[Files]
Source: "{#PayloadRoot}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Tasks]
Name: "desktopicon"; Description: "在桌面创建 RLY/0 Hub 快捷方式"; GroupDescription: "快捷方式:"

[Icons]
; The Hub window manages everything; Codex opens from it or from its own shortcut.
Name: "{userprograms}\RLY0 Hub"; Filename: "{app}\bin\rly0-hub.exe"; WorkingDir: "{app}"
Name: "{userprograms}\Codex (RLY0 Hub)"; Filename: "{app}\bin\codexhost-start.exe"; WorkingDir: "{app}"
Name: "{userdesktop}\RLY0 Hub"; Filename: "{app}\bin\rly0-hub.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\bin\rly0-hub.exe"; Description: "打开 RLY/0 Hub"; Flags: nowait postinstall skipifsilent

[UninstallRun]
; Close the tray app before its files are removed.
Filename: "{app}\bin\rly0-hub.exe"; Parameters: "--exit"; Flags: runhidden skipifdoesntexist; RunOnceId: "StopHub"

[Registry]
; The Hub's own autostart value goes with the app, so nothing starts a missing program.
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: none; ValueName: "RLY0Hub"; Flags: uninsdeletevalue dontcreatekey

[Dirs]
Name: "{app}"

[UninstallDelete]
Type: filesandordirs; Name: "{app}"

[Code]
// An update while the tray app runs would hit locked files: ask it to exit first.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Code: Integer;
begin
  if FileExists(ExpandConstant('{app}\bin\rly0-hub.exe')) then
  begin
    Exec(ExpandConstant('{app}\bin\rly0-hub.exe'), '--exit', '', SW_HIDE, ewWaitUntilTerminated, Code);
    Sleep(1500);
  end;
  Result := '';
end;
