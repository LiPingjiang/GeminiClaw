export type OutputFormat = "human" | "json"

export function printHuman(text: string): void {
  console.log(text)
}

export function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2))
}

export function printOutput(data: unknown, text: string, format: OutputFormat): void {
  if (format === "json") {
    printJson(data)
  } else {
    printHuman(text)
  }
}

export function printError(msg: string, format: OutputFormat): void {
  if (format === "json") {
    printJson({ error: msg })
  } else {
    console.error(`❌ ${msg}`)
  }
  process.exit(1)
}

export function printWarn(msg: string): void {
  console.error(`⚠️  ${msg}`)
}
