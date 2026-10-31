import { z } from 'zod';

const envSchema = z.object({
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_PATH: z.string().default('data/alerts.sqlite'),
  SOURCE_ID: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/).default('grafana'),
  GRAFANA_WEBHOOK_SECRET: z.string().min(32),
  STORAGE_KEY: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
  PUBLIC_URL: z.url().optional(),
  AUTH_MODE: z.enum(['oauth', 'cloudflare']).default('oauth'),
  CF_ACCESS_TEAM_DOMAIN: z.string().regex(/^[a-z0-9-]+\.cloudflareaccess\.com$/).optional(),
  CF_ACCESS_AUD: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  CF_ACCESS_ALLOWED_EMAILS: z.string().optional(),
  OAUTH_ISSUER: z.url().optional(),
  OAUTH_JWKS_URL: z.url().optional(),
  OAUTH_ALLOWED_SUBJECTS: z.string().optional(),
  DEV_MCP_TOKEN: z.string().min(32).optional()
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.parse(Object.fromEntries(Object.entries(env).filter(([, value]) => value !== '')));
  if (parsed.DEV_MCP_TOKEN) {
    if (parsed.HOST !== '127.0.0.1' || env.NODE_ENV === 'production') {
      throw new Error('DEV_MCP_TOKEN requires HOST=127.0.0.1 and a non-production environment');
    }
    if (parsed.OAUTH_ISSUER || parsed.AUTH_MODE === 'cloudflare') throw new Error('Choose one authentication mode');
  } else {
    const urls = parsed.AUTH_MODE === 'cloudflare' ? ['PUBLIC_URL'] as const : ['PUBLIC_URL', 'OAUTH_ISSUER', 'OAUTH_JWKS_URL'] as const;
    for (const key of urls) {
      const value = parsed[key];
      if (!value || new URL(value).protocol !== 'https:' || new URL(value).username || new URL(value).password) {
        throw new Error(`${key} must be a credential-free HTTPS URL`);
      }
    }
    if (parsed.AUTH_MODE === 'oauth' && !parsed.OAUTH_ALLOWED_SUBJECTS?.trim()) throw new Error('OAUTH_ALLOWED_SUBJECTS is required');
    if (new URL(parsed.PUBLIC_URL!).origin !== parsed.PUBLIC_URL) throw new Error('PUBLIC_URL must be an HTTPS origin without a trailing slash');
  }
  const subjects = new Set((parsed.OAUTH_ALLOWED_SUBJECTS ?? '').split(',').map(s => s.trim()).filter(Boolean));
  const accessEmails = new Set((parsed.CF_ACCESS_ALLOWED_EMAILS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
  if (parsed.AUTH_MODE === 'cloudflare') {
    if (!parsed.CF_ACCESS_TEAM_DOMAIN || !parsed.CF_ACCESS_AUD || !accessEmails.size) throw new Error('Cloudflare authentication requires team domain, audience, and allowed emails');
    for (const email of accessEmails) z.email().parse(email);
    if (parsed.OAUTH_ISSUER || parsed.OAUTH_JWKS_URL || subjects.size) throw new Error('Do not mix OAuth and Cloudflare configuration');
  }
  return { ...parsed, subjects, accessEmails, storageKey: Buffer.from(parsed.STORAGE_KEY, 'base64') };
}
export type Config = ReturnType<typeof loadConfig>;
