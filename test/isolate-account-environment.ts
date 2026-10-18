import { afterEach, beforeEach } from "vitest";

/** Keep inherited process overrides out of tests that expect ordinary account selection. */
export function isolateAccountEnvironment(): void {
  const inherited = process.env.PI_ACCOUNT;
  beforeEach(() => {
    delete process.env.PI_ACCOUNT;
  });
  afterEach(() => {
    if (inherited === undefined) delete process.env.PI_ACCOUNT;
    else process.env.PI_ACCOUNT = inherited;
  });
}
