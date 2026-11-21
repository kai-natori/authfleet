export const apiSettings = ["TOKEN_ENCRYPTION_KEY", "AUTHFLEET_OPERATOR_EMAILS"];
export const webSettings = ["AUTHFLEET_ACCESS_TEAM_DOMAIN", "AUTHFLEET_ACCESS_AUD"];

export function planSecrets(existingNames, env, settings) {
  const existing = new Set(existingNames);
  return settings
    .filter((name) => !existing.has(name))
    .map((name) => {
      if (name === "TOKEN_ENCRYPTION_KEY") return { name, source: "generate" };
      const value = env[name]?.trim();
      return value ? { name, source: "env", value } : { name, source: "prompt" };
    });
}

export function parseSecretNames(output) {
  const secrets = JSON.parse(output);
  if (!Array.isArray(secrets) || secrets.some((entry) => typeof entry?.name !== "string")) {
    throw new Error("Wrangler returned an invalid secret list; refusing to change secrets.");
  }
  return secrets.map((entry) => entry.name);
}

export function missingInputsMessage(plan) {
  const missing = plan.filter((entry) => entry.source === "prompt").map((entry) => entry.name);
  return missing.length
    ? `Missing deployment settings: ${missing.join(", ")}. Set these environment variables or rerun in an interactive terminal.`
    : null;
}
