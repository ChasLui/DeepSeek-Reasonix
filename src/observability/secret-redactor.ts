export type SecretRedactor = (text: string) => string;

const URL_USERINFO_RE = /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^@\s/]+@/gi;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._\-+/]+=*/g;
const SK_RE = /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{19,}\b/g;
const ENV_SECRET_RE =
  /\b([A-Za-z_][A-Za-z0-9_]*(?:_TOKEN|_KEY|_SECRET|_PASSWORD|_PASSWD|PASSWORD|PASSWD))\s*[=:]\s*\S+/g;

export const defaultRedactor: SecretRedactor = (text) =>
  text
    .replace(URL_USERINFO_RE, "$1[redacted]@")
    .replace(BEARER_RE, "Bearer [REDACTED]")
    .replace(SK_RE, "sk-[REDACTED]")
    .replace(ENV_SECRET_RE, "$1=[REDACTED]");
