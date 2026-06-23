import { isolatedDeclarationSync, transformSync } from "oxc-transform";

function assertNoErrors(label, result) {
  if (result.errors.length === 0) return;
  const messages = result.errors.map((error) => error.message).join("\n");
  throw new Error(`${label} failed:\n${messages}`);
}

const tsx = transformSync(
  "probe.tsx",
  "export const View = ({ name }: { name: string }) => <span>{name}</span>;\n",
  {
    lang: "tsx",
    sourceType: "module",
    target: "es2022",
    jsx: { runtime: "automatic", importSource: "react" },
  },
);
assertNoErrors("tsx transform", tsx);
if (!tsx.code.includes("react/jsx-runtime")) {
  throw new Error("tsx transform did not use the React automatic JSX runtime");
}

const declaration = isolatedDeclarationSync(
  "probe.ts",
  "export interface Box<T> { value: T }\nexport const answer: number = 42;\n",
);
assertNoErrors("isolated declaration", declaration);
if (!declaration.code.includes("export declare const answer: number;")) {
  throw new Error("isolated declaration output is missing the exported const declaration");
}
