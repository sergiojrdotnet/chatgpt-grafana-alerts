import { createHash, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTVerifyGetKey } from 'jose';
import type { Config } from './config.ts';
import type { Principal } from './service.ts';

export function authenticator(config: Config, keys?: JWTVerifyGetKey) {
  const accessMode = config.AUTH_MODE === 'cloudflare';
  const issuer = accessMode ? `https://${config.CF_ACCESS_TEAM_DOMAIN}` : config.OAUTH_ISSUER;
  const keyUrl = accessMode ? `${issuer}/cdn-cgi/access/certs` : config.OAUTH_JWKS_URL;
  const jwks = keys ?? (keyUrl ? createRemoteJWKSet(new URL(keyUrl)) : undefined);
  const devOwner = 'development';
  function authorized(owner: string) {
    if (config.DEV_MCP_TOKEN) return owner === devOwner;
    if (!accessMode) return config.subjects.has(owner);
    try {
      const identity = JSON.parse(owner);
      return identity.issuer === issuer && typeof identity.subject === 'string' && identity.subject.length > 0
        && typeof identity.email === 'string' && config.accessEmails.has(identity.email);
    } catch { return false; }
  }
  return {
    authorized,
    async authenticate(header: string | undefined, assertion?: string): Promise<Principal | undefined> {
      const token = accessMode ? assertion : header?.startsWith('Bearer ') ? header.slice(7) : undefined;
      if (!token) return undefined;
      if (config.DEV_MCP_TOKEN) {
        const actual = createHash('sha256').update(token).digest();
        const expected = createHash('sha256').update(config.DEV_MCP_TOKEN).digest();
        return timingSafeEqual(actual, expected) ? { id: devOwner, expiresAt: Date.now() + 3_600_000 } : undefined;
      }
      try {
        const { payload } = await jwtVerify(token, jwks!, {
          issuer,
          audience: accessMode ? config.CF_ACCESS_AUD : `${config.PUBLIC_URL!.replace(/\/$/, '')}/mcp`,
          algorithms: accessMode ? ['RS256'] : ['RS256', 'ES256', 'EdDSA'],
          requiredClaims: ['sub', 'exp', 'iat']
        });
        if (!payload.sub) return undefined;
        if (accessMode) {
          if (typeof payload.email !== 'string' || payload.type !== 'app') return undefined;
          const email = payload.email.toLowerCase();
          if (!config.accessEmails.has(email)) return undefined;
          return { id: JSON.stringify({ issuer, subject: payload.sub, email }), expiresAt: payload.exp! * 1000 };
        }
        if (!payload.sub || !config.subjects.has(payload.sub)) return undefined;
        if (typeof payload.scope !== 'string' || !payload.scope.split(' ').includes('alerts:read')) return undefined;
        return { id: payload.sub, expiresAt: payload.exp! * 1000 };
      } catch { return undefined; }
    }
  };
}
