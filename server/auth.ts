import { createHash, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTVerifyGetKey } from 'jose';
import type { Config } from './config.ts';
import type { Principal } from './service.ts';

export function authenticator(config: Config, keys?: JWTVerifyGetKey) {
  const jwks = keys ?? (config.OAUTH_JWKS_URL ? createRemoteJWKSet(new URL(config.OAUTH_JWKS_URL)) : undefined);
  const devOwner = 'development';
  return {
    authorized: (owner: string) => config.DEV_MCP_TOKEN
      ? owner === devOwner
      : config.subjects.has(owner),
    async authenticate(header: string | undefined): Promise<Principal | undefined> {
      if (!header?.startsWith('Bearer ')) return undefined;
      const token = header.slice(7);
      if (config.DEV_MCP_TOKEN) {
        const actual = createHash('sha256').update(token).digest();
        const expected = createHash('sha256').update(config.DEV_MCP_TOKEN).digest();
        return timingSafeEqual(actual, expected) ? { id: devOwner, expiresAt: Date.now() + 3_600_000 } : undefined;
      }
      try {
        const { payload } = await jwtVerify(token, jwks!, {
          issuer: config.OAUTH_ISSUER,
          audience: `${config.PUBLIC_URL!.replace(/\/$/, '')}/mcp`,
          algorithms: ['RS256', 'ES256', 'EdDSA'],
          requiredClaims: ['sub', 'exp', 'iat']
        });
        if (!payload.sub || !config.subjects.has(payload.sub)) return undefined;
        if (typeof payload.scope !== 'string' || !payload.scope.split(' ').includes('alerts:read')) return undefined;
        return { id: payload.sub, expiresAt: payload.exp! * 1000 };
      } catch { return undefined; }
    }
  };
}
