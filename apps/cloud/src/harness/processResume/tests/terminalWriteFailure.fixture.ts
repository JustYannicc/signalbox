export function failTerminalWrite(storage: DurableObjectStorage, after: boolean) {
  const original = storage.transaction.bind(storage);
  storage.transaction = async <T>(
    callback: (transaction: DurableObjectTransaction) => Promise<T>,
  ) => {
    let terminal = false;
    const result = await original((transaction) =>
      callback(
        new Proxy(transaction, {
          get(target, key) {
            if (key === "put")
              return async (...args: unknown[]) => {
                // Fencing adds unrelated transactions before completion; fault the terminal write itself.
                if (
                  typeof args[0] === "string" &&
                  args[0].startsWith("harness-process-terminal/v1/")
                ) {
                  terminal = true;
                  storage.transaction = original;
                  if (!after) throw new Error("Injected C evidence transaction failure.");
                }
                return Reflect.apply(target.put, target, args);
              };
            const value: unknown = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
      ),
    );
    if (terminal && after)
      throw new Error(`Injected C evidence reply loss after commit: ${typeof result}`);
    return result;
  };
}
