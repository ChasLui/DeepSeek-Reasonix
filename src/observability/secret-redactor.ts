export type SecretRedactor = (text: string) => string;

const URL_USERINFO_RE = /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^@\s/]+@/gi;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._\-+/]+=*/g;
const SK_RE = /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{19,}\b/g;
const ENV_SECRET_RE =
  /\b([A-Za-z_][A-Za-z0-9_]*(?:_TOKEN|_KEY|_SECRET|_PASSWORD|_PASSWD|PASSWORD|PASSWD))\s*[=:]\s*\S+/g;
const GITHUB_PAT_RE = /\b(ghp_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9]{36,}\b/g;
const GITHUB_FINE_RE = /\bgithub_pat_[A-Za-z0-9_]{82,}\b/g;
const GITLAB_PAT_RE = /\bglpat-[A-Za-z0-9_-]{20,}\b/g;
const AWS_AKID_RE = /\b(AKIA|ASIA|AROA|AIDA)[A-Z0-9]{16}\b/g;
const STRIPE_LIVE_RE = /\bsk_live_[A-Za-z0-9]{24,}\b/g;
const SLACK_RE = /\b(xox[abprso]|xapp)-[A-Za-z0-9-]{10,}\b/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;

export const defaultRedactor: SecretRedactor = (text) =>
  text
    .replace(URL_USERINFO_RE, "$1[redacted]@")
    .replace(BEARER_RE, "Bearer [REDACTED]")
    .replace(SK_RE, "sk-[REDACTED]")
    .replace(ENV_SECRET_RE, "$1=[REDACTED]")
    .replace(GITHUB_PAT_RE, "[REDACTED]")
    .replace(GITHUB_FINE_RE, "[REDACTED]")
    .replace(GITLAB_PAT_RE, "[REDACTED]")
    .replace(AWS_AKID_RE, "[REDACTED]")
    .replace(STRIPE_LIVE_RE, "[REDACTED]")
    .replace(SLACK_RE, "[REDACTED]")
    .replace(JWT_RE, "[REDACTED]");
