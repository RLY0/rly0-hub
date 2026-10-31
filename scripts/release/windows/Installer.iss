[Setup]
#ifdef SandboxTest
; tests/release/windows-installer-sandbox: a throwaway AppId and nothing outside the target folder.
AppId={{0D7C2E51-7A0B-4C6B-9E64-5A3F1D2B8C10}
Uninstallable=no
CreateUninstallRegKey=no
#else
AppId={{B6760EFC-A68E-4309-BDA8-BC379D64E5FC}
#endif
AppName=RLY/0 Hub
AppVerName=RLY/0 Hub {#ProductVersion}
AppPublisherURL=https://github.com/RLY0/rly0-hub
ShowLanguageDialog=no
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
; PrepareToInstall ends everything running from {app} first (stop-install-processes.ps1); the
; Restart Manager is only the fallback for anything left. Nothing is restarted by it.
CloseApplications=force
RestartApplications=no
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

[Languages]
Name: "chinesesimplified"; MessagesFile: "ChineseSimplified.isl"

[Files]
Source: "stop-install-processes.ps1"; Flags: dontcopy
#ifndef SandboxTest
; Extract the new helper before touching an existing installation, including older versions.
Source: "{#PayloadRoot}\libexec\codexhost-updater.exe"; DestName: "codexhost-install-helper.exe"; Flags: dontcopy
#endif
Source: "{#PayloadRoot}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

#ifndef SandboxTest
[Tasks]
Name: "desktopicon"; Description: "在桌面创建 RLY/0 Hub 快捷方式"; GroupDescription: "快捷方式:"

[Icons]
; The Hub window manages everything; Codex opens from it or from its own shortcut.
Name: "{userprograms}\RLY0 Hub"; Filename: "{app}\bin\rly0-hub.exe"; WorkingDir: "{app}"
Name: "{userprograms}\Codex (RLY0 Hub)"; Filename: "{app}\bin\codexhost-start.exe"; WorkingDir: "{app}"
Name: "{userdesktop}\RLY0 Hub"; Filename: "{app}\bin\rly0-hub.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\bin\rly0-hub.exe"; Description: "打开 RLY/0 Hub"; Flags: nowait postinstall skipifsilent
; In-app updates (silent): open the Hub again, and Codex if the update had to close it.
Filename: "{app}\bin\rly0-hub.exe"; Flags: nowait; Check: HasFlag('RELAUNCH')
Filename: "{app}\bin\codexhost-start.exe"; Flags: nowait skipifdoesntexist; Check: ShouldReopenCodex

[UninstallRun]
; Close the tray app before its files are removed.
Filename: "{app}\bin\rly0-hub.exe"; Parameters: "--exit"; Flags: runhidden skipifdoesntexist; RunOnceId: "StopHub"

[Registry]
; The Hub's own autostart value goes with the app, so nothing starts a missing program.
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: none; ValueName: "RLY0Hub"; Flags: uninsdeletevalue dontcreatekey

#endif

[Dirs]
Name: "{app}"

[UninstallDelete]
Type: filesandordirs; Name: "{app}"

[Code]
var
  CodexClosedBySetup: Boolean;

// /RELAUNCH=1 and /REOPENCODEX=1 on the command line, passed by the Hub's own updater.
function HasFlag(Name: String): Boolean;
begin
  Result := ExpandConstant('{param:' + Name + '|0}') = '1';
end;

function ShouldReopenCodex: Boolean;
begin
  Result := HasFlag('REOPENCODEX') or CodexClosedBySetup;
end;

// Runs stop-install-processes.ps1; -1 when PowerShell itself could not be started.
function RunStopper(Mode: String; CloseCodex: Boolean): Integer;
var
  Params: String;
begin
  Params := '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' +
    ExpandConstant('{tmp}\stop-install-processes.ps1') + '" -InstallDir "' +
    ExpandConstant('{app}') + '" -Mode ' + Mode;
  if CloseCodex then
    Params := Params + ' -CloseCodex';
  if not Exec('powershell.exe', Params, '', SW_HIDE, ewWaitUntilTerminated, Result) then
    Result := -1;
  Log(Format('stop-install-processes -Mode %s (CloseCodex=%d): %d', [Mode, Ord(CloseCodex), Result]));
end;

// Running executables cannot be replaced (DeleteFile error 5), and the Restart Manager cannot
// close the windowless helpers Codex starts from libexec. So before any file is copied, every
// process running from {app} is ended; Codex Desktop is closed too, with consent, when it uses
// this install, and opened again afterwards. If something still holds a file, nothing is installed.
// RLY/0: exits the Hub, asks before closing Codex, then ends everything running from {app}.
function StopInstalledProcesses: String;
var
  Code, Attempt: Integer;
  CloseCodex: Boolean;
begin
  Result := '';
  if not DirExists(ExpandConstant('{app}')) then
    Exit;
  if FileExists(ExpandConstant('{app}\bin\rly0-hub.exe')) then
  begin
    Exec(ExpandConstant('{app}\bin\rly0-hub.exe'), '--exit', '', SW_HIDE, ewWaitUntilTerminated, Code);
    Sleep(1000);
  end;
  ExtractTemporaryFile('stop-install-processes.ps1');

  // The Hub's updater asked about Codex and closed it already; it passes /REOPENCODEX=1.
  CloseCodex := HasFlag('REOPENCODEX') or HasFlag('CLOSECODEX');
  if not CloseCodex then
  begin
    Code := RunStopper('Detect', False);
    if Code = -1 then
      Exit; // No PowerShell: leave it to the Restart Manager.
    if Code = 2 then
    begin
      if SuppressibleMsgBox('需要先关闭 Codex，安装完会自动重新打开。' + #13#10#13#10 +
        'Codex 正在使用 RLY/0 Hub 的组件，不关闭就无法替换这些文件。进行中的对话会中断，' +
        '未发送的输入可能丢失。' + #13#10#13#10 + '现在关闭 Codex 并继续安装吗？',
        mbConfirmation, MB_YESNO, IDYES) <> IDYES then
      begin
        Result := '安装未进行，没有做任何更改：Codex 仍在使用 RLY/0 Hub。关闭 Codex 后再运行安装程序即可。';
        Exit;
      end;
      CloseCodex := True;
      CodexClosedBySetup := True;
    end;
  end;

  for Attempt := 1 to 3 do
  begin
    Code := RunStopper('Stop', CloseCodex);
    if (Code = 0) or (Code = -1) then
      Exit;
    Sleep(1000);
  end;
  Result := '安装未进行，没有做任何更改：仍有程序占用 RLY/0 Hub 的文件，无法替换。' +
    '请关闭 Codex 和 RLY/0 Hub 后重试；仍不行时重启电脑再安装。';
end;

#ifndef SandboxTest
// Upstream: the bundled updater closes this installation's own executables by exact path.
function RunInstallHelper: String;
var
  ResultCode: Integer;
begin
  Result := '';
  try
    ExtractTemporaryFile('codexhost-install-helper.exe');
    { PrepareToInstall runs after Install is clicked, before the file-in-use check.
      Append a dot so even a drive-root destination has no trailing argument backslash. }
    if not ExecAndLogOutput(
      ExpandConstant('{tmp}\codexhost-install-helper.exe'),
      'prepare-install --install-root ' + AddQuotes(AddBackslash(ExpandConstant('{app}')) + '.'),
      ExpandConstant('{tmp}'), SW_SHOWNORMAL, ewWaitUntilTerminated, ResultCode, nil) then
      Result := 'Could not start codexhost installation preparation: ' + SysErrorMessage(ResultCode)
    else if ResultCode <> 0 then begin
      Log(Format('codexhost installation preparation failed with exit code %d', [ResultCode]));
      Result := 'Could not close the running codexhost installation. Close Codex and RLY/0 Hub and try again.';
    end;
  except
    Result := 'Could not prepare codexhost installation: ' + GetExceptionMessage;
  end;
end;
#endif

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := StopInstalledProcesses;
#ifndef SandboxTest
  if Result = '' then
    Result := RunInstallHelper;
#endif
end;
