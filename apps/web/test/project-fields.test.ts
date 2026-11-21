import { demoProject, toPublicProject } from "@authfleet/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentProjectFields, D1ProjectFields, ProjectList } from "../src/components/project-fields";

describe("project presentation", () => {
  it("renders empty, demo and failed-plugin lists", () => {
    const props = { projects: [], agentStatus: {}, busy: false, onDelete: async () => {} };
    expect(renderToStaticMarkup(createElement(ProjectList, props))).toContain(
      "No projects registered.",
    );
    const project = toPublicProject(demoProject());
    const demo = renderToStaticMarkup(
      createElement(ProjectList, { ...props, projects: [project] }),
    );
    expect(demo).toContain(project.name);
    expect(demo).not.toContain(">Delete<");
    const failed = renderToStaticMarkup(
      createElement(ProjectList, {
        ...props,
        busy: true,
        projects: [{ ...project, type: "agent", isDemo: false }],
        agentStatus: { [project.id]: "not-found" },
      }),
    );
    expect(failed).toContain("Delete");
    expect(failed).toContain("disabled");
    expect(failed).not.toContain("Plugin OK");
  });

  it("preserves D1 form names and password input", () => {
    const html = renderToStaticMarkup(createElement(D1ProjectFields));
    for (const name of ["cfAccountId", "d1DatabaseId", "token"])
      expect(html).toContain(`name="${name}"`);
    expect(html).toContain('type="password"');
  });

  it("renders controlled agent fields, optional generated values, and busy state", () => {
    const props = {
      apiKeyValue: "",
      setApiKeyValue: () => {},
      generated: null,
      busy: false,
      onGenerateKey: async () => {},
    };
    const empty = renderToStaticMarkup(createElement(AgentProjectFields, props));
    expect(empty).toContain('name="baseUrl"');
    expect(empty).toContain('name="apiKey"');
    expect(empty).not.toContain("Your generated key");
    const generated = renderToStaticMarkup(
      createElement(AgentProjectFields, {
        ...props,
        busy: true,
        apiKeyValue: "example-key",
        generated: { apiKey: "example-key", apiKeyHash: "example-hash" },
      }),
    );
    expect(generated).toContain("AUTHFLEET_API_KEY_HASH=example-hash");
    expect(generated).toContain('value="example-key"');
    expect(generated).toContain("disabled");
  });
});
