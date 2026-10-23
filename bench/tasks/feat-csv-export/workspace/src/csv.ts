export function escapeField(value: string): string {
  if (value.includes(',')) {
    return `"${value}"`
  }
  return value
}
