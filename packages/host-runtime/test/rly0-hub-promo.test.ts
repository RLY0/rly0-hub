import { describe, expect, it } from "vitest";

import { parsePromo, Rly0PromoSource } from "../src/rly0-hub-service/promo.js";

const answer = (data: unknown) => JSON.stringify({ code: 0, data });

function source(bodies: Array<string | Error>, clock = { t: 0 }) {
  let calls = 0;
  const promo = new Rly0PromoSource(
    async () => async () => {
      const next = bodies[Math.min(calls++, bodies.length - 1)]!;
      if (next instanceof Error) throw next;
      return {
        status: 200,
        headers: {},
        body: (async function* () {
          yield Buffer.from(next);
        })(),
        cancel() {},
      };
    },
    () => clock.t,
  );
  return { promo, calls: () => calls, clock };
}

describe("rly0.com 福利横幅", () => {
  it("reads the banner sentence only while the site shows it", () => {
    expect(
      parsePromo(
        answer({ promotion_banner_enabled: true, promotion_banner_text: " 首充送 $3\n｜返利10% " }),
      ),
    ).toEqual({ text: "首充送 $3 ｜返利10%" });
    expect(
      parsePromo(answer({ promotion_banner_enabled: false, promotion_banner_text: "x" })),
    ).toEqual({ text: null });
    expect(parsePromo("<html>")).toEqual({ text: null });
    expect(
      parsePromo(answer({ promotion_banner_enabled: true, promotion_banner_text: 5 })),
    ).toEqual({ text: null });
  });

  it("caches a good answer for half an hour and retries after a failure", async () => {
    const ok = answer({ promotion_banner_enabled: true, promotion_banner_text: "福利" });
    const failing = source([new Error("offline"), ok]);
    expect(await failing.promo.read()).toEqual({ text: null });
    expect(await failing.promo.read()).toEqual({ text: "福利" });
    expect(await failing.promo.read()).toEqual({ text: "福利" });
    expect(failing.calls()).toBe(2);
    failing.clock.t = 31 * 60_000;
    await failing.promo.read();
    expect(failing.calls()).toBe(3);
  });
});
