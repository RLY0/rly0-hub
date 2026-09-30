/**
 * Canonical GitHub repository for RLY/0 Hub releases, issues, and update checks.
 * Every TypeScript consumer derives its repository URLs from these constants so the
 * updater can never be pointed back at the upstream CodexHost repository by accident.
 */
export const RLY0_GITHUB_REPOSITORY = "a1039861261-stack/rly0-hub";
export const RLY0_GITHUB_REPOSITORY_URL = `https://github.com/${RLY0_GITHUB_REPOSITORY}`;
export const RLY0_GITHUB_ISSUES_URL = `${RLY0_GITHUB_REPOSITORY_URL}/issues`;
export const RLY0_GITHUB_ISSUES_NEW_URL = `${RLY0_GITHUB_ISSUES_URL}/new`;
export const RLY0_GITHUB_RELEASES_LATEST_URL = `${RLY0_GITHUB_REPOSITORY_URL}/releases/latest`;
export const RLY0_GITHUB_RELEASE_TAG_URL_PREFIX = `${RLY0_GITHUB_REPOSITORY_URL}/releases/tag/`;
export const RLY0_GITHUB_RELEASE_DOWNLOAD_URL_PREFIX = `${RLY0_GITHUB_REPOSITORY_URL}/releases/download/`;
export const RLY0_GITHUB_API_LATEST_RELEASE_ENDPOINT = `repos/${RLY0_GITHUB_REPOSITORY}/releases/latest`;
export const RLY0_GITHUB_API_LATEST_RELEASE_URL = `https://api.github.com/${RLY0_GITHUB_API_LATEST_RELEASE_ENDPOINT}`;

function escapeRegularExpression(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\/]/gu, "\\$&");
}

/** Matches `<repo>/releases/tag/v<version>` and captures the tag in group 1. */
export const RLY0_GITHUB_RELEASE_TAG_URL_PATTERN = new RegExp(
  `^${escapeRegularExpression(RLY0_GITHUB_RELEASE_TAG_URL_PREFIX)}(v[0-9A-Za-z.+-]+)$`,
  "u",
);
