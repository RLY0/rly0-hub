import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { createReadStream } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const execFileAsync = promisify(execFile);
const protectedDirectories = new Map<string, Promise<void>>();
// Fixed script and an environment path; no shell interpolation of cache paths or data.
const protectScript = `
$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$acl = [System.Security.AccessControl.DirectorySecurity]::new()
$acl.SetAccessRuleProtection($true, $false)
$acl.SetOwner($sid)
$inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
foreach ($who in @($sid, $system)) {
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($who, 'FullControl', $inherit, 'None', 'Allow')
  $acl.AddAccessRule($rule)
}
[System.IO.Directory]::SetAccessControl($env:RLY0_QUOTA_CACHE_DIR, $acl)
$actual = [System.IO.Directory]::GetAccessControl($env:RLY0_QUOTA_CACHE_DIR)
if (-not $actual.AreAccessRulesProtected) { throw 'CACHE_ACL_FAILED' }
foreach ($rule in $actual.Access) {
  $id = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
  if ($id -ne $sid.Value -and $id -ne $system.Value) { throw 'CACHE_ACL_FAILED' }
}
`;

export async function protectPrivateLocalDirectory(directory: string): Promise<void> {
  let pending = protectedDirectories.get(directory);
  if (!pending) {
    pending = (async () => {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const metadata = await fs.lstat(directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink())
        throw new Error("CACHE_DIRECTORY_REJECTED");
      if (process.platform === "win32") {
        const powershell = path.join(
          process.env.SystemRoot || "C:\\Windows",
          "System32/WindowsPowerShell/v1.0/powershell.exe",
        );
        await execFileAsync(
          powershell,
          ["-NoProfile", "-NonInteractive", "-Command", protectScript],
          {
            env: { ...process.env, RLY0_QUOTA_CACHE_DIR: directory },
            windowsHide: true,
            timeout: 10_000,
            maxBuffer: 64 * 1024,
          },
        );
      } else await fs.chmod(directory, 0o700);
    })().catch((error: unknown) => {
      protectedDirectories.delete(directory);
      throw error;
    });
    protectedDirectories.set(directory, pending);
    if (protectedDirectories.size > 256) {
      const oldest = protectedDirectories.keys().next().value;
      if (oldest) protectedDirectories.delete(oldest);
    }
  }
  return pending;
}

/** Only for app-owned private subdirectories; never changes the user's data-root ACL. */
export async function writePrivateLocalText(file: string, text: string): Promise<void> {
  await protectPrivateLocalDirectory(path.dirname(file));
  const temporary = `${file}.tmp-${randomUUID()}`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(text, "utf8");
    await handle.close();
    await fs.rename(temporary, file);
  } finally {
    await handle.close().catch(() => undefined);
    await fs.unlink(temporary).catch(() => undefined);
  }
}

export async function writePrivateQuotaCache(file: string, value: unknown): Promise<void> {
  await writePrivateLocalText(file, JSON.stringify(value) + "\n");
}

/** Copies bytes into a newly created private file without inheriting the source ACL. */
export async function copyPrivateLocalFile(
  source: string,
  target: string,
  maxBytes: number,
): Promise<void> {
  await protectPrivateLocalDirectory(path.dirname(target));
  const handle = await fs.open(target, "wx", 0o600);
  let count = 0;
  try {
    await pipeline(
      createReadStream(source),
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          count += chunk.length;
          callback(count > maxBytes ? new Error("PRIVATE_COPY_LIMIT") : null, chunk);
        },
      }),
      handle.createWriteStream(),
    );
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fs.unlink(target).catch(() => undefined);
    throw error;
  } finally {
    await handle.close().catch(() => undefined);
  }
}
