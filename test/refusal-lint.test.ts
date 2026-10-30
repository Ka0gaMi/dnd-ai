// Refusals that teach: a refusal the DM reads must say what to call or pass instead (owner decision 2026-10-06).
// Texts that do not yet are a ratcheted baseline in test/fixtures/refusal-baseline.json, which may only shrink.
import { readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { refusal } from '../src/core/refusals.js';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const BASELINE = fileURLToPath(new URL('./fixtures/refusal-baseline.json', import.meta.url));

/**
 * The retry clause: a refusal passes when any pattern matches its text. They accept an imperative naming the next call
 * or argument, a tool or field written as code (`target_id`, `story {op: …}`, `op=get`), or a list of the valid choices.
 */
const RETRY_CLAUSE = [
  /\b(?:re-?call|call|pass|use|give|try|retry|omit|wait|choose|pick|instead|first)\b/i,
  /\bleave\b[^.;]*\b(?:off|out)\b/i,
  /\b[a-z]+_[a-z0-9_]+\b|\b[a-z]+ ?\{|\bop=/,
  /\b(?:valid \w+|available|options|its \w+|\w+ here|remaining):|\bone of\b/i,
];

/** A baseline entry: the file and the first 60 characters of the text, so a moved line keeps its entry. */
const PREFIX = 60;

interface Refusal {
  file: string;
  line: number;
  text: string;
}

type Fn = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;

/** The const or function named `name` in the nearest scope that declares one; a parameter of that name hides it. */
function declared(name: string, from: ts.Node): ts.Expression | Fn | undefined {
  for (let node: ts.Node | undefined = from; node; node = node.parent) {
    if (ts.isFunctionLike(node) && node.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === name)) return undefined;
    if (!ts.isBlock(node) && !ts.isSourceFile(node)) continue;
    for (const statement of node.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement;
      if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
      const declaration = statement.declarationList.declarations.find((d) => ts.isIdentifier(d.name) && d.name.text === name);
      if (declaration?.initializer) return declaration.initializer;
    }
  }
  return undefined;
}

/** The one expression a function returns, when it has exactly one. */
function returned(fn: Fn): ts.Expression | undefined {
  if (!fn.body || !ts.isBlock(fn.body)) return fn.body;
  const found: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isReturnStatement(node) && node.expression) found.push(node.expression);
    else if (!ts.isFunctionLike(node)) ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn.body, visit);
  return found.length === 1 ? found[0] : undefined;
}

/** A message's text through literals, `+`, same-file consts and one-return helpers; anything else reads `${}`. */
function textOf(node: ts.Node | undefined, depth = 0): string {
  if (!node || depth > 4) return '${}';
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((span) => textOf(span.expression, depth + 1) + span.literal.text).join('');
  }
  if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) return textOf(node.expression, depth);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return textOf(node.left, depth) + textOf(node.right, depth);
  }
  if (ts.isIdentifier(node)) {
    const value = declared(node.text, node);
    return value && !ts.isFunctionLike(value) ? textOf(value, depth + 1) : '${}';
  }
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
    const fn = declared(node.expression.text, node);
    if (fn && (ts.isFunctionDeclaration(fn) || ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return textOf(returned(fn), depth + 1);
  }
  return '${}';
}

const property = (object: ts.ObjectLiteralExpression, name: string): ts.ObjectLiteralElementLike | undefined =>
  object.properties.find((p) => p.name !== undefined && ts.isIdentifier(p.name) && p.name.text === name);

/** Every refusal text in src: `new Error(...)` messages, the retry of a `refusal(...)` call, and literal `isError: true` replies. */
function scan(): Refusal[] {
  const found: Refusal[] = [];
  const files = (readdirSync(SRC, { recursive: true }) as string[]).filter((f) => f.endsWith('.ts')).map((f) => f.split(sep).join('/'));
  for (const file of files) {
    // The helper's own Error is checked at its call sites, where the retry is written.
    if (file === 'core/refusals.ts') continue;
    const source = ts.createSourceFile(file, readFileSync(join(SRC, file), 'utf8'), ts.ScriptTarget.Latest, true);
    const add = (node: ts.Node, text: string): void => {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      found.push({ file, line, text: text.replace(/\s+/g, ' ').trim() });
    };
    const visit = (node: ts.Node): void => {
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Error') {
        add(node, textOf(node.arguments?.[0]));
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'refusal') {
        add(node, textOf(node.arguments[2]));
      }
      const flag = ts.isObjectLiteralExpression(node) ? property(node, 'isError') : undefined;
      if (flag && ts.isPropertyAssignment(flag) && flag.initializer.kind === ts.SyntaxKind.TrueKeyword) {
        const content = property(node as ts.ObjectLiteralExpression, 'content');
        const items = content && ts.isPropertyAssignment(content) && ts.isArrayLiteralExpression(content.initializer) ? content.initializer.elements : [];
        for (const item of items) {
          const text = ts.isObjectLiteralExpression(item) ? property(item, 'text') : undefined;
          if (text && ts.isShorthandPropertyAssignment(text)) add(item, textOf(text.name));
          else if (text && ts.isPropertyAssignment(text)) add(item, textOf(text.initializer));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

const key = (r: Refusal): string => `${r.file}: ${r.text.slice(0, PREFIX)}`;

/** The entries of `a` left after taking out one match in `b` for each, so repeated texts are counted. */
function minus(a: string[], b: string[]): string[] {
  const left = [...b];
  return a.filter((entry) => {
    const at = left.indexOf(entry);
    if (at === -1) return true;
    left.splice(at, 1);
    return false;
  });
}

describe('refusal registry', () => {
  it('opens with the family lead and ends with the retry clause', () => {
    const error = refusal('unknown_id', 'combatant 12 in this encounter', 'get_battle_state lists the ids; re-call with one of them.');
    expect(error.message).toBe('No combatant 12 in this encounter. get_battle_state lists the ids; re-call with one of them.');
    expect(refusal('missing_field', 'target_id for help', 'Re-call with the ally being helped.').message).toBe(
      'Missing target_id for help. Re-call with the ally being helped.',
    );
  });
});

describe('refusal lint', () => {
  const violations = scan().filter((r) => !RETRY_CLAUSE.some((pattern) => pattern.test(r.text)));
  const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as string[];

  it('finds no refusal without a retry clause beyond the baseline', () => {
    const fresh = new Set(minus(violations.map(key), baseline));
    const where = violations.filter((r) => fresh.has(key(r))).map((r) => `${r.file}:${r.line} ${r.text}`);
    expect(where, 'Say what to call or pass instead (RETRY_CLAUSE above); do not grow the baseline.').toEqual([]);
  });

  it('keeps no baseline entry that was fixed or removed', () => {
    expect(minus(baseline, violations.map(key)), 'Delete these from test/fixtures/refusal-baseline.json.').toEqual([]);
  });
});
