import { describe, expect, it } from 'vitest';
import { AuthUserSchema } from '#contracts/AuthSession.js';

const user = { id: 'test-user', name: 'Test User', email: 'test@example.test' };

describe('authenticated administrator metadata', () => {
  it('defaults older profiles to no administrator access', () => {
    expect(AuthUserSchema.parse(user)).toEqual({ ...user, isAdmin: false });
  });

  it('preserves an explicit administrator flag without coercing other values', () => {
    expect(AuthUserSchema.parse({ ...user, isAdmin: true }).isAdmin).toBe(true);
    expect(AuthUserSchema.parse({ ...user, isAdmin: false }).isAdmin).toBe(false);
    for (const isAdmin of ['true', 'false', 0, 1, null]) {
      expect(AuthUserSchema.safeParse({ ...user, isAdmin }).success).toBe(false);
    }
  });
});
