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
