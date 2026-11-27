// Keep this shared by prompt selection and Responses serialization. Gateways
// can prefix the upstream ID with a namespace, e.g. openai/gpt-6.2-sol.
const latestAliases = new Set([
  "gpt-latest",
  "gpt-sol-latest",
  "gpt-astra-latest",
  "gpt-terra-latest",
]);

const versionedId =
  /^gpt-(?:6\.2|6-2|62)(?:-(?:sol|astra))?(?:-\d{4}-\d{2}-\d{2})?$/;

export function isGpt62Model(model: string): boolean {
  const id = model.trim().toLowerCase().split("/").at(-1) ?? "";
  return latestAliases.has(id) || versionedId.test(id);
}
