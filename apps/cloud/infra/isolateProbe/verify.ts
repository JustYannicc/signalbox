const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const verificationErrors = (rows: unknown[]) => {
  const errors: string[] = [];
  if (rows.length === 0) errors.push("No evidence rows recorded");
  for (const [index, row] of rows.entries()) {
    if (!record(row)) {
      errors.push(`row ${index}: malformed evidence`);
      continue;
    }
    const label = String(row.path ?? row.scenario ?? index);
    const response = "response" in row ? row.response : row;
    if (!record(response)) {
      errors.push(`${label}: malformed response`);
      continue;
    }
    if (typeof response.error === "string") errors.push(`${label}: ${response.error}`);
    if (typeof response.status === "number" && response.status !== 200) {
      errors.push(`${label}: HTTP ${response.status}`);
    }
    if (row.scenario === "worker-handles" && typeof row.count === "number" && row.count <= 10) {
      const results = response.results;
      if (
        !Array.isArray(results) ||
        results.length !== row.count ||
        results.some((r) => !record(r) || r.ok !== true)
      ) {
        errors.push(`${label}: worker admission failed below the production concurrency bound`);
      }
    }
    if (typeof response.error === "string" || row.scenario === "worker-handles") continue;
    if (!record(response.result)) {
      errors.push(`${label}: missing result`);
      continue;
    }
    if (response.result.ok === false) errors.push(`${label}: behavioral assertion failed`);
    if (
      typeof row.path === "string" &&
      ["/jspi", "/wasm", "/sqlite"].includes(row.path.split("?")[0]!) &&
      response.result.ok !== true &&
      response.result.ok !== false
    )
      errors.push(`${label}: missing behavioral assertion`);
    if (row.scenario === "request-time-codegen" && response.result.value !== row.generatedValue) {
      errors.push(`${label}: generated code returned the wrong value`);
    }
    if (row.path === "/capabilities") {
      for (const key of ["requireEsm", "functionConstructor", "wasm", "jspi"]) {
        const result = response.result[key];
        if (!record(result) || result.ok !== true) errors.push(`${label}: ${key} failed`);
      }
      const constructor = response.result.functionConstructor;
      if (!record(constructor) || constructor.restored !== true) {
        errors.push(`${label}: Function was not restored`);
      }
    }
  }
  return errors;
};
