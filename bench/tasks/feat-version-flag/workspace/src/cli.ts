export interface Parsed {
  readonly command: string
  readonly verbose: boolean
}

export function parseArgs(argv: readonly string[]): Parsed {
  const rest = argv.filter((arg) => !arg.startsWith('--'))
  return {
    command: rest[0] ?? 'help',
    verbose: argv.includes('--verbose'),
  }
}
