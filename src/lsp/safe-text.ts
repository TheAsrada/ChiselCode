import { SecretRedactor } from "../security/redaction.js";

const redactor = new SecretRedactor();
export const safeText = (value: unknown, maximum = 2048) =>
  redactor.text(typeof value === "string" ? value : "").slice(0, maximum);
