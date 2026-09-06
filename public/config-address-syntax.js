// Lexical address recognition for display; configuration validation remains separate.
export const ADDRESS_TOKEN = /(?<![\w.:-])(?:\[?(?:[a-f\d]{0,4}:){2,}(?:[a-f\d]{0,4}|(?:\d{1,3}\.){3}\d{1,3})(?:%[\w.-]+)?\]?(?:\/\d{1,3})?|(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?)(?![\w.:])/i;
export const DOMAIN_TOKEN = /(?<![\w.*+-])(?:localhost|(?=[a-z\d*.-]*\*)(?:[a-z\d*-]+\.)+[a-z\d*-]+|\+\.(?:[a-z\d-]+\.)*[a-z][a-z\d-]*|(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z][a-z\d-]*)(?![\w.*-]|\s*=)/i;
