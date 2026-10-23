export function decodeComponent(raw: string): string {
  return decodeURIComponent(raw.replace(/\+/g, ' '))
}
