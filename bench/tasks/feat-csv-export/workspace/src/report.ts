import { escapeField } from './csv.ts'

export function toCsv(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => row.map(escapeField).join(',')).join('\n')
}
