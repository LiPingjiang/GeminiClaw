// @ts-nocheck
import { existsSync, readFileSync } from "fs";
import { resolve, dirname } from "path";
import yaml from "js-yaml";
import { printOutput, printError } from "../lib/output.js";
function findConfigFile() {
    if (process.env.GC_CONFIG)
        return resolve(process.env.GC_CONFIG);
    const cwd = process.cwd() + "/config.yaml";
    if (existsSync(cwd))
        return cwd;
    let dir = process.cwd();
    for (let i = 0; i < 8; i++) {
        const pkg = dir + "/package.json";
        if (existsSync(pkg)) {
            try {
                const p = JSON.parse(readFileSync(pkg, "utf-8"));
                if (p.name === "geminiclaw") {
                    const cfg = dir + "/config.yaml";
                    if (existsSync(cfg))
                        return cfg;
                }
            }
            catch { }
        }
        const parent = dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    throw new Error("config.yaml not found. Set GC_CONFIG env var or run from GeminiClaw project directory.");
}
export function registerConfigCommand(program) {
    const config = program
        .command("config")
        .description(`Configuration management — inspect GeminiClaw config.yaml

WHAT
  Reads and displays config.yaml settings.
  Sensitive fields (secrets, tokens, api keys) are redacted in human output.

WHEN (agent guidance)
  Call \`gc config show\` to understand current server settings, workspace paths,
  model configuration, and feature flags.
  Call \`gc config path\` to find where config.yaml lives.

OUTPUT
  Human: formatted YAML with secrets redacted
  JSON:  parsed config object (secrets still redacted)`);
    config
        .command("show")
        .description("Show current configuration (secrets redacted)")
        .option("--json", "Output as JSON")
        .option("--raw", "Show raw YAML without redaction (use with care)")
        .action((opts) => {
        const format = opts.json ? "json" : "human";
        try {
            const configPath = findConfigFile();
            const raw = readFileSync(configPath, "utf-8");
            const parsed = yaml.load(raw);
            if (!opts.raw) {
                redactSecrets(parsed);
            }
            const humanText = `⚙️  GeminiClaw Configuration\nFile: ${configPath}\n\n${yaml.dump(parsed)}`;
            printOutput({ path: configPath, config: parsed }, humanText, format);
        }
        catch (e) {
            printError(String(e), format);
        }
    });
    config
        .command("path")
        .description("Show path to config.yaml")
        .action(() => {
        try {
            const configPath = findConfigFile();
            console.log(configPath);
        }
        catch (e) {
            console.error(`❌ ${e}`);
            process.exit(1);
        }
    });
}
const SECRET_KEYS = ["token", "secret", "password", "key", "apiKey", "api_key", "auth"];
function redactSecrets(obj) {
    if (!obj || typeof obj !== "object")
        return;
    for (const key of Object.keys(obj)) {
        const lk = key.toLowerCase();
        if (SECRET_KEYS.some((s) => lk.includes(s))) {
            obj[key] = "***REDACTED***";
        }
        else {
            redactSecrets(obj[key]);
        }
    }
}
