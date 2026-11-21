import { AgentReadError } from "@authfleet/core";

/** Plugin check failures, phrased for the operator. */
export function agentRegistrationError(
  cause: unknown,
  action: "registration" | "update" = "registration",
): string {
  if (cause instanceof AgentReadError) {
    switch (cause.kind) {
      case "unreachable":
        return `agent ${action} failed: could not reach the plugin at the base URL`;
      case "not-found":
        return `agent ${action} failed: no AuthFleet plugin found at the base URL (check the URL and that the plugin is installed)`;
      case "unauthorized":
        return `agent ${action} failed: the plugin rejected the API key`;
      case "version-mismatch":
        return `agent ${action} failed: ${cause.message}`;
      default:
        return `agent ${action} failed: the plugin returned an unexpected response`;
    }
  }
  return `agent ${action} failed: plugin validation error`;
}
