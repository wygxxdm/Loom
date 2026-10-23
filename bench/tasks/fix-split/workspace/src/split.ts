export function splitList(input: string): string[] {
  return input.split(',').map((part) => part.trim())
}
