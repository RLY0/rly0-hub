import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { copyPrivateLocalFile } from "../src/rly0-maintenance/private-quota-cache.js";

it("SYNTHETIC byte copies inherit the private destination ACL, never the source ACL", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rly0-private-copy-"));
  try {
    const source = path.join(root, "source.sqlite"),
      destination = path.join(root, "private", "snapshot.sqlite");
    const bytes = Buffer.from([0, 1, 255, 128, 13, 10, 23]);
    await fs.writeFile(source, bytes);
    await copyPrivateLocalFile(source, destination, 1024);
    expect(await fs.readFile(destination)).toEqual(bytes);
    expect(await fs.readFile(source)).toEqual(bytes);
    if (process.platform === "win32") {
      const powershell = path.join(
        process.env.SystemRoot || "C:\\Windows",
        "System32/WindowsPowerShell/v1.0/powershell.exe",
      );
      const script = `$ErrorActionPreference='Stop'; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $d=[System.IO.Directory]::GetAccessControl([System.IO.Path]::GetDirectoryName($env:RLY0_PRIVATE_COPY_TEST)); if(-not $d.AreAccessRulesProtected){throw 'DIR_UNPROTECTED'}; $acl=[System.IO.File]::GetAccessControl($env:RLY0_PRIVATE_COPY_TEST); $rules=@($acl.Access); if($rules.Count -ne 2){throw 'FILE_RULE_COUNT'}; foreach($r in $rules){$who=$r.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value; if($who -ne $sid -and $who -ne 'S-1-5-18'){throw 'FILE_PUBLIC'}}; 'PRIVATE_COPY_ACL_VERIFIED'`;
      const result = await promisify(execFile)(
        powershell,
        ["-NoProfile", "-NonInteractive", "-Command", script],
        {
          env: { ...process.env, RLY0_PRIVATE_COPY_TEST: destination },
          windowsHide: true,
          timeout: 10000,
        },
      );
      expect(result.stdout).toContain("PRIVATE_COPY_ACL_VERIFIED");
    } else {
      expect((await fs.stat(destination)).mode & 0o777).toBe(0o600);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it("SYNTHETIC copy limits remove only the owned incomplete file, preserving the source", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rly0-private-copy-limit-"));
  try {
    const source = path.join(root, "source"),
      destination = path.join(root, "private", "snapshot");
    await fs.writeFile(source, "SYNTHETIC_INPUT_BYTES");
    await expect(copyPrivateLocalFile(source, destination, 2)).rejects.toThrow(
      "PRIVATE_COPY_LIMIT",
    );
    await expect(fs.stat(destination)).rejects.toThrow();
    expect(await fs.readFile(source, "utf8")).toBe("SYNTHETIC_INPUT_BYTES");
    await fs.writeFile(destination, "EXISTING_TARGET");
    await expect(copyPrivateLocalFile(source, destination, 1024)).rejects.toThrow();
    expect(await fs.readFile(destination, "utf8")).toBe("EXISTING_TARGET");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
