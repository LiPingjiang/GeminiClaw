export function getSandboxAdapter(): any { return {} }
export function shouldAllowManagedSandboxDomainsOnly(..._args: any[]): any { return false }

// SandboxManager as a class with static methods
export class SandboxManager {
  static isSandboxingEnabled(): boolean { return false }
  static isEnabled(): boolean { return false }
  static getSandboxConfig(): any { return null }
  static getInstance(): SandboxManager { return new SandboxManager() }
  static getSandboxUnavailableReason(): string | null { return null }
  static isSandboxAvailable(): boolean { return false }
  static getActiveSandboxId(): string | null { return null }
  
  isSandboxingEnabled(): boolean { return false }
  isEnabled(): boolean { return false }
}

export default SandboxManager
