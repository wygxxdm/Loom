export function validateSignup(email: string, age: number): string[] {
  const errors: string[] = []

  if (!email.includes('@') || email.startsWith('@') || email.endsWith('@')) {
    errors.push('email')
  }
  if (!Number.isInteger(age) || age < 18) {
    errors.push('age')
  }

  return errors
}
