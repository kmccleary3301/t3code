import { describe, expect, it } from "vite-plus/test";

import { resolvePiFamilyEnvironment } from "./PiFamilyDriver.ts";

describe("Pi-family driver environment isolation", () => {
  it("merges instance variables over config variables without sharing instances", () => {
    const configEnvironment = {
      PI_PROFILE: "default",
      SHARED_VALUE: "config",
      CONFIG_ONLY: "kept",
    };
    const personal = resolvePiFamilyEnvironment(configEnvironment, [
      { name: "PI_PROFILE", value: "personal", sensitive: false },
      { name: "INSTANCE_ONLY", value: "personal-only", sensitive: false },
    ]);
    const work = resolvePiFamilyEnvironment(configEnvironment, [
      { name: "PI_PROFILE", value: "work", sensitive: false },
      { name: "INSTANCE_ONLY", value: "work-only", sensitive: false },
    ]);

    expect(personal).toMatchObject({
      PI_PROFILE: "personal",
      INSTANCE_ONLY: "personal-only",
      SHARED_VALUE: "config",
      CONFIG_ONLY: "kept",
    });
    expect(work).toMatchObject({
      PI_PROFILE: "work",
      INSTANCE_ONLY: "work-only",
      SHARED_VALUE: "config",
      CONFIG_ONLY: "kept",
    });
    expect(personal).not.toBe(work);
    expect(configEnvironment).toEqual({
      PI_PROFILE: "default",
      SHARED_VALUE: "config",
      CONFIG_ONLY: "kept",
    });
  });
});
