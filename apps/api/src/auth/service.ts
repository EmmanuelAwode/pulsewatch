import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@pulsewatch/database";
import type { LoginInput, RegisterInput } from "@pulsewatch/shared";
import { AppError, conflict, unauthenticated } from "../errors.js";
import { hashPassword, verifyAgainstDummy, verifyPassword } from "./passwords.js";
import type { TokenService } from "./tokens.js";

/** What the API is allowed to say about a user. Never includes the hash. */
export interface PublicUser {
  id: string;
  email: string;
  createdAt: Date;
}

export interface Session {
  user: PublicUser;
  accessToken: string;
  refreshToken: string;
}

export interface AuthServiceOptions {
  db: PrismaClient;
  tokens: TokenService;
  refreshTtlSeconds: number;
  now: () => Date;
}

export interface AuthService {
  register: (input: RegisterInput) => Promise<Session>;
  login: (input: LoginInput) => Promise<Session>;
  /** Exchanges a refresh token for a new session, rotating the token. */
  refresh: (refreshToken: string | undefined) => Promise<Session>;
  /** Revokes the session the token belongs to. Never fails. */
  logout: (refreshToken: string | undefined) => Promise<void>;
  /** Returns null when the user no longer exists. */
  getUser: (userId: string) => Promise<PublicUser | null>;
}

const PUBLIC_USER = { id: true, email: true, createdAt: true } as const;

const invalidCredentials = (): AppError =>
  new AppError(401, "INVALID_CREDENTIALS", "Incorrect email or password.");

const invalidSession = (): AppError => unauthenticated("Your session has expired. Log in again.");

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/**
 * Authentication business rules. Knows nothing about HTTP, cookies or
 * Fastify: it takes plain values and returns plain values, which is why it
 * can be reasoned about (and tested) independently of the transport.
 */
export function createAuthService(options: AuthServiceOptions): AuthService {
  const { db, tokens, now } = options;

  /** Creates a refresh-token row and the matching access token. */
  async function issueSession(
    client: PrismaClient | Prisma.TransactionClient,
    user: PublicUser,
    familyId: string,
  ): Promise<Session> {
    const refreshToken = tokens.generateRefreshToken();
    await client.refreshToken.create({
      data: {
        userId: user.id,
        familyId,
        tokenHash: tokens.hashRefreshToken(refreshToken),
        expiresAt: new Date(now().getTime() + options.refreshTtlSeconds * 1000),
      },
    });
    return { user, accessToken: await tokens.signAccessToken(user.id), refreshToken };
  }

  async function revokeFamily(familyId: string): Promise<void> {
    await db.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: now() },
    });
  }

  return {
    async register({ email, password }) {
      const passwordHash = await hashPassword(password);
      try {
        const user = await db.user.create({ data: { email, passwordHash }, select: PUBLIC_USER });
        return await issueSession(db, user, randomUUID());
      } catch (error) {
        // Let the database's unique constraint decide, rather than checking
        // first and inserting second: two simultaneous registrations would
        // both pass a check, but only one can pass the constraint.
        if (isUniqueViolation(error)) {
          throw conflict("An account with this email already exists.");
        }
        throw error;
      }
    },

    async login({ email, password }) {
      const user = await db.user.findUnique({ where: { email } });
      if (!user) {
        await verifyAgainstDummy(password);
        throw invalidCredentials();
      }
      if (!(await verifyPassword(user.passwordHash, password))) {
        // Same error as "no such user", so the response does not reveal
        // whether the email is registered.
        throw invalidCredentials();
      }
      const { id, createdAt } = user;
      return issueSession(db, { id, email: user.email, createdAt }, randomUUID());
    },

    async refresh(refreshToken) {
      if (!refreshToken) throw invalidSession();

      const stored = await db.refreshToken.findUnique({
        where: { tokenHash: tokens.hashRefreshToken(refreshToken) },
        include: { user: { select: PUBLIC_USER } },
      });
      if (!stored) throw invalidSession();

      // Re-use detection. A token is revoked the moment it is exchanged, so a
      // revoked token arriving again means two parties hold it: the real user
      // and someone who copied it. We cannot tell which is which, so every
      // token descended from that login is revoked and both must log in again.
      if (stored.revokedAt) {
        await revokeFamily(stored.familyId);
        throw invalidSession();
      }
      if (stored.expiresAt <= now()) throw invalidSession();

      const session = await db.$transaction(async (tx) => {
        // Conditional update: succeeds only if the token is still unrevoked.
        // If two requests present the same token at once, the database lets
        // exactly one of them through.
        const claimed = await tx.refreshToken.updateMany({
          where: { id: stored.id, revokedAt: null },
          data: { revokedAt: now() },
        });
        if (claimed.count === 0) return null;
        return issueSession(tx, stored.user, stored.familyId);
      });

      if (!session) {
        await revokeFamily(stored.familyId);
        throw invalidSession();
      }
      return session;
    },

    async logout(refreshToken) {
      if (!refreshToken) return;
      const stored = await db.refreshToken.findUnique({
        where: { tokenHash: tokens.hashRefreshToken(refreshToken) },
        select: { familyId: true },
      });
      if (stored) await revokeFamily(stored.familyId);
    },

    getUser(userId) {
      return db.user.findUnique({ where: { id: userId }, select: PUBLIC_USER });
    },
  };
}
