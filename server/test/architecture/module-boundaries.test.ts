import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { readdir } from "node:fs/promises";

import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";

import { checkModuleBoundaries } from "../../scripts/check-module-boundaries.js";

const SRC_ROOT = new URL("../../src/", import.meta.url).pathname.replace(/\/$/, "");

const fixtureRoots: string[] = [];

/** 每个用例独享临时源码树，避免夹具互相污染。 */
async function createFixtureRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "boundary-fixture-"));
    fixtureRoots.push(root);
    return root;
}

async function writeFixture(root: string, relativePath: string, contents: string): Promise<void> {
    const target = join(root, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents, "utf8");
}

afterEach(async () => {
    for (const root of fixtureRoots.splice(0)) {
        await rm(root, { recursive: true, force: true }).catch(() => {});
    }
});

type Violation = { module: string; file: string; rule: string };

/** 递归收集 TypeScript 源文件，忽略声明文件。 */
async function collectSourceFiles(root: string): Promise<string[]> {
    const found: string[] = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
        const path = join(root, entry.name);
        if (entry.isDirectory()) found.push(...(await collectSourceFiles(path)));
        else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) found.push(path);
    }
    return found.sort();
}

/** 用 TypeScript 解析器取出静态导入、再导出与动态 import() 的模块字面量。 */
function readModuleSpecifiers(sourceText: string, fileName: string): string[] {
    const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.ESNext, true);
    const specifiers: string[] = [];

    const visit = (node: ts.Node): void => {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
            if (ts.isStringLiteral(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier.text);
        }
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
            const [first] = node.arguments;
            if (first && ts.isStringLiteral(first)) specifiers.push(first.text);
        }
        ts.forEachChild(node, visit);
    };

    visit(source);
    return specifiers;
}

/** 直接在测试内扫描当前源码树，报告真实越界导入。 */
async function scanSourceTree(root: string): Promise<Violation[]> {
    const { readFile } = await import("node:fs/promises");
    const violations: Violation[] = [];

    for (const file of await collectSourceFiles(root)) {
        const relativePath = relative(root, file).split(sep).join("/");
        const insideIdentity = relativePath.startsWith("modules/identity/");

        for (const specifier of readModuleSpecifiers(await readFile(file, "utf8"), file)) {
            if (specifier.startsWith("better-auth") && !insideIdentity) {
                violations.push({ module: specifier, file: relativePath, rule: "better-auth-outside-identity" });
            }
            if (specifier.includes("identity/auth-schema") && !insideIdentity) {
                violations.push({ module: specifier, file: relativePath, rule: "private-schema-import" });
            }
        }
    }

    return violations;
}

describe("module boundaries in the current source tree", () => {
    it("keeps every better-auth import inside the Identity module", async () => {
        const violations = await scanSourceTree(SRC_ROOT);

        expect(violations.filter((item) => item.rule === "better-auth-outside-identity")).toEqual([]);
    });

    it("never imports the private identity/auth-schema across modules", async () => {
        const violations = await scanSourceTree(SRC_ROOT);

        expect(violations.filter((item) => item.rule === "private-schema-import")).toEqual([]);
    });
});

describe("checkModuleBoundaries", () => {
    it("rejects better-auth imports outside Identity", async () => {
        const root = await createFixtureRoot();
        await writeFixture(root, "modules/workspaces/bad.ts", `import { APIError } from "better-auth/api";`);

        await expect(checkModuleBoundaries(root)).resolves.toEqual([
            expect.objectContaining({ module: "better-auth/api", file: "modules/workspaces/bad.ts" }),
        ]);
    });

    it("allows better-auth imports inside Identity", async () => {
        const root = await createFixtureRoot();
        await writeFixture(root, "modules/identity/auth.ts", `import { betterAuth } from "better-auth";`);

        await expect(checkModuleBoundaries(root)).resolves.toEqual([]);
    });

    it("rejects cross-module imports of the private identity/auth-schema", async () => {
        const root = await createFixtureRoot();
        await writeFixture(root, "modules/workspaces/schema.ts", `import { users } from "../identity/auth-schema.js";`);

        await expect(checkModuleBoundaries(root)).resolves.toEqual([
            expect.objectContaining({ rule: "private-schema-import", file: "modules/workspaces/schema.ts" }),
        ]);
    });

    it("rejects a cross-module import of a non-public implementation file", async () => {
        const root = await createFixtureRoot();
        await writeFixture(root, "modules/canvases/service.ts", `import { helper } from "../workspaces/internal-helper.js";`);

        await expect(checkModuleBoundaries(root)).resolves.toEqual([
            expect.objectContaining({ rule: "non-public-module-entry", file: "modules/canvases/service.ts" }),
        ]);
    });

    it("allows cross-module imports of documented public entries", async () => {
        const root = await createFixtureRoot();
        await writeFixture(root, "modules/canvases/schema.ts", `import { workspaces } from "../workspaces/schema.js";`);
        await writeFixture(root, "modules/workspaces/schema.ts", `import { users } from "../identity/schema.js";`);

        await expect(checkModuleBoundaries(root)).resolves.toEqual([]);
    });

    it("inspects dynamic import() specifiers as well", async () => {
        const root = await createFixtureRoot();
        await writeFixture(root, "modules/workspaces/lazy.ts", `export const load = () => import("better-auth/plugins/organization");`);

        await expect(checkModuleBoundaries(root)).resolves.toEqual([
            expect.objectContaining({ module: "better-auth/plugins/organization", rule: "better-auth-outside-identity" }),
        ]);
    });
});
