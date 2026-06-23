export function withoutGitEnv(
  env: NodeJS.ProcessEnv = process.env,
  opts: { isolateConfig?: boolean | undefined } = {},
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("GIT_")) out[key] = value;
  }
  if (opts.isolateConfig) {
    out["GIT_CONFIG_NOSYSTEM"] = "1";
    out["GIT_CONFIG_GLOBAL"] = "/dev/null";
    out["GIT_CONFIG_COUNT"] = "3";
    out["GIT_CONFIG_KEY_0"] = "commit.gpgsign";
    out["GIT_CONFIG_VALUE_0"] = "false";
    out["GIT_CONFIG_KEY_1"] = "tag.gpgsign";
    out["GIT_CONFIG_VALUE_1"] = "false";
    out["GIT_CONFIG_KEY_2"] = "gpg.format";
    out["GIT_CONFIG_VALUE_2"] = "openpgp";
  }
  return out;
}
