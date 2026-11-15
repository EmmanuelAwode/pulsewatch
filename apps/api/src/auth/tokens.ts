import { createHash, randomBytes } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";

const ISSUER = "pulsewatch";
const AUDIENCE = "pulsewatch-api";
const ALGORITHM = "HS256";

export interface TokenServiceOptions {
  /** HMAC secret for access tokens. At least 32 characters (validated in config). */
  accessSecret: string;
  accessTtlSeconds: number;
  /** Injected so tests can move time forward instead of sleeping. */
  now: () => Date;
}

export interface TokenService {
  signAccessToken: (userId: string) => Promise<string>;
  /** Returns the user ID, or null for any token that is invalid for any reason. */
  verifyAccessToken: (token: string) => Promise<string | null>;
  generateRefreshToken: () => string;
  hashRefreshToken: (token: string) => string;
}

export function createTokenService(options: TokenServiceOptions): TokenService {
  const key = new TextEncoder().encode(options.accessSecret);
  const nowSeconds = (): number => Math.floor(options.now().getTime() / 1000);

  return {
    async signAccessToken(userId) {
      const issuedAt = nowSeconds();
      return new SignJWT({})
        .setProtectedHeader({ alg: ALGORITHM })
        .setSubject(userId)
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setIssuedAt(issuedAt)
        .setExpirationTime(issuedAt + options.accessTtlSeconds)
        .sign(key);
    },

    async verifyAccessToken(token) {
      try {
        const { payload } = await jwtVerify(token, key, {
          // Pinning the algorithm is essential. A verifier that trusts the
          // token's own "alg" header can be handed a token with alg "none"
          // (no signature at all) and accept it.
          algorithms: [ALGORITHM],
          issuer: ISSUER,
          audience: AUDIENCE,
          currentDate: options.now(),
        });
        return typeof payload.sub === "string" ? payload.sub : null;
      } catch {
        // Expired, tampered, wrong key, wrong algorithm, malformed: the caller
        // treats them all the same, so the reason is deliberately discarded.
        return null;
      }
    },

    /**
     * Refresh tokens are opaque random strings, not JWTs. They are looked up
     * in the database on every use anyway (that is what makes them
     * revocable), so a self-describing format would add nothing.
     */
    generateRefreshToken() {
      return randomBytes(32).toString("base64url");
    },

    /**
     * Only this hash is stored. SHA-256 is enough here, unlike for passwords:
     * the input is 256 random bits, so it cannot be guessed or brute-forced,
     * and a fast hash keeps every refresh cheap.
     */
    hashRefreshToken(token) {
      return createHash("sha256").update(token).digest("hex");
    },
  };
}
