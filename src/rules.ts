// Secret scanning rules — pure, RAM-only, zero deps.
// Scans short indexed units (8..320 chars) for high-precision credential patterns.
// Panel/worker attach the FIRST hit only as `sec` on a unit:
//   findings are { rule: string; sev: Severity; label: string } = SecretHit.

import type { Severity } from './types.js';

export interface SecretRule {
  id: string;
  label: string;
  severity: Severity;
  pattern: RegExp;
}

export interface SecretHit {
  rule: string;
  sev: Severity;
  label: string;
}

// ~41 high-precision rules. All patterns are NON-global (tested once per call).
// \b boundaries where possible to avoid matching inside longer identifiers.
export const SECRET_RULES: SecretRule[] = [
  { id: 'aws_access_key', label: 'AWS access key ID', severity: 'critical', pattern: /\bAKIA[0-9A-Z]{16,}\b/ },
  { id: 'aws_secret_key', label: 'AWS secret access key', severity: 'critical', pattern: /aws_secret_access_key\s*[:=]\s*['"]?[A-Za-z0-9/+=]{30,}['"]?/i },
  { id: 'github_token', label: 'GitHub token', severity: 'critical', pattern: /\b(ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|ghu_[A-Za-z0-9]{20,}|ghs_[A-Za-z0-9]{20,}|ghr_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { id: 'gitlab_token', label: 'GitLab token', severity: 'high', pattern: /\bglpat-[A-Za-z0-9\-_]{16,}\b/ },
  { id: 'slack_token', label: 'Slack token', severity: 'critical', pattern: /\bxox[baprs]-[A-Za-z0-9\-]{10,}\b/ },
  { id: 'slack_webhook', label: 'Slack webhook', severity: 'high', pattern: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{10,}/ },
  { id: 'stripe_live', label: 'Stripe live secret key', severity: 'critical', pattern: /\bsk_live_[A-Za-z0-9]{16,}\b/ },
  { id: 'square_token', label: 'Square access token', severity: 'high', pattern: /\bsq0atp-[A-Za-z0-9\-_]{16,}\b/ },
  { id: 'paypal_braintree', label: 'PayPal/Braintree secret', severity: 'high', pattern: /(?:paypal[_-]?secret|braintree[_-]?(?:api|token|key))\s*[:=]\s*['"]?[A-Za-z0-9\-_]{16,}['"]?/i },
  { id: 'google_api_key', label: 'Google API key', severity: 'medium', pattern: /\bAIza[0-9A-Za-z\-_]{30,}\b/ },
  { id: 'firebase_key', label: 'Firebase URL', severity: 'medium', pattern: /\b[A-Za-z0-9\-]+\.firebaseio\.com\b/ },
  { id: 'twilio_sid', label: 'Twilio SID', severity: 'high', pattern: /\bAC[0-9a-fA-F]{30,}\b/ },
  { id: 'twilio_auth', label: 'Twilio auth token', severity: 'high', pattern: /twilio[_-]?auth[_-]?token\s*[:=]\s*['"]?[0-9a-fA-F]{20,}['"]?/i },
  { id: 'twilio_api_key', label: 'Twilio API key', severity: 'high', pattern: /\bSK[0-9a-fA-F]{30,}\b/ },
  { id: 'sendgrid', label: 'SendGrid API key', severity: 'high', pattern: /\bSG\.[A-Za-z0-9\-_]{16,}\.[A-Za-z0-9\-_]{16,}\b/ },
  { id: 'mailgun', label: 'Mailgun API key', severity: 'high', pattern: /\bkey-[0-9a-fA-F]{24,}\b/ },
  { id: 'jwt', label: 'JSON Web Token', severity: 'high', pattern: /\beyJ[A-Za-z0-9\-_]{8,}\.[A-Za-z0-9\-_]{8,}\.[A-Za-z0-9\-_]{8,}\b/ },
  { id: 'rsa_private_key', label: 'RSA private key', severity: 'critical', pattern: /-----BEGIN RSA PRIVATE KEY-----/ },
  { id: 'dsa_private_key', label: 'DSA private key', severity: 'critical', pattern: /-----BEGIN DSA PRIVATE KEY-----/ },
  { id: 'ec_private_key', label: 'EC private key', severity: 'critical', pattern: /-----BEGIN EC PRIVATE KEY-----/ },
  { id: 'openssh_private_key', label: 'OpenSSH private key', severity: 'critical', pattern: /-----BEGIN OPENSSH PRIVATE KEY-----/ },
  { id: 'private_key_generic', label: 'Generic private key', severity: 'critical', pattern: /-----BEGIN PRIVATE KEY-----/ },
  { id: 'bearer_token', label: 'Bearer token', severity: 'high', pattern: /\bbearer\s+[A-Za-z0-9\-._~+/=]{16,}/i },
  { id: 'basic_auth', label: 'Basic auth', severity: 'high', pattern: /\bbasic\s+[A-Za-z0-9+/=]{12,}/i },
  { id: 'openai_key', label: 'OpenAI API key', severity: 'critical', pattern: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { id: 'anthropic_key', label: 'Anthropic API key', severity: 'critical', pattern: /\bsk-ant-[A-Za-z0-9\-_]{20,}\b/ },
  { id: 'discord_token', label: 'Discord bot token', severity: 'high', pattern: /\b[MN][A-Za-z0-9\-_]{20,}\.[A-Za-z0-9\-_]{5,}\.[A-Za-z0-9\-_]{20,}\b/ },
  { id: 'discord_webhook', label: 'Discord webhook', severity: 'high', pattern: /https:\/\/discord(?:app)?\.com\/api\/webhooks\/[0-9]{10,}\/[A-Za-z0-9\-_]{20,}/ },
  { id: 'telegram_bot', label: 'Telegram bot token', severity: 'high', pattern: /\b[0-9]{8,10}:[A-Za-z0-9\-_]{30,}\b/ },
  { id: 'npm_token', label: 'npm token', severity: 'high', pattern: /\bnpm_[A-Za-z0-9]{20,}\b/ },
  { id: 'pypi_token', label: 'PyPI token', severity: 'high', pattern: /\bpypi-[A-Za-z0-9\-_]{20,}\b/ },
  { id: 'heroku_key', label: 'Heroku API key', severity: 'high', pattern: /heroku[_-]?api[_-]?key\s*[:=]\s*['"]?[0-9a-fA-F\-]{20,}['"]?/i },
  { id: 'azure_sas', label: 'Azure SAS token', severity: 'high', pattern: /\?sig=[A-Za-z0-9%\-_]{20,200}/ },
  { id: 'connection_string', label: 'DB connection string', severity: 'critical', pattern: /\b(?:mongodb(?:\+srv)?:\/\/|postgres(?:ql)?:\/\/)[^\s'"`]+:[^\s'"`]+@[^\s'"`]+/i },
  { id: 'square_oauth', label: 'Square OAuth secret', severity: 'high', pattern: /\bsq0csp-[A-Za-z0-9\-_]{16,}\b/ },
  { id: 'mailchimp', label: 'Mailchimp API key', severity: 'high', pattern: /\b[0-9a-fA-F]{32}-us[0-9]{1,2}\b/ },
  { id: 'algolia_api', label: 'Algolia API key', severity: 'medium', pattern: /algolia[_-]?api[_-]?key\s*[:=]\s*['"]?[A-Za-z0-9]{20,}['"]?/i },
  { id: 'mapbox', label: 'Mapbox token', severity: 'medium', pattern: /\b(?:pk|sk)\.[A-Za-z0-9\-_]{20,}\.[A-Za-z0-9\-_]{20,}\b/ },
  { id: 'cloudflare_token', label: 'Cloudflare API token', severity: 'high', pattern: /\bcfpat-[A-Za-z0-9\-_]{20,}\b/ },
  { id: 'digitalocean_token', label: 'DigitalOcean token', severity: 'high', pattern: /\b(?:dop_v1_[A-Za-z0-9]{30,}|do_pat_[A-Za-z0-9\-_]{20,})\b/ },
  { id: 'gcp_service_account', label: 'GCP service account', severity: 'high', pattern: /"type"\s*:\s*"service_account"/ },
  { id: 'openai_project', label: 'OpenAI project key', severity: 'critical', pattern: /\bsk-proj-[A-Za-z0-9\-_]{20,}\b/ },
  { id: 'aws_session_token', label: 'AWS session token', severity: 'critical', pattern: /\bASIA[0-9A-Z]{16,}\b/ },
  { id: 'stripe_test', label: 'Stripe test/restricted key', severity: 'high', pattern: /\b(?:sk_test_|rk_live_|rk_test_)[A-Za-z0-9]{12,}\b/ },
  { id: 'slack_app_token', label: 'Slack app token', severity: 'high', pattern: /\bxox[ae]-[A-Za-z0-9\-]{10,}\b/ },
  { id: 'password_assignment', label: 'Password assignment', severity: 'high', pattern: /\b(passw(or)?d|passwd|pwd)\s*[:=]\s*["']?([^"'`\s]{6,128})/i },
  { id: 'private_secret_token', label: 'Private/secret token assignment', severity: 'high', pattern: /\b(?:private_token|secret_token)\s*[:=]\s*['"]?[A-Za-z0-9\-_]{16,}['"]?/i },
  { id: 'x_api_key', label: 'X-API-Key header value', severity: 'medium', pattern: /\bx-api-key\s*[:=]\s*['"]?[A-Za-z0-9\-_]{16,}['"]?/i },
  { id: 'npm_auth_token', label: 'npm auth token', severity: 'high', pattern: /\b_authToken\s*[:=]\s*['"]?[A-Za-z0-9\-_]{16,}['"]?/ },
  { id: 'generic_secret_assignment', label: 'Generic credential assignment', severity: 'medium', pattern: /\b(api[_-]?key|api[_-]?secret|secret[_-]?key|client[_-]?secret|auth[_-]?token|access[_-]?token)\s*[:=]\s*["']?([^"'`\s]{8,128})/i },
];

const PLACEHOLDER_WORDS: ReadonlySet<string> = new Set([
  'example', 'test', 'testing', 'tests', 'demo', 'sample', 'placeholder',
  'fake', 'dummy', 'mock', 'changeme', 'yourkey', 'insert', 'todo', 'xxx', 'xxxx',
]);

/**
 * Fast pure string checks for fixture/placeholder matches.
 * True for example/test/demo/sample/placeholder/xxx tokens, `xxxx`-style
 * repeated-char runs, and `abcd1234`-style fixture sequences.
 * Uses word-token equality (not substring) so embedded words like the
 * `EXAMPLE` inside `AKIAIOSFODNN7EXAMPLEX` stay negative.
 */
export function isPlaceholder(v: string): boolean {
  if (!v) return true;
  const s = v.toLowerCase();
  // Repeated-char runs like 'xxxx', '0000' (4+ identical in a row).
  for (let i = 0; i + 3 < s.length; i++) {
    const c = s.charCodeAt(i);
    if (s.charCodeAt(i + 1) === c && s.charCodeAt(i + 2) === c && s.charCodeAt(i + 3) === c) return true;
  }
  if (s.includes('xxx') || s.includes('***')) return true;
  if (s.includes('abcd') || s.includes('123456') || s.includes('qwerty') || s.includes('password')) return true;
  const parts = s.split(/[^a-z0-9]+/);
  for (const p of parts) {
    if (!p) continue;
    if (PLACEHOLDER_WORDS.has(p)) return true;
  }
  return false;
}

/**
 * Scan short text (8..320 chars) for secrets. Each SECRET_RULES pattern is
 * tested once; full matches that look like placeholders are skipped.
 * Results capped at maxHits (default 3).
 */
export function scanTextForSecrets(text: string, maxHits = 3): SecretHit[] {
  if (!text || text.length < 8 || text.length > 320) return [];
  const out: SecretHit[] = [];
  for (const r of SECRET_RULES) {
    const m = r.pattern.exec(text);
    if (!m) continue;
    const full = m[0];
    if (!full || isPlaceholder(full)) continue;
    out.push({ rule: r.id, sev: r.severity, label: r.label });
    if (r.id === 'jwt' && out.length < maxHits) {
      if (decodeJwtAlg(full) === 'none') {
        out.push({ rule: 'jwt_none_alg', sev: 'critical', label: 'JWT with none algorithm' });
      }
    }
    if (out.length >= maxHits) break;
  }
  if (out.length === 0 && out.length < maxHits && /^[A-Za-z0-9\-_+/=]{24,96}$/.test(text) && shannon(text) >= 4.7) {
    out.push({ rule: 'high_entropy_string', sev: 'medium', label: 'High-entropy string (possible secret)' });
  }
  return out;
}

/**
 * Classic Shannon entropy over char frequencies, in bits.
 * 0 for uniform strings ('aaaaaaaa'), ~log2(n) for n distinct chars.
 */
export function shannon(s: string): number {
  if (!s) return 0;
  const freq = new Map<string, number>();
  for (const c of s) freq.set(c, (freq.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Best-effort decode of a JWT header's `alg`. Base64url-decodes segment 0
 * (via atob with '-'->'+', '_'->'/' + padding), JSON.parse tolerant.
 * Returns the alg string, or null on any failure.
 */
export function decodeJwtAlg(token: string): string | null {
  try {
    const seg0 = token.split('.')[0];
    if (!seg0) return null;
    const b64 = seg0.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const obj = JSON.parse(atob(padded)) as { alg?: unknown } | null;
    const alg = obj?.alg;
    return typeof alg === 'string' ? alg : null;
  } catch {
    return null;
  }
}
