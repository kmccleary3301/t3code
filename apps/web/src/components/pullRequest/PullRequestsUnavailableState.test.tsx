import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { PullRequestsUnavailableState } from "./PullRequestsUnavailableState";

describe("PullRequestsUnavailableState", () => {
  it("retains the retry for transient load failures", () => {
    const html = renderToStaticMarkup(
      <PullRequestsUnavailableState
        error="GitHub did not answer."
        onRetry={() => {}}
        gitHubUrl="https://github.com/pingdotgg/t3code/pull/42"
      />,
    );

    expect(html).toContain("Retry");
    expect(html).toContain("Open on GitHub");
    expect(html).toContain('href="https://github.com/pingdotgg/t3code/pull/42"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("can offer the browser without offering a retry", () => {
    const html = renderToStaticMarkup(
      <PullRequestsUnavailableState
        error="This server cannot read the pull request."
        gitHubUrl="https://github.com/pingdotgg/t3code/pull/9"
      />,
    );

    expect(html).toContain("Open on GitHub");
    expect(html).not.toContain("Retry");
  });

  it("can offer a retry without offering GitHub", () => {
    const html = renderToStaticMarkup(
      <PullRequestsUnavailableState error="The host did not answer." onRetry={() => {}} />,
    );

    expect(html).toContain("Retry");
    expect(html).not.toContain("Open on GitHub");
  });

  it("renders no action content without a retry or browser target", () => {
    const html = renderToStaticMarkup(
      <PullRequestsUnavailableState error="This project has no known remote." />,
    );

    expect(html).not.toContain("href=");
  });
});
