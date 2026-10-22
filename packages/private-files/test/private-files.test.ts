import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs, {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import {
  assertPrivatePathSync,
  ensurePrivateDirectorySync,
  protectPrivatePathSync,
  readPrivateFileSync,
  writePrivateFileSync,
} from "../src/index.js";

const directories: string[] = [];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "private-files-test-"));
  directories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function verifyIndependently(path: string, directory = false, descriptor?: Uint8Array) {
  if (process.platform !== "win32") {
    const info = lstatSync(path);
    assert.equal(info.mode & 0o777, directory ? 0o700 : 0o600);
    assert.equal(info.uid, process.getuid?.());
    return;
  }
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
$inputPath = [Console]::In.ReadToEnd()
${
  descriptor
    ? `$acl = New-Object Security.AccessControl.${directory ? "DirectorySecurity" : "FileSecurity"}
$acl.SetSecurityDescriptorBinaryForm([Convert]::FromBase64String($inputPath))`
    : `$entry = New-Object IO.${directory ? "DirectoryInfo" : "FileInfo"}($inputPath)
$acl = [IO.FileSystemAclExtensions]::GetAccessControl($entry)`
}
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid) { throw 'Unexpected owner.' }
if (-not $acl.AreAccessRulesProtected -or $rules.Count -ne 1) { throw 'Unprotected ACL or unexpected grants.' }
$rule = $rules[0]
if ($rule.IdentityReference.Value -ne $sid -or $rule.AccessControlType -ne 'Allow' -or $rule.IsInherited -or $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl) { throw 'Unexpected access rule.' }
$expected = ${directory ? "'ContainerInherit,ObjectInherit'" : "'None'"}
if ($rule.InheritanceFlags -ne [Security.AccessControl.InheritanceFlags]$expected) { throw 'Unexpected inheritance.' }
`;
  execFileSync(
    "mise.exe",
    [
      "exec",
      "--",
      "pwsh",
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-OutputFormat",
      "Text",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      input: descriptor ? Buffer.from(descriptor).toString("base64") : path,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
}

test("exclusive private creation supports native Unicode paths", () => {
  const root = fixture();
  const file = join(root, "user's 日本語.txt");
  writePrivateFileSync(file, "fixture credential\n");
  assert.equal(readPrivateFileSync(file), "fixture credential\n");
  assertPrivatePathSync(file);
  verifyIndependently(file);
  assert.throws(() => writePrivateFileSync(file, "replacement"), { code: "EEXIST" });
  assert.equal(readFileSync(file, "utf8"), "fixture credential\n");
});

test("private directories protect child inheritance and remain idempotent", () => {
  const root = fixture();
  const directory = join(root, "nested", "private");
  ensurePrivateDirectorySync(directory);
  ensurePrivateDirectorySync(directory);
  assertPrivatePathSync(directory, { directory: true });
  assert.equal(protectPrivatePathSync(directory, { directory: true }), false);
  verifyIndependently(directory, true);
});

test("permission repairs remove unrelated reader grants without rewriting file bytes", () => {
  const file = join(fixture(), "existing.txt");
  writePrivateFileSync(file, "original bytes\n");
  if (process.platform === "win32") {
    execFileSync("icacls.exe", [file, "/grant", "*S-1-1-0:(R)", "/q"], { stdio: "pipe", windowsHide: true });
  } else {
    chmodSync(file, 0o644);
  }
  assert.throws(() => assertPrivatePathSync(file), /permissions/);
  assert.equal(readPrivateFileSync(file), "original bytes\n");
  assert.equal(protectPrivatePathSync(file), false);
  verifyIndependently(file);
});

for (const kind of ["symlink", "hardlink"] as const) {
  test(`${kind} protection refuses to read, create, or change the target`, () => {
    const root = fixture();
    const target = join(root, "target");
    const linked = join(root, "linked");
    writeFileSync(target, "unchanged target", { mode: 0o644 });
    if (kind === "symlink")
      symlinkSync(
        process.platform === "win32" ? root : target,
        linked,
        process.platform === "win32" ? "junction" : "file",
      );
    else linkSync(target, linked);
    const before = lstatSync(target);
    assert.throws(() => protectPrivatePathSync(linked), /link|reparse/);
    assert.throws(() => readPrivateFileSync(linked), /link|reparse/);
    // CREATE_NEW reports access denied for a directory reparse point on Windows.
    assert.throws(() => writePrivateFileSync(linked, "must not replace"), {
      code: process.platform === "win32" && kind === "symlink" ? "EACCES" : "EEXIST",
    });
    assert.equal(readFileSync(target, "utf8"), "unchanged target");
    assert.equal(lstatSync(target).mode, before.mode);
    assert.equal(lstatSync(target).ctimeMs, before.ctimeMs);
  });
}

test("bounded reads reject oversized files and public modes are refused before creation", () => {
  const file = join(fixture(), "bounded");
  for (const mode of [0o644, 0o777, -1, Number.NaN]) {
    assert.throws(() => writePrivateFileSync(file, "private", mode), /owner/);
    assert.equal(existsSync(file), false);
  }
  writePrivateFileSync(file, "日本語");
  assert.throws(() => readPrivateFileSync(file, 8), { code: "EFBIG" });
  assert.equal(readPrivateFileSync(file, 9), "日本語");
  assert.throws(() => readPrivateFileSync(file, -1), /limit/);
});

for (const phase of ["permissions", "write", "flush"] as const) {
  test(`private permissions precede the first write and failed ${phase} removes the new file`, async () => {
    const file = join(fixture(), "failure");
    let observedPrivateCreation = false;
    vi.resetModules();
    try {
      if (process.platform === "win32") {
        const native = createRequire(import.meta.url)("koffi") as typeof import("koffi");
        const originalLoad = native.load.bind(native);
        const security = originalLoad("advapi32.dll");
        const kernel = originalLoad("kernel32.dll");
        const query = security.func(
          "uint32 __stdcall GetSecurityInfo(intptr_t handle, int type, uint32 flags, void *owner, void *group, void *dacl, void *sacl, _Out_ void **descriptor)",
        );
        const length = security.func("uint32 __stdcall GetSecurityDescriptorLength(void *descriptor)");
        const free = kernel.func("void * __stdcall LocalFree(void *value)");
        vi.spyOn(native, "load").mockImplementation(
          (...args) =>
            new Proxy(originalLoad(...args), {
              get(target, property, receiver) {
                if (property !== "func") return Reflect.get(target, property, receiver);
                return (...signature: unknown[]) => {
                  const fn = Reflect.apply(target.func, target, signature);
                  const name = signature.filter((value) => typeof value === "string").join(" ");
                  if (name.includes("GetSecurityDescriptorControl") && phase === "permissions") return () => 1;
                  if (name.includes("WriteFile"))
                    return (...values: unknown[]) => {
                      const descriptor = [null];
                      assert.equal(query(values[0], 1, 5, null, null, null, null, descriptor), 0);
                      try {
                        verifyIndependently(
                          file,
                          false,
                          Buffer.from(native.view(descriptor[0], length(descriptor[0]))),
                        );
                      } finally {
                        free(descriptor[0]);
                      }
                      observedPrivateCreation = true;
                      if (phase === "write") throw new Error("injected write failure");
                      return Reflect.apply(fn, target, values);
                    };
                  if (name.includes("FlushFileBuffers") && phase === "flush")
                    return () => {
                      throw new Error("injected flush failure");
                    };
                  return fn;
                };
              },
            }),
        );
      } else {
        if (phase === "permissions") {
          const chmod = fs.fchmodSync;
          vi.spyOn(fs, "fchmodSync").mockImplementation((fd) => chmod(fd, 0o644));
        }
        const originalWrite = fs.writeFileSync;
        vi.spyOn(fs, "writeFileSync").mockImplementation((...args) => {
          verifyIndependently(file);
          observedPrivateCreation = true;
          if (phase === "write") throw new Error("injected write failure");
          return originalWrite(...args);
        });
        if (phase === "flush")
          vi.spyOn(fs, "fsyncSync").mockImplementation(() => {
            throw new Error("injected flush failure");
          });
        syncBuiltinESMExports();
      }
      const isolated = await import("../src/index.js");
      assert.throws(
        () => isolated.writePrivateFileSync(file, "fixture credential"),
        phase === "permissions" ? /verification failed/ : /injected/,
      );
      assert.equal(observedPrivateCreation, phase !== "permissions");
      assert.equal(existsSync(file), false);
    } finally {
      vi.restoreAllMocks();
      syncBuiltinESMExports();
      vi.resetModules();
    }
  });
}

for (const [nativeCode, code] of [
  [5, "EACCES"],
  [32, "EBUSY"],
  [33, "EBUSY"],
] as const) {
  test(`opening failure ${nativeCode} preserves ${code} without changing existing bytes`, async () => {
    const file = join(fixture(), "open-failure");
    writePrivateFileSync(file, "unchanged");
    vi.resetModules();
    try {
      if (process.platform === "win32") {
        const native = createRequire(import.meta.url)("koffi") as typeof import("koffi");
        const originalLoad = native.load.bind(native);
        vi.spyOn(native, "load").mockImplementation(
          (...args) =>
            new Proxy(originalLoad(...args), {
              get(target, property, receiver) {
                if (property !== "func") return Reflect.get(target, property, receiver);
                return (...signature: unknown[]) => {
                  const name = signature.filter((value) => typeof value === "string").join(" ");
                  if (name.includes("CreateFileW")) return () => -1;
                  if (name.includes("GetLastError")) return () => nativeCode;
                  return Reflect.apply(target.func, target, signature);
                };
              },
            }),
        );
      } else {
        vi.spyOn(fs, "openSync").mockImplementation(() => {
          throw Object.assign(new Error("injected open failure"), { code });
        });
        syncBuiltinESMExports();
      }
      const isolated = await import("../src/index.js");
      assert.throws(() => isolated.readPrivateFileSync(file), { code });
      assert.throws(() => isolated.protectPrivatePathSync(file), { code });
    } finally {
      vi.restoreAllMocks();
      syncBuiltinESMExports();
      vi.resetModules();
    }
    assert.equal(readFileSync(file, "utf8"), "unchanged");
  });
}

test("missing reads do not create paths and nonregular entries cannot be private files", () => {
  const root = fixture();
  const file = join(root, "missing");
  assert.throws(() => readPrivateFileSync(file), { code: "ENOENT" });
  assert.equal(existsSync(file), false);
  assert.throws(() => readPrivateFileSync(root), /regular/);
});
