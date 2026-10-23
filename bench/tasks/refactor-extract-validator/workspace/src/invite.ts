export function validateInvite(email: string): string[] {
  const errors: string[] = []

  if (!email.includes('@') || email.startsWith('@') || email.endsWith('@')) {
    errors.push('email')
  }

  return errors
}
