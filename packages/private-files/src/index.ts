import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { windowsPrivacy } from "./windows-private-paths.js";

interface PrivatePathOptions {
  directory?: boolean;
  mode?: number;
}

function accessPosix<T>(
  path: string,
  options: PrivatePathOptions,
  repair: boolean,
  action: (fd: number, changed: boolean) => T,
): T {
  const directory = options.directory ?? false;
  const mode = options.mode ?? (directory ? 0o700 : 0o600);
  const before = lstatSync(path, { bigint: true });
  if (
    before.isSymbolicLink() ||
    (directory ? !before.isDirectory() : !before.isFile()) ||
    (!directory && before.nlink !== 1n) ||
    (process.getuid && before.uid !== BigInt(process.getuid()))
  ) {
    throw new Error("Private path must be owned by the current user and cannot be a link or nonregular entry.");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.uid !== before.uid ||
      opened.nlink !== before.nlink
    ) {
      throw new Error("Private path changed while it was opened.");
    }
    const changed = (opened.mode & 0o7777n) !== BigInt(mode);
    if (changed) {
      if (!repair) throw new Error("Private path permissions are not restricted to the current user.");
      fchmodSync(fd, mode);
      if ((fstatSync(fd).mode & 0o7777) !== mode) throw new Error("Private path permission verification failed.");
    }
    const result = action(fd, changed);
    const current = lstatSync(path, { bigint: true });
    const after = fstatSync(fd, { bigint: true });
    if (
      current.isSymbolicLink() ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino ||
      after.nlink !== opened.nlink
    ) {
      throw new Error("Private path changed during access.");
    }
    return result;
  } finally {
    closeSync(fd);
  }
}

function validateMode(mode: number): void {
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o700 || (mode & 0o077) !== 0)
    throw new Error("Private-file mode must grant access only to its owner.");
}

export function assertPrivatePathSync(path: string, options: PrivatePathOptions = {}): void {
  validateMode(options.mode ?? (options.directory ? 0o700 : 0o600));
  if (process.platform === "win32") {
    windowsPrivacy().access(resolve(path), options.directory ?? false, false, () => undefined);
  } else {
    accessPosix(path, options, false, () => undefined);
  }
}

export function protectPrivatePathSync(path: string, options: PrivatePathOptions = {}): boolean {
  validateMode(options.mode ?? (options.directory ? 0o700 : 0o600));
  return process.platform === "win32"
    ? windowsPrivacy().access(resolve(path), options.directory ?? false, true, (changed) => changed)
    : accessPosix(path, options, true, (_fd, changed) => changed);
}

export function ensurePrivateDirectorySync(path: string): void {
  if (process.platform !== "win32") {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  } else {
    const missing: string[] = [];
    let candidate = resolve(path);
    while (true) {
      try {
        const existing = lstatSync(candidate);
        if (existing.isSymbolicLink() || !existing.isDirectory())
          throw new Error("Private directory ancestor must be a regular directory.");
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        missing.unshift(candidate);
        candidate = dirname(candidate);
      }
    }
    for (const directory of missing) {
      try {
        windowsPrivacy().directory(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        protectPrivatePathSync(directory, { directory: true });
      }
    }
  }
  protectPrivatePathSync(path, { directory: true });
}

export function writePrivateFileSync(path: string, contents: string | Uint8Array, mode = 0o600): void {
  validateMode(mode);
  if (process.platform === "win32") {
    windowsPrivacy().create(resolve(path), typeof contents === "string" ? Buffer.from(contents, "utf8") : contents);
    return;
  }
  const fd = openSync(path, "wx", mode);
  try {
    fchmodSync(fd, mode);
    if ((fstatSync(fd).mode & 0o7777) !== mode) throw new Error("New private-file permission verification failed.");
    writeFileSync(fd, contents);
    fsyncSync(fd);
  } catch (error) {
    try {
      const opened = fstatSync(fd, { bigint: true });
      const current = lstatSync(path, { bigint: true, throwIfNoEntry: false });
      if (current) {
        if (current.dev !== opened.dev || current.ino !== opened.ino || current.isSymbolicLink())
          throw new Error("Private path changed before failed-file cleanup.");
        unlinkSync(path);
      }
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Private-file creation and cleanup failed.");
    }
    throw error;
  } finally {
    closeSync(fd);
  }
}

function readBounded(fd: number, maxBytes: number): string {
  const size = fstatSync(fd).size;
  const tooLarge = () => Object.assign(new Error(`Private file exceeds ${maxBytes} bytes.`), { code: "EFBIG" });
  if (size > maxBytes) throw tooLarge();
  const buffer = Buffer.alloc(size + 1);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const length = readSync(fd, buffer, offset, buffer.byteLength - offset, offset);
    if (!length) break;
    offset += length;
  }
  if (offset > maxBytes || offset > size) throw tooLarge();
  return buffer.toString("utf8", 0, offset);
}

export function readPrivateFileSync(path: string, maxBytes = 16 * 1024 * 1024): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new Error("Private-file size limit must be a nonnegative integer.");
  return process.platform === "win32"
    ? windowsPrivacy().read(resolve(path), maxBytes)
    : accessPosix(path, {}, true, (fd) => readBounded(fd, maxBytes));
}
