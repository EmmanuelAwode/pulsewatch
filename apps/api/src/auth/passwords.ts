import { hash, verify } from "@node-rs/argon2";

/**
 * Argon2id parameters (the library's default algorithm is Argon2id).
 *
 * These are OWASP's recommended minimum: 19 MiB of memory, 2 passes, 1 lane.
 * The memory cost is the point of Argon2: it makes each guess expensive on
 * GPUs and ASICs, where an attacker would otherwise try billions per second.
 *
 * The parameters are stored inside every hash, so they can be raised later
 * without invalidating existing passwords.
 */
const ARGON2_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

/** Returns false, never throws, for a wrong password or a malformed hash. */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Spends the same time as a real verification, for logins where the email
 * does not exist.
 *
 * Without this, "unknown email" returns in about a millisecond while "wrong
 * password" takes tens of milliseconds, and an attacker can tell which emails
 * have accounts just by timing responses.
 */
export async function verifyAgainstDummy(password: string): Promise<void> {
  dummyHash ??= hashPassword("dummy-password-for-timing-equalisation");
  await verifyPassword(await dummyHash, password);
}
