export function getSandboxAdapter(): any { return {} }
export function shouldAllowManagedSandboxDomainsOnly(..._args: any[]): any { return false }

// SandboxManager as a class with static methods
export class SandboxManager {
  static isSandboxingEnabled(): boolean { return false }
  static isEnabled(): boolean { return false }
  static getSandboxConfig(): any { return null }
  static getInstance(): any { return new SandboxManager() }
  isSandboxingEnabled(): boolean { return false }
  isEnabled(): boolean { return false }
}

export default SandboxManager

// Additional static methods
SandboxManager.getSandboxUnavailableReason = (): string | null => null
SandboxManager.isSandboxAvailable = (): boolean => false
SandboxManager.getActiveSandboxId = (): string | null => null
