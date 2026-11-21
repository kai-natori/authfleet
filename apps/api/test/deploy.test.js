import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  apiSettings,
  missingInputsMessage,
  parseSecretNames,
  planSecrets,
  webSettings,
} from "../../../scripts/deploy-plan.mjs";

describe("deployment secret planning", () => {
  it("generates a new encryption key only when absent", () => {
    expect(planSecrets([], {}, apiSettings)).toEqual([
      { name: "TOKEN_ENCRYPTION_KEY", source: "generate" },
      { name: "AUTHFLEET_OPERATOR_EMAILS", source: "prompt" },
    ]);
    expect(
      planSecrets(
        apiSettings,
        {
          TOKEN_ENCRYPTION_KEY: "never-use-this-replacement",
          AUTHFLEET_OPERATOR_EMAILS: "replacement@example.com",
        },
        apiSettings,
      ),
    ).toEqual([]);
  });

  it("uses environment values only for missing settings", () => {
    expect(
      planSecrets(
        ["AUTHFLEET_ACCESS_AUD"],
        {
          AUTHFLEET_ACCESS_TEAM_DOMAIN: " team.cloudflareaccess.com ",
          AUTHFLEET_ACCESS_AUD: "must-not-overwrite",
        },
        webSettings,
      ),
    ).toEqual([
      { name: "AUTHFLEET_ACCESS_TEAM_DOMAIN", source: "env", value: "team.cloudflareaccess.com" },
    ]);
  });

  it("reports blank and missing inputs without including values", () => {
    const plan = planSecrets([], { AUTHFLEET_OPERATOR_EMAILS: " " }, apiSettings);
    expect(missingInputsMessage(plan)).toContain("AUTHFLEET_OPERATOR_EMAILS");
    expect(missingInputsMessage(plan)).not.toContain("TOKEN_ENCRYPTION_KEY");
    expect(missingInputsMessage([])).toBeNull();
    expect(
      missingInputsMessage(
        planSecrets([], { AUTHFLEET_OPERATOR_EMAILS: "op@example.com" }, apiSettings),
      ),
    ).toBeNull();
  });

  it("parses existing names and fails closed on malformed list output", () => {
    expect(parseSecretNames('[{"name":"TOKEN_ENCRYPTION_KEY","type":"secret_text"}]')).toEqual([
      "TOKEN_ENCRYPTION_KEY",
    ]);
    expect(parseSecretNames("[]")).toEqual([]);
    for (const invalid of ["not json", "{}", "[{}]", "[null]"])
      expect(() => parseSecretNames(invalid)).toThrow();
  });
});

describe("deployment orchestration", () => {
  function deploy(existingSecrets) {
    const directory = mkdtempSync(join(tmpdir(), "authfleet-deploy-"));
    const commands = join(directory, "commands.jsonl");
    try {
      writeFileSync(commands, "");
      symlinkSync(process.execPath, join(directory, "node"));
      writeFileSync(
        join(directory, "pnpm"),
        `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.COMMAND_LOG, JSON.stringify(args) + "\\n");
if (args.includes("list")) {
  const app = args[1] === "@authfleet/api" ? "api" : "web";
  if (process.env.EXISTING_SECRETS !== "1") {
    console.error('Worker "authfleet-' + app + '" not found.');
    process.exit(1);
  }
  const names = app === "api"
    ? ["TOKEN_ENCRYPTION_KEY", "AUTHFLEET_OPERATOR_EMAILS"]
    : ["AUTHFLEET_ACCESS_TEAM_DOMAIN", "AUTHFLEET_ACCESS_AUD"];
  console.log(JSON.stringify(names.map(name => ({ name }))));
} else {
  console.log("{}");
}
`,
        { mode: 0o700 },
      );
      const result = spawnSync(
        process.execPath,
        [fileURLToPath(new URL("../../../scripts/deploy.mjs", import.meta.url))],
        {
          encoding: "utf8",
          timeout: 10_000,
          env: {
            PATH: directory,
            COMMAND_LOG: commands,
            EXISTING_SECRETS: existingSecrets ? "1" : "0",
            CLOUDFLARE_API_TOKEN: "dummy-token",
            CLOUDFLARE_ACCOUNT_ID: "dummy-account",
          },
        },
      );
      return {
        ...result,
        commands: readFileSync(commands, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse),
      };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  it("fails before any build or deployment when new installations lack settings", () => {
    const result = deploy(false);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Missing deployment settings");
    expect(result.stderr).not.toContain("dummy-token");
    expect(result.commands.every((args) => args.includes("whoami") || args.includes("list"))).toBe(
      true,
    );
  });

  it("deploys API before web and never replaces existing secrets", () => {
    const result = deploy(true);
    expect(result.status, result.stderr).toBe(0);
    expect(result.commands.filter((args) => args.includes("run"))).toEqual([
      ["run", "build"],
      ["--filter", "@authfleet/api", "run", "deploy"],
      ["--filter", "@authfleet/web", "run", "deploy"],
    ]);
    expect(result.commands.some((args) => args.includes("put"))).toBe(false);
  });
});
