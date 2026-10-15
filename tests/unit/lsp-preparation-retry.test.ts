import { expect, test } from "bun:test";
import { RuntimeError } from "../../src/runtime/errors.js";
import { withLspPreparationRetry } from "../helpers/lsp-preparation.js";

const transient = () =>
  new RuntimeError("WEB_HTTP_ERROR", "download HTTP 502", {
    status: 502,
    retryable: true,
  });

test("initial LSP download retries once after cleanup and returns the actual successful result", async () => {
  const order: string[] = [];
  const result = await withLspPreparationRetry(
    async () => {
      order.push("request");
      if (order.length === 1) throw transient();
      expect(order).toEqual(["request", "cleanup", "request"]);
      return { diagnostics: ["actual result"] };
    },
    async () => {
      order.push("cleanup");
    },
  );
  expect(result.diagnostics).toEqual(["actual result"]);
});

test("persistent LSP download refusal remains an error after exactly two attempts", async () => {
  let requests = 0,
    cleanups = 0;
  const error = transient();
  let failure: unknown;
  try {
    await withLspPreparationRetry(
      async () => {
        requests++;
        throw error;
      },
      async () => {
        cleanups++;
      },
    );
  } catch (caught) {
    failure = caught;
  }
  expect(failure).toBe(error);
  expect(requests).toBe(2);
  expect(cleanups).toBe(1);
});

test("LSP assertions, activation, protocol, unsafe targets and rate limits never receive this retry", async () => {
  for (const error of [
    new Error("actual diagnostic missing"),
    new RuntimeError("LSP_UNAVAILABLE", "activation failed"),
    new RuntimeError("LSP_PROTOCOL_ERROR", "bad response"),
    new RuntimeError("WEB_UNSAFE_ADDRESS", "unsafe target"),
    new RuntimeError("CANCELLED", "cancelled"),
    new RuntimeError("WEB_HTTP_ERROR", "HTTP 403", {
      status: 403,
      retryable: false,
    }),
    new RuntimeError("WEB_HTTP_ERROR", "HTTP 429", {
      status: 429,
      retryable: true,
    }),
  ]) {
    let requests = 0,
      resets = 0,
      failure: unknown;
    try {
      await withLspPreparationRetry(
        async () => {
          requests++;
          throw error;
        },
        async () => {
          resets++;
        },
      );
    } catch (caught) {
      failure = caught;
    }
    expect(failure).toBe(error);
    expect(requests).toBe(1);
    expect(resets).toBe(0);
  }
});

test("a failed preparation cleanup blocks retry", async () => {
  let requests = 0;
  const cleanup = new Error("cleanup failed");
  let failure: unknown;
  try {
    await withLspPreparationRetry(
      async () => {
        requests++;
        throw transient();
      },
      async () => {
        throw cleanup;
      },
    );
  } catch (caught) {
    failure = caught;
  }
  expect(failure).toBe(cleanup);
  expect(requests).toBe(1);
});
