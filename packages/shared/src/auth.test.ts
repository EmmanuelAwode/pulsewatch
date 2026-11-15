import { describe, expect, it } from "vitest";
import { loginSchema, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, registerSchema } from "./auth.js";

const password = "correct horse battery";

describe("registerSchema", () => {
  it("normalises the email to trimmed lower-case", () => {
    const result = registerSchema.parse({ email: "  User@Example.COM ", password });

    expect(result.email).toBe("user@example.com");
  });

  it.each(["", "not-an-email", "a@", "@example.com", "a b@example.com"])(
    "rejects an invalid email (%j)",
    (email) => {
      expect(registerSchema.safeParse({ email, password }).success).toBe(false);
    },
  );

  it("accepts a password at each length bound and rejects one outside", () => {
    const withLength = (length: number) =>
      registerSchema.safeParse({ email: "a@example.com", password: "x".repeat(length) }).success;

    expect(withLength(PASSWORD_MIN_LENGTH - 1)).toBe(false);
    expect(withLength(PASSWORD_MIN_LENGTH)).toBe(true);
    expect(withLength(PASSWORD_MAX_LENGTH)).toBe(true);
    expect(withLength(PASSWORD_MAX_LENGTH + 1)).toBe(false);
  });

  it("does not impose character-class rules", () => {
    expect(registerSchema.safeParse({ email: "a@example.com", password }).success).toBe(true);
  });
});

describe("loginSchema", () => {
  it("does not reveal the password policy by rejecting a short password", () => {
    expect(loginSchema.safeParse({ email: "a@example.com", password: "short" }).success).toBe(true);
  });

  it("still bounds the password length", () => {
    const tooLong = "x".repeat(PASSWORD_MAX_LENGTH + 1);

    expect(loginSchema.safeParse({ email: "a@example.com", password: tooLong }).success).toBe(
      false,
    );
  });
});
