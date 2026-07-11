import { describe, expect, it } from "vitest";
import {
  extractSubscriptionToken,
  isUnderManagedBasePath,
  managedBasePathFromConfig,
  managedRuleSetUrl,
  managedSubscriptionUrl,
  managedSubscriptionUrlForRequest,
  normalizeManagedBasePath,
  parseSyncPath
} from "../src/managed-url";
import { DEFAULT_CONFIG } from "../src/default-config";

describe("managed subscription URL helpers", () => {
  it("normalizes base paths and checks managed path containment", () => {
    expect(normalizeManagedBasePath("/sync/")).toBe("/sync");
    expect(normalizeManagedBasePath("/")).toBe("/");
    expect(isUnderManagedBasePath("/sync", "/sync")).toBe(true);
    expect(isUnderManagedBasePath("/sync/read-token/", "/sync")).toBe(true);
    expect(isUnderManagedBasePath("/sync/read-token/", "/sync/")).toBe(true);
    expect(isUnderManagedBasePath("/sync-other/read-token/", "/sync")).toBe(false);
    expect(isUnderManagedBasePath("/read-token/", "/")).toBe(false);
  });

  it("extracts the first subscription token while keeping strict path parsing separate", () => {
    expect(extractSubscriptionToken("/sync/read-token/surge-resources/", "/sync")).toBe("read-token");
    expect(extractSubscriptionToken("/read-token/", "/")).toBe("read-token");
    expect(parseSyncPath("/sync/read-token/", "/sync")).toEqual({ token: "read-token" });
    expect(parseSyncPath("/sync/read-token/SubPilot.nodes", "/sync")).toBeNull();
    expect(parseSyncPath("/sync/read-token/SubPilot.conf", "/sync")).toEqual({
      token: "read-token",
      fileName: "SubPilot.conf"
    });
    expect(parseSyncPath("/sync/read-token/surge-resources/", "/sync")).toBeNull();
    expect(parseSyncPath("/sync/read-token/surge", "/sync")).toBeNull();
    expect(parseSyncPath("/sync/read-token/Unknown.conf", "/sync")).toBeNull();
    expect(parseSyncPath("/sync/%E4%B8%AD/", "/sync")).toBeNull();
  });

  it("builds subscription URLs from configured or inferred managed base URLs", () => {
    const inferredConfig = {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        managedBaseUrl: ""
      }
    };
    expect(managedBasePathFromConfig(inferredConfig, "https://admin.example.com/api/preview")).toBe("/sync");
    expect(managedSubscriptionUrl(inferredConfig, "https://admin.example.com/api/preview", "read-token"))
      .toBe("https://admin.example.com/sync/read-token/");

    const configuredConfig = {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        managedBaseUrl: "https://links.example.com/sywwqnc/"
      }
    };
    expect(managedBasePathFromConfig(configuredConfig, "https://admin.example.com/api/preview")).toBe("/sywwqnc");
    expect(managedSubscriptionUrl(configuredConfig, "https://admin.example.com/api/preview", "read-token"))
      .toBe("https://links.example.com/sywwqnc/read-token/");
    expect(managedSubscriptionUrlForRequest(configuredConfig, "https://links.example.com/sywwqnc/read-token/"))
      .toBe("https://links.example.com/sywwqnc/read-token/");
    expect(managedRuleSetUrl(configuredConfig, "https://admin.example.com/api/preview", "read-token", "AI Rules", "domain", "surge"))
      .toBe("https://links.example.com/sywwqnc/read-token/r/AI%20Rules-domain.list");
    expect(managedRuleSetUrl(configuredConfig, "https://admin.example.com/api/preview", "read-token", "AI Rules", "combined", "surge"))
      .toBe("https://links.example.com/sywwqnc/read-token/r/AI%20Rules.list");
    expect(managedRuleSetUrl(configuredConfig, "https://admin.example.com/api/preview", "read-token", "Docker", "combined", "clash"))
      .toBe("https://links.example.com/sywwqnc/read-token/r/Docker.yaml");
    expect(managedRuleSetUrl(configuredConfig, "https://admin.example.com/api/preview", "read-token", "Docker", "combined", "stash"))
      .toBe("https://links.example.com/sywwqnc/read-token/r/Docker.yaml");
  });

  it("parses named rule set files and rejects directory-style paths", () => {
    expect(parseSyncPath("/sync/read-token/r/AI%20Rules-domain.list", "/sync")).toEqual({
      token: "read-token",
      ruleSet: {
        artifactName: "AI Rules-domain",
        target: "surge"
      }
    });
    expect(parseSyncPath("/sync/read-token/r/AI%20Rules/noutput-id/d/surge.list", "/sync")).toBeNull();
    expect(parseSyncPath("/sync/read-token/rule-sets/AI%20Rules/output-id/domain/surge.list", "/sync")).toBeNull();
    expect(parseSyncPath("/sync/read-token/r/AI%20Rules.list", "/sync")).toEqual({
      token: "read-token",
      ruleSet: {
        artifactName: "AI Rules",
        target: "surge"
      }
    });
    expect(parseSyncPath("/sync/read-token/r/Docker.yaml", "/sync")).toEqual({
      token: "read-token",
      ruleSet: {
        artifactName: "Docker",
        target: "clash"
      }
    });
  });
});
