// Only these static messages may cross the CLI/logging boundary.
export class GitHubError extends Error {
  constructor(public readonly kind: 'connection' | 'timeout' | 'tool' | 'schema' | 'limit' | 'permission') {
    const messages = {
      connection: 'Could not connect to GitHub MCP. Check network access and GITHUB_TOKEN permissions.',
      timeout: 'GitHub MCP request timed out.',
      tool: 'GitHub MCP read failed. The PR may be inaccessible, or GitHub may be rate-limiting requests.',
      schema: 'GitHub MCP returned an unsupported or invalid response.',
      limit: 'GitHub MCP response exceeded the supported size limit.',
      permission: 'The requested GitHub capability is not on the read-only allow-list or is unavailable.',
    };
    super(messages[kind]);
  }
}
