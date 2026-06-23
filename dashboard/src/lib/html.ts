import htm from "htm";
import { h, type VNode } from "preact";

type HtmlTemplate = (strings: TemplateStringsArray, ...values: unknown[]) => VNode;

export const html: HtmlTemplate = htm.bind(h) as HtmlTemplate;
