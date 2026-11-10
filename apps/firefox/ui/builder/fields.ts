const MAX = 50;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Fields offered in a template: keys of the first item (or of the object), then `config.<key>`. */
export function availableFields(upstreamOutput: unknown, config: unknown): string[] {
  const example = Array.isArray(upstreamOutput) ? upstreamOutput[0] : upstreamOutput;
  const fieldList = isObject(example) ? Object.keys(example) : [];
  if (isObject(config)) fieldList.push(...Object.keys(config).map((k) => `config.${k}`));
  return fieldList.slice(0, MAX);
}
