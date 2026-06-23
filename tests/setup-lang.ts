import { Console } from "node:console";
import { setLanguageRuntime } from "../src/i18n/index.js";

if (typeof console.Console !== "function") {
  Object.defineProperty(console, "Console", { configurable: true, value: Console });
}

setLanguageRuntime("EN");
