import { readFileSync } from "node:fs";
import ts from "typescript";

export function moduleUrl(name, dependencies = {}) {
  const source = readFileSync(
    new URL("../src/playtest/" + name + ".ts", import.meta.url),
    "utf8",
  );
  let { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
    },
  });
  for (const [path, url] of Object.entries(dependencies))
    outputText = outputText.replaceAll('"' + path + '"', '"' + url + '"');
  return (
    "data:text/javascript;base64," + Buffer.from(outputText).toString("base64")
  );
}

function printing(id) {
  return {
    id,
    name: "Name " + id,
    oracleId: id,
    setCode: "abc",
    setName: "Example",
    collectorNumber: "1",
    rarity: "common",
    manaCost: "",
    cmc: 0,
    typeLine: "Creature",
    oracleText: "",
    colors: [],
    owned: 1,
    imageUri: null,
    backImageUri: null,
  };
}

export const deck = (prefix, count = 12) => ({
  id: prefix,
  name: "Deck " + prefix,
  createdAt: "",
  updatedAt: "",
  cards: [
    ...Array.from({ length: count }, (_, i) => ({
      card: printing(prefix + i),
      quantity: 1,
      section: "main",
    })),
    { card: printing("sideboard"), quantity: 1, section: "sideboard" },
  ],
});
