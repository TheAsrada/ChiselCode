/** Shared names for configuration validation and untrusted output redaction. */
export const MCP_SENSITIVE_KEY =
  /(?:secret|token|password|passwd|credential|api[-_]?key|authorization|cookie|database_url|private[-_]?key|signature|^sig$|^key$)/i;
