import { type AnyNode, parse } from "acorn";

/** Parse the delivered ESM as data. Never compile, import or expand Bun macros here. */
export function inspectExtensionModule(source: string) {
  const program = parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
  });
  const hasDefault = program.body.some(
    (node) =>
      node.type === "ExportDefaultDeclaration" ||
      (node.type === "ExportNamedDeclaration" &&
        node.specifiers.some((specifier) =>
          specifier.exported.type === "Identifier"
            ? specifier.exported.name === "default"
            : specifier.exported.value === "default",
        )),
  );
  const imports: string[] = [];
  const pending: AnyNode[] = [program];
  while (pending.length) {
    const node = pending.pop();
    if (!node) break;
    if (
      node.type === "ImportDeclaration" ||
      node.type === "ExportAllDeclaration" ||
      node.type === "ExportNamedDeclaration"
    ) {
      if (
        node.attributes?.some((attribute) => attribute.value.value === "macro")
      )
        throw new Error(
          "Bundle macros before delivering an extension; authoring never expands them.",
        );
      if (typeof node.source?.value === "string")
        imports.push(node.source.value);
    } else if (
      node.type === "ImportExpression" &&
      node.source.type === "Literal" &&
      typeof node.source.value === "string"
    )
      imports.push(node.source.value);
    else if (node.type === "CallExpression") {
      const callee = node.callee;
      const requireCall =
        callee.type === "Identifier" && callee.name === "require";
      const resolveCall =
        callee.type === "MemberExpression" &&
        callee.object.type === "Identifier" &&
        callee.object.name === "require" &&
        !callee.computed &&
        callee.property.type === "Identifier" &&
        callee.property.name === "resolve";
      const first = node.arguments[0];
      if (
        (requireCall || resolveCall) &&
        first?.type === "Literal" &&
        typeof first.value === "string"
      )
        imports.push(first.value);
    }
    for (const value of Object.values(node)) {
      const children = Array.isArray(value) ? value : [value];
      for (const child of children)
        if (
          child &&
          typeof child === "object" &&
          typeof child.type === "string"
        )
          pending.push(child as AnyNode);
    }
  }
  return { hasDefault, imports };
}
