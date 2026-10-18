import { execFileSync } from "node:child_process";
import { chmodSync } from "node:fs";

export { assertPrivatePathSync as assertPrivateFile } from "@expgolemclone/pi-private-files";

export function weakenFilePermissions(path: string): void {
  if (process.platform === "win32") {
    execFileSync("icacls.exe", [path, "/grant", "*S-1-1-0:(R)", "/q"], { stdio: "pipe", windowsHide: true });
  } else {
    chmodSync(path, 0o644);
  }
}
