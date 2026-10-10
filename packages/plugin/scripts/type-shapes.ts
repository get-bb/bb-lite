import { fileURLToPath } from "node:url";
import ts from "typescript";
import type { TypeShapes } from "../src/describe.js";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const MAX_DEPTH = 40;
const KINDS = ["op", "event", "slot", "live"];
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const ENTRIES = [
  here("../src/index.ts"),
  here("../src/app.ts"),
  here("../../runner/src/index.ts"),
];

function program(): ts.Program {
  const file = here("../tsconfig.json");
  const host: ts.ParseConfigFileHost = {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: () => {},
  };
  const parsed = ts.getParsedCommandLineOfConfigFile(file, {}, host);
  const options = { ...parsed?.options, noEmit: true, rootDir: undefined };
  return ts.createProgram(ENTRIES, options);
}

function describer(checker: ts.TypeChecker) {
  const flags =
    ts.TypeFormatFlags.NoTruncation |
    ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope;
  const named = (type: ts.Type): Json => ({
    ref: checker.typeToString(type, undefined, flags),
  });
  const foreign = (symbol: ts.Symbol | undefined): boolean =>
    (symbol?.declarations ?? []).some((declaration) => {
      const { fileName } = declaration.getSourceFile();
      return (
        fileName.includes("/node_modules/") ||
        /\/lib\.[^/]*\.d\.ts$/u.test(fileName)
      );
    });
  const literal = (type: ts.Type): Json | undefined => {
    if (type.isStringLiteral() || type.isNumberLiteral()) {
      return { const: type.value };
    }
    if (type.flags & ts.TypeFlags.BooleanLiteral) {
      return { const: checker.typeToString(type) === "true" };
    }
    return undefined;
  };
  const basic = (type: ts.Type): Json | undefined => {
    const has = (flag: ts.TypeFlags) => (type.flags & flag) !== 0;
    if (has(ts.TypeFlags.Any)) return { any: true };
    if (has(ts.TypeFlags.Unknown)) return {};
    if (has(ts.TypeFlags.Boolean)) return { type: "boolean" };
    if (has(ts.TypeFlags.String)) return { type: "string" };
    if (has(ts.TypeFlags.Number)) return { type: "number" };
    if (has(ts.TypeFlags.Null)) return { type: "null" };
    if (has(ts.TypeFlags.Undefined | ts.TypeFlags.Void)) {
      return { type: "undefined" };
    }
    if (has(ts.TypeFlags.Never)) return { never: true };
    if (has(ts.TypeFlags.TypeParameter)) return named(type);
    return literal(type);
  };

  const opaque = (symbol: ts.Symbol | undefined): boolean =>
    foreign(symbol) &&
    !(symbol?.declarations ?? []).some((declaration) =>
      declaration.getSourceFile().fileName.includes("/node_modules/zod/"),
    );
  const digests = new Map<ts.Type, string>();
  const digestOf = (type: ts.Type): string => {
    const known = digests.get(type);
    if (known !== undefined) return known;
    digests.set(type, "self");
    const text = JSON.stringify(shapeOf(type, 0, [], Infinity));
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
      hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
    }
    const digest = `#${(hash >>> 0).toString(36)}`;
    digests.set(type, digest);
    return digest;
  };

  function shapeOf(
    type: ts.Type,
    depth: number,
    seen: ts.Type[],
    limit: number,
  ): Json {
    const simple = basic(type);
    if (simple !== undefined) return simple;
    const deeper = (inner: ts.Type) =>
      shapeOf(inner, depth + 1, [...seen, type], limit);
    const alias = type.aliasSymbol;
    if (alias?.name === "ComponentType" && foreign(alias)) {
      const [props] = type.aliasTypeArguments ?? [];
      return { component: props === undefined ? {} : deeper(props) };
    }
    if (alias !== undefined && opaque(alias)) return named(type);
    if (type.isUnion()) {
      const members = type.types.map(deeper);
      const sorted = members.sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      );
      return { anyOf: sorted };
    }
    if (seen.includes(type)) return { cycle: seen.length - seen.indexOf(type) };
    if (depth >= limit) return { ref: digestOf(type) };
    if (checker.isArrayType(type)) {
      const [item] = checker.getTypeArguments(type as ts.TypeReference);
      return { type: "array", items: item === undefined ? {} : deeper(item) };
    }
    if (checker.isTupleType(type)) {
      const items = checker.getTypeArguments(type as ts.TypeReference);
      return { tuple: items.map(deeper) };
    }
    const symbol = type.getSymbol();
    if (symbol?.name === "Promise" && foreign(symbol)) {
      const [value] = checker.getTypeArguments(type as ts.TypeReference);
      return { promise: value === undefined ? {} : deeper(value) };
    }
    const [call] = type.getCallSignatures();
    if (call !== undefined) {
      const params = call.parameters.map((parameter) =>
        deeper(checker.getTypeOfSymbol(parameter)),
      );
      return { fn: { params, returns: deeper(call.getReturnType()) } };
    }
    if (foreign(symbol)) return named(type);
    const properties: { [key: string]: Json } = {};
    const required: string[] = [];
    const listed = checker
      .getPropertiesOfType(type)
      .toSorted((left, right) => left.name.localeCompare(right.name));
    for (const property of listed) {
      properties[property.name] = deeper(checker.getTypeOfSymbol(property));
      if (!(property.flags & ts.SymbolFlags.Optional)) {
        required.push(property.name);
      }
    }
    const index = checker.getIndexInfosOfType(type)[0];
    const open =
      index === undefined ? {} : { additionalProperties: deeper(index.type) };
    return { type: "object", properties, required, ...open };
  }

  return (type: ts.Type | undefined): Json =>
    type === undefined ? {} : shapeOf(type, 0, [], MAX_DEPTH);
}

export function describeTypes(): TypeShapes {
  const built = program();
  const checker = built.getTypeChecker();
  const shape = describer(checker);
  const produced = (schema: ts.Type | undefined): ts.Type | undefined => {
    const output = schema?.getProperty("_output");
    return output === undefined ? undefined : checker.getTypeOfSymbol(output);
  };
  const kindOf = (member: ts.Type): string | null => {
    const tag = member.getProperty("type");
    const type = tag === undefined ? undefined : checker.getTypeOfSymbol(tag);
    return type?.isStringLiteral() ? type.value : null;
  };
  const shapes: TypeShapes = {};
  for (const entry of ENTRIES) {
    const source = built.getSourceFile(entry);
    const module = source && checker.getSymbolAtLocation(source);
    if (module === undefined) throw new Error(`Cannot read ${entry}`);
    for (const exported of checker.getExportsOfModule(module)) {
      if (
        !(exported.flags & (ts.SymbolFlags.Variable | ts.SymbolFlags.Alias))
      ) {
        continue;
      }
      const target =
        exported.flags & ts.SymbolFlags.Alias
          ? checker.getAliasedSymbol(exported)
          : exported;
      if (!(target.flags & ts.SymbolFlags.Variable)) continue;
      const members = checker.getPropertiesOfType(
        checker.getTypeOfSymbol(target),
      );
      const typed = members.map((member) => {
        const type = checker.getTypeOfSymbol(member);
        return { key: member.name, type, kind: kindOf(type) };
      });
      const isContract =
        typed.length > 0 &&
        typed.every(({ kind }) => KINDS.includes(kind ?? ""));
      if (!isContract) continue;
      const described: TypeShapes[string] = {};
      for (const { key, type, kind } of typed) {
        const [first, second] = checker.getTypeArguments(
          type as ts.TypeReference,
        );
        if (kind === "slot") described[key] = { item: shape(first) };
        if (kind === "op") {
          described[key] = {
            input: shape(produced(first)),
            output: shape(produced(second)),
          };
        }
        if (kind === "event")
          described[key] = { payload: shape(produced(first)) };
        if (kind === "live") described[key] = { value: shape(produced(first)) };
      }
      shapes[exported.name] = described;
    }
  }
  return shapes;
}
