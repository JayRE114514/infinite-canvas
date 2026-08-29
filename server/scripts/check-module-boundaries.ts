import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { argv, exitCode } from "node:process";
import { fileURLToPath } from "node:url";

import ts from "typescript";

/**
 * 模块边界检查：用 TypeScript 解析器读取静态导入、再导出与动态 import()。
 * 规则一：better-auth* 只能出现在 Identity 模块内。
 * 规则二：任何模块都不得导入 Identity 的私有实现 identity/auth-schema。
 * 规则三：跨模块导入只能指向目标模块的公开入口。
 */

export type BoundaryViolation = { module: string; file: string; rule: string };

const IDENTITY_PREFIX = "modules/identity/";

/** 各模块允许被其他模块引用的公开入口，其余文件都是模块私有实现。 */
const MODULE_PUBLIC_ENTRIES: Record<string, readonly string[]> = {
    identity: ["schema", "session", "auth", "types", "routes"],
    workspaces: ["schema", "service", "authorization", "context", "routes"],
    canvases: ["schema", "service", "routes"],
    "platform-admin": ["schema", "service", "routes"],
    credits: ["amount", "schema", "service", "routes"],
    billing: ["schema", "service"],
    assets: ["schema", "service", "object-store", "routes"],
    providers: ["adapter", "registry", "test-adapter", "openai-images", "gemini-images"],
    "ai-tasks": ["schema", "service", "routes", "queue", "worker", "events"],
};

async function collectSourceFiles(root: string): Promise<string[]> {
    const found: string[] = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
        const path = join(root, entry.name);
        if (entry.isDirectory()) found.push(...(await collectSourceFiles(path)));
        else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) found.push(path);
    }
    return found.sort();
}

/** 取出全部模块字面量；忽略非字面量的动态 import()。 */
export function readModuleSpecifiers(sourceText: string, fileName: string): string[] {
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

/** 当前文件所属模块名；不在 modules/ 下的（组合根、基础设施）返回 undefined。 */
function moduleOf(relativePath: string): string | undefined {
    const match = /^modules\/([^/]+)\//.exec(relativePath);
    return match?.[1];
}

/** 把相对导入解析成相对 src 根的路径，便于判断目标模块与入口名。 */
function resolveSpecifier(relativePath: string, specifier: string): string | undefined {
    if (!specifier.startsWith(".")) return undefined;
    const fromDir = relativePath.split("/").slice(0, -1);
    const parts = specifier.replace(/\.js$/, "").split("/");
    const stack = [...fromDir];
    for (const part of parts) {
        if (part === ".") continue;
        else if (part === "..") stack.pop();
        else stack.push(part);
    }
    return stack.join("/");
}

export async function checkModuleBoundaries(rootDir: string): Promise<BoundaryViolation[]> {
    const violations: BoundaryViolation[] = [];

    for (const file of await collectSourceFiles(rootDir)) {
        const relativePath = relative(rootDir, file).split(sep).join("/");
        const currentModule = moduleOf(relativePath);
        const insideIdentity = relativePath.startsWith(IDENTITY_PREFIX);

        for (const specifier of readModuleSpecifiers(await readFile(file, "utf8"), file)) {
            if (specifier.startsWith("better-auth") && !insideIdentity) {
                violations.push({ module: specifier, file: relativePath, rule: "better-auth-outside-identity" });
            }

            const resolved = resolveSpecifier(relativePath, specifier);
            if (!resolved) continue;

            if (resolved === `${IDENTITY_PREFIX}auth-schema` && !insideIdentity) {
                violations.push({ module: specifier, file: relativePath, rule: "private-schema-import" });
                continue;
            }

            const targetModule = moduleOf(`${resolved}/`);
            if (!targetModule || targetModule === currentModule) continue;

            const entry = resolved.slice(`modules/${targetModule}/`.length);
            const allowed = MODULE_PUBLIC_ENTRIES[targetModule] ?? [];
            if (!allowed.includes(entry)) {
                violations.push({ module: specifier, file: relativePath, rule: "non-public-module-entry" });
            }
        }
    }

    return violations;
}

/** 作为命令执行时打印全部违规并以非零码退出。 */
async function main(): Promise<void> {
    const [target] = process.argv.slice(2);
    if (!target) throw new Error("Usage: tsx scripts/check-module-boundaries.ts <src-dir>");

    const violations = await checkModuleBoundaries(target);
    if (violations.length === 0) {
        process.stdout.write("module boundaries: ok\n");
        return;
    }

    for (const violation of violations) {
        process.stderr.write(`${violation.rule}: ${violation.file} imports ${violation.module}\n`);
    }
    process.exitCode = 1;
}

// 仅在被直接执行时运行，作为库导入时保持纯函数。
if (argv[1] && resolve(argv[1]) === fileURLToPath(import.meta.url)) {
    await main();
}
