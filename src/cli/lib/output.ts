// @ts-nocheck
export function printHuman(text) {
    console.log(text);
}
export function printJson(data) {
    console.log(JSON.stringify(data, null, 2));
}
export function printOutput(data, text, format) {
    if (format === "json") {
        printJson(data);
    }
    else {
        printHuman(text);
    }
}
export function printError(msg, format) {
    if (format === "json") {
        printJson({ error: msg });
    }
    else {
        console.error(`❌ ${msg}`);
    }
    process.exit(1);
}
export function printWarn(msg) {
    console.error(`⚠️  ${msg}`);
}
