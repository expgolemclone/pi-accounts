import { createRequire } from "node:module";
import { toNamespacedPath } from "node:path";
import type * as Koffi from "koffi";

const FILE_ALL_ACCESS = 0x1f01ff;
const READ_CONTROL = 0x20000;
const WRITE_DAC = 0x40000;
const DACL_SECURITY_INFORMATION = 4;
const PROTECTED_DACL_SECURITY_INFORMATION = 0x80000000;
const FILE_ATTRIBUTE_DIRECTORY = 0x10;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
const SE_DACL_PROTECTED = 0x1000;

type Pointer = bigint | null;
type Handle = number | bigint;

function loadApi() {
  const koffi = createRequire(import.meta.url)("koffi") as typeof Koffi;
  const kernel = koffi.load("kernel32.dll");
  const security = koffi.load("advapi32.dll");
  const attributes = koffi.struct({ length: "uint32", descriptor: "void *", inherit: "int" });
  const fileTime = koffi.struct({ low: "uint32", high: "uint32" });
  const fileInfo = koffi.struct({
    attributes: "uint32",
    creation: fileTime,
    access: fileTime,
    write: fileTime,
    volume: "uint32",
    sizeHigh: "uint32",
    sizeLow: "uint32",
    links: "uint32",
    indexHigh: "uint32",
    indexLow: "uint32",
  });
  const createFile = kernel.func("__stdcall", "CreateFileW", "intptr_t", [
    "str16",
    "uint32",
    "uint32",
    koffi.pointer(attributes),
    "uint32",
    "uint32",
    "intptr_t",
  ]);
  const close = kernel.func("int __stdcall CloseHandle(intptr_t handle)");
  const localFree = kernel.func("void * __stdcall LocalFree(void *value)");
  const lastError = kernel.func("uint32 __stdcall GetLastError()");
  const info = kernel.func("__stdcall", "GetFileInformationByHandle", "int", [
    "intptr_t",
    koffi.out(koffi.pointer(fileInfo)),
  ]);
  const write = kernel.func(
    "int __stdcall WriteFile(intptr_t handle, const void *data, uint32 size, _Out_ uint32 *written, void *overlapped)",
  );
  const flush = kernel.func("int __stdcall FlushFileBuffers(intptr_t handle)");
  const read = kernel.func(
    "int __stdcall ReadFile(intptr_t handle, void *data, uint32 size, _Out_ uint32 *read, void *overlapped)",
  );
  const sizeOfFile = kernel.func("int __stdcall GetFileSizeEx(intptr_t handle, _Out_ int64 *size)");
  const dispose = kernel.func(
    "int __stdcall SetFileInformationByHandle(intptr_t handle, int type, const void *data, uint32 size)",
  );
  const createDirectory = kernel.func("__stdcall", "CreateDirectoryW", "int", ["str16", koffi.pointer(attributes)]);
  const openToken = security.func(
    "int __stdcall OpenProcessToken(intptr_t process, uint32 access, _Out_ intptr_t *token)",
  );
  const tokenInfo = security.func(
    "int __stdcall GetTokenInformation(intptr_t token, uint32 type, void *data, uint32 size, _Out_ uint32 *required)",
  );
  const sidToString = security.func("int __stdcall ConvertSidToStringSidW(void *sid, _Out_ void **text)");
  const fromString = security.func(
    "int __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(str16 text, uint32 revision, _Out_ void **descriptor, _Out_ uint32 *size)",
  );
  const getSecurity = security.func(
    "uint32 __stdcall GetSecurityInfo(intptr_t handle, int type, uint32 flags, _Out_ void **owner, void *group, _Out_ void **dacl, void *sacl, _Out_ void **descriptor)",
  );
  const setSecurity = security.func(
    "uint32 __stdcall SetSecurityInfo(intptr_t handle, int type, uint32 flags, void *owner, void *group, void *dacl, void *sacl)",
  );
  const getControl = security.func(
    "int __stdcall GetSecurityDescriptorControl(void *descriptor, _Out_ uint16 *control, _Out_ uint32 *revision)",
  );
  const getDacl = security.func(
    "int __stdcall GetSecurityDescriptorDacl(void *descriptor, _Out_ int *present, _Out_ void **dacl, _Out_ int *defaulted)",
  );
  const getOwner = security.func(
    "int __stdcall GetSecurityDescriptorOwner(void *descriptor, _Out_ void **owner, _Out_ int *defaulted)",
  );
  const aclInfo = security.func("int __stdcall GetAclInformation(void *acl, void *info, uint32 size, int type)");
  const getAce = security.func("int __stdcall GetAce(void *acl, uint32 index, _Out_ void **ace)");

  function checked(success: number, operation: string): void {
    if (!success)
      throw Object.assign(new Error(`Windows private-file ${operation} failed (${lastError()}).`), { code: "EACCES" });
  }

  function sidString(sid: Pointer): string {
    const text: Pointer[] = [null];
    checked(sidToString(sid, text), "SID query");
    try {
      return koffi.decode.string16(text[0]);
    } finally {
      localFree(text[0]);
    }
  }

  const token: Handle[] = [0];
  checked(openToken(-1, 8, token), "token query");
  const tokenSid = (type: number): string => {
    const size = [0];
    tokenInfo(token[0], type, null, 0, size);
    const buffer = koffi.alloc("uint8", size[0] ?? 0);
    try {
      checked(tokenInfo(token[0], type, buffer, size[0], size), "token SID query");
      return sidString(koffi.decode(buffer, "void *") as Pointer);
    } finally {
      koffi.free(buffer);
    }
  };
  let user: string;
  let administratorOwner: boolean;
  try {
    user = tokenSid(1);
    administratorOwner = tokenSid(4) === "S-1-5-32-544";
  } finally {
    close(token[0]);
  }

  function withSecurity<T>(handle: Handle, action: (owner: Pointer, dacl: Pointer, descriptor: Pointer) => T): T {
    const owner: Pointer[] = [null];
    const dacl: Pointer[] = [null];
    const descriptor: Pointer[] = [null];
    const result = getSecurity(handle, 1, 5, owner, null, dacl, null, descriptor);
    if (result !== 0) throw new Error(`Windows private-file security query failed (${result}).`);
    try {
      return action(owner[0] ?? null, dacl[0] ?? null, descriptor[0] ?? null);
    } finally {
      localFree(descriptor[0]);
    }
  }

  function aclEntries(dacl: Pointer): Array<{ type: number; flags: number; mask: number; sid?: string }> {
    if (!dacl) return [];
    const count = Buffer.alloc(12);
    checked(aclInfo(dacl, count, count.length, 2), "ACL query");
    const entries = [];
    for (let index = 0; index < count.readUInt32LE(0); index++) {
      const ace: Pointer[] = [null];
      checked(getAce(dacl, index, ace), "ACE query");
      const pointer = ace[0];
      if (!pointer) throw new Error("Windows ACL contains an invalid ACE.");
      const header = Buffer.from(koffi.view(pointer, 8));
      entries.push({
        type: header[0] ?? -1,
        flags: header[1] ?? 0,
        mask: header.readUInt32LE(4),
        sid: header[0] === 0 ? sidString(pointer + 8n) : undefined,
      });
    }
    return entries;
  }

  function isPrivate(handle: Handle, directory: boolean): boolean {
    return withSecurity(handle, (owner, dacl, descriptor) => {
      const ownerSid = sidString(owner);
      if (ownerSid !== user) {
        // Elevated tokens default to Administrators ownership. Accept that case only
        // when the DACL already explicitly identifies this user as a full-control owner.
        const entries = aclEntries(dacl);
        if (
          administratorOwner &&
          ownerSid === "S-1-5-32-544" &&
          entries.every((ace) => ace.type === 0) &&
          entries.some((ace) => ace.sid === user && !(ace.flags & 8) && ace.mask === FILE_ALL_ACCESS)
        )
          return false;
        throw new Error("Private path has another owner.");
      }
      const control = [0];
      checked(getControl(descriptor, control, [0]), "descriptor control query");
      if (!((control[0] ?? 0) & SE_DACL_PROTECTED) || !dacl) return false;
      const entries = aclEntries(dacl);
      const ace = entries[0];
      return (
        entries.length === 1 &&
        ace?.type === 0 &&
        ace.flags === (directory ? 3 : 0) &&
        ace.mask === FILE_ALL_ACCESS &&
        ace.sid === user
      );
    });
  }

  function descriptorFor<T>(directory: boolean, action: (descriptor: Pointer, dacl: Pointer, owner: Pointer) => T): T {
    const descriptor: Pointer[] = [null];
    checked(
      fromString(`O:${user}D:P(A;${directory ? "OICI" : ""};FA;;;${user})`, 1, descriptor, null),
      "descriptor creation",
    );
    try {
      const dacl: Pointer[] = [null];
      const owner: Pointer[] = [null];
      checked(getDacl(descriptor[0], [0], dacl, [0]), "descriptor ACL query");
      checked(getOwner(descriptor[0], owner, [0]), "descriptor owner query");
      return action(descriptor[0] ?? null, dacl[0] ?? null, owner[0] ?? null);
    } finally {
      localFree(descriptor[0]);
    }
  }

  function open(path: string, directory: boolean, writable: boolean): Handle {
    // Do not follow the final reparse point or permit replacement during validation/repair/read.
    const handle = createFile(
      toNamespacedPath(path),
      READ_CONTROL | (writable ? WRITE_DAC | (administratorOwner ? 0x80000 : 0) : 0) | 0x80 | (directory ? 0 : 1),
      3,
      null,
      3,
      0x00200000 | 0x02000000,
      0,
    ) as Handle;
    if (handle === -1 || handle === -1n) {
      const code = lastError();
      throw Object.assign(new Error(`Cannot open private path (${code}).`), {
        code: code === 2 || code === 3 ? "ENOENT" : code === 32 || code === 33 ? "EBUSY" : "EACCES",
      });
    }
    try {
      const metadata: { attributes?: number; links?: number } = {};
      checked(info(handle, metadata), "file identity query");
      if (
        (metadata.attributes ?? 0) & FILE_ATTRIBUTE_REPARSE_POINT ||
        Boolean((metadata.attributes ?? 0) & FILE_ATTRIBUTE_DIRECTORY) !== directory ||
        (!directory && metadata.links !== 1)
      ) {
        throw new Error(
          "Private path must be a single-link regular file or directory, not a reparse point or hard link.",
        );
      }
      return handle;
    } catch (error) {
      close(handle);
      throw error;
    }
  }

  return {
    access<T>(path: string, directory: boolean, repair: boolean, action: (changed: boolean, handle: Handle) => T): T {
      const handle = open(path, directory, repair);
      try {
        const changed = !isPrivate(handle, directory);
        if (changed) {
          if (!repair) throw new Error("Private path permissions are not restricted to the current user.");
          descriptorFor(directory, (_descriptor, dacl, owner) => {
            const status = setSecurity(
              handle,
              1,
              DACL_SECURITY_INFORMATION + PROTECTED_DACL_SECURITY_INFORMATION + (administratorOwner ? 1 : 0),
              administratorOwner ? owner : null,
              null,
              dacl,
              null,
            );
            if (status !== 0) throw new Error(`Windows private-file ACL update failed (${status}).`);
          });
          if (!isPrivate(handle, directory)) throw new Error("Private path ACL verification failed.");
        }
        return action(changed, handle);
      } finally {
        close(handle);
      }
    },
    read(path: string, maxBytes: number): string {
      return this.access(path, false, true, (_changed, handle) => {
        const size: Array<number | bigint> = [0];
        checked(sizeOfFile(handle, size), "size query");
        const length = Number(size[0]);
        const tooLarge = () => Object.assign(new Error(`Private file exceeds ${maxBytes} bytes.`), { code: "EFBIG" });
        if (!Number.isSafeInteger(length) || length < 0 || length > maxBytes) throw tooLarge();
        const data = Buffer.alloc(length + 1);
        let offset = 0;
        while (offset < data.byteLength) {
          const received = [0];
          checked(read(handle, data.subarray(offset), data.byteLength - offset, received, null), "read");
          if (!received[0]) break;
          offset += received[0];
        }
        if (offset > length || offset > maxBytes) throw tooLarge();
        return data.toString("utf8", 0, offset);
      });
    },
    directory(path: string): void {
      descriptorFor(true, (descriptor) => {
        if (!createDirectory(toNamespacedPath(path), { length: koffi.sizeof(attributes), descriptor, inherit: 0 })) {
          const code = lastError();
          throw Object.assign(new Error(`Cannot create private directory (${code}).`), {
            code: code === 183 ? "EEXIST" : "EACCES",
          });
        }
      });
      this.access(path, true, false, () => undefined);
    },
    create(path: string, contents: Uint8Array): void {
      descriptorFor(false, (descriptor) => {
        const handle = createFile(
          toNamespacedPath(path),
          0x40000000 | READ_CONTROL | 0x10000,
          0,
          { length: koffi.sizeof(attributes), descriptor, inherit: 0 },
          1,
          0x80,
          0,
        ) as Handle;
        if (handle === -1 || handle === -1n) {
          const code = lastError();
          throw Object.assign(new Error(`Cannot create private file (${code}).`), {
            code: code === 80 || code === 183 ? "EEXIST" : "EACCES",
          });
        }
        try {
          if (!isPrivate(handle, false)) throw new Error("New private-file ACL verification failed.");
          const written = [0];
          checked(write(handle, contents, contents.byteLength, written, null), "write");
          if (written[0] !== contents.byteLength) throw new Error("Private-file write was incomplete.");
          checked(flush(handle), "flush");
        } catch (error) {
          const disposition = Buffer.from([1]);
          try {
            checked(dispose(handle, 4, disposition, disposition.length), "failed-file removal");
          } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], "Private-file creation and cleanup failed.");
          }
          throw error;
        } finally {
          close(handle);
        }
      });
    },
  };
}

let api: ReturnType<typeof loadApi> | undefined;
export function windowsPrivacy(): ReturnType<typeof loadApi> {
  api ??= loadApi();
  return api;
}
