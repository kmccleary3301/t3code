import { describe, expect, it } from "vite-plus/test";

import { ProviderDriverKind } from "./providerInstance.ts";
import { PROVIDER_DISPLAY_NAMES } from "./model.ts";

describe("provider display names", () => {
  it("labels Pi-family drivers distinctly", () => {
    expect(PROVIDER_DISPLAY_NAMES[ProviderDriverKind.make("pi")]).toBe("Pi");
    expect(PROVIDER_DISPLAY_NAMES[ProviderDriverKind.make("omp")]).toBe("Oh My Pi");
  });
});
