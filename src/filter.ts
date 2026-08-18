/**
 * Rich Frontmatter & Tag Filter Expression DSL (issue #94).
 * Supports boolean expressions (AND, OR, NOT, grouping parentheses)
 * across frontmatter tags, properties, dates, and custom fields.
 */
import { DocumentMetadata } from './frontmatter.js';

export type FilterNode =
  | { type: 'AND'; left: FilterNode; right: FilterNode }
  | { type: 'OR'; left: FilterNode; right: FilterNode }
  | { type: 'NOT'; child: FilterNode }
  | {
      type: 'COMPARE';
      field: string;
      op: ':' | 'contains' | '=' | '==' | '!=' | '>' | '>=' | '<' | '<=';
      value: string | number | boolean;
    };

export function tokenizeFilter(expr: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    if (ch === '(' || ch === ')') {
      tokens.push(ch);
      i++;
      continue;
    }

    // Quoted string
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let str = '';
      i++;
      while (i < expr.length && expr[i] !== quote) {
        if (expr[i] === '\\' && i + 1 < expr.length) {
          str += expr[i + 1];
          i += 2;
        } else {
          str += expr[i];
          i++;
        }
      }
      i++; // skip closing quote
      tokens.push(`"${str}"`);
      continue;
    }

    // Two-character operators: >=, <=, !=, ==
    if (i + 1 < expr.length) {
      const two = expr.slice(i, i + 2);
      if (two === '>=' || two === '<=' || two === '!=' || two === '==') {
        tokens.push(two);
        i += 2;
        continue;
      }
    }

    // Single-character operators: >, <, =, :
    if (ch === '>' || ch === '<' || ch === '=' || ch === ':') {
      tokens.push(ch);
      i++;
      continue;
    }

    // Word / identifier / value token
    let word = '';
    while (
      i < expr.length &&
      !/\s/.test(expr[i]) &&
      expr[i] !== '(' &&
      expr[i] !== ')' &&
      expr[i] !== ':' &&
      expr[i] !== '=' &&
      expr[i] !== '!' &&
      expr[i] !== '>' &&
      expr[i] !== '<' &&
      expr[i] !== '"' &&
      expr[i] !== "'"
    ) {
      word += expr[i];
      i++;
    }
    if (word) {
      tokens.push(word);
    } else if (i < expr.length) {
      tokens.push(expr[i]);
      i++;
    }
  }
  return tokens;
}

export function parseFilter(expr: string): FilterNode {
  const tokens = tokenizeFilter(expr);
  if (tokens.length === 0) {
    throw new Error('Empty filter expression');
  }

  let pos = 0;

  function peek(): string | undefined {
    return tokens[pos];
  }

  function consume(): string {
    return tokens[pos++];
  }

  function parseExpression(): FilterNode {
    return parseOr();
  }

  function parseOr(): FilterNode {
    let node = parseAnd();
    while (pos < tokens.length && peek()?.toUpperCase() === 'OR') {
      consume(); // OR
      const beforePos = pos;
      const right = parseAnd();
      if (pos === beforePos) {
        throw new Error(`Invalid syntax in filter expression near token "${peek()}"`);
      }
      node = { type: 'OR', left: node, right };
    }
    return node;
  }

  function parseAnd(): FilterNode {
    let node = parseNot();
    while (
      pos < tokens.length &&
      peek()?.toUpperCase() !== 'OR' &&
      peek() !== ')'
    ) {
      if (peek()?.toUpperCase() === 'AND') {
        consume(); // AND
      }
      const beforePos = pos;
      const right = parseNot();
      if (pos === beforePos) {
        throw new Error(`Invalid syntax in filter expression near token "${peek()}"`);
      }
      node = { type: 'AND', left: node, right };
    }
    return node;
  }

  function parseNot(): FilterNode {
    if (pos < tokens.length && (peek()?.toUpperCase() === 'NOT' || peek() === '!')) {
      consume(); // NOT / !
      const child = parsePrimary();
      return { type: 'NOT', child };
    }
    return parsePrimary();
  }

  function parsePrimary(): FilterNode {
    const token = peek();
    if (!token) {
      throw new Error(`Unexpected end of filter expression at position ${pos}`);
    }

    if (token === '(') {
      consume(); // (
      const node = parseExpression();
      if (peek() !== ')') {
        throw new Error('Expected closing parenthesis ")" in filter expression');
      }
      consume(); // )
      return node;
    }

    // Comparison term: <field> <op> <value> or <field>:<value>
    const fieldToken = consume();
    const cleanField = fieldToken.replace(/^["']|["']$/g, '');

    let op: any = ':';
    let rawVal = '';

    const nextTok = peek();
    if (
      nextTok === ':' ||
      nextTok === '=' ||
      nextTok === '==' ||
      nextTok === '!=' ||
      nextTok === '>' ||
      nextTok === '>=' ||
      nextTok === '<' ||
      nextTok === '<=' ||
      nextTok?.toLowerCase() === 'contains'
    ) {
      op = consume();
      if (op === '==') op = '=';
      rawVal = consume();
      if (!rawVal) {
        throw new Error(`Missing value after operator "${op}" for field "${cleanField}"`);
      }
    } else {
      op = ':';
      rawVal = cleanField;
    }

    const unquoted = rawVal.replace(/^["']|["']$/g, '');
    let parsedVal: string | number | boolean = unquoted;
    if (/^true$/i.test(unquoted)) parsedVal = true;
    else if (/^false$/i.test(unquoted)) parsedVal = false;
    else if (/^-?\d+(\.\d+)?$/.test(unquoted)) parsedVal = Number(unquoted);

    return {
      type: 'COMPARE',
      field: cleanField,
      op,
      value: parsedVal,
    };
  }

  const result = parseExpression();
  if (pos < tokens.length) {
    throw new Error(`Unexpected trailing token in filter: "${tokens[pos]}"`);
  }
  return result;
}

export function evaluateFilter(
  node: FilterNode | string,
  meta?: DocumentMetadata,
  doc?: { file?: string; title?: string }
): boolean {
  if (typeof node === 'string') {
    if (!node.trim()) return true;
    try {
      node = parseFilter(node);
    } catch {
      return false;
    }
  }

  if (node.type === 'AND') {
    return evaluateFilter(node.left, meta, doc) && evaluateFilter(node.right, meta, doc);
  }

  if (node.type === 'OR') {
    return evaluateFilter(node.left, meta, doc) || evaluateFilter(node.right, meta, doc);
  }

  if (node.type === 'NOT') {
    return !evaluateFilter(node.child, meta, doc);
  }

  if (node.type === 'COMPARE') {
    return evaluateCompare(node.field, node.op, node.value, meta, doc);
  }

  return true;
}

function evaluateCompare(
  field: string,
  op: string,
  targetVal: string | number | boolean,
  meta?: DocumentMetadata,
  doc?: { file?: string; title?: string }
): boolean {
  const normField = field.toLowerCase().replace(/[-_]/g, '');

  let actualVal: any = undefined;

  if (normField === 'file' || normField === 'path') {
    actualVal = doc?.file;
  } else if (normField === 'title') {
    actualVal = meta?.title || doc?.title;
  } else if (normField === 'tag' || normField === 'tags') {
    actualVal = meta?.tags || [];
  } else if (normField === 'alias' || normField === 'aliases') {
    actualVal = meta?.aliases || [];
  } else if (normField === 'project') {
    actualVal = meta?.project;
  } else if (normField === 'type') {
    actualVal = meta?.type;
  } else if (normField === 'status') {
    actualVal = meta?.status;
  } else if (normField === 'canonical') {
    actualVal = meta?.canonical;
  } else if (normField === 'date' || normField === 'created') {
    actualVal = meta?.created;
  } else if (normField === 'updated') {
    actualVal = meta?.updated;
  } else if (meta?.custom && field in meta.custom) {
    actualVal = meta.custom[field];
  }

  // Tag array membership
  if (normField === 'tag' || normField === 'tags' || Array.isArray(actualVal)) {
    const list = Array.isArray(actualVal) ? actualVal : [];
    const searchTarget = String(targetVal).toLowerCase().replace(/^#/, '');

    if (op === ':' || op === 'contains' || op === '=' || op === '==') {
      return list.some((item) => String(item).toLowerCase().replace(/^#/, '') === searchTarget);
    }
    if (op === '!=') {
      return !list.some((item) => String(item).toLowerCase().replace(/^#/, '') === searchTarget);
    }
  }

  if (actualVal === undefined || actualVal === null) {
    if (op === '!=') return true;
    return false;
  }

  // Boolean compare
  if (typeof targetVal === 'boolean') {
    const b = Boolean(actualVal);
    return op === '!=' ? b !== targetVal : b === targetVal;
  }

  // Number compare
  if (typeof targetVal === 'number') {
    const num = Number(actualVal);
    if (Number.isNaN(num)) return false;
    switch (op) {
      case '=':
      case ':':
        return num === targetVal;
      case '!=':
        return num !== targetVal;
      case '>':
        return num > targetVal;
      case '>=':
        return num >= targetVal;
      case '<':
        return num < targetVal;
      case '<=':
        return num <= targetVal;
      default:
        return false;
    }
  }

  // String / Date comparison
  const strActual = String(actualVal).toLowerCase();
  const strTarget = String(targetVal).toLowerCase();

  switch (op) {
    case '=':
      return strActual === strTarget;
    case ':':
    case 'contains':
      return strActual.includes(strTarget);
    case '!=':
      return strActual !== strTarget;
    case '>':
      return strActual > strTarget;
    case '>=':
      return strActual >= strTarget;
    case '<':
      return strActual < strTarget;
    case '<=':
      return strActual <= strTarget;
    default:
      return false;
  }
}
