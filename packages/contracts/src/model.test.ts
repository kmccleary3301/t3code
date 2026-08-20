import { describe, expect, it } from "vite-plus/test";

import { ProviderDriverKind } from "./providerInstance.ts";
import { DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER, PROVIDER_DISPLAY_NAMES } from "./model.ts";

describe("provider display names", () => {
  it("labels Pi-family drivers distinctly", () => {
    expect(PROVIDER_DISPLAY_NAMES[ProviderDriverKind.make("pi")]).toBe("Pi");
    expect(PROVIDER_DISPLAY_NAMES[ProviderDriverKind.make("omp")]).toBe("Oh My Pi");
  });
});

describe("provider text-generation defaults", () => {
  it("uses provider-qualified model identifiers for Pi-family drivers", () => {
    expect(DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[ProviderDriverKind.make("pi")]).toBe(
      "openai-codex/gpt-5.4",
    );
    expect(DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[ProviderDriverKind.make("omp")]).toBe(
      "openai-codex/gpt-5.6-sol",
    );
  });
});
