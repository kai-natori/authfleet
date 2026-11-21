import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  apiSettings,
  missingInputsMessage,
  parseSecretNames,
  planSecrets,
  webSettings,
} from "./deploy-plan.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);

function run(args, { capture = false, input, allowMissingWorker } = {}) {
  const result = spawnSync("pnpm", args, {
    cwd: root,
    encoding: "utf8",
    stdio:
      input !== undefined
        ? ["pipe", "pipe", "pipe"]
        : capture
          ? ["ignore", "pipe", "pipe"]
          : "inherit",
    input,
  });
  if (result.error)
    throw new Error("Could not start pnpm. Install dependencies and check your PATH.");
  if (result.status !== 0) {
    if (
      allowMissingWorker &&
      `${result.stdout}\n${result.stderr}`.includes(`Worker "${allowMissingWorker}" not found.`)
    )
      return "[]";
    throw new Error(
      `Deployment command failed: pnpm ${args.join(" ")}. Check Cloudflare authentication, account selection and permissions. No secret values are shown.`,
    );
  }
  return result.stdout;
}

function wrangler(app, args, options) {
  return run(["--filter", `@authfleet/${app}`, "exec", "wrangler", ...args], options);
}

async function prompt(name) {
  process.stdout.write(`Enter ${name} (input hidden): `);
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  try {
    const value = (await rl.question("")).trim();
    if (!value) throw new Error(`${name} must not be empty.`);
    return value;
  } finally {
    rl.close();
    process.stdout.write("\n");
  }
}

async function ensureSecrets(app, plan) {
  const missing = missingInputsMessage(plan);
  if (!interactive && missing) throw new Error(missing);
  for (const entry of plan) {
    const value =
      entry.source === "generate"
        ? randomBytes(32).toString("base64")
        : entry.source === "env"
          ? entry.value
          : await prompt(entry.name);
    wrangler(app, ["secret", "put", entry.name], { input: `${value}\n` });
    console.log(`Configured ${entry.name} for ${app}.`);
  }
}

async function main() {
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: Deployment runs directly with Node, outside Turbo.
  if (!interactive && (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID)) {
    throw new Error(
      "Non-interactive deployment requires CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.",
    );
  }
  wrangler("api", ["whoami", "--json"], { capture: true });
  const apiNames = parseSecretNames(
    wrangler("api", ["secret", "list", "--format", "json"], {
      capture: true,
      allowMissingWorker: "authfleet-api",
    }),
  );
  const webNames = parseSecretNames(
    wrangler("web", ["secret", "list", "--format", "json"], {
      capture: true,
      allowMissingWorker: "authfleet-web",
    }),
  );
  const apiPlan = planSecrets(apiNames, process.env, apiSettings);
  const webPlan = planSecrets(webNames, process.env, webSettings);
  const missing = missingInputsMessage([...apiPlan, ...webPlan]);
  if (!interactive && missing) throw new Error(missing);
  run(["run", "build"]);
  run(["--filter", "@authfleet/api", "run", "deploy"]);
  await ensureSecrets("api", apiPlan);
  await ensureSecrets("web", webPlan);
  run(["--filter", "@authfleet/web", "run", "deploy"]);
  console.log(
    "Deployment complete. In Cloudflare, attach your web custom domain and protect it with a self-hosted Access application (Zero Trust → Access → Applications), allowing only your operators. Ensure its team domain and audience match the configured web settings. workers.dev remains disabled. Keep a secure backup of the existing encryption key; this command never rotates it.",
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
