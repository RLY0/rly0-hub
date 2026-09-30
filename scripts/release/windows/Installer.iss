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
UninstallDisplayIcon={app}\bin\codexhost-start.exe

#if Architecture == "x64"
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
#else
ArchitecturesAllowed=arm64
ArchitecturesInstallIn64BitMode=arm64
#endif

[Files]
Source: "{#PayloadRoot}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{userprograms}\RLY0 Hub"; Filename: "{app}\bin\codexhost-start.exe"; WorkingDir: "{app}"

[Dirs]
Name: "{app}"

[UninstallDelete]
Type: filesandordirs; Name: "{app}"
