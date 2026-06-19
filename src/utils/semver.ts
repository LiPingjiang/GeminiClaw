import semver from 'semver'

export function gte(a: string, b: string): boolean {
  return semver.gte(a, b)
}
export function gt(..._args: any[]): any { return undefined as any }
