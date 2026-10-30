import { describe, expect, it } from "vitest";
import { TOOLS } from "../openhub-mcp";

const CONTROL_PLANE = [
  "openhub_android_audit_profiles",
  "openhub_android_audit_report",
  "openhub_android_audit_tasks",
  "openhub_evidence_index",
  "openhub_model_status",
  "openhub_model_route",
  "openhub_control_plane",
  "openhub_mesh_metrics",
];

describe("OpenHub control-plane MCP tools", () => {
  it("registers every control-plane tool", () => {
    const names = new Set(TOOLS.map((t) => t.name));
    for (const name of CONTROL_PLANE) expect(names.has(name), name).toBe(true);
  });

  it("keeps every tool's schema closed and object-shaped", () => {
    for (const tool of TOOLS) {
      expect(tool.inputSchema.type, tool.name).toBe("object");
      expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
    }
  });

  it("requires an id for report and task fetches", () => {
    for (const name of ["openhub_android_audit_report", "openhub_android_audit_tasks"]) {
      const tool = TOOLS.find((t) => t.name === name)!;
      expect(tool.inputSchema.required, name).toContain("id");
    }
  });

  it("requires a task for model route", () => {
    const tool = TOOLS.find((t) => t.name === "openhub_model_route")!;
    expect(tool.inputSchema.required).toContain("task");
  });
});
