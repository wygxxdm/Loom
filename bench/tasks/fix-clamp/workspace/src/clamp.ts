export function clamp(value: number, low: number, high: number): number {
  if (value < low) return high
  if (value > high) return low
  return value
}
