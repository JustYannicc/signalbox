import { describe, expect, it } from "vite-plus/test";
import { nativeElicitationForm, nativeElicitationResponse } from "./nativeElicitation.ts";

const schema = {
  type: "object",
  required: ["region", "features", "enabled", "count"],
  properties: {
    region: { type: "string", title: "Region", oneOf: [{ const: "eu", title: "Europe" }] },
    features: {
      type: "array",
      items: {
        anyOf: [
          { const: "logs", title: "Logs" },
          { const: "traces", title: "Traces" },
        ],
      },
      minItems: 1,
    },
    enabled: { type: "boolean" },
    count: { type: "integer" },
    note: { type: "string", enum: ["brief"], enumNames: ["Brief summary"] },
  },
};

describe("native elicitation forms", () => {
  it("keeps titled choice values, multi-select and required fields", () => {
    const form = nativeElicitationForm(schema, "Configure the report");
    expect(form?.questions[0]).toMatchObject({
      id: "region",
      header: "Region",
      required: true,
      allowCustomAnswer: false,
      options: [{ label: "Europe", value: "eu", description: "Europe" }],
    });
    expect(form?.questions[1]).toMatchObject({
      id: "features",
      multiSelect: true,
      options: [
        { label: "Logs", value: "logs", description: "Logs" },
        { label: "Traces", value: "traces", description: "Traces" },
      ],
    });
    expect(form?.questions[4]).toMatchObject({
      required: false,
      options: [{ label: "Brief summary", value: "brief", description: "Brief summary" }],
    });
  });

  it("accepts nullable native schema annotations and empty forms", () => {
    const form = nativeElicitationForm(
      {
        type: "object",
        properties: {
          enabled: {
            type: "boolean",
            title: null,
            description: null,
            enum: null,
            enumNames: null,
            oneOf: null,
          },
        },
        required: null,
      },
      "Enable?",
    );
    expect(nativeElicitationResponse(form, { enabled: false })).toEqual({
      action: "accept",
      content: { enabled: false },
    });
    expect(
      nativeElicitationResponse(nativeElicitationForm({ type: "object" }, "Continue?"), {}),
    ).toEqual({ action: "accept", content: {} });
    expect(nativeElicitationForm({ properties: {}, required: ["missing"] }, "Invalid")).toBeNull();
  });

  it("returns actual answers with schema-based scalar types and array selections", () => {
    const form = nativeElicitationForm(schema, "Configure");
    expect(
      nativeElicitationResponse(form, {
        region: "eu",
        features: ["logs", "traces"],
        enabled: "false",
        count: "2",
        unknown: "ignored",
      }),
    ).toEqual({
      action: "accept",
      content: { region: "eu", features: ["logs", "traces"], enabled: false, count: 2 },
    });
    expect(
      nativeElicitationResponse(form, {
        region: ["eu"],
        features: ["logs"],
        enabled: ["true"],
        count: ["3"],
      }),
    ).toEqual({
      action: "accept",
      content: { region: "eu", features: ["logs"], enabled: true, count: 3 },
    });
  });

  it("declines missing required fields, invalid selections and invalid scalars", () => {
    const form = nativeElicitationForm(schema, "Configure");
    const answers = { region: "eu", features: ["logs"], enabled: "true", count: "2" };
    for (const changed of [
      { region: "Europe" },
      { features: ["unknown"] },
      { features: [] },
      { enabled: "yes" },
      { count: "" },
      { count: "2.5" },
      { count: "Infinity" },
    ]) {
      expect(nativeElicitationResponse(form, { ...answers, ...changed })).toEqual({
        action: "decline",
      });
    }
    expect(nativeElicitationResponse(form, {})).toEqual({ action: "decline" });
  });

  it("rejects secret-marked and unsupported nested fields before publishing questions", () => {
    for (const field of [
      { type: "string", format: "password" },
      { type: "string", isSecret: true },
      { type: "string", writeOnly: true },
      { type: "object" },
    ]) {
      expect(nativeElicitationForm({ properties: { credential: field } }, "Secret")).toBeNull();
    }
    expect(nativeElicitationResponse(null, { credential: "secret" })).toEqual({
      action: "decline",
      _meta: {
        "signalbox/reason":
          "Unsupported form. Secret questions must use request_secret or URL elicitation.",
      },
    });
  });
});
