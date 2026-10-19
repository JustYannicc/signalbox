import { describe, expect, it } from "vite-plus/test";
import { secretForms } from "@signalbox/runner-protocol/SecretScrubber";
import { estimateSecretFormsScratch } from "./secretFormsBudget.ts";

const encoder = new TextEncoder();

describe("estimateSecretFormsScratch", () => {
  it("covers retained shared scrubber forms across Unicode and escaping inputs", () => {
    const values = [
      "quotes ' \" slash \\\\ dollar $ tick ` newline\n tab\t and shell ;<>|",
      "üñíçødé 🔑 中文 and url /?&=+%".repeat(4),
      "control\u0000\u0001\u001f escaped-json \\".repeat(4),
    ];

    for (const value of values) {
      const forms = secretForms(value);
      const retainedStringBytes = forms.reduce((size, form) => size + form.length * 2, 0);
      const encodedMatcherBytes = forms.reduce(
        (size, form) => size + encoder.encode(form).byteLength,
        0,
      );
      const estimate = estimateSecretFormsScratch(value, encoder.encode(value).byteLength);
      expect(estimate.peakBytes).toBeGreaterThanOrEqual(retainedStringBytes + encodedMatcherBytes);
    }
  });
});
