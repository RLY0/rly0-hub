import { describe, expect, it } from "vitest";
import {
  resetConsumeParams,
  resetPrepareParams,
  resetConsumeResult,
} from "../src/rly0-hub-service/reset-credits.js";

describe("reset-credit command boundary", () => {
  const command = {
    id: "0123456789ab",
    requestId: "00000000-0000-4000-8000-000000000001",
    creditId: "synthetic-card",
    revision: "a".repeat(64),
    confirmed: true,
  };
  it("requires an exact account, card, credential revision, confirmation and UUID", () => {
    expect(resetConsumeParams.parse(command)).toEqual(command);
    for (const patch of [
      { confirmed: false },
      { id: "../wrong" },
      { requestId: "new" },
      { creditId: "" },
      { revision: "" },
      { url: "https://other.test" },
    ]) {
      expect(resetConsumeParams.safeParse({ ...command, ...patch }).success).toBe(false);
    }
    expect(
      resetPrepareParams.safeParse({ id: command.id, url: "https://other.test" }).success,
    ).toBe(false);
  });
  it("does not turn an unknown backend response into success", () => {
    expect(resetConsumeResult.safeParse({ outcome: "success" }).success).toBe(false);
    expect(resetConsumeResult.parse({ outcome: "alreadyRedeemed", secret: "drop" })).toEqual({
      outcome: "alreadyRedeemed",
    });
  });
});
