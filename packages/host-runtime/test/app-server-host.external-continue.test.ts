import { existsSync, readFileSync, rmSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";

import { EXTERNAL_CONTINUE_TEXT, externalTurnInput } from "../src/external-turn-input.js";
import {
  createFixture,
  requestId,
  startPiThread,
  startPiTurn,
  stopFixture,
  turnEvent,
  writeRequest,
} from "./app-server-host-fixture.js";

type Fixture = ReturnType<typeof createFixture>;

async function startTurn(fixture: Fixture, threadId: string, id: number, input: JsonObject[]) {
  writeRequest(fixture.desktopInput, { id, method: "turn/start", params: { threadId, input } });
  return fixture.collector.waitFor((message) => requestId(message, id));
}

function startedInput(execute: { mock: { calls: unknown[][] } }): unknown {
  const call = execute.mock.calls
    .map(([command]) => command as JsonObject)
    .findLast((command: JsonObject) => command.type === "turn.start");
  return call?.input;
}

describe("External Thread turn/start without typed text", () => {
  it("continues in the same Session after a stopped Turn, without a user message", async () => {
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      const stoppedTurnId = await startPiTurn(fixture, threadId);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Session was not opened");
      session.completeCancellationOnRequest();
      writeRequest(fixture.desktopInput, {
        id: 3,
        method: "turn/interrupt",
        params: { threadId, turnId: stoppedTurnId },
      });
      await fixture.collector.waitFor((message) => requestId(message, 3));
      await fixture.collector.waitFor((message) =>
        turnEvent(message, "turn/completed", stoppedTurnId),
      );
      const execute = vi.spyOn(session, "execute");

      const response = await startTurn(fixture, threadId, 4, []);
      expect(response).not.toHaveProperty("error");
      const turn = (response.result as JsonObject).turn as JsonObject;
      expect(turn.id).not.toBe(stoppedTurnId);
      expect(turn.items).toEqual([]);
      expect(startedInput(execute)).toEqual([{ type: "text", text: EXTERNAL_CONTINUE_TEXT }]);
      expect(fixture.adapter.sessions).toHaveLength(1);

      session.appendText("resumed");
      session.succeedTurn();
      await fixture.collector.waitFor((message) =>
        turnEvent(message, "turn/completed", String(turn.id)),
      );
    } finally {
      await stopFixture(fixture);
    }
  });

  it("passes an image-only message to the Harness as an attachment reference", async () => {
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Session was not opened");
      const execute = vi.spyOn(session, "execute");
      const response = await startTurn(fixture, threadId, 2, [
        { type: "localImage", path: "C:\\shots\\screen.png" },
      ]);
      expect(response).not.toHaveProperty("error");
      const [item] = startedInput(execute) as Array<{ type: string; text: string }>;
      expect(item?.text).toContain("## screen.png: C:\\shots\\screen.png\nImage attachment: true");
      expect(item?.text).not.toContain(EXTERNAL_CONTINUE_TEXT);
    } finally {
      await stopFixture(fixture);
    }
  });
});

describe("externalTurnInput", () => {
  it("keeps typed text as it is", async () => {
    await expect(externalTurnInput({ input: [{ type: "text", text: "hello" }] })).resolves.toEqual({
      text: "hello",
      visible: true,
    });
  });

  it("treats empty and whitespace-only input as continue", async () => {
    for (const input of [[], [{ type: "text", text: "  " }]]) {
      await expect(externalTurnInput({ input })).resolves.toEqual({
        text: EXTERNAL_CONTINUE_TEXT,
        visible: false,
      });
    }
  });

  it("still rejects a non-array input", async () => {
    await expect(externalTurnInput({})).rejects.toThrow("turn/start input must be an array");
  });

  it("does not repeat an attachment Desktop already serialized into the text", async () => {
    const text = "# Files mentioned by the user:\n\n## a.png: /tmp/a.png\nImage attachment: true\n";
    await expect(
      externalTurnInput({
        input: [
          { type: "text", text },
          { type: "localImage", path: "/tmp/a.png" },
        ],
      }),
    ).resolves.toEqual({ text, visible: true });
  });

  it("saves an inline image and references its file; mentions keep their path", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const result = await externalTurnInput({
      input: [
        { type: "image", url: `data:image/png;base64,${png.toString("base64")}` },
        { type: "mention", name: "notes", path: "/repo/notes.md" },
        { type: "text", text: "look" },
      ],
    });
    expect(result.visible).toBe(true);
    expect(result.text).toContain("## notes.md: /repo/notes.md\n");
    expect(result.text.endsWith("## My request:\nlook")).toBe(true);
    const saved = /## [^\n]+: ([^\n]+\.png)\nImage attachment: true/u.exec(result.text)?.[1];
    expect(saved && existsSync(saved)).toBe(true);
    expect(readFileSync(saved as string)).toEqual(png);
    rmSync(saved as string, { force: true });
  });
});
