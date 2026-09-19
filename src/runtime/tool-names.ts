/**
 * Operation names as Anthropic tool names, which must match ^[a-zA-Z0-9_-]{1,128}$. A dot becomes
 * `__`, which is only safe while no two listed operations encode alike (`a.b` and `a__b`, or `a._b`
 * and `a_.b`), so a list that would is refused rather than sent.
 */
export function toolName(operation: string): string { return operation.replaceAll('.', '__') }

/** The reason these operations cannot all be tools, or undefined when each maps to its own valid name. */
export function toolNameProblem(operations: string[]): string | undefined {
  const seen = new Map<string, string>()
  for (const operation of operations) {
    const name = toolName(operation)
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(name)) return `'${operation}' is not a valid tool name: use letters, digits, '_', '-' and '.', at most 128 characters once each '.' becomes '__'`
    const other = seen.get(name)
    if (other !== undefined && other !== operation) return `'${other}' and '${operation}' both become the tool name '${name}'`
    seen.set(name, operation)
  }
  return undefined
}
