// Environment detection stub
export const env: {
  terminal: string | undefined
  isCI: boolean
} = {
  terminal: process.env.TERM_PROGRAM,
  isCI: Boolean(process.env.CI),
}
