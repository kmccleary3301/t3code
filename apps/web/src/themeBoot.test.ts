import { describe, expect, it } from "vite-plus/test";

import indexHtml from "../index.html?raw";
import { CUSTOM_THEMES_STORAGE_KEY, toCanonicalThemeColor } from "./themePalette";

const THEME_STORAGE_KEY = "t3code:theme";

const bootScript = (() => {
  const match = indexHtml.match(/<script>([\s\S]*?)<\/script>/);
  if (!match?.[1]) throw new Error("Could not find the inline boot script in index.html");
  return match[1];
})();

type BootResult = {
  isDark: boolean;
  themeId: string | undefined;
  t3AppearanceActive: string | undefined;
  appearanceSafeMode: string | undefined;
  themeSelected: string | undefined;
  backgroundColor: string;
  bootVariables: Record<string, string>;
  metaContent: string | null;
};

function runBootScript(options: {
  storage?: Record<string, string>;
  storageThrows?: boolean;
  search?: string;
  prefersDark: boolean;
}): BootResult {
  const classes = new Set<string>();
  const bootVariables: Record<string, string> = {};
  const meta = {
    content: null as string | null,
    setAttribute(_name: string, value: string) {
      this.content = value;
    },
  };
  const documentElement = {
    dataset: {} as Record<string, string | undefined>,
    classList: {
      add: (name: string) => void classes.add(name),
      remove: (name: string) => void classes.delete(name),
      toggle: (name: string, force?: boolean) => {
        const next = force ?? !classes.has(name);
        if (next) classes.add(name);
        else classes.delete(name);
        return next;
      },
    },
    style: {
      backgroundColor: "",
      setProperty: (name: string, value: string) => {
        bootVariables[name] = value;
      },
    },
  };
  const fakeDocument = {
    documentElement,
    querySelectorAll: (selector: string) => (selector === 'meta[name="theme-color"]' ? [meta] : []),
  };
  const fakeWindow = {
    localStorage: {
      getItem: (key: string): string | null => {
        if (options.storageThrows) throw new Error("storage blocked");
        return options.storage?.[key] ?? null;
      },
    },
    matchMedia: () => ({ matches: options.prefersDark }),
    location: { search: options.search ?? "" },
  };

  const fakeCss = {
    supports: (property: string, value: string) =>
      property === "color" && toCanonicalThemeColor(value) !== null,
  };

  new Function("window", "document", "CSS", bootScript)(fakeWindow, fakeDocument, fakeCss);

  return {
    isDark: classes.has("dark"),
    themeId: documentElement.dataset.themeId,
    t3AppearanceActive: documentElement.dataset.t3AppearanceActive,
    appearanceSafeMode: documentElement.dataset.appearanceSafeMode,
    themeSelected: documentElement.dataset.themeSelected,
    backgroundColor: documentElement.style.backgroundColor,
    bootVariables,
    metaContent: meta.content,
  };
}

function bootChecksum(value: unknown): string {
  const encoded = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < encoded.length; index += 1) {
    hash ^= encoded.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

describe("index.html boot script", () => {
  it("uses a neutral OS surface when no valid runtime snapshot exists", () => {
    const boot = runBootScript({
      storage: {
        [THEME_STORAGE_KEY]: "unsafe-custom",
        [CUSTOM_THEMES_STORAGE_KEY]: JSON.stringify([
          {
            id: "unsafe-custom",
            label: "Unsafe Custom",
            appearance: "dark",
            colors: { canvas: "#010203", text: "#ffffff", accent: "#ff0000" },
          },
        ]),
      },
      prefersDark: false,
    });
    expect(boot.themeId).toBeUndefined();
    expect(boot.themeSelected).toBeUndefined();
    expect(boot.isDark).toBe(false);
    expect(boot.bootVariables).toEqual({});
    expect(boot.backgroundColor).toBe("#ffffff");
  });

  it("does not fall through to legacy custom styling when the runtime snapshot is corrupt", () => {
    const boot = runBootScript({
      storage: {
        "t3code:appearance:boot:v1": JSON.stringify({
          version: 2,
          revision: 8,
          themeId: "unsafe-custom",
          mode: "dark",
          safeMode: true,
          colorVariables: { "--app-theme-canvas": "#010203" },
          checksum: "00000000",
        }),
        [THEME_STORAGE_KEY]: "unsafe-custom",
        [CUSTOM_THEMES_STORAGE_KEY]: JSON.stringify([
          {
            id: "unsafe-custom",
            label: "Unsafe Custom",
            appearance: "dark",
            colors: { canvas: "#010203", text: "#ffffff", accent: "#ff0000" },
          },
        ]),
      },
      prefersDark: false,
    });
    expect(boot.themeId).toBeUndefined();
    expect(boot.appearanceSafeMode).toBeUndefined();
    expect(boot.isDark).toBe(false);
    expect(boot.bootVariables).toEqual({});
    expect(boot.backgroundColor).toBe("#ffffff");
  });

  it("leaves unknown preferences unthemed so the runtime default applies", () => {
    const boot = runBootScript({
      storage: { [THEME_STORAGE_KEY]: "gone-theme" },
      prefersDark: true,
    });
    expect(boot.themeId).toBeUndefined();
    expect(boot.themeSelected).toBeUndefined();
    expect(boot.isDark).toBe(true);
  });

  it("follows the OS appearance when storage is unavailable", () => {
    const light = runBootScript({ storageThrows: true, prefersDark: false });
    expect(light.isDark).toBe(false);
    expect(light.themeId).toBeUndefined();

    const dark = runBootScript({ storageThrows: true, prefersDark: true });
    expect(dark.isDark).toBe(true);
  });
  it("applies a bounded checksummed runtime boot snapshot", () => {
    const body = {
      version: 2,
      revision: 7,
      themeId: "runtime-theme",
      mode: "dark",
      safeMode: false,
      colorVariables: {
        "--app-theme-accent": "#ff0000",
        "--app-theme-canvas": "#010203",
        "--app-theme-text": "#ffffff",
      },
    };
    const boot = runBootScript({
      storage: {
        "t3code:appearance:boot:v1": JSON.stringify({
          ...body,
          checksum: bootChecksum(body),
        }),
      },
      prefersDark: false,
    });
    expect(boot.themeId).toBe("runtime-theme");
    expect(boot.t3AppearanceActive).toBe("true");
    expect(boot.themeSelected).toBe("true");
    expect(boot.isDark).toBe(true);
    expect(boot.bootVariables["--app-theme-canvas"]).toBe("#010203");
    expect(boot.bootVariables["--boot-background"]).toBe("#010203");
    expect(boot.metaContent).toBe("#010203");
  });

  it("preserves explicit variables that resemble the internal color namespace", () => {
    const body = {
      version: 2,
      revision: 8,
      themeId: "runtime-theme",
      mode: "light",
      safeMode: false,
      colorVariables: { "--t3-color-brand": "#abcdef" },
    };
    const boot = runBootScript({
      storage: {
        "t3code:appearance:boot:v1": JSON.stringify({
          ...body,
          checksum: bootChecksum(body),
        }),
      },
      prefersDark: false,
    });
    expect(boot.bootVariables["--t3-color-brand"]).toBe("#abcdef");
    expect(boot.bootVariables["--app-theme-brand"]).toBeUndefined();
  });

  it("applies a runtime-only custom snapshot in system mode before React", () => {
    const body = {
      version: 2,
      revision: 9,
      themeId: "runtime-system-custom",
      mode: "system",
      safeMode: false,
      colorVariables: {
        "--app-theme-canvas": "#010203",
        "--app-theme-text": "#ffffff",
      },
    };
    const boot = runBootScript({
      storage: {
        "t3code:appearance:boot:v1": JSON.stringify({
          ...body,
          checksum: bootChecksum(body),
        }),
      },
      prefersDark: true,
    });
    expect(boot.themeId).toBe("runtime-system-custom");
    expect(boot.isDark).toBe(true);
    expect(boot.bootVariables["--app-theme-canvas"]).toBe("#010203");
  });

  it("ignores cached system colors after the OS appearance changes", () => {
    const body = {
      version: 2,
      revision: 10,
      themeId: "runtime-system-custom",
      mode: "system",
      systemAppearance: "dark",
      safeMode: false,
      colorVariables: {
        "--app-theme-canvas": "#010203",
        "--app-theme-text": "#ffffff",
      },
    };
    const boot = runBootScript({
      storage: {
        "t3code:appearance:boot:v1": JSON.stringify({
          ...body,
          checksum: bootChecksum(body),
        }),
      },
      prefersDark: false,
    });
    expect(boot.themeId).toBeUndefined();
    expect(boot.isDark).toBe(false);
    expect(boot.bootVariables).toEqual({});
    expect(boot.backgroundColor).toBe("#ffffff");
    expect(boot.metaContent).toBe("#ffffff");
  });

  it("honors a durable safe snapshot instead of falling through to legacy custom themes", () => {
    const body = {
      version: 2,
      revision: 8,
      themeId: "unsafe-custom",
      mode: "system",
      safeMode: true,
      colorVariables: { "--app-theme-canvas": "#010203" },
    };
    const boot = runBootScript({
      storage: {
        "t3code:appearance:boot:v1": JSON.stringify({
          ...body,
          checksum: bootChecksum(body),
        }),
        [THEME_STORAGE_KEY]: "unsafe-custom",
        [CUSTOM_THEMES_STORAGE_KEY]: JSON.stringify([
          {
            id: "unsafe-custom",
            label: "Unsafe Custom",
            appearance: "dark",
            colors: { canvas: "#010203" },
          },
        ]),
      },
      prefersDark: false,
    });
    expect(boot.appearanceSafeMode).toBe("true");
    expect(boot.themeId).toBeUndefined();
    expect(boot.t3AppearanceActive).toBeUndefined();
    expect(boot.isDark).toBe(false);
    expect(boot.bootVariables["--app-theme-canvas"]).toBe("#010203");
    expect(boot.themeSelected).toBe("true");
  });

  it.each(["safe", "reset"])(
    "parses %s recovery before reading custom or runtime boot state",
    (recovery) => {
      const boot = runBootScript({
        search: `?t3-appearance=${recovery}`,
        storageThrows: true,
        prefersDark: false,
      });
      expect(boot.themeId).toBeUndefined();
      expect(boot.isDark).toBe(false);
      expect(boot.bootVariables).toEqual({});
      expect(boot.appearanceSafeMode).toBe("true");
    },
  );
});
