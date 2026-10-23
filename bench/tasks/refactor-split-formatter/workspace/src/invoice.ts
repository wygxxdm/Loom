export interface Invoice {
  readonly id: string
  readonly cents: number
  readonly currency: string
}

export function formatInvoice(invoice: Invoice): string {
  const sign = invoice.cents < 0 ? '-' : ''
  const absolute = Math.abs(invoice.cents)
  const whole = Math.floor(absolute / 100)
  const fraction = String(absolute % 100).padStart(2, '0')
  return `${invoice.id} ${sign}${invoice.currency}${whole}.${fraction}`
}
