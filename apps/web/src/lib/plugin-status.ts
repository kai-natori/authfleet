/**
 * First-class plugin states for `agent` projects (spec: contract
 * versioning and plugin absence). These mirror the AgentReadError
 * kinds the api surfaces as `pluginStatus` on stats failures. A
 * failure state is NEVER rendered as a zero-user project: a genuine
 * zero-user project is a successful stats response with totalUsers 0.
 */
export type PluginStatus =
  | "unreachable"
  | "unauthorized"
  | "not-found"
  | "version-mismatch"
  | "malformed"
  | "upstream";

export const PLUGIN_STATUSES: readonly PluginStatus[] = [
  "unreachable",
  "unauthorized",
  "not-found",
  "version-mismatch",
  "malformed",
  "upstream",
];

export function isPluginStatus(value: unknown): value is PluginStatus {
  return typeof value === "string" && (PLUGIN_STATUSES as readonly string[]).includes(value);
}

export interface PluginStatusInfo {
  label: string;
  description: string;
}

export function pluginStatusInfo(status: PluginStatus): PluginStatusInfo {
  switch (status) {
    case "not-found":
      return {
        label: "Plugin not found",
        description:
          "No AuthFleet plugin answered at this base URL. Check the URL and that the plugin is installed in the app.",
      };
    case "unreachable":
      return {
        label: "Plugin unreachable",
        description: "The dashboard could not reach the app at this base URL.",
      };
    case "unauthorized":
      return {
        label: "Plugin key rejected",
        description:
          "The plugin rejected the API key. The key in the app config and the one stored here must be the same key.",
      };
    case "version-mismatch":
      return {
        label: "Plugin version mismatch",
        description:
          "The plugin speaks a contract version this dashboard does not support. Upgrade the older side.",
      };
    case "malformed":
      return {
        label: "Plugin response invalid",
        description: "The plugin endpoint returned a response AuthFleet could not parse.",
      };
    case "upstream":
      return {
        label: "Plugin error",
        description: "The plugin endpoint returned an error.",
      };
  }
}
