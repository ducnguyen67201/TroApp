import { createHash } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import { ModelGatewayConfig } from './ModelGatewayConfig.js';

const ModelCredentialPolicy = {
  keyNamespace: 'tro-model-gateway-v1:',
  issuer: 'tro-api',
  audience: 'tro-model',
  scope: 'model',
} as const;

interface ModelCredential {
  token: string;
  expiresAt: string;
}

interface ModelCredentials {
  issueModelCredential(userId: string): Promise<ModelCredential>;
  isModelCredentialValid(token: string): Promise<boolean>;
}

/** Issue and verify short-lived model-only credentials using the existing signing format. */
export function createModelCredentials(secret: string): ModelCredentials {
  const signingKey = createHash('sha256')
    .update(ModelCredentialPolicy.keyNamespace)
    .update(secret)
    .digest();

  return {
    async issueModelCredential(userId: string): Promise<ModelCredential> {
      const expiresAt = new Date(Date.now() + ModelGatewayConfig.credentialTtlMs);
      const token = await new SignJWT({ scope: ModelCredentialPolicy.scope })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(userId)
        .setIssuer(ModelCredentialPolicy.issuer)
        .setAudience(ModelCredentialPolicy.audience)
        .setExpirationTime(expiresAt)
        .sign(signingKey);
      return { token, expiresAt: expiresAt.toISOString() };
    },

    async isModelCredentialValid(token: string): Promise<boolean> {
      try {
        const verified = await jwtVerify(token, signingKey, {
          issuer: ModelCredentialPolicy.issuer,
          audience: ModelCredentialPolicy.audience,
        });
        return (
          verified.payload.scope === ModelCredentialPolicy.scope && Boolean(verified.payload.sub)
        );
      } catch {
        return false;
      }
    },
  };
}
