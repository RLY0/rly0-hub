import { describe, expect, it, vi } from "vitest";

import darkSvg from "../../src/assets/codexhost-otter-dark.svg?raw";
import lightSvg from "../../src/assets/codexhost-otter-light.svg?raw";
import rly0Master from "../../src/assets/codexhost-app-icon.svg?raw";

import {
  CODEXHOST_OTTER_DARK_DETAIL_PATH,
  CODEXHOST_OTTER_PATH,
} from "../../src/assets/codexhost-otter.js";
import { createRendererSettingsBrandGlyph } from "../../src/settings/icons.js";

class FakeSvgElement {
  readonly attributes = new Map<string, string>();
  readonly children: FakeSvgElement[] = [];
  readonly classList = { add: vi.fn() };

  constructor(readonly tagName: string) {}

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  append(...children: FakeSvgElement[]): void {
    this.children.push(...children);
  }
}

function withSvgDocument(test: () => void): void {
  vi.stubGlobal("document", {
    createElementNS: (_namespace: string, name: string) => new FakeSvgElement(name),
  });
  try {
    test();
  } finally {
    vi.unstubAllGlobals();
  }
}

function expectRailMark(icon: SVGElement, size: number): void {
  const svg = icon as unknown as FakeSvgElement;
  expect(svg.tagName).toBe("svg");
  expect(svg.attributes.get("viewBox")).toBe("56 44 158 158");
  expect(svg.attributes.get("width")).toBe(String(size));
  expect(svg.attributes.get("height")).toBe(String(size));
  expect(svg.attributes.get("aria-hidden")).toBe("true");
  expect(svg.attributes.get("focusable")).toBe("false");
  expect(svg.children).toHaveLength(2);
  const [figure, signal] = svg.children;
  expect(figure?.tagName).toBe("path");
  expect(rly0Master).toContain(`d="${figure?.attributes.get("d")}"`);
  expect(figure?.attributes.get("fill")).toBe("currentColor");
  expect(figure?.attributes.get("fill-rule")).toBe("evenodd");
  expect(signal?.tagName).toBe("rect");
  expect(signal?.attributes.get("fill")).toBe("#ff4b2e");
  expect(signal?.attributes.get("x")).toBe("190");
  expect(signal?.attributes.get("y")).toBe("50");
  expect(signal?.attributes.get("width")).toBe("18");
  expect(signal?.attributes.get("height")).toBe("18");
  for (const shape of svg.children) {
    expect(shape.attributes.has("transform")).toBe(false);
    expect(shape.attributes.has("style")).toBe(false);
  }
  expect(svg.classList.add).toHaveBeenCalledWith("codexhost-settings-icon");
}

describe("RLY/0 navigation rail mark", () => {
  for (const size of [16, 20, 22, 24]) {
    it(`preserves the existing RLY/0 geometry and signal square at ${size}px`, () => {
      withSvgDocument(() => expectRailMark(createRendererSettingsBrandGlyph(size), size));
    });
  }

  it("keeps the retained otter SVG exports aligned with their source paths", () => {
    const light = lightSvg;
    const dark = darkSvg;
    expect(light).toContain(`d="${CODEXHOST_OTTER_PATH}"`);
    expect(light).toContain('fill="currentColor"');
    expect(light.match(/<path\b/gu)).toHaveLength(1);
    expect(dark).toContain(`d="${CODEXHOST_OTTER_PATH}"`);
    expect(dark).toContain(`d="${CODEXHOST_OTTER_DARK_DETAIL_PATH}"`);
    expect(dark).toContain('fill="#697680"');
    expect(dark).toContain('fill="#b8c0c6"');
    expect(dark.match(/<path\b/gu)).toHaveLength(2);
    for (const svg of [light, dark]) {
      expect(svg).toContain('viewBox="0 0 384 384"');
      expect(svg).not.toMatch(/<(?:image|mask|circle|rect)\b/u);
    }
  });
});
