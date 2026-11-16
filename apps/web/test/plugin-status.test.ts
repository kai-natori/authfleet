import { describe, expect, it } from "vitest";
import { isPluginStatus, PLUGIN_STATUSES, pluginStatusInfo } from "../src/lib/plugin-status";

describe("plugin status taxonomy", () => {
  it("recognizes exactly the api's AgentReadError kinds", () => {
    for (const status of PLUGIN_STATUSES) {
      expect(isPluginStatus(status)).toBe(true);
    }
    expect(isPluginStatus("ok")).toBe(false);
    expect(isPluginStatus("")).toBe(false);
    expect(isPluginStatus(undefined)).toBe(false);
    expect(isPluginStatus(null)).toBe(false);
    expect(isPluginStatus(42)).toBe(false);
  });

  it("every status has a distinct label and an explanation", () => {
    const labels = PLUGIN_STATUSES.map((s) => pluginStatusInfo(s).label);
    expect(new Set(labels).size).toBe(PLUGIN_STATUSES.length);
    for (const status of PLUGIN_STATUSES) {
      expect(pluginStatusInfo(status).description.length).toBeGreaterThan(10);
    }
  });

  it("the failure states never claim zero users", () => {
    for (const status of PLUGIN_STATUSES) {
      const info = pluginStatusInfo(status);
      expect(`${info.label} ${info.description}`).not.toMatch(/0 users|zero users/i);
    }
  });
});
